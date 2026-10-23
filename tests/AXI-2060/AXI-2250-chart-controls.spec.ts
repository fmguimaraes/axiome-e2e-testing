import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2250 (epic AXI-2060) — chart controls on `/datasets/:datasetId/chart/:specId`:
 * Group Order/Labels keep a typed comma (AC1), Top Groups on a boxplot keeps
 * the largest groups (AC2), a trace's line width changes the DRAWN line (AC3).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2250. Tags: @SI-033.
 *
 * Runs against the real seeded demo project (org CeRAINOM-IgG4, workspace
 * Mag4) WITHOUT mutating it: the chart page's only write — `PATCH
 * …/candidates/:specId/params`, fired by trace-style edits — is aborted by a
 * route before it leaves the browser, and the last test proves the stored
 * params are unchanged. Every assertion reads the live input or the rendered
 * Plotly figure/SVG, never the stored spec.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const STRIP_SPEC_ID = 'baeef139-64f0-4226-aad7-fdc7969d44e4';
const BOXPLOT_SPEC_ID = '5cbe04fb-8620-424c-b5b3-7ab6e198da4f';

async function signInAdmin(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com';
  const password = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.evaluate(([org, ws]) => {
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', ws);
  }, [ORGANIZATION_ID, WORKSPACE_ID]);
}

/** Abort the page's param save so no edit here ever reaches the demo DB. */
async function blockParamSaves(page: Page) {
  await page.route('**/candidates/*/params**', (route) =>
    route.request().method() === 'GET' ? route.continue() : route.abort());
}

async function openChartVisualTab(page: Page, specId: string) {
  await signInAdmin(page);
  await blockParamSaves(page);
  await page.goto(`/datasets/${ENT059_DATASET_ID}/chart/${specId}`);
  await expect.poll(() => page.locator('.js-plotly-plot').count(), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.getByText('Visual', { exact: true }).click();
}

type FigureTrace = { type: string; name: string; yLength: number; lineWidth?: number; markerLineWidth?: number };

async function readFigure(page: Page): Promise<FigureTrace[]> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gd = document.querySelector('.js-plotly-plot') as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return gd.data.map((t: any) => ({
      type: t.type, name: t.name, yLength: Array.isArray(t.y) ? t.y.length : 0,
      lineWidth: t.line?.width, markerLineWidth: t.marker?.line?.width,
    }));
  });
}

/** The stroke-width Plotly actually DREW for a named trace's SVG paths. */
async function drawnStrokeWidth(page: Page, layer: string, path: string, traceName: string): Promise<string | null> {
  return page.evaluate(([layerSel, pathSel, name]) => {
    const groups = Array.from(document.querySelectorAll(`.js-plotly-plot ${layerSel} .trace`));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = groups.find((el) => (el as any).__data__?.[0]?.trace?.name === name);
    const drawn = g?.querySelector(pathSel) as SVGElement | null | undefined;
    return drawn ? drawn.style.strokeWidth : null;
  }, [layer, path, traceName]);
}

async function storedParams(request: APIRequestContext, specId: string): Promise<unknown> {
  const login = await request.post(apiUrl('/api/v1/auth/login'), { data: { email: 'admin@cro-one.com', password: 'admin' } });
  const { accessToken } = await login.json();
  const res = await request.get(
    apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${ENT059_DATASET_ID}/candidates/${specId}`),
    { headers: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } },
  );
  expect(res.ok()).toBe(true);
  return (await res.json()).params;
}

/** The documented rule: the topK largest groups (ties: first appearance),
 * kept in first-appearance order. */
function largestGroups(traces: FigureTrace[], topK: number): string[] {
  const bySize = [...traces].sort((a, b) => b.yLength - a.yLength).slice(0, topK).map((t) => t.name);
  return traces.map((t) => t.name).filter((n) => bySize.includes(n));
}

test.describe('AXI-2250 - chart controls: commas, Top Groups, line width', { tag: ['@SI-033'] }, () => {
  // Serial: every test drives the same live chart pages on one dev server.
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: { cookies: [], origins: [] } });

  const before: Record<string, unknown> = {};

  test.beforeAll(async ({ request }) => {
    before[STRIP_SPEC_ID] = await storedParams(request, STRIP_SPEC_ID);
    before[BOXPLOT_SPEC_ID] = await storedParams(request, BOXPLOT_SPEC_ID);
  });

  test('AC1 @SI-033 - Group Order keeps the comma after the last entry is deleted, and the next entry can be typed', async ({ page }) => {
    await openChartVisualTab(page, STRIP_SPEC_ID);
    const field = page.getByLabel('Group Order (comma-separated)');
    await expect(field).toHaveValue('HD, IgG4-RD, SD');
    await field.click();
    await field.press('End');
    await field.press('Backspace');
    await field.press('Backspace');
    await expect(field).toHaveValue('HD, IgG4-RD, ');
    await field.pressSequentially('AL');
    await expect(field).toHaveValue('HD, IgG4-RD, AL');
  });

  test('AC1 @SI-033 - Group Labels keeps a typed comma and a partial "key:" pair', async ({ page }) => {
    await openChartVisualTab(page, STRIP_SPEC_ID);
    const field = page.getByLabel('Group Labels (e.g. 0: Absent, 1: Present)');
    await field.fill('');
    await field.pressSequentially('HD: Healthy, SD:');
    await expect(field).toHaveValue('HD: Healthy, SD:');
  });

  test('AC2 @SI-033 - Top Groups 2 on a boxplot shows exactly the two largest groups', async ({ page }) => {
    await openChartVisualTab(page, BOXPLOT_SPEC_ID);
    const all = (await readFigure(page)).filter((t) => t.type === 'box');
    expect(all.length).toBeGreaterThan(2);
    const slider = page.getByLabel('Top Groups');
    await slider.fill('2');
    await expect(slider).toHaveValue('2');
    await expect.poll(async () => (await readFigure(page)).filter((t) => t.type === 'box').map((t) => t.name))
      .toEqual(largestGroups(all, 2));
  });

  test('AC3 @SI-033 - the strip median line width changes the drawn median bar', async ({ page }) => {
    await openChartVisualTab(page, STRIP_SPEC_ID);
    const control = page.getByRole('button', { name: 'HD median line width' });
    await expect(control).toHaveText('3');
    await control.click();
    await page.getByRole('spinbutton', { name: 'HD median line width' }).fill('6');
    await expect.poll(async () => (await readFigure(page)).find((t) => t.name === 'HD median')?.markerLineWidth).toBe(6);
    await expect.poll(() => drawnStrokeWidth(page, '.scatterlayer', 'path.point', 'HD median')).toBe('6px');
    await expect(page.getByRole('button', { name: 'HD line width' })).toHaveCount(0);
  });

  test('AC3 @SI-033 - a boxplot outline width changes the drawn box', async ({ page }) => {
    await openChartVisualTab(page, BOXPLOT_SPEC_ID);
    await page.getByRole('button', { name: 'HD outline width' }).click();
    await page.getByRole('spinbutton', { name: 'HD outline width' }).fill('4');
    await expect.poll(async () => (await readFigure(page)).find((t) => t.name === 'HD')?.lineWidth).toBe(4);
    await expect.poll(() => drawnStrokeWidth(page, '.boxlayer', 'path.box', 'HD')).toBe('4px');
  });

  test('no edit made by this spec reached the stored chart params', async ({ request }) => {
    expect(await storedParams(request, STRIP_SPEC_ID)).toEqual(before[STRIP_SPEC_ID]);
    expect(await storedParams(request, BOXPLOT_SPEC_ID)).toEqual(before[BOXPLOT_SPEC_ID]);
  });
});
