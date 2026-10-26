import { test, expect, request as apiRequest, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2294 (epic AXI-2060): on the chart page, a FACETED strip chart's
 * Controls panel offers Panel Order (`facet_order`) and Panel Labels
 * (`facet_labels`), and every display param the Controls panel edits —
 * those two plus chart/axis titles, group order/labels and the median bar —
 * is SAVED through `PATCH …/candidates/:specId/params` (snapshot-scoped when
 * the page is opened in a snapshot), so it survives a reload. Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-Reproduction.md`
 * § AXI-2294. Tags: @SI-033.
 *
 * Self-isolating: a throwaway analysis `[e2e AXI-2294 throwaway] …` (with
 * its own snapshot) in the synthetic reproduction project `22585add`, on
 * its read-only dataset `4c1bd11e`, holding two throwaway charts created by
 * API. Never touches project 4ff39166 / analysis b00e6348 / chart 1d2c21f6
 * or project b7b274bc. `afterAll` deletes the charts and the analysis.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const PROTECTED_IDS = ['4ff39166', 'b00e6348', '1d2c21f6', 'b7b274bc'];
const DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
// The read-only heatmap summary dataset AXI-2245 renders its throwaway heatmaps on.
const HEATMAP_DATASET_ID = '6779b1df-8591-4510-bc31-a9afe364fc90';
const THROWAWAY = '[e2e AXI-2294 throwaway]';

const REFS = ['ENT 059', 'CER 229', 'CER 215 et 234'];
const GROUPS = ['HD', 'IgG4-RD', 'SD'];
const PANEL_ORDER = 'Panel Order (comma-separated)';
const PANEL_LABELS = 'Panel Labels (e.g. ENT 059: ENT059, CER 229: CER229)';
const ORDER_TEXT = 'CER 229, ENT 059, CER 215 et 234';
const LABELS_TEXT = 'ENT 059: ENT059, CER 229: CER229, CER 215 et 234: CER215 + CER234';
const LABELS_MAP = { 'ENT 059': 'ENT059', 'CER 229': 'CER229', 'CER 215 et 234': 'CER215 + CER234' };

type Params = Record<string, unknown>;
interface Figure { panels: string[]; title: string | null; yTitle: string | null; annotations: string[]; firstPanelGroups: string[] }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let analysisId = '';
let snapshotId = '';
let facetedId = '';
let plainId = '';
let boxplotId = '';
let heatmapId = '';

async function ok<T>(label: string, call: Promise<APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

function candidatesUrl(suffix = '', datasetId = DATASET_ID) {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
}

async function createChart(title: string, faceted: boolean): Promise<string> {
  const bindings: Params = { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } };
  if (faceted) bindings.facet = { column_id: 'col_reference' };
  const body = {
    templateId: 'strip_v1',
    templateVersion: '1.0.0',
    title: `${THROWAWAY} ${title}`,
    bindings,
    params: {},
    filters: [
      { column: 'group', operator: 'in', value: GROUPS },
      { column: 'reference', operator: 'in', value: REFS },
    ],
    viewAnalysisId: analysisId,
  };
  return (await ok<{ id: string }>(`create ${title}`, api.post(candidatesUrl(), { data: body }))).id;
}

async function createBoxplot(): Promise<string> {
  const body = {
    templateId: 'boxplot_v1',
    templateVersion: '1.0.0',
    title: `${THROWAWAY} boxplot`,
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
    params: {},
    filters: [{ column: 'group', operator: 'in', value: GROUPS }, { column: 'reference', operator: 'in', value: ['ENT 059'] }],
    viewAnalysisId: analysisId,
  };
  return (await ok<{ id: string }>('create boxplot', api.post(candidatesUrl(), { data: body }))).id;
}

/** Same create payload as AXI-2245's throwaway heatmap, with no display params set. */
async function createHeatmap(): Promise<string> {
  const body = {
    templateId: 'heatmap_annotated_v1',
    templateVersion: '1.0.0',
    title: `${THROWAWAY} heatmap`,
    bindings: { x: 'reference', y: 'variable', z: 'rho', mark: 'significance' },
    params: {},
  };
  return (await ok<{ id: string }>('create heatmap', api.post(candidatesUrl('', HEATMAP_DATASET_ID), { data: body }))).id;
}

async function createThrowawayAnalysis(): Promise<void> {
  const me = await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')));
  const va = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId: DATASET_ID, name: `${THROWAWAY} ${Date.now()}`, createdBy: me.id },
  }));
  analysisId = va.id;
  const snap = await ok<{ id: string }>('snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysisId, filters: [{ column: 'pct', operator: 'gte', value: -1 - Math.random() }] },
  }));
  snapshotId = snap.id;
}

async function storedParams(specId: string, datasetId = DATASET_ID): Promise<Params> {
  return (await ok<{ params: Params }>('read spec', api.get(candidatesUrl(`/${specId}`, datasetId)))).params ?? {};
}

/** The live figure's y-axis type, box `boxpoints`, heatmap x categories and annotation texts. */
async function readPlot(page: Page) {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gd = document.querySelector('.js-plotly-plot') as any;
    if (!gd?.layout) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (gd.data ?? []) as any[];
    return {
      yType: gd.layout.yaxis?.type ?? null,
      boxpoints: data.filter((t) => t.type === 'box').map((t) => t.boxpoints),
      heatmapX: (data.find((t) => t.type === 'heatmap')?.x ?? []) as string[],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      annotations: ((gd.layout.annotations ?? []) as any[]).map((a) => String(a.text ?? '')),
    };
  });
}

async function openPlain(page: Page, datasetId: string, specId: string) {
  await page.goto(`/datasets/${datasetId}/chart/${specId}`);
  await expect.poll(async () => (await readPlot(page)) !== null, { timeout: 60_000 }).toBe(true);
  await page.getByText('Visual', { exact: true }).click();
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

/** The live Plotly figure: panel labels in panel (x-axis) order, titles, annotation texts. */
async function readFigure(page: Page): Promise<Figure | null> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gd = document.querySelector('.js-plotly-plot') as any;
    if (!gd?.layout) return null;
    const strip = (t: unknown) => String(t ?? '').replace(/<\/?b>/g, '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotations = (gd.layout.annotations ?? []) as any[];
    const panels = annotations
      .map((a) => ({ m: /^x(\d*) domain$/.exec(String(a.xref ?? '')), text: strip(a.text) }))
      .filter((p) => p.m)
      .sort((a, b) => Number(a.m![1] || 1) - Number(b.m![1] || 1))
      .map((p) => p.text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstPanelGroups = (gd.layout.xaxis?.categoryarray ?? []) as string[];
    return {
      panels,
      title: gd.layout.title?.text ?? null,
      yTitle: gd.layout.yaxis?.title?.text ?? null,
      annotations: annotations.map((a) => strip(a.text)),
      firstPanelGroups: [...firstPanelGroups],
    } as Figure;
  });
}

async function traceNames(page: Page): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(() => ((document.querySelector('.js-plotly-plot') as any)?.data ?? []).map((t: any) => String(t.name ?? '')));
}

async function openChart(page: Page, specId: string, snapshot?: string) {
  const query = snapshot ? `?snapshotId=${snapshot}` : '';
  await page.goto(`/datasets/${DATASET_ID}/chart/${specId}${query}`);
  await expect.poll(async () => (await readFigure(page))?.panels.length ?? -1, { timeout: 60_000 }).toBeGreaterThanOrEqual(0);
  await page.getByText('Visual', { exact: true }).click();
  await expect(page.getByLabel('Group Order (comma-separated)')).toBeVisible({ timeout: 30_000 });
}

/** "a: b, c: d" as a sorted pair list — the map a Labels field means, independent of pair order. */
function pairs(text: string): string[] {
  return text.split(',').map((p) => p.trim()).filter(Boolean).sort();
}

function medianToggle(page: Page) {
  return page.locator('xpath=//span[normalize-space()="Show Median Bar"]/following-sibling::button');
}

test.describe('AXI-2294 - faceted chart Panel Order / Panel Labels, and Controls edits persist', { tag: ['@SI-033'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  // Signs in by token itself — no dependency on the setup project's storage state.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    for (const id of [PROJECT_ID, DATASET_ID]) expect(PROTECTED_IDS.some((p) => id.startsWith(p))).toBe(false);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
    await createThrowawayAnalysis();
    facetedId = await createChart('faceted', true);
    plainId = await createChart('unfaceted', false);
    boxplotId = await createBoxplot();
    heatmapId = await createHeatmap();
  });

  test.afterAll(async () => {
    if (!api) return;
    for (const id of [facetedId, plainId, boxplotId].filter(Boolean)) {
      const res = await api.delete(candidatesUrl(`/${id}`));
      expect([200, 204, 404], `delete chart ${id}`).toContain(res.status());
    }
    if (heatmapId) {
      const res = await api.delete(candidatesUrl(`/${heatmapId}`, HEATMAP_DATASET_ID));
      expect([200, 204, 404], `delete heatmap ${heatmapId}`).toContain(res.status());
    }
    if (analysisId) {
      const del = await api.delete(apiUrl(`/api/v1/view-analyses/${analysisId}`));
      if (!del.ok()) await api.patch(apiUrl(`/api/v1/view-analyses/${analysisId}/archive`), { data: {} });
    }
    await api.dispose();
  });

  test('AC1 @SI-033 - Panel Order / Panel Labels show only on a faceted strip chart', async ({ page }) => {
    await signIn(page);
    await openChart(page, plainId);
    await expect(page.getByLabel(PANEL_ORDER)).toHaveCount(0);
    await expect(page.getByLabel(PANEL_LABELS)).toHaveCount(0);
    await openChart(page, facetedId);
    await expect(page.getByLabel(PANEL_ORDER)).toBeVisible();
    await expect(page.getByLabel(PANEL_LABELS)).toBeVisible();
  });

  test('AC2 @SI-033 - Panel Order and Panel Labels reorder/relabel the panels and survive a reload', async ({ page }) => {
    await signIn(page);
    await openChart(page, facetedId);
    // Unset: first-appearance order (CER 215 et 234, CER 229, ENT 059 on this dataset) — not the target order.
    await expect.poll(async () => (await readFigure(page))?.panels).toEqual(['CER 215 et 234', 'CER 229', 'ENT 059']);
    await page.getByLabel(PANEL_ORDER).fill(ORDER_TEXT);
    await page.getByLabel(PANEL_LABELS).fill(LABELS_TEXT);
    const onScreen = ['CER229', 'ENT059', 'CER215 + CER234'];
    await expect.poll(async () => (await readFigure(page))?.panels).toEqual(onScreen);
    await expect.poll(() => storedParams(facetedId), { timeout: 15_000 })
      .toMatchObject({ facet_order: ['CER 229', 'ENT 059', 'CER 215 et 234'], facet_labels: LABELS_MAP });

    await page.reload();
    await page.getByText('Visual', { exact: true }).click();
    await expect(page.getByLabel(PANEL_ORDER)).toHaveValue(ORDER_TEXT);
    // Stored as a jsonb object: the pairs come back in the database's key order, not the typed order.
    await expect.poll(async () => pairs(await page.getByLabel(PANEL_LABELS).inputValue())).toEqual(pairs(LABELS_TEXT));
    await expect.poll(async () => (await readFigure(page))?.panels, { timeout: 60_000 }).toEqual(onScreen);
  });

  test('AC3 @SI-033 - Chart Title, axis titles, Group Order/Labels and Show Median Bar survive a reload', async ({ page }) => {
    await signIn(page);
    await openChart(page, facetedId);
    await page.getByLabel('Chart Title').fill('IgG4 e2e');
    await page.getByLabel('X Axis Title').fill('Reference microbiota');
    await page.getByLabel('Y Axis Title').fill('% opsonized');
    await page.getByLabel('Group Order (comma-separated)').fill('SD, IgG4-RD, HD');
    await page.getByLabel('Group Labels (e.g. 0: Absent, 1: Present)').fill('HD: Healthy');
    await medianToggle(page).click();
    await expect.poll(() => storedParams(facetedId), { timeout: 15_000 }).toMatchObject({
      chart_title: 'IgG4 e2e', x_title: 'Reference microbiota', y_title: '% opsonized',
      group_order: ['SD', 'IgG4-RD', 'HD'], group_labels: { HD: 'Healthy' }, show_median: true,
      // AC2's edits are still there — a later save never drops an earlier key.
      facet_labels: LABELS_MAP,
    });

    await page.reload();
    await page.getByText('Visual', { exact: true }).click();
    await expect(page.getByLabel('Chart Title')).toHaveValue('IgG4 e2e');
    await expect(page.getByLabel('X Axis Title')).toHaveValue('Reference microbiota');
    await expect(page.getByLabel('Y Axis Title')).toHaveValue('% opsonized');
    await expect(page.getByLabel('Group Order (comma-separated)')).toHaveValue('SD, IgG4-RD, HD');
    await expect(page.getByLabel('Group Labels (e.g. 0: Absent, 1: Present)')).toHaveValue('HD: Healthy');
    await expect.poll(async () => {
      const fig = await readFigure(page);
      return fig && { title: fig.title, yTitle: fig.yTitle, facetTitle: fig.annotations.includes('Reference microbiota'), groups: fig.firstPanelGroups };
    }, { timeout: 60_000 }).toEqual({ title: 'IgG4 e2e', yTitle: '% opsonized', facetTitle: true, groups: ['SD', 'IgG4-RD', 'HD'] });
    await expect.poll(async () => (await traceNames(page)).some((n) => / median$/.test(n))).toBe(true);
  });

  test('AC4 @SI-033 - in a snapshot, a Panel Labels edit is saved to that snapshot only', async ({ page }) => {
    await signIn(page);
    await openChart(page, facetedId, snapshotId);
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/candidates/${facetedId}/params`), { timeout: 15_000 });
    await page.getByLabel(PANEL_LABELS).fill('ENT 059: ENT059 (snapshot)');
    const response = await saved;
    expect(response.ok()).toBe(true);
    expect(`${response.url()} ${response.request().postData() ?? ''}`).toContain(snapshotId);

    await page.reload();
    await page.getByText('Visual', { exact: true }).click();
    await expect(page.getByLabel(PANEL_LABELS)).toHaveValue('ENT 059: ENT059 (snapshot)');
    await expect.poll(async () => (await readFigure(page))?.panels, { timeout: 60_000 }).toContain('ENT059 (snapshot)');
    expect((await storedParams(facetedId)).facet_labels).toEqual(LABELS_MAP);
  });

  test('AC5 @SI-033 - a boxplot Y Scale and Show Points survive a reload', async ({ page }) => {
    await signIn(page);
    await openPlain(page, DATASET_ID, boxplotId);
    await expect.poll(async () => (await readPlot(page))?.boxpoints).toEqual([false, false, false]);
    await page.getByRole('combobox').filter({ has: page.locator('option[value="log"]') }).selectOption('log');
    await page.locator('xpath=//span[normalize-space()="Show Points"]/following-sibling::button').click();
    await expect.poll(() => storedParams(boxplotId), { timeout: 15_000 }).toMatchObject({ y_scale: 'log', show_points: true });

    await page.reload();
    await page.getByText('Visual', { exact: true }).click();
    await expect(page.getByRole('combobox').filter({ has: page.locator('option[value="log"]') })).toHaveValue('log');
    await expect.poll(async () => {
      const plot = await readPlot(page);
      return plot && { yType: plot.yType, boxpoints: plot.boxpoints };
    }, { timeout: 60_000 }).toEqual({ yType: 'log', boxpoints: ['all', 'all', 'all'] });
  });

  test('AC6 @SI-033 - a heatmap X Order and Significance Marks survive a reload', async ({ page }) => {
    const xOrder = 'ENT059, CER229';
    await signIn(page);
    await openPlain(page, HEATMAP_DATASET_ID, heatmapId);
    await expect.poll(async () => (await readPlot(page))?.heatmapX.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(2);
    expect((await readPlot(page))?.annotations.some((t) => t.includes('§'))).toBe(false);
    await page.getByLabel('X Order (comma-separated)').fill(xOrder);
    await page.getByLabel('Significance Marks (e.g. after_correction: *)').fill('after_correction: §');
    await expect.poll(() => storedParams(heatmapId, HEATMAP_DATASET_ID), { timeout: 15_000 })
      .toMatchObject({ x_order: ['ENT059', 'CER229'], mark_values: { after_correction: '§' } });

    await page.reload();
    await page.getByText('Visual', { exact: true }).click();
    await expect(page.getByLabel('X Order (comma-separated)')).toHaveValue(xOrder);
    await expect(page.getByLabel('Significance Marks (e.g. after_correction: *)')).toHaveValue('after_correction: §');
    await expect.poll(async () => {
      const plot = await readPlot(page);
      return plot && { first: plot.heatmapX.slice(0, 2), marked: plot.annotations.some((t) => t.includes('§')) };
    }, { timeout: 60_000 }).toEqual({ first: ['ENT059', 'CER229'], marked: true });
  });

  test('AC7 @SI-033 - an edit followed by an immediate reload (inside the 500 ms save window) is kept', async ({ page }) => {
    await signIn(page);
    await openChart(page, facetedId);
    await page.getByLabel('Chart Title').fill('saved on pagehide');
    await page.reload();
    await expect.poll(async () => (await storedParams(facetedId)).chart_title, { timeout: 15_000 }).toBe('saved on pagehide');
    // The keepalive save may land after the reloaded page's own read — read again.
    await page.reload();
    await page.getByText('Visual', { exact: true }).click();
    await expect(page.getByLabel('Chart Title')).toHaveValue('saved on pagehide');
  });
});
