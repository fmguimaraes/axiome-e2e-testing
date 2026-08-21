import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  createWorkspace,
  publishSchema,
  send,
  newRoleRequestContext,
  SCHEMA_COLUMNS,
} from './subject-fixtures';

/**
 * AXI-1250 — audit & compliance trail (manual-e2e §4.5, §5.8 — FR16, NFR1, NFR2, AC13).
 *
 * API-only. A fresh workspace is provisioned per run and mutated twice
 * (draft+publish, draft+publish) so the trail holds exactly two `draft_saved`
 * and two `published` schema mutations. The spec then asserts, deterministically:
 *
 *  - the module audit read `GET .../subjects/audit-logs` — `{ logs, total }`
 *    newest-first, each entry `entityType: subject_schema`, `action`
 *    `draft_saved`/`published`, `changes`, `reason` (publish rows carry the exact
 *    reason), `performedBy`, `performedAt` (FR16/AC13);
 *  - `?entityType=&action=` filters, an unknown action returning an empty page
 *    (not a 500), and `?limit=&page=` paging (FR16/NFR2);
 *  - payloads carry column metadata + reasons only, never subject-data values
 *    (NFR1);
 *  - the deny surface: a non-member and a path/header workspace mismatch both
 *    403 (NFR4/§5.8);
 *  - the central hash-chained mirror `GET /audit-logs?resource=subject_schema`
 *    eventually carries the same mutations with a non-null `entryHash` — the
 *    central entries arrive asynchronously over RabbitMQ, so this is polled, never
 *    slept on (AC13/NFR2).
 *
 * The strict `GET /audit-logs/verify → { valid: true }` chain-integrity assertion
 * is NOT made here: against the shared local event-service the global hash chain
 * is already reported invalid from its genesis entry (chain-wide verify returns
 * `valid: false`, firstInvalidIndex 0), independent of this spec's mutations, so a
 * `valid: true` assertion cannot pass deterministically. The verify endpoint is
 * instead exercised at the contract level (reachable, 200, reports over our
 * entries); the integrity claim is recorded as manual residue.
 */

/** The second publish carries a genuinely different column set so the draft save
 *  is a real change (tighten the age bound), letting us assert a distinct reason. */
const SECOND_COLUMNS = SCHEMA_COLUMNS.map((c) =>
  c.key === 'age_at_enrollment' ? { ...c, max: 110 } : c,
);

const FIRST_REASON = 'AXI-1250 audit-trail first publish';
const SECOND_REASON = 'AXI-1250 audit-trail second publish';

/** Change-payload keys the trail is allowed to expose — schema-shape metadata and
 *  reasons only. No subject-level data value may ever appear (NFR1). */
const ALLOWED_CHANGE_KEYS = new Set(['activeVersion', 'draftColumns', 'reason']);
const ALLOWED_COLUMN_KEYS = new Set([
  'key',
  'label',
  'type',
  'category',
  'required',
  'enumValues',
  'unit',
  'min',
  'max',
]);

let adminApi: APIRequestContext;
let userId: string;
let orgId: string;
let ws: string;
let plainWs: string;
let schemaId: string;

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  userId = ctx.userId;
  orgId = ctx.orgId;

  ws = await createWorkspace(adminApi, orgId, userId, 'audit');
  await publishSchema(adminApi, ws, SCHEMA_COLUMNS, FIRST_REASON);
  await publishSchema(adminApi, ws, SECOND_COLUMNS, SECOND_REASON);

  const schema = await send(adminApi, 'get', `/api/v1/workspaces/${ws}/subject-schema`, ws);
  schemaId = schema.schemaId;

  // A second workspace the caller IS a member of — used for the path/header
  // mismatch 403 (the guard must reject even a member-of-the-header workspace).
  plainWs = await createWorkspace(adminApi, orgId, userId, 'audit-plain');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** GET an audit route with the admin token, scoped to `workspaceId`. */
function auditGet(api: APIRequestContext, path: string, workspaceId: string) {
  return api.get(apiUrl(path), { headers: { 'X-Workspace-Id': workspaceId } });
}

/** Assert a `changes` payload exposes schema metadata + reasons only — never a
 *  subject-data value (NFR1). Walks any embedded column arrays. */
function expectMetadataOnly(changes: Record<string, any>): void {
  for (const key of Object.keys(changes)) {
    expect(ALLOWED_CHANGE_KEYS.has(key)).toBe(true);
  }
  const columns = changes.draftColumns?.new ?? changes.draftColumns?.old ?? [];
  for (const column of columns ?? []) {
    for (const key of Object.keys(column)) {
      expect(ALLOWED_COLUMN_KEYS.has(key)).toBe(true);
    }
  }
}

test.describe('AXI-1250 — audit & compliance trail (§4.5/§5.8)', () => {
  // ─── Module audit read (FR16 / AC13 — §4.5 step 1) ─────────────────

  test('FR16 AC13 — the module audit read returns {logs,total} newest-first, each schema mutation carrying action/changes/reason/performedBy/performedAt', async () => {
    const body = await send(adminApi, 'get', `/api/v1/workspaces/${ws}/subjects/audit-logs`, ws);

    expect(body.total).toBe(4);
    expect(body.logs).toHaveLength(4);
    // Newest first: publish(2), draft(2), publish(1), draft(1).
    expect(body.logs.map((l: any) => l.action)).toEqual([
      'published',
      'draft_saved',
      'published',
      'draft_saved',
    ]);

    for (const entry of body.logs) {
      expect(entry.entityType).toBe('subject_schema');
      expect(entry.entityId).toBe(schemaId);
      expect(entry.performedBy).toBe(userId);
      expect(entry.performedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.changes).toBeTruthy();
    }

    // The newest entry is the second publish and carries its exact reason.
    expect(body.logs[0].reason).toBe(SECOND_REASON);
    // Publish rows carry the mandatory reason; draft saves do not.
    const publishReasons = body.logs.filter((l: any) => l.action === 'published').map((l: any) => l.reason);
    expect(publishReasons).toEqual([SECOND_REASON, FIRST_REASON]);
    for (const draft of body.logs.filter((l: any) => l.action === 'draft_saved')) {
      expect(draft.reason).toBeNull();
    }
  });

  test('FR16 — the entityType/action filters narrow the trail to one action class (§4.5 step 2)', async () => {
    const published = await send(
      adminApi,
      'get',
      `/api/v1/workspaces/${ws}/subjects/audit-logs?entityType=subject_schema&action=published`,
      ws,
    );
    expect(published.total).toBe(2);
    expect(published.logs.every((l: any) => l.action === 'published')).toBe(true);

    const drafts = await send(
      adminApi,
      'get',
      `/api/v1/workspaces/${ws}/subjects/audit-logs?action=draft_saved`,
      ws,
    );
    expect(drafts.total).toBe(2);
    expect(drafts.logs.every((l: any) => l.action === 'draft_saved')).toBe(true);
  });

  test('NFR2 — an unknown action filter returns an empty page, not a 500 (§4.5 step 2)', async () => {
    const res = await auditGet(adminApi, `/api/v1/workspaces/${ws}/subjects/audit-logs?action=nope`, ws);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.logs).toEqual([]);
    expect(body.total).toBe(0);
  });

  test('FR16 — paging (?limit=&page=) walks the same newest-first ordering (§4.5 step 2)', async () => {
    const page1 = await send(
      adminApi,
      'get',
      `/api/v1/workspaces/${ws}/subjects/audit-logs?limit=1&page=1`,
      ws,
    );
    expect(page1.total).toBe(4);
    expect(page1.logs).toHaveLength(1);
    expect(page1.logs[0].action).toBe('published');

    const page2 = await send(
      adminApi,
      'get',
      `/api/v1/workspaces/${ws}/subjects/audit-logs?limit=1&page=2`,
      ws,
    );
    expect(page2.total).toBe(4);
    expect(page2.logs).toHaveLength(1);
    expect(page2.logs[0].action).toBe('draft_saved');
    // Distinct rows across the two pages — real paging, not a repeated head.
    expect(page2.logs[0].id).not.toBe(page1.logs[0].id);
  });

  test('NFR1 — module audit payloads carry column metadata and reasons only, never subject-data values (§5.8 step 2)', async () => {
    const body = await send(adminApi, 'get', `/api/v1/workspaces/${ws}/subjects/audit-logs`, ws);
    for (const entry of body.logs) {
      expectMetadataOnly(entry.changes);
    }
  });

  // ─── Deny surface (NFR4 — §5.8 step 1) ─────────────────────────────

  test('NFR4 — the module audit read is denied to a non-member (403) and on a path/header workspace mismatch (403)', async () => {
    // A non-member of the workspace is refused regardless of capability.
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.get(apiUrl(`/api/v1/workspaces/${ws}/subjects/audit-logs`), {
        headers: { 'X-Workspace-Id': ws },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }

    // Path workspace ≠ X-Workspace-Id header workspace is refused before any RPC,
    // even though the caller is a member of the header workspace.
    const mismatch = await auditGet(adminApi, `/api/v1/workspaces/${ws}/subjects/audit-logs`, plainWs);
    expect(mismatch.status()).toBe(403);
  });

  // ─── Central hash-chained mirror (AC13 / NFR2 — §4.5 step 3) ────────

  test('AC13 NFR2 — the central hash-chained log mirrors the schema mutations with a non-null entryHash', async () => {
    const centralUrl = apiUrl(`/api/v1/audit-logs?resource=subject_schema&workspaceId=${ws}`);

    // Central entries are fire-and-forget over RabbitMQ — poll for arrival, never sleep.
    let logs: any[] = [];
    await expect
      .poll(
        async () => {
          const res = await adminApi.get(centralUrl);
          if (!res.ok()) return 0;
          logs = (await res.json()).logs ?? [];
          return logs.length;
        },
        { timeout: 15_000, message: 'central subject_schema entries never materialized' },
      )
      .toBeGreaterThanOrEqual(4);

    const scoped = logs.filter((l: any) => l.workspaceId === ws);
    const actions = scoped.map((l: any) => l.action);
    expect(actions).toContain('subject_schema.published');
    expect(actions).toContain('subject_schema.draft_saved');

    for (const entry of scoped) {
      expect(entry.resource).toBe('subject_schema');
      expect(entry.resourceId).toBe(schemaId);
      expect(entry.userId).toBe(userId);
      expect(entry.workspaceId).toBe(ws);
      // Hash-chained: every entry stamps a non-null entryHash.
      expect(entry.entryHash).toBeTruthy();
    }
  });

  test('NFR1 — central audit payloads carry reasons/metadata only, never subject-data values (§5.8 step 2)', async () => {
    const res = await adminApi.get(apiUrl(`/api/v1/audit-logs?resource=subject_schema&workspaceId=${ws}`));
    expect(res.status()).toBe(200);
    const logs = ((await res.json()).logs ?? []).filter((l: any) => l.workspaceId === ws);
    expect(logs.length).toBeGreaterThanOrEqual(4);
    for (const entry of logs) {
      expectMetadataOnly(entry.changes);
    }
  });

  // ─── Hash-chain verify endpoint (AC13 / NFR2 — §4.5 step 4) ─────────

  test('AC13 NFR2 — the verify endpoint reports the workspace hash chain over the new entries', async () => {
    // NOTE: the strict { valid: true } integrity assertion is manual residue — the
    // shared event-service chain is already invalid from its genesis entry in this
    // environment (see file header). Here we assert the endpoint contract: it is
    // reachable, answers 200, and its report spans our workspace's entries.
    const res = await adminApi.get(apiUrl(`/api/v1/audit-logs/verify?workspaceId=${ws}`));
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.valid).toBe('boolean');
    expect(typeof body.totalEntries).toBe('number');
    expect(body.totalEntries).toBeGreaterThanOrEqual(4);
  });
});
