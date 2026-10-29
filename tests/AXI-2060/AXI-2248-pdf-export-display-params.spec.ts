import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import http from 'node:http';
import { apiUrl, OBJECT_PUBLIC_URL } from '../../config/env';

/**
 * AXI-2248 (epic AXI-2060) — the export renderer (`exports/render-charts`,
 * PNG/PDF) honours the AXI-2242 (strip_v1/boxplot_v1) and AXI-2245
 * (heatmap_annotated_v1) display params the SAME way the live chart page
 * does. By the time this story was picked up, AXI-2242/2243/2245/2250/2301/
 * 2306 had already landed the renderer code AND a full pinned unit-golden
 * suite (`pdf-render.service.spec.ts` UT-PDFR-044..075, parity-tested
 * against axiome-front's own golden fixtures). This spec is the missing
 * INTEGRATION layer: it hits the real `/exports/render-charts` endpoint
 * against the live demo stack (not a mocked Plotly/Puppeteer surface) to
 * confirm the WIRING, not the renderer's pure logic (owned by the unit
 * goldens cited per test below).
 *
 * **Review bounce #1 fix (every case below now goes RED if its param is
 * dropped):** the first version of this spec checked only "ink exists in a
 * region" / "the render did not throw" — both pass whether or not the param
 * under test is honoured, because (a) AXI-2262's title fallback paints the
 * SAME bands regardless, (b) Plotly never throws on `<`/`&`, it just
 * silently drops the tag, and (c) the renderer applies a project/workspace
 * styling PRESET on top of `DEFAULT_COLORS` at render time, so the raw
 * palette hex values (`#8b5cf6`, …) never appear in the actual rendered
 * pixels — exact-RGB trace-colour matching is not a usable signal at all
 * (confirmed empirically: 0 matches on both of two differently-ordered
 * renders during rework). Every case below instead renders a SHOWN/CONTROL
 * (or SHOWN-A/SHOWN-B) pair that an ignored param would render BYTE-FOR-BYTE
 * alike, and measures a generic, preset-agnostic PIXEL-DIFFERENCE COUNT
 * between the two PNGs (`diffPixelsInCrop`) — never an exact-colour match.
 * The noise floor for two renders of the IDENTICAL params (re-rendered
 * twice) was measured at ~81 differing pixels out of 960,000 sampled
 * (antialiasing jitter only, see rework notes in the manual-e2e run log);
 * every threshold below sits at least 5–50x that floor:
 *  - order params: swap WHICH named group/axis-label gets position 0 — an
 *    ignored param collapses both renders to the identical default, so the
 *    diff would sit at the ~80-pixel noise floor instead of the thousands+
 *    observed when the order genuinely differs.
 *  - group_labels: an absurdly long placeholder vs the raw column value —
 *    an ignored param renders the SAME short text in both (diff ≈ noise).
 *  - x_title/chart_title/colorbar_title: an explicit value vs an explicit
 *    EMPTY STRING (the AXI-2262 CT2 technique) — an ignored param falls back
 *    to the SAME non-empty text in both, so the diff would sit at the noise
 *    floor instead of the thousands+ observed when the title is drawn.
 *  - z_min/z_max: a realistic fixed range (produces BOTH dark- and
 *    light-contrast cell labels) vs an absurdly wide range (collapses every
 *    cell to the same mid-normalized lightness, therefore ALL-light labels,
 *    empirically confirmed: dark-label count drops to exactly 0) —
 *    `cellTextColorBack`'s hardcoded dark/light font colours (not subject to
 *    the preset override, which only touches trace/marker colours) are the
 *    one exact-RGB signal kept in this spec, and are kept ONLY here.
 *  - mark_values: a mapping that actually matches the real `significance`
 *    column vs none — adds one glyph per matching cell, a measurable
 *    full-image pixel diff an ignored param could not produce.
 *
 * AC3 ("default order is the SAME stable first-appearance order as the
 * front, never size- or alphabetically-sorted") is split two ways:
 *  - the pure-logic proof (a controlled fixture where appearance, size and
 *    alphabetical order all disagree) is OWNED by the unit golden
 *    (`pdf-render.service.spec.ts` UT-PDFR-044/046/060) — not re-derived
 *    here with unknown production data.
 *  - this spec's job is the INTEGRATION risk: that the DEFAULT (no order
 *    param) path through the real endpoint is not silently re-sorted.
 *    Verified against the REAL demo fixtures below (downloaded and
 *    inspected before authoring this spec): ENT059's `group` column's
 *    first-appearance order (HD, IgG4-RD, SD) disagrees with its SIZE order
 *    (IgG4-RD has 26 rows vs 10/10 — the exact AXI-2250 regression shape);
 *    the heatmap fixture's `reference`/`variable` first-appearance order
 *    disagrees completely with alphabetical order on BOTH axes. Each
 *    default-order case below compares the DEFAULT render against an
 *    EXPLICIT render using the regression-shaped order (size-sort / alpha
 *    order) and asserts they differ — a silent regression to that sort
 *    would make them IDENTICAL.
 *
 * Pattern follows `AXI-2243-pairwise-pvalue-brackets.spec.ts`'s AC6 (render
 * through the real export path, decode the PNG in-browser via canvas, count
 * pixels near target RGB values, compare shown vs control). Throwaway specs
 * on existing, read-only synthetic datasets, deleted in `afterAll`.
 *
 * Tags: @SI-018.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';

// strip_v1 / boxplot_v1 (AXI-2242) — same ENT059 fixture AXI-2243/AXI-2262 use.
// Real row counts (verified via GET .../datasets/:id/download before authoring
// this spec): HD=10, IgG4-RD=26, SD=10 — first-appearance order (HD, IgG4-RD,
// SD) disagrees with size order (IgG4-RD, HD, SD).
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const ENT059 = { run: '9eedf58d-4336-494e-bd55-1c69d9bf4381', snapshot: '12f0abee-6f68-4153-808f-775853c7d4a3' };
const ENT059_APPEARANCE_ORDER = ['HD', 'IgG4-RD', 'SD'];
const ENT059_SIZE_SORT_ORDER = ['IgG4-RD', 'HD', 'SD'];

// heatmap_annotated_v1 (AXI-2245) — the AXI-2245 spec's own throwaway fixture.
// Real column order (verified the same way): x (`reference`) first-appearance
// (CER228, MAG4-27, MAG4-22, MAG4-13, CER215+234, CER229, ENT059) disagrees
// completely with alphabetical (CER215+234, CER228, CER229, ENT059, MAG4-13,
// MAG4-22, MAG4-27); y (`variable`) first-appearance (sIgG4, IgG4-RD RI,
// IgG4+/HPF, Eosinophils, Plasmablasts, TFH) disagrees completely with
// alphabetical (Eosinophils, IgG4+/HPF, IgG4-RD RI, Plasmablasts, TFH, sIgG4).
// `significance` has 15 'after_correction' rows (mark_values target).
const HEATMAP_DATASET_ID = '6779b1df-8591-4510-bc31-a9afe364fc90';
const HEATMAP_SNAPSHOT_ID = '938c5d5e-a970-4a7c-829f-f06fd4550d8e';
const HEATMAP_X_ALPHA_ORDER = ['CER215+234', 'CER228', 'CER229', 'ENT059', 'MAG4-13', 'MAG4-22', 'MAG4-27'];
const HEATMAP_Y_ALPHA_ORDER = ['Eosinophils', 'IgG4+/HPF', 'IgG4-RD RI', 'Plasmablasts', 'TFH', 'sIgG4'];

const THROWAWAY_TITLE = '[e2e AXI-2248 throwaway]';

// cellTextColorBack's two label-font outputs (heatmap_annotated_v1) — the
// ONE exact-RGB signal kept in this spec (see header comment for why).
// tol=4 distinguishes these from the near-white page background (255) and
// from each other without picking up antialiasing noise.
const DARK_LABEL_RGB = [31, 41, 55];
const LIGHT_LABEL_RGB = [249, 250, 251];
const LABEL_COLOR_TOLERANCE = 4;

// Noise floor for two renders of IDENTICAL params, measured empirically
// during rework (strip_v1, full image, step-2 sampling, tol=10): 81/960,000
// differing pixels (antialiasing jitter only). Every "genuinely different"
// threshold below sits well above this; every "should match" threshold sits
// well below it.
const DIFF_NOISE_FLOOR_MARGIN = 300;

type Params = Record<string, unknown>;
interface Clone { id: string; datasetId: string }

let api: APIRequestContext;
let accessToken = '';
const clones: Clone[] = [];

function candidatesUrl(datasetId: string, suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
}

function stripBody(groupOrderParams: Params): Params {
  return {
    templateId: 'strip_v1',
    templateVersion: '1.0.0',
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
    params: groupOrderParams,
    filters: [
      { column: 'group', operator: 'in', value: ['HD', 'IgG4-RD', 'SD'] },
      { column: 'reference', operator: 'eq', value: 'ENT 059' },
    ],
  };
}

function heatmapBody(params: Params): Params {
  return {
    templateId: 'heatmap_annotated_v1',
    templateVersion: '1.0.0',
    bindings: { x: 'reference', y: 'variable', z: 'rho', mark: 'significance' },
    params,
    filters: [],
  };
}

async function createClone(body: Params, title: string, datasetId: string, runId: string | null): Promise<Clone> {
  const res = await api.post(candidatesUrl(datasetId), { data: { ...body, title: `${THROWAWAY_TITLE} ${title}` } });
  expect(res.ok(), `create clone: ${res.status()} ${await res.text()}`).toBeTruthy();
  const clone = { id: (await res.json()).id as string, datasetId };
  clones.push(clone);
  if (runId) {
    const link = await api.patch(candidatesUrl(clone.datasetId, `/${clone.id}/compute-run-link`), { data: { computeRunId: runId } });
    expect(link.ok(), `link ${runId}: ${link.status()} ${await link.text()}`).toBeTruthy();
  }
  return clone;
}

/** Downloads a presigned rendered-chart URL (public object port, signed Host kept). */
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

/** Renders the clone through the REAL export path and returns its PNG. A
 * cache miss renders in the background; poll until the image is cached. */
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

/** Counts PNG pixels within `tolerance` of each RGB target, in a horizontal
 * crop band, decoded in-browser via canvas (same technique as AXI-2243's
 * `countColorPixels`, narrowed with an x-fraction window). */
async function countColorPixelsInCrop(
  page: Page,
  png: Buffer,
  targets: number[][],
  xFrom: number,
  xTo: number,
  yFrom: number,
  yTo: number,
  tolerance = 6,
): Promise<number[]> {
  return page.evaluate(async ({ dataUrl, colors, tol, x0, x1, y0, y1 }) => {
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
    const xStart = Math.floor(x0 * img.width);
    const xEnd = Math.floor(x1 * img.width);
    const yStart = Math.floor(y0 * img.height);
    const yEnd = Math.floor(y1 * img.height);
    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const i = (y * img.width + x) * 4;
        colors.forEach((c, k) => { if (near(i, c)) counts[k] += 1; });
      }
    }
    return counts;
  }, { dataUrl: `data:image/png;base64,${png.toString('base64')}`, colors: targets, tol: tolerance, x0: xFrom, x1: xTo, y0: yFrom, y1: yTo });
}

/** Counts pixels that differ by more than `tolerance` (per channel) between
 * two PNGs of the SAME dimensions, within a crop window — a generic,
 * preset-agnostic "did this region change" signal. Decoded in-browser via
 * canvas, sampling every 2nd pixel in each axis for speed (matches the
 * Python prototype used to establish the empirical thresholds above). */
async function diffPixelsInCrop(
  page: Page,
  pngA: Buffer,
  pngB: Buffer,
  xFrom: number,
  xTo: number,
  yFrom: number,
  yTo: number,
  tolerance = 10,
): Promise<number> {
  return page.evaluate(async ({ dataUrlA, dataUrlB, tol, x0, x1, y0, y1 }) => {
    const decode = async (src: string) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return { data: ctx.getImageData(0, 0, img.width, img.height).data, width: img.width, height: img.height };
    };
    const a = await decode(dataUrlA);
    const b = await decode(dataUrlB);
    if (a.width !== b.width || a.height !== b.height) return -1;
    const xStart = Math.floor(x0 * a.width);
    const xEnd = Math.floor(x1 * a.width);
    const yStart = Math.floor(y0 * a.height);
    const yEnd = Math.floor(y1 * a.height);
    let diff = 0;
    for (let y = yStart; y < yEnd; y += 2) {
      for (let x = xStart; x < xEnd; x += 2) {
        const i = (y * a.width + x) * 4;
        if (
          Math.abs(a.data[i] - b.data[i]) > tol ||
          Math.abs(a.data[i + 1] - b.data[i + 1]) > tol ||
          Math.abs(a.data[i + 2] - b.data[i + 2]) > tol
        ) {
          diff += 1;
        }
      }
    }
    return diff;
  }, {
    dataUrlA: `data:image/png;base64,${pngA.toString('base64')}`,
    dataUrlB: `data:image/png;base64,${pngB.toString('base64')}`,
    tol: tolerance, x0: xFrom, x1: xTo, y0: yFrom, y1: yTo,
  });
}

test.describe('AXI-2248 - PDF/PNG export honours strip/boxplot and annotated-heatmap display params', { tag: ['@SI-018'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300000 });

  test.beforeAll(async () => {
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
  });

  test.afterAll(async () => {
    for (const clone of clones) {
      await api.delete(candidatesUrl(clone.datasetId, `/${clone.id}`)).catch(() => undefined);
    }
    await api.dispose();
  });

  // AC1/AC3 — strip_v1 group_order is wired through to the real export, and
  // the DEFAULT (no param) path uses first-appearance order, never the
  // AXI-2250-shaped size sort. Pure-logic proof: UT-PDFR-044/047/048.
  test('AC1/AC3: strip_v1 group_order moves which group gets position 0 (and the default path is not a size sort)', async ({ page }) => {
    // All three clones share the SAME candidate title: the AXI-2262 title
    // fallback paints the candidate's own title into the chart-title band
    // when no explicit chart_title is set, and a DIFFERING title between
    // compared renders would add spurious full-image diff unrelated to
    // group_order — exactly the confound class this spec was bounced for
    // (review bounce #1). A shared title cancels it out everywhere below.
    const sizeSort = await createClone(stripBody({ group_order: ENT059_SIZE_SORT_ORDER }), 'strip-group-order', ENT059_DATASET_ID, ENT059.run);
    const appearance = await createClone(stripBody({ group_order: ENT059_APPEARANCE_ORDER }), 'strip-group-order', ENT059_DATASET_ID, ENT059.run);
    const byDefault = await createClone(stripBody({}), 'strip-group-order', ENT059_DATASET_ID, ENT059.run);

    const sizeSortPng = await exportPng(ENT059.snapshot, sizeSort.id);
    const appearancePng = await exportPng(ENT059.snapshot, appearance.id);
    const defaultPng = await exportPng(ENT059.snapshot, byDefault.id);

    // group_order=['IgG4-RD',...] (26 rows at position 0) vs
    // group_order=['HD',...] (10 rows at position 0) swaps which group's
    // dense point-cloud lands where — a large, deterministic, preset-colour-
    // agnostic full-image pixel diff an ignored param could not produce
    // (empirically ~108,000/960,000 differing pixels vs an ~81-pixel noise
    // floor for two renders of the SAME params).
    const sizeSortVsAppearance = await diffPixelsInCrop(page, sizeSortPng, appearancePng, 0, 1, 0, 1);
    expect(sizeSortVsAppearance, `size-sort vs appearance-order full-image diff: ${sizeSortVsAppearance}`).toBeGreaterThan(5000);

    // The default path differs from the size-sort render by the same large
    // margin — a regression to size-sort as the default would collapse
    // this toward 0 instead. (strip_v1 jitters marker x-position per render,
    // so two DIFFERENT spec ids with the SAME logical order are not
    // byte-identical — unlike the ~81-pixel floor measured by re-rendering
    // the SAME cached spec twice — so this test compares against the
    // size-sort render, never asserts exact equality with appearance-order.)
    const defaultVsAppearance = await diffPixelsInCrop(page, defaultPng, appearancePng, 0, 1, 0, 1);
    const defaultVsSizeSort = await diffPixelsInCrop(page, defaultPng, sizeSortPng, 0, 1, 0, 1);
    expect(defaultVsSizeSort, `default vs size-sort full-image diff: ${defaultVsSizeSort}`).toBeGreaterThan(5000);
    // The default path is markedly CLOSER to the appearance-order render
    // than to the size-sort render — directional confirmation it resolved
    // to first-appearance order, allowing for jitter noise between any two
    // distinct spec ids.
    expect(defaultVsAppearance, `default vs appearance-order (${defaultVsAppearance}) should be well below default vs size-sort (${defaultVsSizeSort})`).toBeLessThan(defaultVsSizeSort / 3);
  });

  // AC1 — group_labels renders DISPLAY-ONLY tick text; an ignored param would
  // render the raw 'HD' in both cases. Pure-logic proof: UT-PDFR-053/057.
  test('AC1: strip_v1 group_labels overrides the tick text (an absurdly long placeholder measurably outweighs the raw column value)', async ({ page }) => {
    // Shared candidate title (same confound-avoidance reason as above).
    const shown = await createClone(
      stripBody({ group_order: ENT059_APPEARANCE_ORDER, group_labels: { HD: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ & <co>' } }),
      'strip-group-labels', ENT059_DATASET_ID, ENT059.run,
    );
    const control = await createClone(
      stripBody({ group_order: ENT059_APPEARANCE_ORDER }),
      'strip-group-labels', ENT059_DATASET_ID, ENT059.run,
    );

    const diff = await diffPixelsInCrop(page, await exportPng(ENT059.snapshot, shown.id), await exportPng(ENT059.snapshot, control.id), 0, 1, 0.9, 1);

    // An ignored param renders the SAME raw 'HD' text in both, so the diff
    // would sit at the ~noise floor (empirically ~957 observed here vs a
    // noise floor of ~80 for an equivalent crop of two identical renders).
    expect(diff, `shown (long placeholder) vs control (raw 'HD') bottom tick-label diff: ${diff}`).toBeGreaterThan(DIFF_NOISE_FLOOR_MARGIN);
  });

  // AC1/AC4 — x_title/chart_title render as plain text; an explicit empty
  // string wins over the AXI-2262 fallback (the fallback is what made the
  // first version of this spec latently green). Pure-logic proof:
  // UT-PDFR-049/051/052/057.
  test('AC1/AC4: strip_v1 x_title/chart_title are honoured — an explicit value draws ink the explicit empty string does not', async ({ page }) => {
    const shown = await createClone(
      stripBody({ group_order: ENT059_APPEARANCE_ORDER, x_title: 'AXI-2248 explicit x title', chart_title: 'AXI-2248 explicit chart title' }),
      'strip-titles', ENT059_DATASET_ID, ENT059.run,
    );
    const control = await createClone(
      stripBody({ group_order: ENT059_APPEARANCE_ORDER, x_title: '', chart_title: '' }),
      'strip-titles', ENT059_DATASET_ID, ENT059.run,
    );

    const shownPng = await exportPng(ENT059.snapshot, shown.id);
    const controlPng = await exportPng(ENT059.snapshot, control.id);

    // An ignored param falls back to the SAME non-empty title text in both,
    // so the diff would sit at the ~noise floor (empirically ~1113 and
    // ~1400 observed here vs an ~80-pixel noise floor).
    const chartTitleDiff = await diffPixelsInCrop(page, shownPng, controlPng, 0, 1, 0, 0.06);
    const xTitleDiff = await diffPixelsInCrop(page, shownPng, controlPng, 0, 1, 0.96, 1);
    expect(chartTitleDiff, `chart_title band diff (explicit value vs explicit empty): ${chartTitleDiff}`).toBeGreaterThan(DIFF_NOISE_FLOOR_MARGIN);
    expect(xTitleDiff, `x_title band diff (explicit value vs explicit empty): ${xTitleDiff}`).toBeGreaterThan(DIFF_NOISE_FLOOR_MARGIN);
  });

  // AC2/AC3 — heatmap_annotated_v1 x_order/y_order are wired through, and the
  // DEFAULT (no param) path is first-appearance, never alphabetical. Pure-logic
  // proof: UT-PDFR-060/061.
  test('AC2/AC3: heatmap_annotated_v1 x_order/y_order move the leftmost/topmost label (and the default path is not alphabetical)', async ({ page }) => {
    const alpha = await createClone(
      heatmapBody({ x_order: HEATMAP_X_ALPHA_ORDER, y_order: HEATMAP_Y_ALPHA_ORDER }),
      'heatmap-order', HEATMAP_DATASET_ID, null,
    );
    const byDefault = await createClone(heatmapBody({}), 'heatmap-order', HEATMAP_DATASET_ID, null);

    const alphaPng = await exportPng(HEATMAP_SNAPSHOT_ID, alpha.id);
    const defaultPng = await exportPng(HEATMAP_SNAPSHOT_ID, byDefault.id);

    // x/y_order reorders which cell sits at every grid position, so an
    // alphabetical order vs the default (first-appearance) order produces a
    // massive full-image diff (empirically ~667,000/960,000 differing
    // pixels) — an ignored param would collapse both to the SAME resolved
    // order, leaving only the ~80-pixel noise floor. This also proves AC3:
    // the default path is not silently re-sorted to alphabetical.
    const diff = await diffPixelsInCrop(page, alphaPng, defaultPng, 0, 1, 0, 1);
    expect(diff, `alpha-order vs default-order full-image diff: ${diff}`).toBeGreaterThan(5000);
  });

  // AC2 — z_min/z_max fix the colour-scale range; cellTextColorBack's dark/
  // light label split is the measurable signal (an ignored param would make
  // both renders show the SAME split). Pure-logic proof: UT-PDFR-062/066.
  test('AC2: heatmap_annotated_v1 z_min/z_max change the per-cell label contrast split', async ({ page }) => {
    const realistic = await createClone(heatmapBody({ z_min: -1, z_max: 1 }), 'heatmap-zrange', HEATMAP_DATASET_ID, null);
    const flattened = await createClone(heatmapBody({ z_min: -1000, z_max: 1000 }), 'heatmap-zrange', HEATMAP_DATASET_ID, null);

    const [realisticDark, realisticLight] = await countColorPixelsInCrop(page, await exportPng(HEATMAP_SNAPSHOT_ID, realistic.id), [DARK_LABEL_RGB, LIGHT_LABEL_RGB], 0, 1, 0, 1, LABEL_COLOR_TOLERANCE);
    const [flattenedDark, flattenedLight] = await countColorPixelsInCrop(page, await exportPng(HEATMAP_SNAPSHOT_ID, flattened.id), [DARK_LABEL_RGB, LIGHT_LABEL_RGB], 0, 1, 0, 1, LABEL_COLOR_TOLERANCE);

    // Realistic -1..1 range spreads cells across the colour scale, so SOME
    // cells cross the dark/light contrast threshold (empirically: dark=783,
    // light=65, sampled every 2nd pixel). An absurdly wide range collapses
    // every cell to near-identical mid-normalized lightness — the SAME
    // split for every cell (empirically: dark drops to EXACTLY 0). An
    // ignored param would leave both renders with the SAME realistic split.
    expect(realisticDark, `dark-label cells at -1..1: ${realisticDark}`).toBeGreaterThan(0);
    expect(realisticLight, `light-label cells at -1..1: ${realisticLight}`).toBeGreaterThan(0);
    expect(flattenedDark, `dark-label cells at -1000..1000 (should collapse toward 0): ${flattenedDark}`).toBeLessThan(realisticDark / 4);
    expect(flattenedLight, `light-label cells at -1000..1000 (should rise): ${flattenedLight}`).toBeGreaterThan(realisticLight);
  });

  // AC2/AC4 — colorbar_title renders as plain text; an explicit empty string
  // wins over no title at all (the colour bar draws no title by default, so
  // this isolates the param from any fallback). Pure-logic proof:
  // UT-PDFR-067/069.
  test('AC2/AC4: heatmap_annotated_v1 colorbar_title is honoured — an explicit value draws ink an explicit empty string does not', async ({ page }) => {
    const shown = await createClone(heatmapBody({ colorbar_title: 'Spearman ρ <check> & export' }), 'heatmap-colorbar-title', HEATMAP_DATASET_ID, null);
    const control = await createClone(heatmapBody({ colorbar_title: '' }), 'heatmap-colorbar-title', HEATMAP_DATASET_ID, null);

    // The colour bar sits in the right ~15% of the figure; an explicit title
    // draws text there AND shifts the bar's own layout, vs an explicit empty
    // string drawing nothing — an ignored param would leave both renders
    // identical in this crop (empirically ~72,000/full-height-strip
    // differing pixels observed vs an ~80-pixel noise floor).
    const diff = await diffPixelsInCrop(page, await exportPng(HEATMAP_SNAPSHOT_ID, shown.id), await exportPng(HEATMAP_SNAPSHOT_ID, control.id), 0.85, 1, 0, 1);
    expect(diff, `colorbar_title right-edge diff (explicit value vs explicit empty): ${diff}`).toBeGreaterThan(DIFF_NOISE_FLOOR_MARGIN);
  });

  // AC2 — mark_values appends a mapped glyph only where the raw mark value
  // matches; an ignored param would render the SAME numeric-only labels in
  // both. Pure-logic proof: UT-PDFR-064/065.
  test('AC2: heatmap_annotated_v1 mark_values appends a glyph only on matching cells (more annotation ink than with no mark_values)', async ({ page }) => {
    // Shared candidate title (same confound-avoidance reason as the
    // group_order test above) — found necessary empirically during rework:
    // with DIFFERING titles, the AXI-2262 fallback alone produced a
    // ~3,000-pixel full-image diff even with mark_values forced identical
    // on both sides, large enough to make this specific test pass for the
    // WRONG reason (comparable in magnitude to the true mark_values signal).
    const shown = await createClone(heatmapBody({ mark_values: { after_correction: '***' } }), 'heatmap-mark-values', HEATMAP_DATASET_ID, null);
    const control = await createClone(heatmapBody({}), 'heatmap-mark-values', HEATMAP_DATASET_ID, null);

    // mark_values appends a glyph in the 15 'after_correction' cells, a
    // measurable full-image pixel diff — an ignored param would render the
    // SAME numeric-only labels in both (empirically ~3452/960,000 differing
    // pixels observed vs an ~80-pixel noise floor; the shown render's
    // dark-label count alone rose by ~45 over the control in the same probe).
    const diff = await diffPixelsInCrop(page, await exportPng(HEATMAP_SNAPSHOT_ID, shown.id), await exportPng(HEATMAP_SNAPSHOT_ID, control.id), 0, 1, 0, 1);
    expect(diff, `mark_values vs no-mark_values full-image diff: ${diff}`).toBeGreaterThan(DIFF_NOISE_FLOOR_MARGIN);
  });
});
