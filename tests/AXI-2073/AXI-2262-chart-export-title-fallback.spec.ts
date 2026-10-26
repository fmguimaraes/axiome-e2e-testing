import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import http from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { apiUrl, OBJECT_PUBLIC_URL } from '../../config/env';

/**
 * AXI-2262 (follow-up of AXI-2073 O3, epic AXI-2073): the live app-export
 * chart PNG (`POST /exports/render-charts`, the "Rendered Visualizations"
 * tab's render path) now falls back to the spec's persisted `title` / the
 * grouping column's name when `params` sets no `chart_title` / `x_title` —
 * the SAME fallback the audit bundle already applied
 * (`AXI-2073-redesign-audit-bundle.spec.ts`'s O3 case). An explicit value,
 * including an explicit empty `x_title`, still wins.
 *
 * Runs against the real seeded demo project (org CeRAINOM-IgG4, workspace
 * Mag4) WITHOUT mutating any real chart: every case renders a THROWAWAY
 * clone (same dataset/analysis/bindings as AXI-2243's clones; title prefixed
 * `[e2e AXI-2262 throwaway]`), and `afterAll` deletes every clone.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const ENT059 = { run: '9eedf58d-4336-494e-bd55-1c69d9bf4381', analysis: '97b8fce5-ae0a-48a3-846d-9468a23808a7', ref: 'ENT 059', snapshot: '12f0abee-6f68-4153-808f-775853c7d4a3' };

const THROWAWAY_TITLE = '[e2e AXI-2262 throwaway]';

type Params = Record<string, unknown>;
interface Clone { id: string; datasetId: string }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
const clones: Clone[] = [];

function candidatesUrl(datasetId: string, suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
}

/** A strip chart over ENT 059 with NO `params` — nothing for the renderer to
 * read a title/x-label from except the spec's own persisted `title` and its
 * grouping binding's column name. */
function bareBody(params: Params = {}): Params {
  return {
    templateId: 'strip_v1',
    templateVersion: '1.0.0',
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
    params,
    filters: [
      { column: 'group', operator: 'in', value: ['HD', 'IgG4-RD', 'SD'] },
      { column: 'reference', operator: 'eq', value: ENT059.ref },
    ],
    viewAnalysisId: ENT059.analysis,
  };
}

async function createClone(body: Params, title: string, runId: string | null): Promise<Clone> {
  const res = await api.post(candidatesUrl(ENT059_DATASET_ID), { data: { ...body, title: `${THROWAWAY_TITLE} ${title}` } });
  expect(res.ok(), `create clone: ${res.status()} ${await res.text()}`).toBeTruthy();
  const clone = { id: (await res.json()).id as string, datasetId: ENT059_DATASET_ID };
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

test.describe('AXI-2262 - app-export chart title/x-label fallback', { tag: ['@SI-018'] }, () => {
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
    void refreshToken;
  });

  test.afterAll(async () => {
    for (const clone of clones) {
      await api.delete(candidatesUrl(clone.datasetId, `/${clone.id}`)).catch(() => undefined);
    }
    await api.dispose();
  });

  // CT1 — manual-e2e/AXI-2073-Evidence-Audit-Report.md, "Per-story E2E disposition"
  test('CT1: a params-{} spec exports with a title band (fallback: persisted spec title) and an x-label band (fallback: grouping column)', async () => {
    const clone = await createClone(bareBody(), 'fallback', ENT059.run);

    const png = await exportPng(ENT059.snapshot, clone.id);

    expect(inkInBand(png, 0, 0.06), 'title band').toBeGreaterThan(500);
    expect(inkInBand(png, 0.955, 1), 'x-label band').toBeGreaterThan(100);
  });

  // CT2 — manual-e2e/AXI-2073-Evidence-Audit-Report.md, "Per-story E2E disposition"
  test('CT2: an explicit chart_title wins, and an explicit empty x_title stays empty', async () => {
    const clone = await createClone(bareBody({ chart_title: 'Explicit title', x_title: '' }), 'explicit', ENT059.run);

    const png = await exportPng(ENT059.snapshot, clone.id);

    expect(inkInBand(png, 0, 0.06), 'explicit chart_title').toBeGreaterThan(500);
    expect(inkInBand(png, 0.955, 1), 'explicit x_title "" wins').toBe(0);
  });
});
