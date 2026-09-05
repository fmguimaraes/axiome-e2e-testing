import { test, expect, APIRequestContext, request as apiRequest, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1418 — Workspace-page download control for the surface spec
 * (manual-e2e AXI-1396-Governed-Statistical-Analysis-Surface.md §4.17;
 * epic AXI-1399; FR30, AC17).
 *
 * The build-generated governed-statistical-surface markdown (AXI-1417,
 * SI-017) is served as a plain static file — this story adds ONLY a
 * download control on the workspace page (`WorkspaceDetail.tsx`), pointing
 * at the committed copy under `axiome-front/public/`. No API endpoint, no
 * backend fetch, per the feature's thin static-serving intent (§7
 * "Downloading the surface spec").
 *
 * This spec is a read-only UI liveness proxy: it provisions a workspace over
 * the public API (register-on-demand determinism, same pattern as the
 * AXI-1244 subject fixtures), opens that workspace's detail page in the
 * browser, and asserts the download control is present and wired to the
 * expected static path — it does not assert the artifact's *content* (that
 * is AXI-1417/SI-017's own drift-guard responsibility). Live browser run is
 * authored and typechecks; per this epic's convention (see run notes on
 * sibling AXI-1396 specs), the actual run against a live stack is deferred
 * to the epic Workflow-5 walk.
 */

const SURFACE_SPEC_HREF = '/GOVERNED-STATISTICAL-SURFACE.md';
const SURFACE_SPEC_FILENAME = 'GOVERNED-STATISTICAL-SURFACE.md';

async function send(
  api: APIRequestContext,
  method: 'post' | 'get',
  path: string,
  workspaceId: string | null,
  body?: unknown,
): Promise<any> {
  const headers = workspaceId ? { 'X-Workspace-Id': workspaceId } : undefined;
  const res = await api[method](apiUrl(path), { headers, data: body as any });
  if (!res.ok()) {
    throw new Error(`fixture ${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  return res.json();
}

async function adminApiContext(): Promise<{ api: APIRequestContext; accessToken: string; refreshToken: string }> {
  const bootstrap = await apiRequest.newContext();
  const role = ROLES.find((r) => r.name === 'admin');
  if (!role) throw new Error('admin role missing from ROLES registry');
  const tokens = await ensureAuthTokens(bootstrap, role);
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  return { api, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

async function createFixtureWorkspace(api: APIRequestContext): Promise<{ workspaceId: string; orgId: string }> {
  const me = await send(api, 'get', '/api/v1/auth/me', null);
  const orgs = await send(api, 'get', '/api/v1/organizations', null);
  const orgId = orgs?.data?.[0]?.id;
  if (!orgId) throw new Error('no organization available to own the fixture workspace');

  const ws = await send(api, 'post', '/api/v1/workspaces', null, {
    name: `E2E AXI-1418 download control ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    description: 'AXI-1418 E2E fixture — workspace-page surface-spec download control',
    type: 'internal',
    ownerOrganizationId: orgId,
    createdBy: me.id,
  });
  return { workspaceId: ws.id, orgId };
}

async function seedBrowserSession(
  page: Page,
  tokens: { accessToken: string; refreshToken: string },
  workspaceId: string,
  orgId: string,
): Promise<void> {
  await page.addInitScript(
    ([access, refresh, ws, org]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [tokens.accessToken, tokens.refreshToken, workspaceId, orgId] as const,
  );
}

test.describe('AXI-1418 — workspace-page surface-spec download control (§4.17, FR30/AC17)', { tag: ['@SI-030', '@SI-035'] }, () => {
  test('FR30/AC17 — the workspace page exposes a download control linking straight at the committed static artifact', async ({ page }) => {
    const { api, accessToken, refreshToken } = await adminApiContext();
    try {
      const { workspaceId, orgId } = await createFixtureWorkspace(api);
      await seedBrowserSession(page, { accessToken, refreshToken }, workspaceId, orgId);

      await page.goto(`/workspaces/${workspaceId}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const downloadLink = page.getByRole('link', { name: /download the governed statistical surface specification/i });
      await expect(downloadLink).toBeVisible();
      await expect(downloadLink).toHaveAttribute('href', SURFACE_SPEC_HREF);
      await expect(downloadLink).toHaveAttribute('download', SURFACE_SPEC_FILENAME);
    } finally {
      await api.dispose();
    }
  });
});
