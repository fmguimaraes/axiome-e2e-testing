import { randomUUID } from 'node:crypto';
import { test, expect, APIRequestContext, request } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, type Actor } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2549 (epic AXI-2540 — FR78, EC42/EC43, AC72, D41/D42): the ingestion
 * timeout watchdog fails a stuck (queued/running past the governed N-minute
 * window) ingestion with a stated reason, and Retry re-dispatches a failed
 * ingestion as a NEW attempt that can reach `ready` — the old, watchdog-failed
 * ingestion is left exactly as it was (never cleared or overwritten, D42).
 *
 * API-only, same shape as AXI-2084's deferred-auto-ingestion spec in this
 * repo (own admin login over the shared demo stack's seeded CeRAINOM-IgG4
 * workspace, no `page`/browser context, no `setup` storageState dependency).
 *
 * PRECONDITION this spec depends on and cannot itself arrange: the target
 * stack's organization-service must run with a SHORT
 * `INGESTION_WATCHDOG_TIMEOUT_MINUTES` (manual-e2e doc's "Config" row — the
 * watchdog's N is governed/configurable, D41, never a literal, so lowering it
 * for a test stack needs no code change, only an env var). `WATCHDOG_TIMEOUT_MINUTES`
 * below reads that same value from the environment this spec runs against so
 * the poll budget tracks whatever the stack is actually configured with,
 * rather than assuming a fixed number the stack might not match.
 *
 * A stuck ingestion is produced the same way bio-compute genuinely gets one
 * stuck (the AXI-2549 motivating incident — a lost callback): an ingestion is
 * started and its callback is simply never delivered by this spec. No
 * test-only seam is reached into the service to force `running`; the spec
 * waits out the real, governed window.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const ORGANIZATION_LOGIN = { email: 'admin@cro-one.com', password: 'admin' };

// The governed window the target stack is configured with, read from the
// environment (default mirrors `INGESTION_WATCHDOG_TIMEOUT_MINUTES`'s own
// production default of 10 — set lower on a test stack to keep this spec
// fast). The scheduler's own tick cadence (every minute) adds up to ~1 extra
// minute of slack on top of the window itself.
const WATCHDOG_TIMEOUT_MINUTES = Number(process.env.AXI_2549_WATCHDOG_TIMEOUT_MINUTES ?? '1');
const WATCHDOG_POLL = {
  attempts: Math.ceil(((WATCHDOG_TIMEOUT_MINUTES + 2) * 60_000) / 5_000),
  intervalMs: 5_000,
};
const ACTIVE_INGESTION_POLL = { attempts: 10, intervalMs: 500 };
const READY_POLL = { attempts: 40, intervalMs: 1500 };
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

async function initiateUpload(originalFilename: string) {
  const res = await api.post(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets`), {
    headers: headers(token),
    data: { organizationId: ORGANIZATION_ID, originalFilename, contentType: 'text/csv' },
  });
  expect(res.ok(), `initiateUpload failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as { dataset: { id: string }; presignedUrl: string };
}

async function putBytes(presignedUrl: string, bytes: Buffer) {
  const put = await api.put(presignedUrl, { data: bytes, headers: { 'Content-Type': 'text/csv' } });
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

async function retryIngestion(datasetId: string, ingestionId: string) {
  return api.post(
    apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/ingestions/${ingestionId}/retry`),
    { headers: headers(token) },
  );
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

test(
  'AC72 — §4.1 a stuck ingestion past the governed window is failed by the watchdog, with its reason @SI-014',
  async () => {
    test.setTimeout(((WATCHDOG_TIMEOUT_MINUTES + 3) * 60_000) + 60_000);

    const stamp = randomUUID().slice(0, 8);
    const csv = Buffer.from('gene,value\nBRCA1,1\nTP53,2\n', 'utf8');

    const upload = await initiateUpload(`axi-2549-watchdog-${stamp}.csv`);
    const datasetId = upload.dataset.id;
    createdDatasetId = datasetId;
    await putBytes(upload.presignedUrl, csv);
    const finalize1 = await finalize(datasetId);
    expect(finalize1.ok(), `finalize failed: ${finalize1.status()}`).toBeTruthy();

    // Confirm the ingestion really started (queued/running) before we start
    // waiting out the watchdog window — otherwise there is nothing to time out.
    const afterFinalize = await pollUntil(
      () => ingestionsFor(datasetId),
      (list) => list.length > 0,
      ACTIVE_INGESTION_POLL,
    );
    const ingestion = afterFinalize?.[0];
    expect(ingestion, 'expected an ingestion row to exist after finalize').toBeTruthy();

    // No callback is ever delivered for this ingestion — the exact shape of
    // the motivating incident (a lost bio-compute result). Poll until the
    // watchdog's own `@Cron` tick fails it.
    const settled = await pollUntil(
      () => ingestionsFor(datasetId),
      (list) => list.some((i) => i.id === ingestion!.id && i.status !== 'queued' && i.status !== 'running'),
      WATCHDOG_POLL,
    );
    const watchdogged = settled?.find((i) => i.id === ingestion!.id);

    test.skip(
      !watchdogged || watchdogged.status === 'ready',
      `ingestion reached ${watchdogged?.status ?? 'no terminal state'} before the watchdog window elapsed — ` +
        'either bio-compute genuinely completed the 2-row CSV before the configured window (lower ' +
        'AXI_2549_WATCHDOG_TIMEOUT_MINUTES / INGESTION_WATCHDOG_TIMEOUT_MINUTES on the stack under test), ' +
        'or the watchdog scheduler is not running on this stack.',
    );

    expect(watchdogged?.status).toBe('failed');
    expect(watchdogged?.errorCode).toBe('INGESTION_TIMEOUT');
    expect(watchdogged?.errorMessage ?? '').toContain('processing did not complete');
  },
);

test(
  'AC72 — §4.2 Retry re-dispatches a failed ingestion as a new attempt that reaches ready, and never overwrites the old failed row (D42) @SI-014 @SI-010',
  async () => {
    test.setTimeout(((WATCHDOG_TIMEOUT_MINUTES + 3) * 60_000) + 90_000);

    const stamp = randomUUID().slice(0, 8);
    const csv = Buffer.from('gene,value\nBRCA1,1\nTP53,2\n', 'utf8');

    const upload = await initiateUpload(`axi-2549-retry-${stamp}.csv`);
    const datasetId = upload.dataset.id;
    createdDatasetId = datasetId;
    await putBytes(upload.presignedUrl, csv);
    const finalize1 = await finalize(datasetId);
    expect(finalize1.ok(), `finalize failed: ${finalize1.status()}`).toBeTruthy();

    const afterFinalize = await pollUntil(
      () => ingestionsFor(datasetId),
      (list) => list.length > 0,
      ACTIVE_INGESTION_POLL,
    );
    const ingestion = afterFinalize?.[0];
    expect(ingestion, 'expected an ingestion row to exist after finalize').toBeTruthy();

    // Drive it to watchdog-failed the same way §4.1 does (no callback delivered).
    const failedList = await pollUntil(
      () => ingestionsFor(datasetId),
      (list) => list.some((i) => i.id === ingestion!.id && i.status === 'failed'),
      WATCHDOG_POLL,
    );
    // Review bounce #2 fix: this must re-check `status === 'failed'` here too —
    // `pollUntil` can exhaust its budget without ever matching (e.g. bio-compute
    // genuinely completed the 2-row CSV before the watchdog window elapsed, the
    // same race §4.1 documents) and still return the LAST fetched list, which
    // contains the SAME ingestion id with a DIFFERENT (non-failed) status. Finding
    // by id alone made this call retry a `ready` ingestion and fail with a 409
    // instead of skipping.
    const failed = failedList?.find((i) => i.id === ingestion!.id && i.status === 'failed');
    test.skip(
      !failed,
      'ingestion never reached failed within the configured watchdog window on this stack — see §4.1 for the ' +
        'same precondition. Skipping the retry assertion rather than calling retry on a non-failed row.',
    );

    const retryRes = await retryIngestion(datasetId, failed!.id);
    expect(retryRes.ok(), `retry failed: ${retryRes.status()} ${await retryRes.text()}`).toBeTruthy();
    const retryBody = await retryRes.json();
    const newIngestionId: string = retryBody.id ?? retryBody.ingestion?.id;
    expect(newIngestionId, 'expected retry to return a new ingestion id').toBeTruthy();
    expect(newIngestionId).not.toBe(failed!.id);

    // The new attempt reaches ready (bio-compute genuinely parses the 2-row CSV).
    const settled = await pollUntil(
      () => ingestionsFor(datasetId),
      (list) => list.some((i) => i.id === newIngestionId && i.status === 'ready'),
      READY_POLL,
    );
    const ready = settled?.find((i) => i.id === newIngestionId);
    expect(ready?.status, `expected the retried ingestion ${newIngestionId} to reach ready`).toBe('ready');

    // D42: the OLD, watchdog-failed ingestion is untouched by the retry — still
    // failed, with its original error, never cleared or overwritten.
    const oldNow = settled?.find((i) => i.id === failed!.id);
    expect(oldNow?.status).toBe('failed');
    expect(oldNow?.errorCode).toBe('INGESTION_TIMEOUT');
  },
);

test('AC72 — §5.2 retry refuses a non-failed ingestion (409) @SI-014', async () => {
  const stamp = randomUUID().slice(0, 8);
  const csv = Buffer.from('gene,value\nBRCA1,1\nTP53,2\n', 'utf8');

  const upload = await initiateUpload(`axi-2549-retry-conflict-${stamp}.csv`);
  const datasetId = upload.dataset.id;
  createdDatasetId = datasetId;
  await putBytes(upload.presignedUrl, csv);
  const finalize1 = await finalize(datasetId);
  expect(finalize1.ok(), `finalize failed: ${finalize1.status()}`).toBeTruthy();

  // Let the ingestion reach a terminal, non-failed state (ready, in the
  // common case) before attempting a retry against it.
  const settled = await pollUntil(
    () => ingestionsFor(datasetId),
    (list) => list.length > 0 && list[0].status !== 'queued' && list[0].status !== 'running',
    READY_POLL,
  );
  const ingestion = settled?.[0];
  test.skip(!ingestion, 'ingestion never left queued/running within the poll budget on this stack');
  test.skip(
    ingestion!.status === 'failed',
    'ingestion reached failed rather than ready — this test needs a non-failed terminal state to exercise ' +
      'the 409; §4.1/§4.2 already cover the failed-ingestion retry paths.',
  );

  const retryRes = await retryIngestion(datasetId, ingestion!.id);
  expect(retryRes.status()).toBe(409);
});

/**
 * §5.3 — retry authorization: 403 for no permission, 404 for another tenant
 * or for an ingestion under a dataset the caller was not authorized against
 * (review bounce #1, B2/B3). Self-provisioned fixture world (AXI-2267's
 * `PrivateProjectsWorld`) — a throwaway workspace with exactly the members
 * this block creates, never the shared demo stack's seeded workspace, since
 * these cases need a sub-Editor actor holding `dataset:upload` on their OWN
 * upload only (the `ownRowOnly` policy branch `DatasetUploadActGuard` never
 * reaches for a team-tier Editor+).
 */
test.describe('§5.3 — retry authorization @SI-014 @SI-010', () => {
  const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';

  async function worldInitiateUpload(
    world: PrivateProjectsWorld,
    actor: Actor,
    originalFilename: string,
  ) {
    const res = await actor.api.post(apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`), {
      data: { organizationId: world.orgId, originalFilename, contentType: 'text/csv' },
    });
    expect(res.ok(), `initiateUpload failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()) as { dataset: { id: string }; presignedUrl: string };
  }

  async function worldFinalize(world: PrivateProjectsWorld, actor: Actor, datasetId: string) {
    return actor.api.patch(
      apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${datasetId}/finalize`),
    );
  }

  async function worldIngestionsFor(world: PrivateProjectsWorld, actor: Actor, datasetId: string) {
    const res = await actor.api.get(
      apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${datasetId}/ingestions`),
      { params: { page: 1, limit: 20 } },
    );
    expect(res.ok(), `list ingestions failed: ${res.status()}`).toBeTruthy();
    const body = await res.json();
    return (body.data ?? body) as Array<{ id: string; status: string }>;
  }

  function worldRetry(world: PrivateProjectsWorld, actor: Actor, datasetId: string, ingestionId: string) {
    return actor.api.post(
      apiUrl(
        `/api/v1/workspaces/${world.workspaceId}/datasets/${datasetId}/ingestions/${ingestionId}/retry`,
      ),
    );
  }

  test('AC72 — no dataset:upload permission and below Editor tier is refused 403', async () => {
    const world = await PrivateProjectsWorld.create();
    try {
      const editor = await world.actor('editor');
      await world.addMember(editor, 'editor');
      const viewer = await world.actor('viewer');
      await world.addMember(viewer, 'viewer');
      await world.leaveWorkspace();

      const upload = await worldInitiateUpload(world, editor, `axi-2549-403-${randomUUID().slice(0, 8)}.csv`);

      // The viewer holds no `dataset:upload` permission and is below Editor —
      // the guard's team-tier check fails, then the permission check fails,
      // before `ownRowOnly`/the dataset lookup is ever reached. A placeholder
      // UUID is sufficient for `:ingestionId` — the guard never gets far
      // enough to look at it.
      const res = await worldRetry(world, viewer, upload.dataset.id, randomUUID());
      expect(res.status()).toBe(403);
    } finally {
      await world.dispose();
    }
  });

  test('AC72 — a cross-tenant ingestion id (another workspace) is NotFound, never 403', async () => {
    const worldA = await PrivateProjectsWorld.create();
    const worldB = await PrivateProjectsWorld.create();
    try {
      const editorA = await worldA.actor('editor-a');
      await worldA.addMember(editorA, 'editor');
      await worldA.leaveWorkspace();

      const editorB = await worldB.actor('editor-b');
      await worldB.addMember(editorB, 'editor');
      await worldB.leaveWorkspace();

      // A real dataset + ingestion in world B — editorA (team-tier Editor+ in
      // world A, so the guard admits them on A's own dataset) targets world
      // A's own dataset id but world B's ingestion id. The SERVICE's own
      // tenant-scoped lookup (`findFirst({ id, workspaceId })`) is what
      // refuses this — not the guard, which only checks dataset A ownership.
      const uploadA = await worldInitiateUpload(worldA, editorA, `axi-2549-404-a-${randomUUID().slice(0, 8)}.csv`);
      const uploadB = await worldInitiateUpload(worldB, editorB, `axi-2549-404-b-${randomUUID().slice(0, 8)}.csv`);
      // Review bounce #2 fix: finalize needs an actual object at the presigned
      // key first — without it, finalize refuses with "object not found" and
      // no ingestion is ever produced (the test then failed on its own
      // `expect(bIngestionId, ...)` assertion rather than exercising 404).
      await uploadPresignedBytes(uploadB.presignedUrl, Buffer.from('gene,value\nBRCA1,1\nTP53,2\n', 'utf8'));
      await worldFinalize(worldB, editorB, uploadB.dataset.id);
      const bIngestions = await pollUntil(
        () => worldIngestionsFor(worldB, editorB, uploadB.dataset.id),
        (list) => list.length > 0,
        { attempts: 10, intervalMs: 500 },
      );
      const bIngestionId = bIngestions?.[0]?.id;
      expect(bIngestionId, 'expected world B to have produced an ingestion').toBeTruthy();

      const res = await worldRetry(worldA, editorA, uploadA.dataset.id, bIngestionId!);
      expect(res.status()).toBe(404);
    } finally {
      await worldA.dispose();
      await worldB.dispose();
    }
  });

  // Review bounce #1, B2: the IDOR this story's fix closes. A sub-Editor
  // actor holding `dataset:upload` (the Investigator role) is authorized by
  // the guard against the ingestion ONLY because it reads `:datasetId` from
  // the URL — never because it checked the ingestion itself. Naming a
  // DIFFERENT, co-worker-owned dataset's ingestion while authorizing against
  // one's own dataset must still be refused, by the SERVICE.
  test('AC72 — an ingestion under a co-worker\'s dataset is NotFound even though the caller owns the dataset named in the URL (IDOR, B2)', async () => {
    const world = await PrivateProjectsWorld.create();
    try {
      const investigatorA = await world.actor('investigator-a');
      await world.addMember(investigatorA, { roleId: INVESTIGATOR_ROLE_ID });
      const investigatorB = await world.actor('investigator-b');
      await world.addMember(investigatorB, { roleId: INVESTIGATOR_ROLE_ID });
      await world.leaveWorkspace();

      const stamp = randomUUID().slice(0, 8);
      const uploadA = await worldInitiateUpload(world, investigatorA, `axi-2549-idor-a-${stamp}.csv`);
      const uploadB = await worldInitiateUpload(world, investigatorB, `axi-2549-idor-b-${stamp}.csv`);

      // A deliberately malformed CSV (an unterminated quoted field) so
      // bio-compute's own parser fails fast with a clean, attributable error
      // — this test needs dataset B's ingestion to reach `failed` WITHOUT
      // waiting out the governed watchdog window. Kept to valid UTF-8 text
      // (never raw/binary bytes): a literal NUL byte reaches bio-compute's
      // parser successfully and only fails later, in organization-service's
      // own persistence of the parsed cell value — a genuine but unrelated
      // latent defect this story does not own, out of scope here.
      const garbage = Buffer.from('gene,value\n"unterminated,1\n', 'utf8');
      await uploadPresignedBytes(uploadB.presignedUrl, garbage);
      await worldFinalize(world, investigatorB, uploadB.dataset.id);

      const bSettled = await pollUntil(
        () => worldIngestionsFor(world, investigatorB, uploadB.dataset.id),
        (list) => list.length > 0 && list[0].status !== 'queued' && list[0].status !== 'running',
        { attempts: 40, intervalMs: 1500 },
      );
      const bIngestion = bSettled?.[0];
      test.skip(
        !bIngestion || bIngestion.status !== 'failed',
        `dataset B's ingestion reached ${bIngestion?.status ?? 'nothing'} rather than failed within the poll ` +
          'budget — this test needs a genuinely failed ingestion to retry; the garbage upload may have been ' +
          'parsed successfully by bio-compute rather than rejected.',
      );

      // investigatorA is authorized on dataset A (their own upload) but
      // names dataset B's failed ingestion — must be refused.
      const res = await worldRetry(world, investigatorA, uploadA.dataset.id, bIngestion!.id);
      expect(res.status()).toBe(404);
    } finally {
      await world.dispose();
    }
  });
});

// Review bounce #2 fix: a presigned S3 PUT carries its OWN SigV4 query-string
// auth — sending it through `actor.api` (whose `extraHTTPHeaders` bakes in a
// bearer `Authorization` header for every request, including this one) gives
// MinIO two authentication types on the same request and it refuses with 400
// `InvalidRequest`. A scratch context with no baked-in headers (mirroring
// this file's own top-level `putBytes`) is what the presigned URL expects.
async function uploadPresignedBytes(presignedUrl: string, bytes: Buffer) {
  const scratch = await request.newContext();
  try {
    const put = await scratch.put(presignedUrl, { data: bytes, headers: { 'Content-Type': 'text/csv' } });
    expect(put.ok(), `S3 PUT failed: ${put.status()} ${await put.text()}`).toBeTruthy();
    return put;
  } finally {
    await scratch.dispose();
  }
}
