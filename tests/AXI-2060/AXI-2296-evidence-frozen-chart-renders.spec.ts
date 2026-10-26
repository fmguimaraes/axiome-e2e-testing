import { test, expect, request as apiRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2296 (epic AXI-2060): the evidence page shows every cited chart, for a
 * FROZEN citation (AXI-1234: `chartArtifactId` = a `dvi_…` render fingerprint)
 * and a LEGACY one (`chartArtifactId` = the DataviewSpec id) alike. The backend
 * resolves each citation's `dataviewSpecId`; the page's gallery filters on it.
 * Red on main: a frozen citation's page shows "No candidate visualizations were
 * generated for this dataset profile".
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2296 (S1–S2).
 *
 * Isolation: a THROWAWAY analysis (`[e2e AXI-2296 throwaway] …`) in the synthetic
 * reproduction project 22585add — never project 4ff39166 / analysis b00e6348 /
 * project b7b274bc. Cleanup as AXI-2290: evidences retired (`unapproved`),
 * chart clones deleted, analysis archived.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const FORBIDDEN_PROJECT_IDS = ['4ff39166-071e-4cec-92f3-697373592710', 'b7b274bc-48a3-494a-a66f-76390bb433a8'];
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const GROUPS = ['HD', 'IgG4-RD', 'SD'];
const THROWAWAY = '[e2e AXI-2296 throwaway]';
const EMPTY_GALLERY = 'No candidate visualizations were generated for this dataset profile';

type Filter = { column: string; operator: string; value?: unknown };
type EvidenceChart = { chartArtifactId: string; frozen?: boolean; dataviewSpecId?: string | null; snapshotId: string };
interface Evidence { id: string; currentVersion: { title?: string; charts: EvidenceChart[] } }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let userId = '';
let analysisId = '';
let snapshotId = '';
const specs: Record<string, string> = {};
const evidenceIds: string[] = [];
const FILTERS: Filter[] = [
  { column: 'group', operator: 'in', value: GROUPS },
  { column: 'reference', operator: 'eq', value: 'ENT 059' },
];

function candidatesUrl(suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${ENT059_DATASET_ID}/candidates${suffix}`);
}

async function ok<T>(label: string, call: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

async function login(): Promise<void> {
  const ctx = await apiRequest.newContext();
  const res = await ctx.post(apiUrl('/api/v1/auth/login'), {
    data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
  });
  expect(res.ok()).toBeTruthy();
  ({ accessToken, refreshToken } = await res.json());
  await ctx.dispose();
  api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
}

async function createThrowawayAnalysis(): Promise<void> {
  expect(FORBIDDEN_PROJECT_IDS).not.toContain(PROJECT_ID);
  userId = (await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')))).id;
  const va = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId: ENT059_DATASET_ID, name: `${THROWAWAY} ${Date.now()}`, createdBy: userId },
  }));
  analysisId = va.id;
  snapshotId = (await ok<{ id: string }>('snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysisId, filters: FILTERS },
  }))).id;
}

async function createChart(label: string): Promise<void> {
  const spec = await ok<{ id: string }>(`chart ${label}`, api.post(candidatesUrl(), {
    data: {
      templateId: 'strip_v1', templateVersion: '1.0.0', title: `${THROWAWAY} ${label}`,
      bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
      params: { x_title: 'Reference microbiota', y_title: '% opsonized', group_order: GROUPS },
      filters: FILTERS, viewAnalysisId: analysisId,
    },
  }));
  specs[label] = spec.id;
}

async function signIn(page: Page) {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [accessToken, refreshToken, ORGANIZATION_ID, WORKSPACE_ID] as const,
  );
}

/** The analysis gallery card for this chart, once its plot has rendered. */
async function renderedGalleryCard(page: Page, label: string): Promise<Locator> {
  await page.getByPlaceholder('Filter by chart type...').fill(`${THROWAWAY} ${label}`);
  return renderedCard(page, label);
}

async function renderedCard(page: Page, label: string): Promise<Locator> {
  const header = page.locator(`h4[title="${THROWAWAY} ${label}"]`).first();
  await expect(header).toBeVisible({ timeout: 60_000 });
  const card = header.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " group ")]').last();
  await expect(card.locator('svg.main-svg').first()).toBeVisible({ timeout: 60_000 });
  return card;
}

async function addToNewEvidence(page: Page, card: Locator, title: string) {
  await card.getByTitle('More actions').evaluate((el) => (el as HTMLElement).click());
  const item = card.getByRole('menuitem', { name: 'Add to evidence' });
  await item.waitFor({ state: 'attached' });
  await item.evaluate((el) => (el as HTMLElement).click());
  await page.getByRole('button', { name: 'Create New' }).click();
  await page.getByPlaceholder('Evidence title').fill(title);
  await page.getByTestId('create-evidence-submit').click();
  const continueAnyway = page.getByTestId('empty-framing-continue');
  if (await continueAnyway.isVisible({ timeout: 3_000 }).catch(() => false)) await continueAnyway.click();
  await expect(page.getByTestId('create-evidence-submit')).not.toBeVisible({ timeout: 20_000 });
}

async function evidenceByTitle(title: string): Promise<Evidence> {
  let found: { id: string } | undefined;
  await expect.poll(async () => {
    const list = await ok<{ data: { id: string; currentVersion?: { title?: string } }[] }>('evidences', api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/evidences?page=1&limit=100`)));
    found = list.data.find((e) => e.currentVersion?.title === title);
    return !!found;
  }, { timeout: 20_000 }).toBe(true);
  if (!evidenceIds.includes(found!.id)) evidenceIds.push(found!.id);
  return ok<Evidence>('evidence', api.get(apiUrl(`/api/v1/view-analyses/evidences/${found!.id}`)));
}

async function expectEvidencePageShowsChart(page: Page, evidenceId: string, label: string) {
  await page.goto(`/projects/${PROJECT_ID}/view-analyses/${analysisId}/evidences/${evidenceId}`);
  await renderedCard(page, label);
  await expect(page.getByText(EMPTY_GALLERY)).toHaveCount(0);
}

test.describe('AXI-2296 - the evidence page renders frozen and legacy chart citations', { tag: ['@SI-034', '@SI-017'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await login();
    await createThrowawayAnalysis();
    await createChart('S1 frozen');
    await createChart('S2 legacy');
  });

  test.afterAll(async () => {
    if (!api) return;
    for (const id of evidenceIds) {
      await api.patch(apiUrl(`/api/v1/view-analyses/evidences/${id}/status`), { data: { status: 'unapproved' } });
    }
    for (const id of Object.values(specs)) await api.delete(candidatesUrl(`/${id}`));
    if (analysisId) await api.patch(apiUrl(`/api/v1/view-analyses/${analysisId}/archive`), { data: {} });
    await api.dispose();
  });

  test('S1 AC1 - an evidence created through Add to evidence (a FROZEN citation) shows its chart on the evidence page', async ({ page }) => {
    const title = `${THROWAWAY} evidence S1 ${Date.now()}`;
    await signIn(page);
    await page.goto(`/projects/${PROJECT_ID}/view-analyses/${analysisId}?snapshotId=${snapshotId}`);
    await addToNewEvidence(page, await renderedGalleryCard(page, 'S1 frozen'), title);

    const evidence = await evidenceByTitle(title);
    const [chart] = evidence.currentVersion.charts;
    // Guard against a latently-green run: the citation really IS frozen.
    expect(chart.frozen, 'the real modal froze the render (AXI-1234)').toBe(true);
    expect(chart.chartArtifactId).toMatch(/^dvi_/);
    expect(chart.dataviewSpecId, 'the server resolves the fingerprint to its spec').toBe(specs['S1 frozen']);

    await expectEvidencePageShowsChart(page, evidence.id, 'S1 frozen');
  });

  test('S2 AC2 - a LEGACY citation naming the spec id still shows its chart on the evidence page', async ({ page }) => {
    const title = `${THROWAWAY} evidence S2 ${Date.now()}`;
    await ok('legacy evidence', api.post(apiUrl('/api/v1/view-analyses/evidences'), {
      data: {
        viewAnalysisId: analysisId, title, createdBy: userId,
        chartEntries: [{ chartArtifactId: specs['S2 legacy'], snapshotId, datasetVersionId: ENT059_DATASET_ID }],
      },
    }));
    const evidence = await evidenceByTitle(title);
    const [chart] = evidence.currentVersion.charts;
    expect(chart.frozen).toBe(false);
    expect(chart.chartArtifactId).toBe(specs['S2 legacy']);
    expect(chart.dataviewSpecId).toBe(specs['S2 legacy']);

    await signIn(page);
    await expectEvidencePageShowsChart(page, evidence.id, 'S2 legacy');
  });
});
