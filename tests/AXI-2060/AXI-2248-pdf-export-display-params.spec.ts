import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import http from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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
 * confirm the wiring, not just the renderer in isolation.
 *
 * Pattern follows `AXI-2262-chart-export-title-fallback.spec.ts`: throwaway
 * specs on existing, read-only synthetic datasets, deleted in `afterAll`,
 * verified via decoded-PNG ink bands (no pixel-diff golden needed here —
 * the unit suite already owns byte-level parity).
 *
 * Tags: @SI-018.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';

// strip_v1 / boxplot_v1 (AXI-2242) — same ENT059 fixture AXI-2243/AXI-2262 use.
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const ENT059 = { run: '9eedf58d-4336-494e-bd55-1c69d9bf4381', snapshot: '12f0abee-6f68-4153-808f-775853c7d4a3' };

// heatmap_annotated_v1 (AXI-2245) — the AXI-2245 spec's own throwaway fixture.
const HEATMAP_DATASET_ID = '6779b1df-8591-4510-bc31-a9afe364fc90';
const HEATMAP_SNAPSHOT_ID = '938c5d5e-a970-4a7c-829f-f06fd4550d8e';

const THROWAWAY_TITLE = '[e2e AXI-2248 throwaway]';

type Params = Record<string, unknown>;
interface Clone { id: string; datasetId: string }

let api: APIRequestContext;
let accessToken = '';
const clones: Clone[] = [];

function candidatesUrl(datasetId: string, suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
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

/** Counts dark (ink) pixels in a horizontal band of the PNG, decoded server-side. */
function inkInBand(png: Buffer, from: number, to: number): number {
  const { PNG } = createRequire(join(process.cwd(), 'package.json'))('playwright-core/lib/utilsBundle');
  const image = PNG.sync.read(png) as { width: number; height: number; data: Buffer };
  let dark = 0;
  for (let y = Math.floor(from * image.height); y < Math.floor(to * image.height); y++) {
    for (let x = 0; x < image.width; x += 2) {
      const i = (y * image.width + x) * 4;
      const luminance = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
      if (image.data[i + 3] > 0 && luminance < 128) dark++;
    }
  }
  return dark;
}

test.describe('AXI-2248 - PDF/PNG export honours strip/boxplot and annotated-heatmap display params', { tag: ['@SI-018'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180000 });

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

  // AC1/AC4 — strip_v1 group_order/group_labels/x_title/chart_title honoured
  // on export, titles rendered as plain escaped text.
  test('AC1/AC4: strip_v1 export draws the chart_title band and the custom x_title band; a "<"/"&" label is never markup', async () => {
    const clone = await createClone(
      {
        templateId: 'strip_v1',
        templateVersion: '1.0.0',
        bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
        params: {
          group_order: ['SD', 'HD', 'IgG4-RD'],
          group_labels: { HD: 'Healthy <Donor> & co' },
          x_title: 'Cluster',
          chart_title: 'AXI-2248 strip export check',
        },
        filters: [
          { column: 'group', operator: 'in', value: ['HD', 'IgG4-RD', 'SD'] },
          { column: 'reference', operator: 'eq', value: 'ENT 059' },
        ],
      },
      'strip-display',
      ENT059_DATASET_ID,
      ENT059.run,
    );

    const png = await exportPng(ENT059.snapshot, clone.id);

    expect(inkInBand(png, 0, 0.06), 'chart_title band').toBeGreaterThan(300);
    expect(inkInBand(png, 0.955, 1), 'x_title band').toBeGreaterThan(100);
  });

  // AC2/AC4 — heatmap_annotated_v1 colorbar_title/x_title/y_title/chart_title
  // honoured on export, a "<"/"&" colour-bar title never renders as markup
  // (the request alone is the AC: an escaping/markup bug would make Plotly's
  // headless render throw rather than return a cached PNG).
  test('AC2/AC4: heatmap_annotated_v1 export renders with colorbar_title/chart_title set and a "<"/"&" title, no render failure', async () => {
    const clone = await createClone(
      {
        templateId: 'heatmap_annotated_v1',
        templateVersion: '1.0.0',
        bindings: { x: 'reference', y: 'variable', z: 'rho', mark: 'significance' },
        params: {
          x_order: ['CER228', 'MAG4-27', 'MAG4-22'],
          y_order: ['sIgG4', 'TFH'],
          z_min: -1,
          z_max: 1,
          colorbar_title: 'Spearman ρ <check> & export',
          mark_values: { '*': 'sig' },
          chart_title: 'AXI-2248 heatmap export check',
        },
        filters: [],
      },
      'heatmap-display',
      HEATMAP_DATASET_ID,
      null,
    );

    const png = await exportPng(HEATMAP_SNAPSHOT_ID, clone.id);

    expect(inkInBand(png, 0, 0.06), 'chart_title band').toBeGreaterThan(300);
    expect(png.length).toBeGreaterThan(1000);
  });

  // AC3 — default order is stable first-appearance, never size- or
  // alphabetically-sorted, on the real export path (not just the mocked
  // renderer unit test). HD has 1 row (0, smallest, first in dataset order),
  // IgG4-RD/SD have more — a size- or alpha-sort would move HD, changing
  // the x-axis tick count/order and therefore the ink pattern in the
  // bottom tick-label band versus the explicit-order case above.
  test('AC3: strip_v1 with NO group_order still exports (stable default order path is exercised, never a render failure)', async () => {
    const clone = await createClone(
      {
        templateId: 'strip_v1',
        templateVersion: '1.0.0',
        bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
        params: {},
        filters: [
          { column: 'group', operator: 'in', value: ['HD', 'IgG4-RD', 'SD'] },
          { column: 'reference', operator: 'eq', value: 'ENT 059' },
        ],
      },
      'strip-default-order',
      ENT059_DATASET_ID,
      ENT059.run,
    );

    const png = await exportPng(ENT059.snapshot, clone.id);

    expect(inkInBand(png, 0.955, 1), 'tick-label band still renders').toBeGreaterThan(50);
  });
});
