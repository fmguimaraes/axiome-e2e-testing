import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import http from 'node:http';
import { apiUrl, OBJECT_PUBLIC_URL } from '../../config/env';

/**
 * AXI-2252 (epic AXI-2060): MAG4 slide 2 as ONE chart — strip_v1 faceted into
 * one panel per reference microbiota (ENT059 | CER229 | CER215 + CER234), a
 * shared y axis, per-panel group order + medians, and per-panel p-value
 * brackets read from each panel's OWN linked Dunn run.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2252. Tags: @SI-017, @SI-018, @SI-015, @SI-010, @SI-033.
 *
 * Never mutates a real chart: every spec this file creates is a THROWAWAY
 * (title prefixed `[e2e AXI-2252 throwaway]`) deleted in `afterAll`. The three
 * Dunn runs and the superseded run are only READ (linked by id).
 *
 * Every ORDER assertion reads the RENDERED page by bounding-rect position
 * (left → right), never the order of a JSON array. No case self-skips.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const ENT059_ANALYSIS_ID = '97b8fce5-ae0a-48a3-846d-9468a23808a7';
const ENT059_SNAPSHOT_ID = '12f0abee-6f68-4153-808f-775853c7d4a3';

const REFS = ['ENT 059', 'CER 229', 'CER 215 et 234'] as const;
const LABELS = { 'ENT 059': 'ENT059', 'CER 229': 'CER229', 'CER 215 et 234': 'CER215 + CER234' };
const DUNN = {
  'ENT 059': '9eedf58d-4336-494e-bd55-1c69d9bf4381',
  'CER 229': 'ed4edab3-be12-4537-820d-c009ca045f8d',
  'CER 215 et 234': '6f779e04-cca5-4f63-bcdb-35cc2bb761db',
} as const;
// Computed on the SUPERSEDED dataset 9315c385: the deliberate per-panel mismatch.
const SUPERSEDED_DUNN_RUN_ID = '88abf55f-39fd-4604-89ba-7a8247b7de29';
const UNKNOWN_RUN_ID = '00000000-0000-4000-8000-000000000000';

const THROWAWAY_TITLE = '[e2e AXI-2252 throwaway]';
const BRACKET_COLOR = '#475569';
const GROUPS = ['HD', 'IgG4-RD', 'SD'];
// Plotly names each panel's tick group after its axis: `.xtick`, `.x2tick`, `.x3tick`.
const TICK_TEXT = '.xtick text, .x2tick text, .x3tick text';

type Params = Record<string, unknown>;
interface Clone { id: string }
interface Placed { text: string; left: number }
interface Figure {
  traceAxes: string[];
  traceYAxes: string[];
  medianAxes: string[];
  layoutKeys: string[];
  yTitle: string;
  title: string;
  annotations: { text: string; xref: string }[];
  bracketRefs: string[];
  separators: number;
}

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
const clones: Clone[] = [];

function candidatesUrl(suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${DATASET_ID}/candidates${suffix}`);
}

/** The slide-2 faceted strip, exactly the create payload the lead posts. */
function facetedBody(params: Params = {}) {
  return {
    templateId: 'strip_v1',
    templateVersion: '1.0.0',
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' }, facet: { column_id: 'col_reference' } },
    params: {
      x_title: 'Reference microbiota',
      y_title: '% microbiota opsonized',
      chart_title: 'IgG4',
      group_order: GROUPS,
      show_median: true,
      facet_order: [...REFS],
      facet_labels: LABELS,
      pairwise: { reference_group: 'IgG4-RD' },
      ...params,
    },
    filters: [
      { column: 'group', operator: 'in', value: GROUPS },
      { column: 'reference', operator: 'in', value: [...REFS] },
    ],
    viewAnalysisId: ENT059_ANALYSIS_ID,
  };
}

/** The pre-existing single-reference strip shape (no facet binding). */
function unfacetedBody() {
  const body = facetedBody({ facet_order: undefined, facet_labels: undefined, chart_title: undefined });
  return {
    ...body,
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
    filters: [{ column: 'group', operator: 'in', value: GROUPS }, { column: 'reference', operator: 'eq', value: 'ENT 059' }],
  };
}

async function createClone(body: Params, title: string): Promise<Clone> {
  const res = await api.post(candidatesUrl(), { data: { ...body, title: `${THROWAWAY_TITLE} ${title}` } });
  expect(res.ok(), `create clone: ${res.status()} ${await res.text()}`).toBeTruthy();
  const clone = { id: (await res.json()).id as string };
  clones.push(clone);
  return clone;
}

function patchFacetLinks(clone: Clone, facetComputeRunIds: unknown) {
  return api.patch(candidatesUrl(`/${clone.id}/facet-compute-run-links`), { data: { facetComputeRunIds } });
}

async function linkFacets(clone: Clone, links: Record<string, string> | null) {
  const res = await patchFacetLinks(clone, links);
  expect(res.ok(), `facet links: ${res.status()} ${await res.text()}`).toBeTruthy();
}

async function comparison(clone: Clone) {
  const res = await api.get(candidatesUrl(`/${clone.id}/pairwise-comparison`));
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

/** The live Plotly figure on the chart page, reduced to what the ACs judge. */
async function readFigure(page: Page): Promise<Figure | null> {
  return page.evaluate((bracketColor) => {
    type Trace = { type?: string; xaxis?: string; yaxis?: string };
    type Ann = { text?: unknown; xref?: string };
    type Shape = { xref?: string; x0: number; x1: number; y0: number; y1: number; line?: { color?: string } };
    const gd = document.querySelector('.js-plotly-plot') as unknown as {
      data?: Trace[];
      layout?: Record<string, unknown> & { annotations?: Ann[]; shapes?: Shape[] };
    } | null;
    if (!gd?.layout || !gd.data) return null;
    const layout = gd.layout;
    const titleText = (t: unknown) => (typeof t === 'string' ? t : String((t as { text?: unknown } | undefined)?.text ?? ''));
    const shapes = layout.shapes ?? [];
    const brackets = shapes.filter((s) => s.line?.color === bracketColor && s.y0 === s.y1);
    return {
      traceAxes: gd.data.map((t) => t.xaxis ?? 'x'),
      traceYAxes: gd.data.map((t) => t.yaxis ?? 'y'),
      medianAxes: gd.data.filter((t) => t.type !== 'box').map((t) => t.xaxis ?? 'x'),
      layoutKeys: Object.keys(layout).filter((k) => /^[xy]axis\d*$/.test(k)).sort(),
      yTitle: titleText((layout.yaxis as { title?: unknown } | undefined)?.title),
      title: titleText(layout.title),
      annotations: (layout.annotations ?? []).map((a) => ({ text: String(a.text), xref: String(a.xref ?? 'x') })),
      bracketRefs: brackets.map((s) => String(s.xref ?? 'x')),
      separators: shapes.filter((s) => s.line?.color === '#cbd5e1' && s.x0 === s.x1).length,
    };
  }, BRACKET_COLOR);
}

/** Rendered SVG text nodes matching `pattern`, with their screen x (centre). */
async function placedTexts(page: Page, selector: string, pattern: RegExp): Promise<Placed[]> {
  const nodes = await page.locator(selector).evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { text: el.textContent ?? '', left: r.left + r.width / 2 };
  }));
  return nodes.filter((n) => pattern.test(n.text)).sort((a, b) => a.left - b.left);
}

async function openChart(page: Page, specId: string, linked: boolean): Promise<void> {
  const fetched = linked
    ? page.waitForResponse((r) => r.url().includes(`/candidates/${specId}/pairwise-comparison`), { timeout: 30000 })
    : Promise.resolve(null);
  await page.goto(`/datasets/${DATASET_ID}/chart/${specId}`);
  await fetched;
  await expect.poll(() => readFigure(page), { timeout: 30000 }).not.toBeNull();
}

async function figureWhen(page: Page, ready: (f: Figure) => boolean): Promise<Figure> {
  await expect.poll(async () => {
    const f = await readFigure(page);
    return f ? ready(f) : false;
  }, { timeout: 30000 }).toBe(true);
  return (await readFigure(page))!;
}

/** For a NEGATIVE assertion on a chart that asks for no comparison: once the
 * network is idle no request is in flight that could redraw it, and the
 * figure must already carry its three panel axes. */
async function settledFigure(page: Page): Promise<Figure> {
  await page.waitForLoadState('networkidle');
  return figureWhen(page, (f) => f.layoutKeys.includes('xaxis3'));
}

const pLabel = (t: string) => t === 'ns' || t.startsWith('p=');
const labelsOn = (f: Figure, xref: string) => f.annotations.filter((a) => a.xref === xref && pLabel(a.text)).map((a) => a.text);

/** Downloads a presigned rendered-chart URL through the public object port,
 * keeping the signed Host header (see AXI-2243). */
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

async function exportPng(specId: string): Promise<Buffer> {
  let url = '';
  await expect.poll(async () => {
    const res = await api.post(apiUrl('/api/v1/exports/render-charts'), { data: { snapshotId: ENT059_SNAPSHOT_ID, specIds: [specId] } });
    const chart = ((await res.json()).charts ?? []).find((c: { specId: string; cached: boolean }) => c.specId === specId && c.cached);
    url = chart?.dataUri ?? '';
    return url !== '';
  }, { timeout: 90000, intervals: [2000] }).toBe(true);
  return downloadSigned(url);
}

/** Per vertical third of the PNG, the count of pixels near `rgb`. */
async function pixelsPerThird(page: Page, png: Buffer, rgb: number[], tol = 6): Promise<number[]> {
  return page.evaluate(async ({ dataUrl, color, t }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, img.width, img.height).data;
    const thirds = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
      const near = Math.abs(px[i] - color[0]) <= t && Math.abs(px[i + 1] - color[1]) <= t && Math.abs(px[i + 2] - color[2]) <= t;
      if (near) thirds[Math.min(2, Math.floor((((i / 4) % img.width) / img.width) * 3))] += 1;
    }
    return thirds;
  }, { dataUrl: `data:image/png;base64,${png.toString('base64')}`, color: rgb, t: tol });
}

test.describe('AXI-2252 - slide 2 as one faceted strip chart', { tag: ['@SI-017', '@SI-018', '@SI-015', '@SI-010', '@SI-033'] }, () => {
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
      const res = await api.delete(candidatesUrl(`/${clone.id}`));
      expect([204, 404], `delete clone ${clone.id}`).toContain(res.status());
    }
    await api.dispose();
  });

  test('AC1/AC2/AC3/AC5 - slide 2: three panels in facet order on one y axis, per-panel group order, medians and brackets (p=0.022 | p=0.038 | ns)', async ({ page }, testInfo) => {
    const clone = await createClone(facetedBody(), 'slide 2');
    await linkFacets(clone, { ...DUNN });
    const facts = await comparison(clone);
    expect(facts.linked).toBe(false);
    expect(facts.facets).toHaveLength(3);
    for (const facet of facts.facets) expect(facet).toMatchObject({ linked: true, mismatch: false });

    await signIn(page);
    await openChart(page, clone.id, true);
    const fig = await figureWhen(page, (f) => f.bracketRefs.length === 6);

    // AC1: one panel per facet value, ONE shared y axis.
    expect(fig.layoutKeys).toEqual(['xaxis', 'xaxis2', 'xaxis3', 'yaxis']);
    expect(new Set(fig.traceYAxes)).toEqual(new Set(['y']));
    expect(fig.yTitle).toBe('% microbiota opsonized');
    expect(fig.title).toBe('IgG4');
    expect(fig.separators).toBe(2);
    const panels = await placedTexts(page, '.annotation-text', /^(ENT059|CER229|CER215 \+ CER234)$/);
    expect(panels.map((p) => p.text)).toEqual(['ENT059', 'CER229', 'CER215 + CER234']);
    expect(await placedTexts(page, '.annotation-text', /^Reference microbiota$/)).toHaveLength(1);

    // AC2: every panel shows HD | IgG4-RD | SD left → right, each with a median bar.
    const ticks = await placedTexts(page, TICK_TEXT, /^(HD|IgG4-RD|SD)$/);
    expect(ticks.map((t) => t.text)).toEqual([...GROUPS, ...GROUPS, ...GROUPS]);
    expect(fig.medianAxes.sort()).toEqual(['x', 'x', 'x', 'x2', 'x2', 'x2', 'x3', 'x3', 'x3']);
    for (const [i, panel] of panels.entries()) {
      const own = ticks.slice(i * 3, i * 3 + 3);
      expect(own[0].left < panel.left && panel.left < own[2].left, `${panel.text} label sits under its own groups`).toBe(true);
    }

    // AC3/AC5: only the two IgG4-RD brackets per panel, labelled from that panel's own run.
    expect(fig.bracketRefs.sort()).toEqual(['x', 'x', 'x2', 'x2', 'x3', 'x3']);
    expect(labelsOn(fig, 'x')).toEqual(['p=0.022', 'p=0.022']);
    expect(labelsOn(fig, 'x2')).toEqual(['p=0.038', 'p=0.038']);
    expect(labelsOn(fig, 'x3')).toEqual(['ns', 'ns']);
    const drawn = await placedTexts(page, '.annotation-text', /^(ns|p=\d)/);
    expect(drawn.map((d) => d.text)).toEqual(['p=0.022', 'p=0.022', 'p=0.038', 'p=0.038', 'ns', 'ns']);
    // AC5 evidence: the rendered chart, to set beside `slide2_Q1.png`.
    const shot = testInfo.outputPath('slide2-faceted.png');
    await page.locator('.js-plotly-plot').first().screenshot({ path: shot });
    await testInfo.attach('slide2-faceted', { path: shot, contentType: 'image/png' });
  });

  test('AC3 - a panel linked to a run on the superseded dataset is withheld with ⚠; the other panels keep their brackets', async ({ page }) => {
    const clone = await createClone(facetedBody(), 'panel mismatch');
    await linkFacets(clone, { ...DUNN, 'CER 215 et 234': SUPERSEDED_DUNN_RUN_ID });
    const facts = await comparison(clone);
    const third = facts.facets.find((f: { facetValue: string }) => f.facetValue === 'CER 215 et 234');
    expect(third).toMatchObject({ linked: true, mismatch: true, pairwise: [] });
    expect(third.mismatchReason).toBeTruthy();

    await signIn(page);
    await openChart(page, clone.id, true);
    const fig = await figureWhen(page, (f) => f.annotations.some((a) => a.text.startsWith('⚠')));
    expect(fig.annotations.filter((a) => a.text.startsWith('⚠'))).toEqual([{ text: `⚠ ${third.mismatchReason}`, xref: 'x3 domain' }]);
    expect(fig.bracketRefs.sort()).toEqual(['x', 'x', 'x2', 'x2']);
    expect(labelsOn(fig, 'x3')).toEqual([]);
    const warning = (await placedTexts(page, '.annotation-text', /^⚠/))[0];
    const panels = await placedTexts(page, '.annotation-text', /^(ENT059|CER229|CER215 \+ CER234)$/);
    expect(warning.left, 'the ⚠ note sits in the third panel').toBeGreaterThan(panels[1].left);
  });

  test('AC1 - a faceted chart with no linked runs draws its panels, no bracket, and never asks for a comparison', async ({ page }) => {
    const clone = await createClone(facetedBody(), 'no links');
    const calls: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/pairwise-comparison')) calls.push(r.url()); });
    await signIn(page);
    await openChart(page, clone.id, false);
    const fig = await settledFigure(page);
    expect(fig.layoutKeys).toEqual(['xaxis', 'xaxis2', 'xaxis3', 'yaxis']);
    expect(fig.bracketRefs).toEqual([]);
    expect(fig.annotations.some((a) => pLabel(a.text) || a.text.startsWith('⚠'))).toBe(false);
    expect(calls).toEqual([]);
  });

  test('AC1 - a strip chart WITHOUT a facet binding renders exactly as before (one axis, AXI-2243 brackets)', async ({ page }) => {
    const clone = await createClone(unfacetedBody(), 'no facet binding');
    const res = await api.patch(candidatesUrl(`/${clone.id}/compute-run-link`), { data: { computeRunId: DUNN['ENT 059'] } });
    expect(res.ok()).toBeTruthy();
    await signIn(page);
    await openChart(page, clone.id, true);
    const fig = await figureWhen(page, (f) => f.bracketRefs.length === 2);
    expect(fig.layoutKeys).toEqual(['xaxis', 'yaxis']);
    expect(new Set(fig.traceAxes)).toEqual(new Set(['x']));
    expect(fig.separators).toBe(0);
    expect(fig.annotations.filter((a) => pLabel(a.text)).map((a) => a.text)).toEqual(['p=0.022', 'p=0.022']);
    const ticks = await placedTexts(page, TICK_TEXT, /^(HD|IgG4-RD|SD)$/);
    expect(ticks.map((t) => t.text)).toEqual(GROUPS);
  });

  test('AC3 - server-side validation: the facet-link route refuses a non-faceted spec, an unknown run and a malformed map', async () => {
    const plain = await createClone(unfacetedBody(), 'validation plain');
    expect((await patchFacetLinks(plain, { 'ENT 059': DUNN['ENT 059'] })).status()).toBe(400);
    const faceted = await createClone(facetedBody(), 'validation faceted');
    expect((await patchFacetLinks(faceted, { 'ENT 059': UNKNOWN_RUN_ID })).status()).toBe(404);
    expect((await patchFacetLinks(faceted, { 'ENT 059': 'not-a-uuid' })).status()).toBe(400);
    expect((await patchFacetLinks(faceted, ['ENT 059'])).status()).toBe(400);
    const tooMany = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`ref ${i}`, DUNN['ENT 059']]));
    expect((await patchFacetLinks(faceted, tooMany)).status()).toBe(400);
    // Unlinking (null) is always allowed and clears every panel.
    await linkFacets(faceted, { ...DUNN });
    await linkFacets(faceted, null);
    const facts = await comparison(faceted);
    expect(facts.facets ?? []).toEqual([]);
  });

  test('AC4 - the exported PNG draws every panel\'s brackets inside that panel (vs a pairwise.show=false control)', async ({ page }) => {
    const shown = await createClone(facetedBody(), 'export brackets');
    await linkFacets(shown, { ...DUNN });
    const hidden = await createClone(facetedBody({ pairwise: { show: false } }), 'export control');
    await linkFacets(hidden, { ...DUNN });
    await page.goto('about:blank');
    const bracketRgb = [0x47, 0x55, 0x69];
    const withBrackets = await pixelsPerThird(page, await exportPng(shown.id), bracketRgb);
    const control = await pixelsPerThird(page, await exportPng(hidden.id), bracketRgb);
    const delta = withBrackets.map((n, i) => n - control[i]);
    expect(delta[0], `panel 1 bracket pixels ${delta}`).toBeGreaterThan(500);
    expect(delta[1], `panel 2 bracket pixels ${delta}`).toBeGreaterThan(500);
    // Panel 3 is "ns": its brackets are drawn too (the label differs, not the line).
    expect(delta[2], `panel 3 bracket pixels ${delta}`).toBeGreaterThan(500);
  });
});
