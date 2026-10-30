import { randomUUID } from 'node:crypto';
import { test, expect, APIRequestContext, request } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2084 — Gap G2 (epic AXI-2060, review bounce #1 fix B3): a finalize
 * that races a still-active ingestion for the SAME dataset must defer its
 * auto-ingestion instead of silently dropping the append — the stored file
 * and the latest `Ingestion` row must never permanently disagree
 * (manual-e2e AXI-2060-Microbiote-IgG4-Study-Reproduction.md §AXI-2084,
 * AC1/AC2).
 *
 * API-only. Own admin login over the shared demo stack's seeded Microbiote
 * workspace — same shape as AXI-2065/AXI-2244/AXI-2243 above (own login,
 * no dependency on the fixture-org `setup` project's storageState).
 *
 * Deterministic by a GATE, not a sleep — but review bounce #2 (B6) showed a
 * single gate BEFORE finalize #2 is not enough: ingestion #1 can still
 * finish in the gap between that check and the finalize #2 call itself
 * (observed live), which would give a false fail even against FIXED code
 * (no 409 could occur, so no `auto_ingestion_deferred` entry is written).
 * This spec therefore branches on what ACTUALLY happened AFTER finalize #2:
 * a missing `auto_ingestion_deferred` entry is a genuine failure only if
 * ingestion #1 was STILL active at that point; if #1 had already gone
 * terminal, the race this spec exists to force simply didn't occur this
 * run, and it SKIPS with a stated reason instead of asserting on a race
 * that never happened. This mirrors AXI-2064's own observed repro (gaps.md
 * G2): "both datasets ended up with one READY ingestion after two append
 * attempts" — i.e. the race window is routinely wide enough for a human
 * append script to hit it, not a microsecond window needing a test-only
 * seam to force — but still not wide enough to assert on blindly.
 *
 * AC2 asserts the NEWEST ingestion (the one created by finalize #2's
 * deferred retry, identified by id — never just "any ingestion in the list
 * is ready", which can true-but-meaninglessly pass on ingestion #1 itself
 * reaching `ready` on its own). Teardown (`afterEach`) waits for EVERY
 * ingestion for this dataset to reach a terminal state before deleting it —
 * review bounce #2 (B6) observed a live run where the retried ingestion's
 * callback arrived ~7s AFTER the dataset had already been deleted.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
// The seeded CeRAINOM-IgG4 organization owning WORKSPACE_ID — `initiateUpload`
// requires it in the request body (the gateway spreads the body first, then
// overwrites only workspaceId/caller/performedBy from server-derived values —
// AXI-1286 — so organizationId is a client-supplied field, same as every
// other dataset-upload spec in this repo, e.g. AXI-1251's `baseUpload()`).
const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const ORGANIZATION_LOGIN = { email: 'admin@cro-one.com', password: 'admin' };

// A still-queued/running ingestion is the PRECONDITION this spec's race
// depends on — poll briefly rather than sleep a fixed amount, since the
// dispatch (presigned URLs + bio-compute submitJob) is itself async.
const ACTIVE_INGESTION_POLL = { attempts: 10, intervalMs: 500 };
// Waiting for the deferred retry to reach `ready` is the OUTCOME this spec
// asserts — give it enough headroom for a real bio-compute parse of a
// 2-row CSV.
const READY_POLL = { attempts: 40, intervalMs: 1500 };
// Review bounce #2 (B6): teardown must not delete the dataset while any
// ingestion for it is still queued/running — a live run saw the retried
// ingestion's callback arrive ~7s after the dataset was already gone.
const TERMINAL_POLL = { attempts: 40, intervalMs: 1500 };

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, 'X-Workspace-Id': WORKSPACE_ID };
}

let api: APIRequestContext;
let token: string;
// The one throwaway dataset this spec creates on the shared demo stack's own
// seeded workspace — soft-deleted in afterEach, win or lose, so repeated runs
// don't accumulate test datasets in a shared resource.
let createdDatasetId: string | undefined;

test.beforeAll(async () => {
  api = await request.newContext();
  const login = await api.post(apiUrl('/api/v1/auth/login'), { data: ORGANIZATION_LOGIN });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).accessToken;
});

test.afterEach(async () => {
  if (!createdDatasetId) return;
  // Review bounce #2 (B6): never delete the dataset while an ingestion for
  // it could still deliver a callback — wait for every ingestion (however
  // many the race produced) to reach ready/failed first. Best-effort: if
  // one never settles, delete anyway rather than leaking the teardown step
  // itself and failing a later run's setup.
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

async function initiateUpload(originalFilename: string) {
  const res = await api.post(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets`), {
    headers: headers(token),
    data: { organizationId: ORGANIZATION_ID, originalFilename, contentType: 'text/csv' },
  });
  expect(res.ok(), `initiateUpload failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { dataset: { id: string }; presignedUrl: string };
}

async function putBytes(presignedUrl: string, bytes: Buffer) {
  const put = await api.put(presignedUrl, {
    data: bytes,
    headers: { 'Content-Type': 'text/csv' },
  });
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
  return (body.data ?? body) as Array<{ id: string; status: string; createdAt: string }>;
}

async function auditLogsFor(datasetId: string) {
  const res = await api.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/audit-logs`), {
    headers: headers(token),
    params: { page: 1, limit: 50 },
  });
  expect(res.ok(), `audit-logs failed: ${res.status()}`).toBeTruthy();
  const body = await res.json();
  return (body.data ?? body) as Array<{ action: string; changes: Record<string, unknown> }>;
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

test('AC1/AC2 — a finalize racing a still-active ingestion defers the auto-trigger (recorded as auto_ingestion_deferred), then the deferred append is retried once the race clears @SI-014', async () => {
  const stamp = randomUUID().slice(0, 8);
  const csvV1 = Buffer.from('gene,value\nBRCA1,1\nTP53,2\n', 'utf8');
  const csvV2 = Buffer.from('gene,value\nBRCA1,1\nTP53,2\nEGFR,3\n', 'utf8');

  // `initiateUpload` mints ONE dataset row + its OWN s3Key; an "append" is a
  // re-PUT of new bytes to the SAME presigned URL followed by a SECOND
  // finalize on the SAME dataset id (gaps.md G2's exact repro — "appending
  // the regenerated CSVs" means re-uploading over the existing object, never
  // creating a second dataset). The presigned PUT URL itself is reusable
  // within its TTL — it is a signed request, not a single-use token.
  const upload = await initiateUpload(`axi-2084-${stamp}.csv`);
  const datasetId = upload.dataset.id;
  createdDatasetId = datasetId;
  await putBytes(upload.presignedUrl, csvV1);
  const finalize1 = await finalize(datasetId);
  expect(finalize1.ok(), `first finalize failed: ${finalize1.status()}`).toBeTruthy();

  // DETERMINISM GATE (not a sleep): ingestion #1 must still be queued/running
  // when we attempt the race, or there is nothing for finalize #2 to collide
  // with and the 409 this spec exists to force cannot occur.
  const afterFirst = await pollUntil(
    () => ingestionsFor(datasetId),
    (list) => list.length > 0,
    ACTIVE_INGESTION_POLL,
  );
  const ingestion1 = afterFirst?.[0];
  test.skip(
    !ingestion1 || !['queued', 'running'].includes(ingestion1.status),
    `ingestion #1 was not queued/running when checked (status: ${ingestion1?.status ?? 'none'}) — ` +
      'bio-compute completed faster than this test could observe; the race this spec forces did not ' +
      'occur this run. Skipping rather than asserting on a 409 that could not have happened.',
  );

  // Append: re-PUT new bytes over the SAME object, then finalize the SAME
  // dataset a second time while ingestion #1 is still active — this is what
  // raced a 409 out of IngestionsService.createIngestion before the fix, and
  // was silently swallowed (gaps.md G2).
  await putBytes(upload.presignedUrl, csvV2);
  const finalize2 = await finalize(datasetId);

  // AC1: the finalize itself still reports the upload succeeded (the object
  // IS stored) — it is only the auto-ingestion refusal that must not vanish.
  expect(finalize2.ok(), `second finalize must still succeed: ${finalize2.status()}`).toBeTruthy();

  // Review bounce #2 (B6): ingestion #1 can finish in the gap between the
  // gate above and this exact point — a live run observed it. Read BOTH the
  // audit log and the current ingestion list right now, once, and branch on
  // what actually happened rather than assuming the race occurred.
  const auditLogs = await auditLogsFor(datasetId);
  const deferred = auditLogs.some((entry) => entry.action === 'auto_ingestion_deferred');
  const afterSecondFinalize = await ingestionsFor(datasetId);
  const ingestion1Now = afterSecondFinalize.find((i) => i.id === ingestion1!.id);

  test.skip(
    !deferred && (!ingestion1Now || ['ready', 'failed'].includes(ingestion1Now.status)),
    `no race occurred this run — ingestion #1 was already terminal (status: ${ingestion1Now?.status ?? 'missing'}) by ` +
      'the time finalize #2 ran, so finalize #2\'s own auto-trigger could not have hit a 409 and no ' +
      'auto_ingestion_deferred entry was expected. Skipping rather than asserting on a race that did not happen.',
  );

  expect(
    deferred,
    `expected an auto_ingestion_deferred audit entry; got actions: ${auditLogs.map((e) => e.action).join(', ')}`,
  ).toBeTruthy();

  // AC2: the deferred append is retried once the race clears — poll until
  // the NEWEST ingestion (the one the retry created, identified by id —
  // never just "any ingestion in the list is ready", which can pass on
  // ingestion #1 itself settling and prove nothing about the retry) reaches
  // `ready`, proving the stored file (the last successful finalize) and the
  // latest ingestion do not stay permanently disagreeing.
  const settled = await pollUntil(
    () => ingestionsFor(datasetId),
    (list) => list.some((i) => i.id !== ingestion1!.id && i.status === 'ready'),
    READY_POLL,
  );
  const retried = settled?.find((i) => i.id !== ingestion1!.id);
  expect(
    retried,
    `expected a second (retried) ingestion distinct from #1 (${ingestion1!.id}) for dataset ${datasetId}; got: ${JSON.stringify(settled)}`,
  ).toBeTruthy();
  expect(retried?.status).toBe('ready');
});
