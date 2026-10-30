import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2333 (epic AXI-2308) — IgG4 strip-plot debug & fix.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2333 §1. Tags: @SI-033.
 *
 * Root-cause: `resolveGroupOrder` (`axiome-front/src/lib/charts/builders/
 * shared.ts`, reused by `resolveFacetOrder` in `facetedStrip.builders.ts`)
 * matched a curated `group_order` name against a raw group value with EXACT
 * string equality. A real header can carry incidental whitespace variance
 * (a merged Excel header cell, a trailing blank) a curated spec's declared
 * name never does, which silently dropped that group to the unnamed
 * fallback position instead of the declared one. Mirrored byte-for-byte in
 * `axiome-back`'s `pdf-render.service.ts` (`resolveGroupOrderBack`).
 *
 * Per the story's instruction, this fixture is shaped like the CLASS of
 * defect Paul's real header exposed (a group value carrying incidental
 * whitespace) — it is a self-contained, freshly-created org/workspace/
 * project/dataset, never the real CeRAINOM-IgG4 org (read-only constraint
 * on that org is honoured by never touching it here).
 */

const THROWAWAY_PREFIX = '[e2e AXI-2333]';

function uniq(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** group value carries a trailing double space — the exact defect class. */
const CSV = [
  'group,value',
  'SD,1.2',
  'SD,1.4',
  'HD  ,2.1',
  'HD  ,2.3',
  'HD  ,2.5',
  'IgG4-RD,3.1',
  'IgG4-RD,3.4',
].join('\n');

interface Tenant {
  orgId: string;
  workspaceId: string;
  datasetId: string;
}

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let tenant: Tenant;
let specId: string;

function headers() {
  return { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': tenant.workspaceId };
}

async function waitDatasetReady(datasetId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await api.get(apiUrl(`/api/v1/workspaces/${tenant.workspaceId}/datasets/${datasetId}`), { headers: headers() });
    const body = await res.json();
    if (body.latestIngestion?.status === 'ready') return;
    if (body.latestIngestion?.status === 'failed') throw new Error('probe CSV ingestion failed');
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('probe CSV ingestion timed out');
}

async function createTenantWithWhitespaceGroupDataset(): Promise<Tenant> {
  const suffix = uniq();
  const org = await api.post(apiUrl('/api/v1/organizations'), {
    data: { name: `${THROWAWAY_PREFIX} org ${suffix}`, type: 'biotech' },
  });
  const orgBody = await org.json();
  const orgId: string = orgBody.id;

  const ws = await api.post(apiUrl('/api/v1/workspaces'), {
    data: { name: `${THROWAWAY_PREFIX} ws ${suffix}`, type: 'internal', ownerOrganizationId: orgId },
  });
  const wsBody = await ws.json();
  const workspaceId: string = wsBody.id;

  const wsHeaders = { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId };
  await api.post(apiUrl('/api/v1/projects'), {
    headers: wsHeaders,
    data: { name: `${THROWAWAY_PREFIX} project ${suffix}`, workspaceId },
  });

  const init = await api.post(apiUrl(`/api/v1/workspaces/${workspaceId}/datasets`), {
    headers: wsHeaders,
    data: { organizationId: orgId, originalFilename: 'axi-2333-whitespace-group.csv', contentType: 'text/csv' },
  });
  const initBody = await init.json();
  const datasetId: string = initBody.dataset.id;

  const put = await fetch(initBody.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: CSV });
  expect(put.ok, `presigned PUT of probe CSV failed (${put.status})`).toBeTruthy();

  const fin = await api.patch(apiUrl(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/finalize`), { headers: wsHeaders });
  expect(fin.ok(), `dataset finalize failed (${fin.status()})`).toBeTruthy();

  return { orgId, workspaceId, datasetId };
}

async function createWhitespaceStripCandidate(): Promise<string> {
  const wsHeaders = { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': tenant.workspaceId };
  const res = await api.post(apiUrl(`/api/v1/workspaces/${tenant.workspaceId}/datasets/${tenant.datasetId}/candidates`), {
    headers: wsHeaders,
    data: {
      templateId: 'strip_v1',
      templateVersion: '1.0.0',
      bindings: { y: { column_id: 'col_value' }, group: { column_id: 'col_group' } },
      // The declared order names the CLEAN group names; the raw data carries
      // "HD  " (trailing double space) — AXI-2333's exact defect class.
      params: { group_order: ['HD', 'IgG4-RD', 'SD'] },
      filters: [],
      title: `${THROWAWAY_PREFIX} strip`,
    },
  });
  expect(res.ok(), `create candidate: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).id as string;
}

async function signIn(page: Page) {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [accessToken, refreshToken, tenant.orgId, tenant.workspaceId] as const,
  );
}

type GdTrace = { type: string; name: string };

async function readTraces(page: Page): Promise<GdTrace[]> {
  await expect.poll(async () => page.locator('.js-plotly-plot').count(), { timeout: 20_000 }).toBeGreaterThan(0);
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gd = document.querySelector('.js-plotly-plot') as any;
    return gd.data.map((t: GdTrace) => ({ type: t.type, name: t.name }));
  });
}

test.describe('AXI-2333 - IgG4 strip-plot debug & fix', { tag: ['@SI-033'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: {
        email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com',
        password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin',
      },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });

    tenant = await createTenantWithWhitespaceGroupDataset();
    await waitDatasetReady(tenant.datasetId);
    specId = await createWhitespaceStripCandidate();
  });

  test.afterAll(async () => {
    if (tenant && specId) {
      const wsHeaders = { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': tenant.workspaceId };
      await api.delete(apiUrl(`/api/v1/workspaces/${tenant.workspaceId}/datasets/${tenant.datasetId}/candidates/${specId}`), { headers: wsHeaders });
    }
    await api?.dispose();
  });

  test('AC30 @SI-033 - renders with no uncaught page error on a group value carrying incidental whitespace', async ({ page }) => {
    // Uncaught JS errors only — NOT a strict zero-network-404 assertion. The
    // chart page independently issues an unrelated derived-evidence/
    // interpretations lookup (`GET /api/v1/derived-evidence?projectId=...`)
    // that 404s whenever a candidate is created directly via the
    // `/candidates` endpoint without a full project-scoped UI flow (this
    // fixture's own creation path, AXI-2252's same pattern) — out of
    // AXI-2333's scope (not the strip-plot render path) and not a
    // regression; asserting on it here would couple this spec to an
    // unrelated feature.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await signIn(page);
    await page.goto(`/datasets/${tenant.datasetId}/chart/${specId}`);
    const traces = await readTraces(page);

    expect(traces.length).toBeGreaterThan(0);
    expect(pageErrors, `uncaught page errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
  });

  test('AC30 @SI-033 - the whitespace-varying group renders at the group_order-declared position, raw value intact', async ({ page }) => {
    await signIn(page);
    await page.goto(`/datasets/${tenant.datasetId}/chart/${specId}`);
    const traces = await readTraces(page);
    const order = traces.filter((t) => t.type === 'box').map((t) => t.name);

    // The curated group_order names the clean form "HD"; the raw data
    // carries "HD  " (trailing double space). A pre-fix build places it at
    // the fallback end (["IgG4-RD", "SD", "HD  "]) because exact-string
    // matching never bound "HD" to "HD  ". The fix binds it to its declared
    // position, still rendering the RAW value, never the curator's string.
    expect(order).toEqual(['HD  ', 'IgG4-RD', 'SD']);
  });
});
