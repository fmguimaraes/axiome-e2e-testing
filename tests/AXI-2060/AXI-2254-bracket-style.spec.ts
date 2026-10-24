import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import http from 'node:http';
import { apiUrl, OBJECT_PUBLIC_URL } from '../../config/env';

/**
 * AXI-2254 (epic AXI-2060): the pairwise significance bracket LINE and its
 * P-label, plus the omnibus-test label, resolve through ONE style —
 * `resolveBracketStyle` (front) / its backend twin in `pdf-render.service.ts`
 * — instead of the hardcoded `#475569`/`#334155` colours. Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-Reproduction.md`
 * § AXI-2254. Tags: @SI-033.
 *
 * Pattern follows AXI-2243 (same throwaway-clone + linked-Dunn-run fixture,
 * same `readOverlay`/export-PNG-pixel-count technique) so a render fact is
 * read off the LIVE Plotly layout or the real export PNG, never off the
 * stored spec. `AC18` (defaults) / `FR35` (Stats-colour fallback) / `FR36`
 * (dedicated bracket colour/width) are asserted end to end against the real
 * running chart page AND the real export renderer.
 *
 * The one UI-driven case (AC18-ui) additionally proves the Controls →
 * Style → "Brackets" row writes the keys the resolver reads
 * (`style_bracket_color`/`style_bracket_width`) — the exact
 * double-prefix-key class of defect this story's own dev report flagged
 * (StyleDefaultsEditor bare-key vs `style_`-prefixed key).
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';

const DUNN_ENT059 = {
  run: '9eedf58d-4336-494e-bd55-1c69d9bf4381',
  analysis: '97b8fce5-ae0a-48a3-846d-9468a23808a7',
  ref: 'ENT 059',
  snapshot: '12f0abee-6f68-4153-808f-775853c7d4a3',
};

const THROWAWAY_TITLE = '[e2e AXI-2254 throwaway]';
const DEFAULT_BRACKET_COLOR = '#475569';
const DEFAULT_LABEL_COLOR = '#334155';

type Params = Record<string, unknown>;
interface Clone { id: string; datasetId: string }
interface StyleOverlay {
  bracketLines: { color?: string; width?: number }[];
  bracketLabels: { text: string; color?: string; size?: number }[];
  omnibusLabel: { text: string; color?: string; size?: number } | null;
}

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
const clones: Clone[] = [];

function candidatesUrl(datasetId: string, suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
}

function stripBody(params: Params) {
  return {
    templateId: 'strip_v1',
    templateVersion: '1.0.0',
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
    params: { x_title: 'Reference microbiota', y_title: '% microbiota opsonized', group_order: ['HD', 'IgG4-RD', 'SD'], show_median: true, ...params },
    filters: [
      { column: 'group', operator: 'in', value: ['HD', 'IgG4-RD', 'SD'] },
      { column: 'reference', operator: 'eq', value: DUNN_ENT059.ref },
    ],
    viewAnalysisId: DUNN_ENT059.analysis,
  };
}

async function createClone(params: Params, title: string): Promise<Clone> {
  const res = await api.post(candidatesUrl(ENT059_DATASET_ID), { data: { ...stripBody(params), title: `${THROWAWAY_TITLE} ${title}` } });
  expect(res.ok(), `create clone: ${res.status()} ${await res.text()}`).toBeTruthy();
  const clone = { id: (await res.json()).id as string, datasetId: ENT059_DATASET_ID };
  clones.push(clone);
  const link = await api.patch(candidatesUrl(clone.datasetId, `/${clone.id}/compute-run-link`), { data: { computeRunId: DUNN_ENT059.run } });
  expect(link.ok(), `link run: ${link.status()} ${await link.text()}`).toBeTruthy();
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

/** The chart page's live Plotly overlay, split into bracket LINE shapes vs
 * the bracket P-label and omnibus-label annotations. */
async function readStyleOverlay(page: Page): Promise<StyleOverlay | null> {
  return page.evaluate(() => {
    const gd = document.querySelector('.js-plotly-plot') as unknown as { layout?: { shapes?: unknown[]; annotations?: unknown[] } } | null;
    if (!gd?.layout) return null;
    type Shape = { x0: number; x1: number; y0: number; y1: number; line?: { color?: string; width?: number } };
    type Annotation = { text?: unknown; font?: { color?: string; size?: number } };
    const shapes = (gd.layout.shapes ?? []) as Shape[];
    const bracketLines = shapes.filter((s) => s.y0 === s.y1).map((s) => ({ color: s.line?.color, width: s.line?.width }));
    const annotations = (gd.layout.annotations ?? []) as Annotation[];
    const bracketLabels = annotations
      .filter((a) => /^(p=|ns)/.test(String(a.text ?? '')))
      .map((a) => ({ text: String(a.text), color: a.font?.color, size: a.font?.size }));
    const omnibus = annotations.find((a) => /Kruskal|Mann|Dunn/.test(String(a.text ?? '')));
    return { bracketLines, bracketLabels, omnibusLabel: omnibus ? { text: String(omnibus.text), color: omnibus.font?.color, size: omnibus.font?.size } : null };
  });
}

async function openChart(page: Page, specId: string): Promise<StyleOverlay> {
  const fetched = page.waitForResponse((r) => r.url().includes(`/candidates/${specId}/pairwise-comparison`), { timeout: 30000 });
  await page.goto(`/datasets/${ENT059_DATASET_ID}/chart/${specId}`);
  await fetched;
  // `expect.poll(fn)` only actually polls when a terminal matcher is chained
  // onto it (`.toBe(...)`/`.not.toBeNull()`) — awaiting the bare poll object
  // resolves to the matcher wrapper itself, not the polled value, which made
  // every caller's `overlay.bracketLines` throw `Cannot read properties of
  // undefined`. Capture the real result in a closured variable instead and
  // poll a plain boolean condition against it.
  let overlay: StyleOverlay | null = null;
  await expect.poll(async () => {
    overlay = await readStyleOverlay(page);
    return overlay !== null && overlay.bracketLines.length > 0;
  }, { timeout: 30000 }).toBe(true);
  return overlay as unknown as StyleOverlay;
}

/** Downloads a presigned rendered-chart URL (AXI-2243 precedent: signed for
 * the internal `minio:9000` host, fetched through the public object port
 * with the signed Host header kept). */
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

function hexToRgb(hex: string): number[] {
  const c = hex.replace('#', '');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

test.describe('AXI-2254 - statistics bracket style follows the Stats colour; dedicated bracket colour/width', { tag: ['@SI-033'] }, () => {
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

  test('AC18 - with no style_* param, the bracket line and labels render the pre-existing hardcoded defaults', async ({ page }) => {
    const clone = await createClone({}, 'AC18 defaults');
    await signIn(page);
    const overlay = await openChart(page, clone.id);
    expect(overlay.bracketLines.every((l) => l.color === DEFAULT_BRACKET_COLOR && l.width === 1.5)).toBe(true);
    expect(overlay.bracketLabels.every((l) => l.color === DEFAULT_LABEL_COLOR && l.size === 11)).toBe(true);
    expect(overlay.omnibusLabel).toBeNull(); // this clone has no omnibus run linked
  });

  test('FR35 - the Stats colour (style_annotation_color) recolors the bracket LINE and its label together', async ({ page }) => {
    const clone = await createClone({ style_annotation_color: '#112233' }, 'FR35 stats colour');
    await signIn(page);
    const overlay = await openChart(page, clone.id);
    expect(overlay.bracketLines.every((l) => l.color === '#112233')).toBe(true);
    expect(overlay.bracketLabels.every((l) => l.color === '#112233')).toBe(true);
  });

  test('FR35 - the Stats size drives the bracket label one point smaller than the omnibus label', async ({ page }) => {
    const clone = await createClone({ style_annotation_size: 20 }, 'FR35 stats size');
    await signIn(page);
    const overlay = await openChart(page, clone.id);
    expect(overlay.bracketLabels.every((l) => l.size === 19)).toBe(true);
  });

  test('FR36 - a dedicated style_bracket_color overrides the LINE only, never the labels', async ({ page }) => {
    const clone = await createClone({ style_annotation_color: '#112233', style_bracket_color: '#abcdef' }, 'FR36 bracket colour');
    await signIn(page);
    const overlay = await openChart(page, clone.id);
    expect(overlay.bracketLines.every((l) => l.color === '#abcdef')).toBe(true);
    expect(overlay.bracketLabels.every((l) => l.color === '#112233')).toBe(true);
  });

  test('FR36 - style_bracket_width overrides the drawn line width', async ({ page }) => {
    const clone = await createClone({ style_bracket_width: 4 }, 'FR36 bracket width');
    await signIn(page);
    const overlay = await openChart(page, clone.id);
    expect(overlay.bracketLines.every((l) => l.width === 4)).toBe(true);
  });

  test('export parity - the rendered PNG carries the dedicated bracket colour, not the default', async ({ page }) => {
    const styled = await createClone({ style_bracket_color: '#ff00ff' }, 'export styled');
    const control = await createClone({}, 'export control');
    await page.goto('about:blank');
    const target = hexToRgb('#ff00ff');
    const [styledCount] = await countColorPixels(page, await exportPng(DUNN_ENT059.snapshot, styled.id), [target]);
    const [controlCount] = await countColorPixels(page, await exportPng(DUNN_ENT059.snapshot, control.id), [target]);
    expect(styledCount - controlCount, `magenta bracket pixels ${styledCount} vs control ${controlCount}`).toBeGreaterThan(500);
  });

  test('AC18-ui - Controls > Style > Brackets writes style_bracket_color/style_bracket_width (not a double-prefixed key)', async ({ page }) => {
    const clone = await createClone({}, 'AC18-ui wiring');
    await signIn(page);
    const bodies: Record<string, unknown>[] = [];
    await page.route('**/candidates/*/params**', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      bodies.push(JSON.parse(route.request().postData() ?? '{}'));
      await route.abort();
    });
    await page.goto(`/datasets/${ENT059_DATASET_ID}/chart/${clone.id}`);
    await expect.poll(() => page.locator('.js-plotly-plot').count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Visual' }).click();
    // `getByRole('button', { name: 'Style' })` matches 10 elements on this
    // page (strict-mode violation) — 'Style' is common copy text. The
    // Controls panel's own Style section toggle carries a dedicated
    // data-testid (front AXI-2254 rework) for exactly this. The section
    // itself renders `defaultOpen` on the chart page (`DatasetChart.tsx`'s
    // `<StyleControls ... defaultOpen />`), so only click the toggle when the
    // Brackets row isn't visible yet — clicking it unconditionally would
    // COLLAPSE an already-open section instead of opening it.
    const bracketsRow = page.locator('div').filter({ hasText: /^Brackets$/ }).last();
    if (!(await bracketsRow.isVisible().catch(() => false))) {
      await page.getByTestId('chart-style-section-toggle').click();
    }
    await bracketsRow.getByRole('button').first().click(); // swatch opens the ColorPicker popover
    const hexInput = page.getByPlaceholder('#000000');
    await hexInput.fill('abcdef');
    await hexInput.blur();
    await page.getByRole('button', { name: 'Bracket width' }).click();
    await page.getByRole('spinbutton', { name: 'Bracket width' }).fill('3');
    await expect.poll(() => bodies.some((b) => 'params' in b && (b.params as Record<string, unknown>).style_bracket_color === '#abcdef')).toBe(true);
    await expect.poll(() => bodies.some((b) => 'params' in b && (b.params as Record<string, unknown>).style_bracket_width === 3)).toBe(true);
    expect(bodies.some((b) => JSON.stringify(b).includes('style_style_bracket'))).toBe(false);
  });
});
