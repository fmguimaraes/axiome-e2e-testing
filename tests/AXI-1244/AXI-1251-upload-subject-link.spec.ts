import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  createSubject,
  createTimepoint,
  createWorkspace,
  newRoleRequestContext,
  publishSchema,
  send,
  type SubjectFixture,
} from './subject-fixtures';

/**
 * AXI-1251 — Upload subject-link integration (FR17, FR18, FR31, NFR3, AC8, AC14,
 * AC15). Manual-E2E §4.11 / §5.14.
 *
 * The dataset upload path (`POST /workspaces/:ws/datasets`, initiate) gains an
 * OPTIONAL subject link that is validated at `initiateUpload` BEFORE any file
 * lands in S3 — so every assertion here is on the synchronous request/response
 * seam (no MinIO PUT, no finalize, no ingestion). This spec covers only that
 * deterministic pre-file surface:
 *
 *   • FR31/AC15 — under a published schema the link is OPTIONAL: a well-formed
 *     initiate with NO subjectId is accepted (self-contained upload), subjectId
 *     stays null.
 *   • AC8 — a valid active subjectId held with `subject:attach` is accepted and
 *     persisted on the returned dataset.
 *   • FR17/FR15 — an unknown subject and a tombstoned subject are refused before
 *     any dataset row / presigned URL is created (no orphan).
 *   • FR18 — the link is never inferred from the filename.
 *   • NFR3/NFR4 — deny-by-default: a caller lacking `subject:attach` is refused
 *     whenever a link is supplied.
 *   • AC14 — a workspace with no published schema is byte-for-byte unchanged.
 *
 * Data is provisioned per run through the public API (self-contained, no seed
 * dependence — NFR3). The file PUT + finalize + async ingestion tail is manual
 * residue (see the story's residue notes): it depends on MinIO object writes and
 * RabbitMQ materialization that are non-deterministic to assert inline.
 *
 * NOTE on status codes: the datasets initiate handler forwards the microservice
 * result with a raw `firstValueFrom` and no RPC→HTTP mapping, so the semantic
 * 404 (unknown) / 409 (tombstoned) thrown by the subject guard currently surface
 * at the gateway as HTTP 500. The refusal itself (no dataset, no URL) is the
 * FR17 invariant and is asserted durably; the status assertions accept both the
 * intended code and the observed masking so the spec stays green whether or not
 * that gateway mapping is later fixed.
 */

// ── Fixture state ─────────────────────────────────────────────────────
let adminApi: APIRequestContext;
let orgId: string;
let adminUserId: string;
let schemaWs: string;
let plainWs: string;
let panelId: string;
let tpBaseline: string;
let subjectUp: SubjectFixture;
let subjectDeadId: string;

/** Full AXI-1257 batch metadata — mandatory on a subject-linked upload, so it is
 *  supplied on every schema-workspace initiate to isolate the SUBJECT-LINK gate
 *  (AXI-1251) as the only variable under test. */
function batchMetadata() {
  return {
    timepointId: tpBaseline,
    instrument: 'Aurora',
    acquisitionDate: '2026-08-16',
    software: 'SpectroFlo 3.1',
    panelId,
    gatingStrategy: 'CD3/CD4/CD8',
  };
}

/** The invariant fields of a well-formed initiate body (no subject link). */
function baseUpload(filename = 'upload.csv') {
  return {
    organizationId: orgId,
    originalFilename: filename,
    contentType: 'text/csv',
    performedBy: adminUserId,
  };
}

/** POST an initiate to `ws` with `api`, returning the raw response (never throws
 *  on non-2xx — the negatives assert the rejection directly). */
function initiate(api: APIRequestContext, ws: string, body: Record<string, unknown>) {
  return api.post(apiUrl(`/api/v1/workspaces/${ws}/datasets`), {
    headers: { 'X-Workspace-Id': ws },
    data: body,
  });
}

/** Current dataset count for a workspace — proves "no orphan on a rejected
 *  initiate" (§5.14 step 1) by comparing before/after a refused call. */
async function datasetTotal(ws: string): Promise<number> {
  const res = await adminApi.get(apiUrl(`/api/v1/workspaces/${ws}/datasets`), {
    headers: { 'X-Workspace-Id': ws },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).meta.total as number;
}

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  orgId = ctx.orgId;
  adminUserId = ctx.userId;

  // WS-SCHEMA: published schema + a timepoint + an active subject (SUBJ-UP) and a
  // tombstoned subject (SUBJ-DEAD). The reserved "Not applicable" panel is seeded
  // on schema publish and is the panel used by the mandatory batch metadata.
  schemaWs = await createWorkspace(adminApi, orgId, adminUserId, 'subject-link');
  await publishSchema(adminApi, schemaWs);
  tpBaseline = await createTimepoint(adminApi, schemaWs, 'Baseline', 1);
  subjectUp = await createSubject(adminApi, schemaWs, 'SUBJ-UP');
  const dead = await createSubject(adminApi, schemaWs, 'SUBJ-DEAD');
  subjectDeadId = dead.id;
  await send(adminApi, 'delete', `/api/v1/workspaces/${schemaWs}/subjects/${subjectDeadId}`, schemaWs, {
    reason: 'AXI-1251 E2E tombstone for refusal test',
  });
  const panels = await send(adminApi, 'get', `/api/v1/workspaces/${schemaWs}/subject-panels`, schemaWs);
  panelId = panels.panels[0].id;

  // WS-PLAIN: no published schema — the AC14 unchanged path.
  plainWs = await createWorkspace(adminApi, orgId, adminUserId, 'subject-plain');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

test.describe('AXI-1251 — upload subject-link integration (FR17/FR31)', () => {
  // ─── Published schema — the accept surface ─────────────────────────

  test('FR31 AC15 — under a published schema an initiate with NO subjectId is accepted (self-contained upload)', async () => {
    const res = await initiate(adminApi, schemaWs, { ...baseUpload(), ...batchMetadata() });
    expect(res.status()).toBe(201);

    const body = await res.json();
    // The link is optional (FR31): the upload proceeds unlinked and returns a URL.
    expect(body.dataset.subjectId).toBeNull();
    expect(body.presignedUrl).toBeTruthy();
  });

  test('FR17 AC8 — a valid active subjectId held with subject:attach is accepted and persisted on the dataset', async () => {
    const res = await initiate(adminApi, schemaWs, {
      ...baseUpload(),
      ...batchMetadata(),
      subjectId: subjectUp.id,
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    // The chosen link is stored on the batch dataset, mirroring siteId.
    expect(body.dataset.subjectId).toBe(subjectUp.id);
    expect(body.presignedUrl).toBeTruthy();
  });

  // ─── Published schema — the refusal surface (before any file lands) ─

  test('FR17 FR15 — an unknown subjectId is refused before any dataset/URL is created', async () => {
    const before = await datasetTotal(schemaWs);
    const res = await initiate(adminApi, schemaWs, {
      ...baseUpload(),
      ...batchMetadata(),
      subjectId: '11111111-1111-1111-1111-111111111111',
    });

    // FR17 contract: an unknown subject is a workspace-scoped 404 (AXI-1320
    // maps the service's NotFound onto the RPC envelope instead of a blanket 500).
    expect(res.status()).toBe(404);
    // No orphan: the registry is unchanged and no presigned URL was issued.
    expect(await datasetTotal(schemaWs)).toBe(before);
    expect((await res.json()).presignedUrl).toBeUndefined();
  });

  test('FR17 FR15 — a tombstoned subjectId is refused before any dataset/URL is created', async () => {
    const before = await datasetTotal(schemaWs);
    const res = await initiate(adminApi, schemaWs, {
      ...baseUpload(),
      ...batchMetadata(),
      subjectId: subjectDeadId,
    });

    // FR17/FR15 contract: a tombstoned subject accepts no attachments → 409
    // (AXI-1320 maps the service's Conflict onto the RPC envelope, not a 500).
    expect(res.status()).toBe(409);
    expect(await datasetTotal(schemaWs)).toBe(before);
    expect((await res.json()).presignedUrl).toBeUndefined();
  });

  test('FR18 — the subject link is never inferred from a filename that matches a real subject code', async () => {
    // Filename equals an existing subject code, but no subjectId is supplied:
    // the platform must NOT auto-populate the link from the name.
    const res = await initiate(adminApi, schemaWs, {
      ...baseUpload('SUBJ-UP.csv'),
      ...batchMetadata(),
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).dataset.subjectId).toBeNull();
  });

  // ─── Deny-by-default (NFR3/NFR4) ───────────────────────────────────

  test('FR17 NFR3 — a caller without subject:attach is refused when a subjectId is supplied (deny-by-default)', async () => {
    const before = await datasetTotal(schemaWs);
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await initiate(userApi, schemaWs, {
        ...baseUpload(),
        ...batchMetadata(),
        subjectId: subjectUp.id,
      });
      // Attaching a subject requires subject:attach; the non-member holds none.
      expect(res.status()).toBe(403);
      expect(await datasetTotal(schemaWs)).toBe(before);
    } finally {
      await userApi.dispose();
    }
  });

  // ─── Schema-less path unchanged (AC14) ─────────────────────────────

  test('AC14 — in a workspace with no published schema the upload is unchanged and subjectId stays null', async () => {
    const res = await initiate(adminApi, plainWs, baseUpload());
    expect(res.status()).toBe(201);

    const body = await res.json();
    // No selector, no link required, no attach gate: the dataset stores null.
    expect(body.dataset.subjectId).toBeNull();
    expect(body.presignedUrl).toBeTruthy();
  });
});
