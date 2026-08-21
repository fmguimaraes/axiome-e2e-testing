import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  createWorkspace,
  send,
  newRoleRequestContext,
  SCHEMA_COLUMNS,
} from './subject-fixtures';

/**
 * AXI-1245 — subject-schema draft → publish lifecycle (manual-e2e §4.1, §5.1–§5.4).
 *
 * API-only coverage of the backend schema half: an empty workspace exposes no
 * active version (FR1); a draft opens at version 1 carrying the advisory
 * free-text warning; publish makes activeVersion.version 1, consumes the draft
 * (a mandatory reason — FR4), and a re-publish with no draft 400s; a second
 * draft+publish walks to version 2 with /versions listing both (immutable
 * published versions — FR5's history half, AC1). The negatives: the
 * direct-identifier blocklist rejects a column by key or by label at draft save
 * (FR5, AC2), and a stale expectedDraftVersion on PUT /draft is refused with a
 * 409 (EC3 optimistic concurrency). Every workspace is provisioned per-test
 * through the public API — self-contained, no seed dependence.
 */

const SCHEMA = (ws: string) => `/api/v1/workspaces/${ws}/subject-schema`;

let adminApi: APIRequestContext;
let orgId: string;
let adminUserId: string;

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  orgId = ctx.orgId;
  adminUserId = ctx.userId;
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** A fresh, empty schema-less workspace owned by the fixture org. */
async function freshWorkspace(label: string): Promise<string> {
  return createWorkspace(adminApi, orgId, adminUserId, label);
}

/** Raw GET against the schema endpoint (status is asserted by the caller). */
function schemaGet(api: APIRequestContext, ws: string, sub = '') {
  return api.get(apiUrl(`${SCHEMA(ws)}${sub}`), { headers: { 'X-Workspace-Id': ws } });
}

test.describe('AXI-1245 — schema draft → publish lifecycle (FR1/FR4/FR5/AC1/AC2/EC3)', () => {
  // ─── Happy path — the draft → publish lifecycle (§4.1) ─────────────

  test('FR1 — an empty workspace has no active schema version and no draft', async () => {
    const ws = await freshWorkspace('schema-empty');
    const body = await send(adminApi, 'get', SCHEMA(ws), ws);
    expect(body.activeVersion).toBeNull();
    expect(body.draft).toBeNull();
    expect(body.schemaId).toBeNull();
  });

  test('FR4 AC1 — a draft opens at version 1 with an advisory free-text warning, publishing nothing', async () => {
    const ws = await freshWorkspace('schema-draft');
    const saved = await send(adminApi, 'put', `${SCHEMA(ws)}/draft`, ws, {
      expectedDraftVersion: 0,
      columns: SCHEMA_COLUMNS,
    });
    expect(saved.draft.version).toBe(1);
    expect(saved.draft.columns).toHaveLength(SCHEMA_COLUMNS.length);
    // The free-text `clinician_notes` column raises exactly one advisory warning.
    expect(saved.warnings).toEqual([
      expect.objectContaining({ columnKey: 'clinician_notes' }),
    ]);

    // Nothing is published yet; a re-read echoes the draft and a null active version.
    const read = await send(adminApi, 'get', SCHEMA(ws), ws);
    expect(read.activeVersion).toBeNull();
    expect(read.draft.columns).toHaveLength(SCHEMA_COLUMNS.length);
  });

  test('FR4 AC1 — publish makes activeVersion.version 1, echoes the reason, and consumes the draft', async () => {
    const ws = await freshWorkspace('schema-publish');
    await send(adminApi, 'put', `${SCHEMA(ws)}/draft`, ws, { expectedDraftVersion: 0, columns: SCHEMA_COLUMNS });

    const res = await adminApi.post(apiUrl(`${SCHEMA(ws)}/publish`), {
      headers: { 'X-Workspace-Id': ws },
      data: { reason: 'Initial schema for pilot cohort', expectedDraftVersion: 1 },
    });
    expect(res.status()).toBe(201);
    const published = await res.json();
    expect(published.activeVersion.version).toBe(1);
    expect(published.activeVersion.publishReason).toBe('Initial schema for pilot cohort');

    // The draft is consumed: a re-read shows an active v1 and no open draft.
    const read = await send(adminApi, 'get', SCHEMA(ws), ws);
    expect(read.activeVersion.version).toBe(1);
    expect(read.draft).toBeNull();
  });

  test('FR4 — re-publishing with no open draft is refused 400 (publish is never a silent re-run)', async () => {
    const ws = await freshWorkspace('schema-republish');
    await send(adminApi, 'put', `${SCHEMA(ws)}/draft`, ws, { expectedDraftVersion: 0, columns: SCHEMA_COLUMNS });
    await send(adminApi, 'post', `${SCHEMA(ws)}/publish`, ws, { reason: 'Initial', expectedDraftVersion: 1 });

    // No draft remains — the second publish has nothing to promote.
    const res = await adminApi.post(apiUrl(`${SCHEMA(ws)}/publish`), {
      headers: { 'X-Workspace-Id': ws },
      data: { reason: 'again', expectedDraftVersion: 1 },
    });
    expect(res.status()).toBe(400);
  });

  test('FR4 — publishing without a reason is refused 400 (reason is mandatory)', async () => {
    const ws = await freshWorkspace('schema-noreason');
    await send(adminApi, 'put', `${SCHEMA(ws)}/draft`, ws, { expectedDraftVersion: 0, columns: SCHEMA_COLUMNS });

    const res = await adminApi.post(apiUrl(`${SCHEMA(ws)}/publish`), {
      headers: { 'X-Workspace-Id': ws },
      data: { reason: '   ', expectedDraftVersion: 1 },
    });
    expect(res.status()).toBe(400);
    // The rejection wrote no version — the draft is still open and re-publishable.
    const read = await send(adminApi, 'get', SCHEMA(ws), ws);
    expect(read.activeVersion).toBeNull();
    expect(read.draft.version).toBe(1);
  });

  test('FR4 AC1 — a second draft+publish walks to version 2; /versions lists both with publish metadata', async () => {
    const ws = await freshWorkspace('schema-v2');
    // Version 1.
    await send(adminApi, 'put', `${SCHEMA(ws)}/draft`, ws, { expectedDraftVersion: 0, columns: SCHEMA_COLUMNS });
    await send(adminApi, 'post', `${SCHEMA(ws)}/publish`, ws, { reason: 'Initial schema for pilot cohort', expectedDraftVersion: 1 });

    // A fresh draft opens at version 1 on top of the published v1, then publishes v2.
    const secondDraft = await send(adminApi, 'put', `${SCHEMA(ws)}/draft`, ws, {
      expectedDraftVersion: 0,
      columns: [...SCHEMA_COLUMNS, { key: 'site_code', label: 'Site code', type: 'text', category: 'analysis', required: false }],
    });
    expect(secondDraft.draft.version).toBe(1);
    const republished = await send(adminApi, 'post', `${SCHEMA(ws)}/publish`, ws, { reason: 'Add site code', expectedDraftVersion: 1 });
    expect(republished.activeVersion.version).toBe(2);

    const versions = await send(adminApi, 'get', `${SCHEMA(ws)}/versions`, ws);
    expect(versions.total).toBe(2);
    expect(versions.versions.map((v: { version: number }) => v.version).sort()).toEqual([1, 2]);
    for (const v of versions.versions) {
      expect(v.publishedAt).toBeTruthy();
      expect(v.publishedBy).toBeTruthy();
      expect(v.publishReason).toBeTruthy();
    }
  });

  // ─── Blocklist — direct-identifier rejection (§5.1, FR5/AC2) ────────

  test('FR5 AC2 — a column whose key is a direct identifier is rejected 400 at draft save', async () => {
    const ws = await freshWorkspace('schema-block-key');
    const res = await adminApi.put(apiUrl(`${SCHEMA(ws)}/draft`), {
      headers: { 'X-Workspace-Id': ws },
      data: {
        expectedDraftVersion: 0,
        columns: [{ key: 'patient_name', label: 'Patient Name', type: 'text', category: 'clinical', required: false }],
      },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('patient_name');
    // The rejected save persisted nothing — the workspace still has no draft.
    const read = await send(adminApi, 'get', SCHEMA(ws), ws);
    expect(read.draft).toBeNull();
  });

  test('FR5 AC2 — a direct identifier in the label alone is rejected 400 at draft save', async () => {
    const ws = await freshWorkspace('schema-block-label');
    const res = await adminApi.put(apiUrl(`${SCHEMA(ws)}/draft`), {
      headers: { 'X-Workspace-Id': ws },
      data: {
        expectedDraftVersion: 0,
        columns: [{ key: 'col_a', label: 'Birth date', type: 'date', category: 'clinical', required: false }],
      },
    });
    expect(res.status()).toBe(400);
    const read = await send(adminApi, 'get', SCHEMA(ws), ws);
    expect(read.draft).toBeNull();
  });

  // ─── EC3 — optimistic-concurrency on the draft (§5.4) ──────────────

  test('FR4 EC3 — a stale expectedDraftVersion on PUT /draft is refused 409 without clobbering', async () => {
    const ws = await freshWorkspace('schema-stale');
    const cols = [{ key: 'age_at_enrollment', label: 'Age', type: 'number', category: 'clinical', required: true, min: 18, max: 120 }];

    // First editor saves → draft.version 1.
    const first = await send(adminApi, 'put', `${SCHEMA(ws)}/draft`, ws, { expectedDraftVersion: 0, columns: cols });
    expect(first.draft.version).toBe(1);

    // Second editor saves on top → draft.version 2.
    const second = await send(adminApi, 'put', `${SCHEMA(ws)}/draft`, ws, { expectedDraftVersion: 1, columns: cols });
    expect(second.draft.version).toBe(2);

    // First editor re-saves with the now-stale token 1 → 409, no overwrite.
    const stale = await adminApi.put(apiUrl(`${SCHEMA(ws)}/draft`), {
      headers: { 'X-Workspace-Id': ws },
      data: { expectedDraftVersion: 1, columns: cols },
    });
    expect(stale.status()).toBe(409);
    // The second editor's draft is untouched — still at version 2.
    const read = await send(adminApi, 'get', SCHEMA(ws), ws);
    expect(read.draft.version).toBe(2);
  });

  // ─── Deny-by-default (NFR4) — non-member is refused ────────────────

  test('NFR4 — a non-member (no subject:schema_manage) is denied 403 on draft save', async () => {
    const ws = await freshWorkspace('schema-deny');
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.put(apiUrl(`${SCHEMA(ws)}/draft`), {
        headers: { 'X-Workspace-Id': ws },
        data: { expectedDraftVersion: 0, columns: SCHEMA_COLUMNS },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });
});
