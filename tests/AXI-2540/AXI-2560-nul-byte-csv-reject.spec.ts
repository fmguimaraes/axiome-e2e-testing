import { randomUUID } from 'node:crypto';
import { test, expect, APIRequestContext, request } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2560 (epic AXI-2540 — bug fix, no new feature AC) — bio-compute's
 * `_reject_nul_bytes` (`src/pipelines/parse_materialize.py`) scans a CSV/TSV's
 * raw bytes BEFORE any polars read and raises a plain `ValueError` naming the
 * NUL byte as the cause. `pl.read_csv` otherwise parses an embedded `\x00`
 * straight into a cell's string value with no error; that value previously
 * reached organization-service's Postgres write and crashed with `22P05`
 * deep inside a downstream service, long after this pipeline had already
 * reported `completed` (found during AXI-2549 E2E). The raise propagates
 * through the EXISTING `jobs.py`/`IngestionsService.handleResult` failure
 * path (AXI-2084/AXI-2548/AXI-2549) with no downstream code change: the
 * ingestion now reaches a clean, terminal `failed` state with a readable
 * `errorMessage` naming "NUL".
 *
 * API-only, same shape as AXI-2549's sibling spec in this repo (own admin
 * login over the shared demo stack's seeded CeRAINOM-IgG4 workspace, no
 * `page`/browser context, no `setup` storageState dependency) — this fix has
 * no UI surface of its own; it feeds AXI-2548's EXISTING `failureReasonOf`
 * fallback a new message string.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const ORGANIZATION_LOGIN = { email: 'admin@cro-one.com', password: 'admin' };

const TERMINAL_POLL = { attempts: 40, intervalMs: 1500 };

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, 'X-Workspace-Id': WORKSPACE_ID };
}

let api: APIRequestContext;
let token: string;
let createdDatasetId: string | undefined;

test.beforeAll(async () => {
  api = await request.newContext();
  const login = await api.post(apiUrl('/api/v1/auth/login'), { data: ORGANIZATION_LOGIN });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).accessToken;
});

test.afterEach(async () => {
  if (!createdDatasetId) return;
  const datasetId = createdDatasetId;
  await pollUntil(
    () => ingestionsFor(datasetId),
    (list) => list.length > 0 && list.every((i) => ['ready', 'failed'].includes(i.status)),
    TERMINAL_POLL,
  );
  await api.delete(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${createdDatasetId}`), {
    headers: headers(token),
  });
  createdDatasetId = undefined;
});

test.afterAll(async () => {
  await api?.dispose();
});

async function initiateUpload(originalFilename: string, contentType: string) {
  const res = await api.post(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets`), {
    headers: headers(token),
    data: { organizationId: ORGANIZATION_ID, originalFilename, contentType },
  });
  expect(res.ok(), `initiateUpload failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { dataset: { id: string }; presignedUrl: string };
}

async function putBytes(presignedUrl: string, bytes: Buffer, contentType: string) {
  const put = await api.put(presignedUrl, { data: bytes, headers: { 'Content-Type': contentType } });
  expect(put.ok(), `S3 PUT failed: ${put.status()}`).toBeTruthy();
}

async function finalize(datasetId: string) {
  return api.patch(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/finalize`), {
    headers: headers(token),
  });
}

async function ingestionsFor(datasetId: string) {
  const res = await api.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/ingestions`), {
    headers: headers(token),
    params: { page: 1, limit: 20 },
  });
  expect(res.ok(), `list ingestions failed: ${res.status()}`).toBeTruthy();
  const body = await res.json();
  return (body.data ?? body) as Array<{
    id: string;
    status: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    createdAt: string;
  }>;
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { attempts, intervalMs }: { attempts: number; intervalMs: number },
): Promise<T | undefined> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i += 1) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

async function uploadAndFinalize(originalFilename: string, contentType: string, bytes: Buffer) {
  const upload = await initiateUpload(originalFilename, contentType);
  const datasetId = upload.dataset.id;
  createdDatasetId = datasetId;
  await putBytes(upload.presignedUrl, bytes, contentType);
  const finalized = await finalize(datasetId);
  expect(finalized.ok(), `finalize failed: ${finalized.status()}`).toBeTruthy();
  return datasetId;
}

test(
  'AC72 — §4.1 a CSV with an embedded NUL byte fails cleanly with a readable reason naming NUL @SI-021',
  async () => {
    const stamp = randomUUID().slice(0, 8);
    const csv = Buffer.from('id,label\n1,hello\x00world\n2,ok\n', 'binary');

    const datasetId = await uploadAndFinalize(`axi-2560-nul-csv-${stamp}.csv`, 'text/csv', csv);

    const settled = await pollUntil(
      () => ingestionsFor(datasetId),
      (list) => list.length > 0 && list[0].status !== 'queued' && list[0].status !== 'running',
      TERMINAL_POLL,
    );
    const ingestion = settled?.[0];
    expect(ingestion, 'expected an ingestion row to exist and reach a terminal state').toBeTruthy();

    expect(ingestion?.status).toBe('failed');
    expect(ingestion?.errorMessage ?? '').toContain('NUL');
  },
);

test(
  'AC72 — §4.2 a TSV with an embedded NUL byte fails cleanly with a readable reason naming NUL @SI-021',
  async () => {
    const stamp = randomUUID().slice(0, 8);
    const tsv = Buffer.from('gene\texpr\nTP53\t5.2\nBRCA1\x00\t3.1\n', 'binary');

    const datasetId = await uploadAndFinalize(
      `axi-2560-nul-tsv-${stamp}.tsv`,
      'text/tab-separated-values',
      tsv,
    );

    const settled = await pollUntil(
      () => ingestionsFor(datasetId),
      (list) => list.length > 0 && list[0].status !== 'queued' && list[0].status !== 'running',
      TERMINAL_POLL,
    );
    const ingestion = settled?.[0];
    expect(ingestion, 'expected an ingestion row to exist and reach a terminal state').toBeTruthy();

    expect(ingestion?.status).toBe('failed');
    expect(ingestion?.errorMessage ?? '').toContain('NUL');
  },
);

test(
  'AC72 — §5.1 a clean CSV with no NUL byte is unaffected and reaches ready (control) @SI-021',
  async () => {
    const stamp = randomUUID().slice(0, 8);
    const csv = Buffer.from('id,label\n1,hello\n2,world\n', 'utf8');

    const datasetId = await uploadAndFinalize(`axi-2560-clean-csv-${stamp}.csv`, 'text/csv', csv);

    const settled = await pollUntil(
      () => ingestionsFor(datasetId),
      (list) => list.length > 0 && list[0].status !== 'queued' && list[0].status !== 'running',
      TERMINAL_POLL,
    );
    const ingestion = settled?.[0];
    expect(ingestion, 'expected an ingestion row to exist and reach a terminal state').toBeTruthy();

    expect(ingestion?.status).toBe('ready');
  },
);
