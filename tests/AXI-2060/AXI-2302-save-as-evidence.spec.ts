import { test, expect, request as apiRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2302 (epic AXI-2060): the chart page carries a "Save as evidence" button
 * immediately right of the Provenance chip. It opens the gallery card's own
 * AddToEvidenceModal, pre-filled the same way, and creates the same evidence
 * as "⋯ → Add to evidence → Create New" on the same chart and snapshot. It is
 * offered exactly where the gallery card offers "Add to evidence": with the
 * analysis context the workspace gallery carries (`?fromAnalysis=`).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2302 (S1–S3).
 *
 * Isolation: a THROWAWAY analysis (`[e2e AXI-2302 throwaway] …`) in the synthetic
 * reproduction project 22585add — never the demo projects 4ff39166 / b7b274bc —
 * with a root filter snapshot carrying a run-unique, row-neutral `pct >= -(1+ε)`
 * predicate. Cleanup: evidence has no delete, so `afterAll` retires each one
 * (`unapproved`), deletes the throwaway chart and archives the analysis.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const DEMO_PROJECT_IDS = ['b7b274bc-48a3-494a-a66f-76390bb433a8', '4ff39166'];
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const GROUPS = ['HD', 'IgG4-RD', 'SD'];
const THROWAWAY = '[e2e AXI-2302 throwaway]';
const CHART_TITLE = `${THROWAWAY} ENT 059 strip ${Date.now()}`;

type Filter = { column: string; operator: string; value?: unknown };
// AXI-1234/AXI-2296: a frozen citation's chartArtifactId is a render fingerprint (dvi_…);
// the spec it is drawn from arrives as dataviewSpecId.
type EvidenceChart = { chartArtifactId: string; frozen?: boolean; dataviewSpecId?: string | null; snapshotId: string; datasetVersionId: string };
interface Evidence { id: string; currentVersion: { title?: string; kind?: string | null; charts: EvidenceChart[] } }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let analysisId = '';
let analysisName = '';
let rootSnapshotId = '';
let specId = '';
const evidenceIds: string[] = [];
const SCOPE_GUARD: Filter = { column: 'pct', operator: 'gte', value: -1 - Math.random() };
const ROOT_FILTERS: Filter[] = [
  { column: 'group', operator: 'in', value: GROUPS },
  { column: 'reference', operator: 'eq', value: 'ENT 059' },
  SCOPE_GUARD,
];

function candidatesUrl(suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${ENT059_DATASET_ID}/candidates${suffix}`);
}

async function ok<T>(label: string, call: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

async function setUpThrowaways(): Promise<void> {
  const me = await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')));
  analysisName = `${THROWAWAY} ${Date.now()}`;
  const va = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId: ENT059_DATASET_ID, name: analysisName, createdBy: me.id },
  }));
  analysisId = va.id;
  const root = await ok<{ id: string }>('root snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysisId, filters: ROOT_FILTERS },
  }));
  rootSnapshotId = root.id;
  const spec = await ok<{ id: string }>('chart', api.post(candidatesUrl(), {
    data: {
      templateId: 'strip_v1', templateVersion: '1.0.0', title: CHART_TITLE,
      bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
      params: { group_order: GROUPS }, filters: ROOT_FILTERS, viewAnalysisId: analysisId,
    },
  }));
  specId = spec.id;
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

/** The chart page as the analysis Workspace gallery opens it (`navigateToFullChart`). */
async function openChartFromWorkspace(page: Page) {
  const qs = new URLSearchParams({
    fromAnalysis: analysisId, projectId: PROJECT_ID, analysisName, chartName: CHART_TITLE,
    snapshotId: rootSnapshotId, filters: JSON.stringify(ROOT_FILTERS),
  });
  await signIn(page);
  await page.goto(`/datasets/${ENT059_DATASET_ID}/chart/${specId}?${qs.toString()}`);
}

function provenanceChip(page: Page): Locator {
  return page.getByRole('button', { name: 'Provenance', exact: true });
}

async function finishCreateNew(page: Page, title: string) {
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

/** The gallery card for the throwaway chart (AXI-2290's card walk). */
async function galleryCard(page: Page): Promise<Locator> {
  await page.getByPlaceholder('Filter by chart type...').fill(CHART_TITLE);
  const header = page.locator(`h4[title="${CHART_TITLE}"]`).first();
  await expect(header).toBeVisible({ timeout: 60_000 });
  const card = header.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " group ")]').last();
  await expect(card.locator('svg.main-svg').first()).toBeVisible({ timeout: 60_000 });
  return card;
}

function entryOf(evidence: Evidence) {
  expect(evidence.currentVersion.charts).toHaveLength(1);
  const { chartArtifactId, frozen, dataviewSpecId, snapshotId, datasetVersionId } = evidence.currentVersion.charts[0];
  return { chartArtifactId, frozen, dataviewSpecId, snapshotId, datasetVersionId };
}

test.describe('AXI-2302 - chart page Save as evidence beside the Provenance chip', { tag: ['@SI-033', '@SI-035'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  test.use({ storageState: { cookies: [], origins: [] } });

  const FROM_CHART_PAGE = `${THROWAWAY} from chart page ${Date.now()}`;
  const FROM_GALLERY = `${THROWAWAY} from gallery ${Date.now()}`;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
    for (const demo of DEMO_PROJECT_IDS) expect(PROJECT_ID.startsWith(demo)).toBe(false);
    await setUpThrowaways();
  });

  test.afterAll(async () => {
    if (!api) return;
    for (const id of evidenceIds) {
      await api.patch(apiUrl(`/api/v1/view-analyses/evidences/${id}/status`), { data: { status: 'unapproved' } });
    }
    if (specId) await api.delete(candidatesUrl(`/${specId}`));
    if (analysisId) await api.patch(apiUrl(`/api/v1/view-analyses/${analysisId}/archive`), { data: {} });
    await api.dispose();
  });

  test('S1 AC1 - the button sits immediately right of the Provenance chip and opens the gallery card\'s Add to Evidence modal', async ({ page }) => {
    await openChartFromWorkspace(page);
    await expect(provenanceChip(page)).toBeVisible({ timeout: 60_000 });
    const button = page.getByTestId('chart-save-as-evidence');
    await expect(button).toBeVisible();
    await expect(button).toHaveText('Save as evidence');
    const nextToChip = provenanceChip(page).locator('xpath=following-sibling::*[1]');
    await expect(nextToChip, 'the next element after the Provenance chip').toHaveAttribute('data-testid', 'chart-save-as-evidence');

    await button.click();
    const dialog = page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Add to Evidence' }) });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(CHART_TITLE, { exact: true }), 'Chart badge names this chart').toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Add to Existing' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create New' })).toBeVisible();
  });

  test('S2 AC2 - Create New makes the same evidence as the gallery card path for the same chart and snapshot', async ({ page }) => {
    await openChartFromWorkspace(page);
    await expect(page.getByTestId('chart-save-as-evidence')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('chart-save-as-evidence').click();
    await finishCreateNew(page, FROM_CHART_PAGE);
    await expect(page.getByText('Evidence created')).toBeVisible({ timeout: 10_000 });
    const fromChartPage = await evidenceByTitle(FROM_CHART_PAGE);
    expect(entryOf(fromChartPage), 'a frozen citation of this chart on its own dataset').toEqual(expect.objectContaining({
      frozen: true, dataviewSpecId: specId, datasetVersionId: ENT059_DATASET_ID,
    }));

    // The existing path, same chart, same open snapshot.
    await page.goto(`/projects/${PROJECT_ID}/view-analyses/${analysisId}?snapshotId=${rootSnapshotId}`);
    const card = await galleryCard(page);
    await card.getByTitle('More actions').evaluate((el) => (el as HTMLElement).click());
    const item = card.getByRole('menuitem', { name: 'Add to evidence' });
    await item.waitFor({ state: 'attached' });
    await item.evaluate((el) => (el as HTMLElement).click());
    await finishCreateNew(page, FROM_GALLERY);
    const fromGallery = await evidenceByTitle(FROM_GALLERY);

    expect(entryOf(fromChartPage), 'same frozen render fingerprint / spec / snapshot / dataset').toEqual(entryOf(fromGallery));
    expect(fromChartPage.currentVersion.kind ?? null, 'same evidence kind').toBe(fromGallery.currentVersion.kind ?? null);
  });

  test('S3 AC3 - without the analysis context the button is absent, not disabled', async ({ page }) => {
    await signIn(page);
    await page.goto(`/datasets/${ENT059_DATASET_ID}/chart/${specId}`);
    await expect(provenanceChip(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('chart-save-as-evidence')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save as evidence' })).toHaveCount(0);
  });
});
