import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2293 (epic AXI-2060): "Save snapshot" records the filtered view on screen as
 * a NAMED filter snapshot without running a rule, through the existing
 * materialize-or-reuse path, parented to the open snapshot; a run started from it
 * uses it as its input.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2293 (S1–S4).
 *
 * Isolation: a THROWAWAY analysis (`[e2e AXI-2293 throwaway] …`) in the synthetic
 * reproduction project 22585add — never the demo project b7b274bc. Its root
 * snapshot carries a run-unique, row-neutral `pct >= -(1+ε)` predicate (every pct
 * is ≥ 0) so nothing here dedups onto another analysis's snapshots. The analysis
 * is archived in `afterAll` (a snapshot has no delete).
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const DEMO_PROJECT_ID = 'b7b274bc-48a3-494a-a66f-76390bb433a8';
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const DUNN_RULE_ID = '796cfeb8-5fa7-442c-a062-abe5957c2d00';
const GROUPS = ['HD', 'IgG4-RD', 'SD'];
const THROWAWAY = '[e2e AXI-2293 throwaway]';

type Filter = { column: string; operator: string; value?: unknown };
interface Snapshot {
  id: string;
  name?: string | null;
  origin?: string;
  filters?: Filter[];
  parentSnapshotId?: string | null;
}

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let analysisId = '';
let rootSnapshotId = '';
let savedSnapshotId = '';
const SCOPE_GUARD: Filter = { column: 'pct', operator: 'gte', value: -1 - Math.random() };
const SAVED_NAME = `ENT 059 saved ${Date.now()}`;

async function ok<T>(label: string, call: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

async function listSnapshots(): Promise<Snapshot[]> {
  const body = await ok<{ data: Snapshot[] }>('snapshots', api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=200`)));
  return body.data;
}

async function filterSnapshotCount(): Promise<number> {
  return (await listSnapshots()).filter((s) => s.origin !== 'rule_derived').length;
}

async function createThrowawayAnalysis(): Promise<void> {
  const me = await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')));
  const va = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId: ENT059_DATASET_ID, name: `${THROWAWAY} ${Date.now()}`, createdBy: me.id },
  }));
  analysisId = va.id;
  const root = await ok<{ id: string }>('root snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysisId, filters: [{ column: 'group', operator: 'in', value: GROUPS }, SCOPE_GUARD] },
  }));
  rootSnapshotId = root.id;
}

async function openAnalysis(page: Page, snapshotId: string) {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [accessToken, refreshToken, ORGANIZATION_ID, WORKSPACE_ID] as const,
  );
  await page.goto(`/projects/${PROJECT_ID}/view-analyses/${analysisId}?snapshotId=${snapshotId}`);
  await expect(page).toHaveURL(new RegExp(`snapshotId=${snapshotId}`), { timeout: 30_000 });
}

/** The table's column menu → one `=` condition → Apply (the explorer's own filter UI). */
async function filterReferenceTo(page: Page, value: string) {
  const header = page.locator('th').filter({ has: page.locator('span', { hasText: /^reference$/ }) }).first();
  await expect(header).toBeVisible({ timeout: 60_000 });
  // The page IGNORES every query for 3 s after it loads a snapshot
  // (`isNavigatingSnapshotRef`, ProjectViewAnalysisDetail — it outlasts the
  // explorer's own initial query), so a filter applied inside that window never
  // reaches the page. Wait it out, as a user always does.
  await page.waitForTimeout(3_500);
  await header.getByTitle('Sort and filter this column').click();
  const menu = page.getByRole('menu');
  await menu.getByRole('button', { name: 'Add condition' }).click();
  await menu.locator('select').last().selectOption('eq');
  await menu.getByPlaceholder('Value…').last().fill(value);
  await menu.getByRole('button', { name: 'Apply' }).click();
}

test.describe('AXI-2293 - Save snapshot records the filtered view as a named snapshot', { tag: ['@SI-035', '@SI-030'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  test.use({ storageState: { cookies: [], origins: [] } });

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
    expect(PROJECT_ID).not.toBe(DEMO_PROJECT_ID);
    await createThrowawayAnalysis();
  });

  test.afterAll(async () => {
    if (!api) return;
    if (analysisId) await api.patch(apiUrl(`/api/v1/view-analyses/${analysisId}/archive`), { data: {} });
    await api.dispose();
  });

  test('S1 AC1/AC2 - filter, Save snapshot named X: a filter snapshot parented to the open one is recorded, opened, and listed by name', async ({ page }) => {
    const before = await filterSnapshotCount();
    await openAnalysis(page, rootSnapshotId);
    // S4: the slice matches the open snapshot — nothing to save.
    await expect(page.getByRole('button', { name: /Snapshot v\d+/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('save-snapshot-button')).toHaveCount(0);

    await filterReferenceTo(page, 'ENT 059');
    await expect(page.getByText('Exploring — not recorded')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('save-snapshot-button').click();
    const nameInput = page.getByTestId('save-snapshot-name');
    await expect(nameInput, 'the proposed name is what the save adds to the open snapshot').toHaveValue('reference = ENT 059');
    await nameInput.fill(SAVED_NAME);
    await page.getByTestId('save-snapshot-confirm').click();

    // AC2: the page opens the new snapshot; the status reads it as recorded.
    // Exploring clears ?snapshotId=; the save puts the NEW snapshot's id back.
    await expect(page).toHaveURL(new RegExp(`snapshotId=(?!${rootSnapshotId})[0-9a-f-]{36}`), { timeout: 30_000 });
    savedSnapshotId = new URL(page.url()).searchParams.get('snapshotId') ?? '';
    expect(savedSnapshotId).toBeTruthy();
    await expect(page.getByText('Exploring — not recorded')).toHaveCount(0);
    await expect(page.getByRole('button', { name: new RegExp(SAVED_NAME) }).first()).toBeVisible();
    await expect(page.getByTestId('save-snapshot-button'), 'the slice is now the open snapshot').toHaveCount(0);

    // AC1: one new filter-origin snapshot, the on-screen filters, parent = the open snapshot.
    const saved = (await listSnapshots()).find((s) => s.id === savedSnapshotId);
    expect(saved?.origin).toBe('filter');
    expect(saved?.name).toBe(SAVED_NAME);
    expect(saved?.parentSnapshotId).toBe(rootSnapshotId);
    expect(saved?.filters).toEqual(expect.arrayContaining([expect.objectContaining({ column: 'reference', operator: 'eq', value: 'ENT 059' })]));
    expect(await filterSnapshotCount()).toBe(before + 1);

    // AC2: the snapshot picker lists it by name.
    await page.getByRole('button', { name: new RegExp(SAVED_NAME) }).first().click();
    await expect(page.locator('div.absolute').getByText(SAVED_NAME, { exact: true })).toBeVisible();
  });

  test('S2 AC3 - the same filters again open the saved snapshot and create no duplicate', async ({ page }) => {
    expect(savedSnapshotId, 'S1 saved a snapshot').toBeTruthy();
    const before = await filterSnapshotCount();
    await openAnalysis(page, rootSnapshotId);
    await expect(page.getByRole('button', { name: /Snapshot v\d+/ }).first()).toBeVisible({ timeout: 30_000 });

    await filterReferenceTo(page, 'ENT 059');
    await expect(page).toHaveURL(new RegExp(`snapshotId=${savedSnapshotId}`), { timeout: 30_000 });
    await expect(page.getByRole('button', { name: new RegExp(SAVED_NAME) }).first()).toBeVisible();
    await expect(page.getByTestId('save-snapshot-button')).toHaveCount(0);
    expect(await filterSnapshotCount()).toBe(before);
  });

  test('S3 AC4 - Run rule from the saved snapshot cites it as the run input; no second filter snapshot', async ({ page }) => {
    expect(savedSnapshotId, 'S1 saved a snapshot').toBeTruthy();
    const rule = await ok<{ code: string }>('dunn rule', api.get(apiUrl(`/api/v1/rules/${DUNN_RULE_ID}`)));
    const before = await filterSnapshotCount();
    await openAnalysis(page, savedSnapshotId);
    await expect(page.getByRole('button', { name: new RegExp(SAVED_NAME) }).first()).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Run rule' }).click();
    await expect(page.getByRole('heading', { name: /Run relationship rule/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('radio').filter({ hasText: rule.code }).click();
    await page.getByRole('button', { name: 'Adjust parameters' }).click();
    await expect(page.getByRole('heading', { name: /^Configure / })).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="rule-run-field"][data-field="role:groupColumn"] > select').selectOption('group');
    await page.getByRole('checkbox', { name: 'pct', exact: true }).check();

    const submit = page.getByRole('button', { name: 'Run rule' }).last();
    await expect(submit).toBeEnabled();
    const [runRequest] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith('/rule-runs') && r.method() === 'POST'),
      submit.click(),
    ]);
    expect(runRequest.postDataJSON().snapshotId, 'the run input is the saved snapshot').toBe(savedSnapshotId);
    expect(await filterSnapshotCount(), 'no second filter snapshot materialized for the run').toBe(before);
  });
});
