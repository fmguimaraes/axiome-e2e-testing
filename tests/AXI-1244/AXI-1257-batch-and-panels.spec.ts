import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  createSubject,
  createTimepoint,
  createWorkspace,
  newRoleRequestContext,
  publishSchema,
  type SubjectFixture,
} from './subject-fixtures';

/**
 * AXI-1257 — batch metadata & panel vocabulary (FR19, FR21, EC7, AC9).
 *
 * Covers the DETERMINISTIC, synchronous surface of the story: the workspace
 * panel vocabulary REST contract (§4.12 panel steps 1–3 / §5.15 step 6) — the
 * reserved "Not applicable" entry seeded lazily on the first read and refusing
 * deletion (EC7), create/duplicate governance, and deny-by-default on
 * `subject:schema_manage` (NFR4) — plus the FR19 mandatory-metadata gate at
 * `initiateUpload`, which runs BEFORE any file lands (§4.12 step 4 / §5.15
 * step 1): omitting a required metadata field refuses the upload and creates no
 * orphan Dataset.
 *
 * Data is provisioned per run through the public API (a fresh schema-enabled
 * workspace with a timepoint + active subject — self-contained, no seed
 * dependence, NFR3). The atomic file lock, S3 upload, uniqueness tuple and
 * correction/supersession (FR20/FR21/AC9, §4.12 steps 5–10) require a real
 * finalized upload and are recorded as manual residue — see the file footer.
 */

let adminApi: APIRequestContext;
let ws: string;
let orgId: string;
let timepointId: string;
let subject: SubjectFixture;

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  orgId = ctx.orgId;
  ws = await createWorkspace(adminApi, orgId, ctx.userId, 'batch-panels');
  await publishSchema(adminApi, ws);
  timepointId = await createTimepoint(adminApi, ws, 'Baseline', 1);
  subject = await createSubject(adminApi, ws, 'SUBJ-UP');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

const panelsPath = () => `/api/v1/workspaces/${ws}/subject-panels`;
const datasetsPath = () => `/api/v1/workspaces/${ws}/datasets`;

/** Issue an admin, workspace-scoped request against the fixture workspace. */
function wsGet(path: string) {
  return adminApi.get(apiUrl(path), { headers: { 'X-Workspace-Id': ws } });
}
function wsPost(path: string, data: unknown) {
  return adminApi.post(apiUrl(path), { headers: { 'X-Workspace-Id': ws }, data });
}
function wsDelete(path: string, data: unknown) {
  return adminApi.delete(apiUrl(path), { headers: { 'X-Workspace-Id': ws }, data });
}

/** The full, valid FR19 batch-metadata body for a subject-linked upload; tests
 *  omit exactly one field to exercise the mandatory-metadata gate. */
function fullUploadBody(panelId: string) {
  return {
    organizationId: orgId,
    originalFilename: 'batch.fcs',
    contentType: 'application/octet-stream',
    subjectId: subject.id,
    timepointId,
    instrument: 'Aurora',
    acquisitionDate: '2026-08-16',
    software: 'SpectroFlo 3.1',
    panelId,
    gatingStrategy: 'CD3/CD4/CD8',
  };
}

test.describe('AXI-1257 — batch metadata & panel vocabulary (FR19/EC7)', () => {
  // ─── Panel vocabulary (§4.12 steps 1–3, §5.15 step 6) ──────────────

  test('FR19 EC7 — a fresh workspace already exposes the reserved "Not applicable" panel and it cannot be deleted', async () => {
    const res = await wsGet(panelsPath());
    expect(res.status()).toBe(200);
    const body = await res.json();

    // Seeded lazily on first read — present even though no panel was created.
    const reserved = body.panels.find((p: { isNotApplicable?: boolean }) => p.isNotApplicable);
    expect(reserved).toBeTruthy();
    expect(reserved.name).toBe('Not applicable');

    // The reserved entry is undeletable (EC7).
    const del = await wsDelete(`${panelsPath()}/${reserved.id}`, { reason: 'AXI-1257 E2E attempt' });
    expect(del.status()).toBe(409);
  });

  test('FR19 — a subject:schema_manage holder creates a workspace panel (201)', async () => {
    const res = await wsPost(panelsPath(), { name: 'Myeloid v2', reason: 'AXI-1257 E2E panel' });
    expect(res.status()).toBe(201);
    const panel = await res.json();
    expect(panel.name).toBe('Myeloid v2');
    expect(panel.isNotApplicable).toBe(false);
  });

  test('FR19 — a duplicate panel name is rejected (409)', async () => {
    const name = `Dup Panel ${Date.now()}`;
    const first = await wsPost(panelsPath(), { name, reason: 'AXI-1257 E2E first' });
    expect(first.status()).toBe(201);

    const dup = await wsPost(panelsPath(), { name, reason: 'AXI-1257 E2E duplicate' });
    expect(dup.status()).toBe(409);
  });

  test('FR19 NFR4 — panel create is deny-by-default: a non-member (no subject:schema_manage) is refused 403', async () => {
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.post(apiUrl(panelsPath()), {
        headers: { 'X-Workspace-Id': ws },
        data: { name: 'Should Not Exist', reason: 'AXI-1257 E2E deny' },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });

  // ─── Mandatory batch metadata (FR19 — §4.12 step 4, §5.15 step 1) ──

  test('FR19 EC7 — omitting any required batch-metadata field refuses the upload before a file lands, creating no orphan dataset', async () => {
    // A valid panel so the base body is complete except for the omitted field.
    const panelRes = await wsPost(panelsPath(), { name: `Meta Panel ${Date.now()}`, reason: 'AXI-1257 E2E meta' });
    expect(panelRes.status()).toBe(201);
    const panelId = (await panelRes.json()).id;

    const required = ['timepointId', 'instrument', 'acquisitionDate', 'software', 'panelId', 'gatingStrategy'] as const;
    for (const field of required) {
      const body: Record<string, unknown> = fullUploadBody(panelId);
      delete body[field];
      const res = await wsPost(datasetsPath(), body);
      // FR19: the metadata gate refuses the subject-linked upload with a 400 that
      // names the missing field (AXI-1320 maps the service BadRequest onto the RPC
      // envelope instead of a blanket 500). The gate runs before any file lands.
      expect(res.status(), `omitting ${field} must refuse the upload with 400`).toBe(400);
    }

    // No orphan: the metadata gate runs before S3, so no Dataset row exists
    // (§5.15 step 1). The registry still holds exactly zero datasets.
    const list = await wsGet(datasetsPath());
    expect(list.status()).toBe(200);
    expect((await list.json()).meta.total).toBe(0);
  });
});
