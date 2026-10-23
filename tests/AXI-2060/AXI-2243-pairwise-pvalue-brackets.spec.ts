import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import http from 'node:http';
import { apiUrl, OBJECT_PUBLIC_URL } from '../../config/env';

/**
 * AXI-2243 (epic AXI-2060): pairwise p-value brackets and the omnibus-test
 * badge on group charts, read from a linked comparison run.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2243. Tags: @SI-017, @SI-018, @SI-033.
 *
 * Runs against the real seeded demo project (org CeRAINOM-IgG4, workspace
 * Mag4) WITHOUT mutating any real chart. Every case that writes (params, link)
 * does so on a THROWAWAY clone of a real chart (same template, bindings,
 * filters and analysis; title prefixed `[e2e AXI-2243 throwaway]`) and
 * `afterAll` deletes every clone. Real charts are only READ (AC8).
 *
 * Coverage (review round 2): AC1, AC2, AC3, AC4, AC5, AC7, AC8 and AC9 read the
 * live Plotly layout of the chart page (`gd.layout.shapes`/`annotations`), not
 * just API facts; AC6 renders the clone through the real export renderer
 * (`POST /exports/render-charts`), downloads the PNG and counts bracket/badge
 * pixels against a control clone. No case self-skips: a demo-data drift FAILS.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const CLUSTERS_DATASET_ID = '82e850af-49d1-4ac7-b4db-2e5622387c7e';
const CLUSTERS_CHART_SPEC_ID = '8cf56c61-9b7f-4dd3-b2fe-eddfb08dc1c0';
const PANCREATIC_CHART_SPEC_ID = 'b04d9aa2-c3d2-4771-9397-29904838cf10';
const CLUSTERS_KW_RUN_ID = '18d94771-a0d6-4d1d-b1c3-1cd82c083b13';

// Current Dunn runs, computed on the current dataset 4c1bd11e with each
// chart's exact filters (so the link is NOT a mismatch).
const DUNN = {
  ent059: { run: '9eedf58d-4336-494e-bd55-1c69d9bf4381', analysis: '97b8fce5-ae0a-48a3-846d-9468a23808a7', ref: 'ENT 059', snapshot: '12f0abee-6f68-4153-808f-775853c7d4a3' },
  cer229: { run: 'ed4edab3-be12-4537-820d-c009ca045f8d', analysis: '21a4c85f-ed24-4b35-9e03-f9c76d8814a7', ref: 'CER 229' },
  cer215: { run: '6f779e04-cca5-4f63-bcdb-35cc2bb761db', analysis: '482db621-b1f6-4288-b3b1-7a6dd833d5cd', ref: 'CER 215 et 234' },
} as const;
// The HISTORICAL Dunn run, computed on the superseded dataset 9315c385: the
// one deliberate AC4 mismatch.
const SUPERSEDED_DUNN_RUN_ID = '88abf55f-39fd-4604-89ba-7a8247b7de29';
const CLUSTERS_EXPORT_SNAPSHOT_ID = 'fa418bfe-121b-4d49-887a-f4bace62f6f5';

const THROWAWAY_TITLE = '[e2e AXI-2243 throwaway]';
const BRACKET_COLOR = '#475569';

type Params = Record<string, unknown>;
interface Clone { id: string; datasetId: string }
interface Overlay { brackets: [number, number][]; ticks: number; texts: string[] }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
const clones: Clone[] = [];

function candidatesUrl(datasetId: string, suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
}

function stripBody(ref: string, analysis: string, params: Params) {
  return {
    templateId: 'strip_v1',
    templateVersion: '1.0.0',
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
    params: { x_title: 'Reference microbiota', y_title: '% microbiota opsonized', group_order: ['HD', 'IgG4-RD', 'SD'], show_median: true, ...params },
    filters: [
      { column: 'group', operator: 'in', value: ['HD', 'IgG4-RD', 'SD'] },
      { column: 'reference', operator: 'eq', value: ref },
    ],
    viewAnalysisId: analysis,
  };
}

/** A clone of the real clusters boxplot (8cf56c61), same bindings/params. */
async function clustersBody(params: Params) {
  const real = await (await api.get(candidatesUrl(CLUSTERS_DATASET_ID, `/${CLUSTERS_CHART_SPEC_ID}`))).json();
  return {
    templateId: real.templateId,
    templateVersion: real.templateVersion,
    bindings: real.bindings,
    params: { ...real.params, ...params },
    filters: real.filters ?? [],
    viewAnalysisId: real.viewAnalysisId,
  };
}

/** Creates an UNLINKED throwaway chart (a POST carrying `computeRunId` would
 * also mint a DerivedEvidence), then links it through the story's own route. */
async function createClone(datasetId: string, body: Params, title: string, runId: string | null): Promise<Clone> {
  const res = await api.post(candidatesUrl(datasetId), { data: { ...body, title: `${THROWAWAY_TITLE} ${title}` } });
  expect(res.ok(), `create clone: ${res.status()} ${await res.text()}`).toBeTruthy();
  const clone = { id: (await res.json()).id as string, datasetId };
  clones.push(clone);
  if (runId) await linkRun(clone, runId);
  return clone;
}

async function linkRun(clone: Clone, computeRunId: string | null) {
  const res = await api.patch(candidatesUrl(clone.datasetId, `/${clone.id}/compute-run-link`), { data: { computeRunId } });
  expect(res.ok(), `link ${computeRunId}: ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function comparison(clone: Clone) {
  const res = await api.get(candidatesUrl(clone.datasetId, `/${clone.id}/pairwise-comparison`));
  expect(res.ok()).toBeTruthy();
  return res.json();
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

/** The chart page's live Plotly overlay: bracket horizontals as [x0,x1],
 * the count of vertical end ticks, and every annotation's text. */
async function readOverlay(page: Page): Promise<Overlay | null> {
  return page.evaluate((bracketColor) => {
    const gd = document.querySelector('.js-plotly-plot') as unknown as { layout?: { shapes?: unknown[]; annotations?: unknown[] } } | null;
    if (!gd?.layout) return null;
    type Shape = { x0: number; x1: number; y0: number; y1: number; line?: { color?: string } };
    const shapes = ((gd.layout.shapes ?? []) as Shape[]).filter((s) => s.line?.color === bracketColor);
    const brackets = shapes.filter((s) => s.y0 === s.y1).map((s) => [s.x0, s.x1] as [number, number]);
    const ticks = shapes.filter((s) => s.x0 === s.x1 && s.y0 !== s.y1).length;
    const texts = ((gd.layout.annotations ?? []) as { text?: unknown }[]).map((a) => String(a.text));
    return { brackets, ticks, texts };
  }, BRACKET_COLOR);
}

/** Opens the chart page and waits for the linked-run fetch (when the chart is
 * linked) and for the Plotly graph div to carry a layout. */
async function openChart(page: Page, datasetId: string, specId: string, linked: boolean): Promise<Overlay> {
  const fetched = linked
    ? page.waitForResponse((r) => r.url().includes(`/candidates/${specId}/pairwise-comparison`), { timeout: 30000 })
    : Promise.resolve(null);
  await page.goto(`/datasets/${datasetId}/chart/${specId}`);
  await fetched;
  await expect.poll(() => readOverlay(page), { timeout: 30000 }).not.toBeNull();
  return (await readOverlay(page))!;
}

/** Waits until the overlay satisfies `ready` (the annotation lands on a redraw
 * after the comparison fetch), then returns it. */
async function overlayWhen(page: Page, ready: (o: Overlay) => boolean): Promise<Overlay> {
  await expect.poll(async () => {
    const o = await readOverlay(page);
    return o ? ready(o) : false;
  }, { timeout: 30000 }).toBe(true);
  return (await readOverlay(page))!;
}

/** For a NEGATIVE assertion: lets the post-fetch redraw land before reading
 * (AC1/AC8 prove that redraw arrives well inside this window). */
async function settledOverlay(page: Page): Promise<Overlay> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  return (await readOverlay(page))!;
}

/** Downloads a presigned rendered-chart URL. The org-service signs it for its
 * INTERNAL endpoint (`minio:9000`); the request goes to the public object port
 * with the signed Host header kept, so the signature still verifies. */
function downloadSigned(url: string): Promise<Buffer> {
  const signed = new URL(url);
  const target = new URL(OBJECT_PUBLIC_URL);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: target.hostname, port: target.port, path: signed.pathname + signed.search, headers: { Host: signed.host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`GET ${res.statusCode}`))));
      },
    );
    req.on('error', reject);
  });
}

/** Renders the clone through the real export path and returns its PNG. A cache
 * miss renders in the background; poll until the image is cached. */
async function exportPng(snapshotId: string, specId: string): Promise<Buffer> {
  let url = '';
  await expect.poll(async () => {
    const res = await api.post(apiUrl('/api/v1/exports/render-charts'), { data: { snapshotId, specIds: [specId] } });
    const chart = ((await res.json()).charts ?? []).find((c: { specId: string; cached: boolean }) => c.specId === specId && c.cached);
    url = chart?.dataUri ?? '';
    return url !== '';
  }, { timeout: 90000, intervals: [2000] }).toBe(true);
  return downloadSigned(url);
}

/** Counts PNG pixels within `tolerance` of each RGB target, decoded in the
 * browser (helpers declared INSIDE the callback). */
async function countColorPixels(page: Page, png: Buffer, targets: number[][], tolerance = 6): Promise<number[]> {
  return page.evaluate(async ({ dataUrl, colors, tol }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const near = (i: number, c: number[]) =>
      Math.abs(px[i] - c[0]) <= tol && Math.abs(px[i + 1] - c[1]) <= tol && Math.abs(px[i + 2] - c[2]) <= tol;
    const counts = colors.map(() => 0);
    for (let i = 0; i < px.length; i += 4) colors.forEach((c, k) => { if (near(i, c)) counts[k] += 1; });
    return counts;
  }, { dataUrl: `data:image/png;base64,${png.toString('base64')}`, colors: targets, tol: tolerance });
}

test.describe('AXI-2243 - pairwise brackets / omnibus-test annotation', { tag: ['@SI-017', '@SI-018', '@SI-033'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180000 });

  test.beforeAll(async () => {
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
  });

  test.afterAll(async () => {
    for (const clone of clones) {
      const res = await api.delete(candidatesUrl(clone.datasetId, `/${clone.id}`));
      expect([204, 404], `delete clone ${clone.id}`).toContain(res.status());
    }
    await api.dispose();
  });

  test('AC1 - a chart linked to the current Dunn run draws adjusted-p brackets in rendered order (ENT059: p=0.022 x2, HD-SD ns)', async ({ page }) => {
    const clone = await createClone(ENT059_DATASET_ID, stripBody(DUNN.ent059.ref, DUNN.ent059.analysis, {}), 'AC1 ENT059', DUNN.ent059.run);
    const facts = await comparison(clone);
    expect(facts).toMatchObject({ linked: true, mismatch: false });
    await signIn(page);
    await openChart(page, ENT059_DATASET_ID, clone.id, true);
    const overlay = await overlayWhen(page, (o) => o.brackets.length === 3);
    // show_median strip: brackets stay on the 3 rendered categories (review round 2 defect).
    expect(overlay.brackets).toEqual([[0, 1], [1, 2], [0, 2]]);
    expect(overlay.ticks).toBe(6);
    expect(overlay.texts.filter((t) => t === 'p=0.022')).toHaveLength(2);
    expect(overlay.texts).toContain('ns');
  });

  test('AC1 - CER215+234 linked to its own Dunn run labels every pair "ns"', async ({ page }) => {
    const clone = await createClone(ENT059_DATASET_ID, stripBody(DUNN.cer215.ref, DUNN.cer215.analysis, {}), 'AC1 CER215+234', DUNN.cer215.run);
    expect(await comparison(clone)).toMatchObject({ linked: true, mismatch: false });
    await signIn(page);
    await openChart(page, ENT059_DATASET_ID, clone.id, true);
    const overlay = await overlayWhen(page, (o) => o.brackets.length === 3);
    expect(overlay.texts.filter((t) => t === 'ns')).toHaveLength(3);
    expect(overlay.texts.some((t) => t.startsWith('p='))).toBe(false);
  });

  test('AC2 - pairwise.show=false draws no bracket on a linked chart', async ({ page }) => {
    const clone = await createClone(ENT059_DATASET_ID, stripBody(DUNN.ent059.ref, DUNN.ent059.analysis, { pairwise: { show: false } }), 'AC2 hidden', DUNN.ent059.run);
    expect(await comparison(clone)).toMatchObject({ linked: true, mismatch: false });
    await signIn(page);
    await openChart(page, ENT059_DATASET_ID, clone.id, true);
    const overlay = await settledOverlay(page);
    expect(overlay.brackets).toEqual([]);
    expect(overlay.texts.some((t) => t === 'ns' || t.startsWith('p='))).toBe(false);
  });

  test('AC3 - reference_group keeps only pairs naming that group (IgG4-RD: no HD-SD bracket)', async ({ page }) => {
    const params = { pairwise: { reference_group: 'IgG4-RD' } };
    const clone = await createClone(ENT059_DATASET_ID, stripBody(DUNN.ent059.ref, DUNN.ent059.analysis, params), 'AC3 reference', DUNN.ent059.run);
    await signIn(page);
    await openChart(page, ENT059_DATASET_ID, clone.id, true);
    const overlay = await overlayWhen(page, (o) => o.brackets.length > 0);
    expect(overlay.brackets).toEqual([[0, 1], [1, 2]]);
    expect(overlay.texts.filter((t) => t === 'p=0.022')).toHaveLength(2);
    expect(overlay.texts).not.toContain('ns');
  });

  test('AC4 - a run on the superseded dataset (88abf55f) is withheld with a visible reason', async ({ page }) => {
    const clone = await createClone(ENT059_DATASET_ID, stripBody(DUNN.ent059.ref, DUNN.ent059.analysis, {}), 'AC4 mismatch', SUPERSEDED_DUNN_RUN_ID);
    const facts = await comparison(clone);
    expect(facts).toMatchObject({ linked: true, mismatch: true, pairwise: [] });
    expect(facts.mismatchReason).toBeTruthy();
    await signIn(page);
    await openChart(page, ENT059_DATASET_ID, clone.id, true);
    const overlay = await overlayWhen(page, (o) => o.texts.some((t) => t.startsWith('⚠')));
    expect(overlay.texts).toContain(`⚠ ${facts.mismatchReason}`);
    expect(overlay.brackets).toEqual([]);
  });

  test('AC5 - linking, re-linking and unlinking changes what the chart draws (CER229 p=0.038)', async ({ page }) => {
    const clone = await createClone(ENT059_DATASET_ID, stripBody(DUNN.cer229.ref, DUNN.cer229.analysis, {}), 'AC5 relink', DUNN.cer229.run);
    await signIn(page);
    await openChart(page, ENT059_DATASET_ID, clone.id, true);
    const linked = await overlayWhen(page, (o) => o.brackets.length === 3);
    expect(linked.texts.filter((t) => t === 'p=0.038')).toHaveLength(2);

    await linkRun(clone, SUPERSEDED_DUNN_RUN_ID);
    expect(await comparison(clone)).toMatchObject({ mismatch: true });
    await openChart(page, ENT059_DATASET_ID, clone.id, true);
    expect((await overlayWhen(page, (o) => o.texts.some((t) => t.startsWith('⚠')))).brackets).toEqual([]);

    await linkRun(clone, null);
    expect(await comparison(clone)).toMatchObject({ linked: false });
    await openChart(page, ENT059_DATASET_ID, clone.id, false);
    const unlinked = await settledOverlay(page);
    expect(unlinked.brackets).toEqual([]);
    expect(unlinked.texts.some((t) => t.startsWith('⚠') || t.startsWith('p='))).toBe(false);
  });

  test('AC6 - the exported PNG carries the brackets (vs a show=false control) and the omnibus badge (vs a hidden-badge control)', async ({ page }) => {
    const shown = await createClone(ENT059_DATASET_ID, stripBody(DUNN.ent059.ref, DUNN.ent059.analysis, {}), 'AC6 export brackets', DUNN.ent059.run);
    const hidden = await createClone(ENT059_DATASET_ID, stripBody(DUNN.ent059.ref, DUNN.ent059.analysis, { pairwise: { show: false } }), 'AC6 export control', DUNN.ent059.run);
    const badge = await createClone(CLUSTERS_DATASET_ID, await clustersBody({}), 'AC6 export badge', CLUSTERS_KW_RUN_ID);
    const noBadge = await createClone(CLUSTERS_DATASET_ID, await clustersBody({ test_annotation: { show: false } }), 'AC6 export badge control', CLUSTERS_KW_RUN_ID);
    await page.goto('about:blank');
    const bracketRgb = [0x47, 0x55, 0x69];
    const textRgb = [0x33, 0x41, 0x55];
    const [withBrackets] = await countColorPixels(page, await exportPng(DUNN.ent059.snapshot, shown.id), [bracketRgb]);
    const [control] = await countColorPixels(page, await exportPng(DUNN.ent059.snapshot, hidden.id), [bracketRgb]);
    expect(withBrackets - control, `bracket pixels ${withBrackets} vs control ${control}`).toBeGreaterThan(2000);
    const [withBadge] = await countColorPixels(page, await exportPng(CLUSTERS_EXPORT_SNAPSHOT_ID, badge.id), [textRgb]);
    const [badgeControl] = await countColorPixels(page, await exportPng(CLUSTERS_EXPORT_SNAPSHOT_ID, noBadge.id), [textRgb]);
    expect(withBadge - badgeControl, `badge pixels ${withBadge} vs control ${badgeControl}`).toBeGreaterThan(100);
  });

  test('AC7 - an unlinked chart draws nothing and never asks for a comparison', async ({ page }) => {
    const clone = await createClone(ENT059_DATASET_ID, stripBody(DUNN.ent059.ref, DUNN.ent059.analysis, {}), 'AC7 unlinked', null);
    const calls: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/pairwise-comparison')) calls.push(r.url()); });
    await signIn(page);
    await openChart(page, ENT059_DATASET_ID, clone.id, false);
    const overlay = await settledOverlay(page);
    expect(overlay.brackets).toEqual([]);
    expect(overlay.texts.some((t) => t.startsWith('p=') || t === 'ns' || t.startsWith('⚠'))).toBe(false);
    expect(calls).toEqual([]);
  });

  test('AC8 - the real omnibus-linked charts render "<test name> P=<p>" (read-only)', async ({ page }) => {
    await signIn(page);
    await openChart(page, CLUSTERS_DATASET_ID, CLUSTERS_CHART_SPEC_ID, true);
    await overlayWhen(page, (o) => o.texts.includes('Kruskal–Wallis P=0.182'));
    await openChart(page, CLUSTERS_DATASET_ID, PANCREATIC_CHART_SPEC_ID, true);
    await overlayWhen(page, (o) => o.texts.includes('Mann–Whitney P=0.371'));
  });

  test('AC9 - test_annotation.show=false hides the omnibus badge on a linked chart', async ({ page }) => {
    const clone = await createClone(CLUSTERS_DATASET_ID, await clustersBody({ test_annotation: { show: false } }), 'AC9 hidden badge', CLUSTERS_KW_RUN_ID);
    expect((await comparison(clone)).testAnnotation).toMatchObject({ operationId: 'stats.kruskal_wallis' });
    await signIn(page);
    await openChart(page, CLUSTERS_DATASET_ID, clone.id, true);
    const overlay = await settledOverlay(page);
    expect(overlay.texts.some((t) => t.includes('Kruskal'))).toBe(false);
  });
});
