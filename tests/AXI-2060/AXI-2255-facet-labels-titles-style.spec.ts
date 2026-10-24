import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import http from 'node:http';
import { apiUrl, OBJECT_PUBLIC_URL } from '../../config/env';

/**
 * AXI-2255 (epic AXI-2060): the faceted strip chart's per-panel label
 * ("ENT059", "CER229", "CER215 + CER234") and its facet x title ("Reference
 * microbiota") follow the chart's existing "Titles" style
 * (`style_label_color`/`style_label_size`/`style_label_bold`/
 * `style_label_enabled` — the SAME params that style every axis title) and
 * must NEVER take the "Stats" style (`style_annotation_*`). Before this
 * story, `buildPlotlyConfig.ts`'s generic Stats font override applied to
 * every layout annotation not explicitly marked self-resolved, so these two
 * annotations wrongly fell into the Stats bucket (owner screenshot,
 * 2026-10-24). Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-
 * IgG4-Study-Reproduction.md` § AXI-2255. Tags: @SI-033.
 *
 * Pattern follows AXI-2252/AXI-2254 (same faceted-strip fixture, same
 * throwaway-clone pattern, same live-Plotly-layout read). Never mutates the
 * reference chart `2aefc664` or any real chart — every spec this file
 * creates is a THROWAWAY (title prefixed `[e2e AXI-2255 throwaway]`) deleted
 * in `afterAll`.
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

const THROWAWAY_TITLE = '[e2e AXI-2255 throwaway]';
const GROUPS = ['HD', 'IgG4-RD', 'SD'];
// The panel label is rendered bold via an inline `<b>...</b>` wrap (Plotly
// annotation text, not a `font.weight`) — the pattern must tolerate it.
const PANEL_LABEL_PATTERN = /^(?:<b>)?(ENT059|CER229|CER215 \+ CER234)(?:<\/b>)?$/;
const FACET_TITLE_TEXT = 'Reference microbiota';

type Params = Record<string, unknown>;
interface Clone { id: string }
interface AnnotationFont {
  text: string;
  color?: string;
  size?: number;
  weight?: string | number;
}
interface Overlay {
  panelLabels: AnnotationFont[];
  facetTitle: AnnotationFont | null;
  bracketLabels: AnnotationFont[];
}

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
const clones: Clone[] = [];

function candidatesUrl(suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${DATASET_ID}/candidates${suffix}`);
}

/** The slide-2 faceted strip, same create payload as AXI-2252. */
function facetedBody(params: Params = {}): Params {
  return {
    templateId: 'strip_v1',
    templateVersion: '1.0.0',
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' }, facet: { column_id: 'col_reference' } },
    params: {
      x_title: FACET_TITLE_TEXT,
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

async function createClone(params: Params, title: string): Promise<Clone> {
  const res = await api.post(candidatesUrl(), { data: { ...facetedBody(params), title: `${THROWAWAY_TITLE} ${title}` } });
  expect(res.ok(), `create clone: ${res.status()} ${await res.text()}`).toBeTruthy();
  const clone = { id: (await res.json()).id as string };
  clones.push(clone);
  const link = await api.patch(candidatesUrl(`/${clone.id}/facet-compute-run-links`), { data: { facetComputeRunIds: { ...DUNN } } });
  expect(link.ok(), `link facets: ${link.status()} ${await link.text()}`).toBeTruthy();
  return clone;
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

/** The chart page's live Plotly layout, split into panel labels, the facet
 * x title and the bracket P labels (the Stats-styled control group). */
async function readOverlay(page: Page): Promise<Overlay | null> {
  return page.evaluate(({ panelSrc, facetTitle }) => {
    const gd = document.querySelector('.js-plotly-plot') as unknown as { layout?: { annotations?: unknown[] } } | null;
    if (!gd?.layout) return null;
    type Annotation = { text?: unknown; font?: { color?: string; size?: number; weight?: string | number } };
    const annotations = (gd.layout.annotations ?? []) as Annotation[];
    const panelPattern = new RegExp(panelSrc);
    const panelLabels = annotations
      .filter((a) => panelPattern.test(String(a.text ?? '')))
      .map((a) => ({ text: String(a.text), color: a.font?.color, size: a.font?.size, weight: a.font?.weight }));
    const facet = annotations.find((a) => String(a.text ?? '') === facetTitle);
    const bracketLabels = annotations
      .filter((a) => /^(p=|ns)/.test(String(a.text ?? '')))
      .map((a) => ({ text: String(a.text), color: a.font?.color, size: a.font?.size, weight: a.font?.weight }));
    return {
      panelLabels,
      facetTitle: facet ? { text: String(facet.text), color: facet.font?.color, size: facet.font?.size, weight: facet.font?.weight } : null,
      bracketLabels,
    };
  }, { panelSrc: PANEL_LABEL_PATTERN.source, facetTitle: FACET_TITLE_TEXT });
}

async function openChart(page: Page, specId: string): Promise<Overlay> {
  const fetched = page.waitForResponse((r) => r.url().includes(`/candidates/${specId}/pairwise-comparison`), { timeout: 30000 });
  await page.goto(`/datasets/${DATASET_ID}/chart/${specId}`);
  await fetched;
  let overlay: Overlay | null = null;
  await expect.poll(async () => {
    overlay = await readOverlay(page);
    return overlay !== null && overlay.panelLabels.length === 3 && overlay.facetTitle !== null && overlay.bracketLabels.length > 0;
  }, { timeout: 30000 }).toBe(true);
  return overlay as unknown as Overlay;
}

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

/** AXI-2255 rework (B1): the panel label / facet x title annotations render
 * in a specific, derivable BAND of the exported PNG — never the whole image.
 * `buildFacetedLayout` (front `facetedStrip.builders.ts`) sets
 * `margin: { b: FACETED_MARGIN_BOTTOM }` (96) and both annotations sit at
 * `yref: 'paper', y: 0` (the plot area's own bottom edge) shifted further
 * down by `yshift: -40`/`-66` — i.e. entirely inside that 96px bottom
 * margin, never inside the plot area itself. The back's mirror
 * (`pdf-render.service.ts`) sets the SAME `margin.b = 96` and calls
 * `plotlyFromTemplate(..., 1200, 800, 2, ...)` with a FIXED, un-overridden
 * `(width, height, scale)` at its one export call site
 * (`export-package.service.ts`), so the exported PNG is always
 * `1200*2 x 800*2` and the bottom margin is always exactly the last
 * `EXPORT_MARGIN_BOTTOM / EXPORT_LAYOUT_HEIGHT` = 12% of the image's own
 * height — a FRACTION, so this crop is correct even if a future change
 * alters `scale` (both dimensions still scale uniformly).
 *
 * Isolating this band is what makes the assertion mean something: without
 * it, a whole-image magenta count also includes the y-axis title (native
 * Plotly `yaxis.title`, vertically centred on the PLOT area, never the
 * bottom margin) and the legend — both already reddened by
 * `style_label_color`/pre-existing style params on `main`, independent of
 * this story's panel-label/facet-title fix, which is exactly what made the
 * prior whole-image version of this test latently green (a review bounce).
 */
const EXPORT_LAYOUT_HEIGHT = 800; // `plotlyFromTemplate`'s/`plotlyToImage`'s fixed CSS height
const EXPORT_MARGIN_BOTTOM = 96; // `facetedStrip.builders.ts` / `pdf-render.service.ts` FACETED margin.b
const BOTTOM_BAND_FRACTION = EXPORT_MARGIN_BOTTOM / EXPORT_LAYOUT_HEIGHT; // 0.12 — the band the panel label/facet title live in, and ONLY that band

async function countColorPixelsInBottomBand(page: Page, png: Buffer, targets: number[][], tolerance = 6): Promise<number[]> {
  return page.evaluate(async ({ dataUrl, colors, tol, bandFraction }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const bandStartRow = Math.floor(img.height * (1 - bandFraction));
    const { data: px } = ctx.getImageData(0, bandStartRow, img.width, img.height - bandStartRow);
    const near = (i: number, c: number[]) =>
      Math.abs(px[i] - c[0]) <= tol && Math.abs(px[i + 1] - c[1]) <= tol && Math.abs(px[i + 2] - c[2]) <= tol;
    const counts = colors.map(() => 0);
    for (let i = 0; i < px.length; i += 4) colors.forEach((c, k) => { if (near(i, c)) counts[k] += 1; });
    return counts;
  }, { dataUrl: `data:image/png;base64,${png.toString('base64')}`, colors: targets, tol: tolerance, bandFraction: BOTTOM_BAND_FRACTION });
}

function hexToRgb(hex: string): number[] {
  const c = hex.replace('#', '');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

test.describe('AXI-2255 - facet panel labels and facet x title follow the Titles style, never Stats', { tag: ['@SI-033'] }, () => {
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

  test('AC19 - with no style_* param, panel labels/facet title render the pre-existing hardcoded defaults (regression floor)', async ({ page }) => {
    const clone = await createClone({}, 'AC19 defaults');
    await signIn(page);
    const overlay = await openChart(page, clone.id);
    expect(overlay.panelLabels.every((l) => l.color === undefined && l.size === 13)).toBe(true);
    expect(overlay.facetTitle).toMatchObject({ color: undefined, size: 12 });
  });

  test('AC19 - the Stats colour does NOT reach the panel labels or the facet x title', async ({ page }) => {
    const clone = await createClone({ style_annotation_color: '#ff0000' }, 'AC19 stats colour');
    await signIn(page);
    const overlay = await openChart(page, clone.id);
    expect(overlay.bracketLabels.every((l) => l.color === '#ff0000')).toBe(true);
    expect(overlay.panelLabels.some((l) => l.color === '#ff0000')).toBe(false);
    expect(overlay.facetTitle?.color).not.toBe('#ff0000');
  });

  test('AC19/FR37 - the Titles colour/size/bold DO reach the panel labels and the facet x title, the panel label one point larger', async ({ page }) => {
    // `style_label_bold: true` is deliberately NOT used here: it equals the
    // app's own BASE style default (`stylingPresets.ts`'s `label_bold: true`),
    // and `DatasetChart.tsx`'s `stripLeakedBaseDefaults` treats a DB-loaded
    // value equal to the base default as a leaked prior-session value and
    // strips it on load — a pre-existing mechanism that applies identically
    // to axis titles, unrelated to this story. `false` is NOT the base
    // default, so it survives the strip and is still an observable override
    // (`weight: 'normal'` vs the unstyled case's absent `weight`).
    const clone = await createClone({ style_label_color: '#112233', style_label_size: 10, style_label_bold: false }, 'FR37 titles style');
    await signIn(page);
    const overlay = await openChart(page, clone.id);
    expect(overlay.panelLabels.every((l) => l.color === '#112233' && l.size === 11)).toBe(true);
    expect(overlay.facetTitle).toMatchObject({ color: '#112233', size: 10 });
    const normalWeight = (w?: string | number) => w === 'normal' || w === 400;
    expect(overlay.panelLabels.every((l) => normalWeight(l.weight))).toBe(true);
    expect(normalWeight(overlay.facetTitle?.weight)).toBe(true);
  });

  test('AC19 - style_label_enabled: false blanks both; style_annotation_enabled: false leaves both unchanged', async ({ page }) => {
    const blanked = await createClone({ style_label_enabled: false }, 'FR37 labels disabled');
    await signIn(page);
    // `openChart` polls for 3 panel labels + a facet title text match, neither
    // of which exist once blanked — wait on the bracket labels instead (they
    // are unaffected by Titles) as the "chart has rendered" signal.
    const fetched = page.waitForResponse((r) => r.url().includes(`/candidates/${blanked.id}/pairwise-comparison`), { timeout: 30000 });
    await page.goto(`/datasets/${DATASET_ID}/chart/${blanked.id}`);
    await fetched;
    await expect.poll(async () => (await readOverlay(page))?.bracketLabels.length ?? 0, { timeout: 30000 }).toBeGreaterThan(0);
    const blankedAnnotations = await page.evaluate(() => {
      const gd = document.querySelector('.js-plotly-plot') as unknown as { layout?: { annotations?: { text?: unknown }[] } } | null;
      const annotations = gd?.layout?.annotations ?? [];
      return annotations.map((a) => String(a.text ?? ''));
    });
    expect(blankedAnnotations.some((t) => /^(ENT059|CER229|CER215 \+ CER234)$/.test(t))).toBe(false);
    expect(blankedAnnotations.some((t) => t === FACET_TITLE_TEXT)).toBe(false);

    const unaffected = await createClone({ style_annotation_enabled: false }, 'stats disabled');
    const overlay = await openChart(page, unaffected.id);
    expect(overlay.panelLabels).toHaveLength(3);
    expect(overlay.facetTitle?.text).toBe(FACET_TITLE_TEXT);
  });

  // AXI-2255 rework (B1 — review bounce): this assertion is REGION-ISOLATED
  // to the bottom-margin band the panel labels/facet title render in (see
  // `countColorPixelsInBottomBand`), not the whole PNG — a whole-image count
  // also picks up the native y-axis title, which `style_label_color` already
  // reddens on `main` independent of this story's fix, making a whole-image
  // delta latently green (it would pass with or without the panel-label
  // fix). The band-isolated version below would NOT: the back's mirror
  // (`pdf-render.service.ts`, pre-rework) gave the panel label/facet title
  // NEITHER style — they rendered hardcoded, untouched by `style_label_*` —
  // so on `main` (pre-merge, which is what the shared demo API at :3000
  // still serves) the styled AND control exports would both show ~0 magenta
  // pixels in this band, and `styledBand - controlBand` would be ~0, well
  // under the threshold: this test WOULD fail against `main`'s current back.
  // We do not stand up a sidecar backend to prove that number for real — the
  // Run note below hands this scenario to the lead, who will execute it
  // post-merge once the demo API itself serves the branch's back change.
  test('export parity - the exported PNG carries the Titles colour on the panel labels/facet title band, not the default, and the control band stays clean', async ({ page }) => {
    const styled = await createClone({ style_label_color: '#ff00ff' }, 'export styled');
    const control = await createClone({}, 'export control');
    await page.goto('about:blank');
    const target = hexToRgb('#ff00ff');
    const [styledBand] = await countColorPixelsInBottomBand(page, await exportPng(styled.id), [target]);
    const [controlBand] = await countColorPixelsInBottomBand(page, await exportPng(control.id), [target]);
    // The control clone sets no style_* param at all, so its bottom band
    // (panel label/facet title only — the y-axis title lives outside this
    // band) must carry ~0 magenta pixels; a nonzero count here would mean the
    // band itself is mis-isolated (catching some other magenta source).
    expect(controlBand, `control band should be clean of magenta, got ${controlBand}`).toBeLessThanOrEqual(5);
    expect(styledBand - controlBand, `magenta band pixels ${styledBand} vs control ${controlBand}`).toBeGreaterThan(50);
  });
});
