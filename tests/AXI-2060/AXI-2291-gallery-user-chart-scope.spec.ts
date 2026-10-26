import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2291 (epic AXI-2060): a USER chart (`origin: 'user'`) is listed in a chart
 * gallery only where it is owned — its own analysis, or its project's gallery.
 * A user chart saved with no analysis (`viewAnalysisId` NULL: dataset page, API,
 * scripts) belongs to the dataset page only. Before the fix every analysis of
 * every project on the same dataset version listed such a chart (live: analysis
 * b00e6348 of project 4ff39166 showed three charts of project 547e56d1).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2291 (S1–S7).
 *
 * Isolation: project P = the synthetic reproduction project 22585add (never the
 * demo project b7b274bc); project Q = a THROWAWAY project created here and linked
 * to the same ENT059 dataset version. Every chart and analysis is
 * `[e2e AXI-2291 throwaway] …`. `afterAll` deletes the charts, archives the
 * analyses, unlinks the dataset from Q and archives Q.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_P = '22585add-60ab-4d8e-a8ff-0f1071862553';
const DEMO_PROJECT_ID = 'b7b274bc-48a3-494a-a66f-76390bb433a8';
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
/** A second dataset of project P (tableau1_long_synthetic.csv) — the cross-dataset scan's target. */
const SECOND_P_DATASET_ID = '9315c385-e5a3-422c-a83b-fc728629e703';
const THROWAWAY = '[e2e AXI-2291 throwaway]';
const RUN = `${Date.now()}`;

interface Spec { id: string; origin: string; viewAnalysisId: string | null; title?: string | null }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let userId = '';
let projectQ = '';
let analysisX = '';
let analysisY = '';
const charts: { id: string; datasetId: string }[] = [];
const analyses: string[] = [];

const title = (label: string) => `${THROWAWAY} ${label} ${RUN}`;

function candidatesUrl(datasetId: string, suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
}

async function ok<T>(label: string, call: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

async function createAnalysis(projectId: string, label: string): Promise<string> {
  const va = await ok<{ id: string }>(`analysis ${label}`, api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId, datasetId: ENT059_DATASET_ID, name: title(label), createdBy: userId },
  }));
  analyses.push(va.id);
  return va.id;
}

async function createChart(datasetId: string, label: string, viewAnalysisId?: string): Promise<string> {
  const spec = await ok<{ id: string }>(`chart ${label}`, api.post(candidatesUrl(datasetId), {
    data: {
      templateId: 'strip_v1', templateVersion: '1.0.0', title: title(label),
      bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
      params: { x_title: 'Group', y_title: '% opsonized' },
      ...(viewAnalysisId ? { viewAnalysisId } : {}),
    },
  }));
  charts.push({ id: spec.id, datasetId });
  return spec.id;
}

async function list(datasetId: string, query: Record<string, string> = {}): Promise<Spec[]> {
  const qs = new URLSearchParams(query).toString();
  return ok<Spec[]>(`list ${qs || 'dataset page'}`, api.get(candidatesUrl(datasetId, qs ? `?${qs}` : '')));
}

const ids = (specs: Spec[]) => specs.map((s) => s.id);

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

/** Opens an analysis gallery and waits until its candidate fetch has settled. */
async function openGallery(page: Page, projectId: string, analysisId: string) {
  await signIn(page);
  const listed = page.waitForResponse(
    (r) => r.url().includes(`/datasets/${ENT059_DATASET_ID}/candidates?viewAnalysisId=${analysisId}`) && r.request().method() === 'GET',
    { timeout: 60_000 },
  );
  await page.goto(`/projects/${projectId}/view-analyses/${analysisId}`);
  await listed;
  await expect(page.getByPlaceholder('Filter by chart type...')).toBeVisible({ timeout: 60_000 });
}

/** Narrows the gallery to one title (the search matches a spec's title). */
async function searchGallery(page: Page, label: string) {
  await page.getByPlaceholder('Filter by chart type...').fill(title(label));
  return page.locator(`h4[title="${title(label)}"]`);
}

test.describe('AXI-2291 - a user chart is listed only in the analysis that owns it', { tag: ['@SI-015', '@SI-033'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  // Own login (below), never the fixture-org `setup` project's storageState.
  test.use({ storageState: { cookies: [], origins: [] } });

  let chartX = '';
  let chartNull = '';
  let crossNull = '';
  let crossOwned = '';

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
    userId = (await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')))).id;

    expect(PROJECT_P).not.toBe(DEMO_PROJECT_ID);
    const q = await ok<{ id: string }>('project Q', api.post(apiUrl('/api/v1/projects'), {
      data: { name: title('project Q'), workspaceId: WORKSPACE_ID },
    }));
    projectQ = q.id;
    await ok('link ENT059 to Q', api.post(apiUrl(`/api/v1/projects/${projectQ}/datasets`), { data: { datasetId: ENT059_DATASET_ID } }));

    analysisX = await createAnalysis(PROJECT_P, 'analysis X');
    analysisY = await createAnalysis(projectQ, 'analysis Y');

    chartX = await createChart(ENT059_DATASET_ID, 'S1 owned by X', analysisX);
    chartNull = await createChart(ENT059_DATASET_ID, 'S2 dataset page');
    // Positive control for Y's gallery: an absence is only evidence once a card
    // of the same listing has rendered.
    await createChart(ENT059_DATASET_ID, 'S1 owned by Y', analysisY);
    crossNull = await createChart(SECOND_P_DATASET_ID, 'S6 other dataset, no analysis');
    crossOwned = await createChart(SECOND_P_DATASET_ID, 'S6 other dataset, owned by X', analysisX);
  });

  test.afterAll(async () => {
    if (!api) return;
    for (const c of charts) await api.delete(candidatesUrl(c.datasetId, `/${c.id}`));
    for (const id of analyses) await api.patch(apiUrl(`/api/v1/view-analyses/${id}/archive`), { data: {} });
    if (projectQ) {
      await api.delete(apiUrl(`/api/v1/projects/${projectQ}/datasets/${ENT059_DATASET_ID}`));
      await api.patch(apiUrl(`/api/v1/projects/${projectQ}/archive`), { data: {} });
    }
    await api.dispose();
  });

  test('S1 AC1 AC6 - a chart owned by analysis X is listed in X and not in analysis Y of project Q (API)', async () => {
    expect(ids(await list(ENT059_DATASET_ID, { viewAnalysisId: analysisX }))).toContain(chartX);
    expect(ids(await list(ENT059_DATASET_ID, { viewAnalysisId: analysisY }))).not.toContain(chartX);
  });

  test('S2 AC1 AC5 AC6 - a dataset-page user chart is in no analysis gallery, only on the dataset page (API)', async () => {
    expect(ids(await list(ENT059_DATASET_ID, { viewAnalysisId: analysisX }))).not.toContain(chartNull);
    expect(ids(await list(ENT059_DATASET_ID, { viewAnalysisId: analysisY }))).not.toContain(chartNull);
    const datasetPage = ids(await list(ENT059_DATASET_ID));
    expect(datasetPage).toContain(chartNull);
    expect(datasetPage).toContain(chartX);
  });

  test('S1 S2 AC1 AC6 - the gallery of analysis Y (project Q) shows neither chart; the gallery of X shows its own chart only', async ({ page }) => {
    await openGallery(page, projectQ, analysisY);
    await expect((await searchGallery(page, 'S1 owned by Y')).first()).toBeVisible({ timeout: 60_000 });
    await expect(await searchGallery(page, 'S1 owned by X')).toHaveCount(0);
    await expect(await searchGallery(page, 'S2 dataset page')).toHaveCount(0);

    await openGallery(page, PROJECT_P, analysisX);
    await expect((await searchGallery(page, 'S1 owned by X')).first()).toBeVisible({ timeout: 60_000 });
    await expect(await searchGallery(page, 'S2 dataset page')).toHaveCount(0);
  });

  test('S3 AC3 - fetch by id opens any chart, NULL-scoped or owned', async () => {
    const byNull = await ok<Spec>('by id null', api.get(candidatesUrl(ENT059_DATASET_ID, `/${chartNull}`)));
    expect(byNull.id).toBe(chartNull);
    expect(byNull.viewAnalysisId ?? null).toBeNull();
    const byOwned = await ok<Spec>('by id owned', api.get(candidatesUrl(ENT059_DATASET_ID, `/${chartX}`)));
    expect(byOwned.viewAnalysisId).toBe(analysisX);
  });

  test('S4 AC1 - NULL-scoped auto and recommended charts are listed in every analysis gallery, unchanged', async () => {
    const datasetWide = (await list(ENT059_DATASET_ID))
      .filter((s) => s.viewAnalysisId == null && (s.origin === 'auto' || s.origin === 'recommended'));
    const inY = new Set(ids(await list(ENT059_DATASET_ID, { viewAnalysisId: analysisY })));
    expect(datasetWide.filter((s) => !inY.has(s.id)).map((s) => s.id)).toEqual([]);
  });

  test('S5 AC1 - the project gallery lists only the charts its own analyses own', async () => {
    const inP = ids(await list(ENT059_DATASET_ID, { projectId: PROJECT_P }));
    expect(inP).toContain(chartX);
    expect(inP).not.toContain(chartNull);
    const inQ = ids(await list(ENT059_DATASET_ID, { projectId: projectQ }));
    expect(inQ).not.toContain(chartX);
    expect(inQ).not.toContain(chartNull);
  });

  test("S6 AC2 - the cross-dataset user scan of X's gallery shows X's chart on P's other dataset, never a NULL-scoped one", async ({ page }) => {
    expect(ids(await list(SECOND_P_DATASET_ID, { viewAnalysisId: analysisX }))).not.toContain(crossNull);
    await openGallery(page, PROJECT_P, analysisX);
    await expect((await searchGallery(page, 'S6 other dataset, owned by X')).first()).toBeVisible({ timeout: 60_000 });
    await expect(await searchGallery(page, 'S6 other dataset, no analysis')).toHaveCount(0);
    expect(crossOwned).not.toBe('');
  });

  test('S7 AC5 - a chart saved from the analysis Editor stores the analysis id and stays in that analysis', async ({ page }) => {
    await openGallery(page, PROJECT_P, analysisX);
    await page.getByRole('tab', { name: 'Editor', exact: true }).click();
    await page.locator('select').filter({ has: page.locator('option[value="strip_v1@1.0.0"]') }).selectOption('strip_v1@1.0.0');
    const bindingSelects = page.locator('select').filter({ has: page.locator('option', { hasText: 'Select column...' }) });
    await expect(bindingSelects.first()).toBeVisible();
    const slots = await bindingSelects.count();
    for (let i = 0; i < slots; i += 1) await bindingSelects.nth(i).selectOption({ index: 1 });
    await page.getByPlaceholder('Chart title (optional)').fill(title('S7 editor'));

    const created = page.waitForResponse(
      (r) => r.url().endsWith(`/datasets/${ENT059_DATASET_ID}/candidates`) && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const response = await created;
    expect(response.ok(), await response.text()).toBeTruthy();
    const spec = (await response.json()) as Spec;
    charts.push({ id: spec.id, datasetId: ENT059_DATASET_ID });

    expect(spec.viewAnalysisId).toBe(analysisX);
    expect(ids(await list(ENT059_DATASET_ID, { viewAnalysisId: analysisX }))).toContain(spec.id);
    expect(ids(await list(ENT059_DATASET_ID, { viewAnalysisId: analysisY }))).not.toContain(spec.id);
  });
});
