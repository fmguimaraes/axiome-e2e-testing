import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  send,
  createWorkspace,
  publishSchema,
  createTimepoint,
  createSubject,
  putRow,
  newRoleRequestContext,
  roleTokens,
  seedBrowserSession,
  type SubjectFixture,
} from './subject-fixtures';

/**
 * AXI-1249 — subject lifecycle & tombstone (FR15, AC7, EC9; manual-e2e §4.10, §5.13).
 *
 * Closes the FR15 loop AXI-1247 only stored: `DELETE .../subjects/:id` writes a
 * `tombstoned` status; the tombstoned subject leaves the active-only default list
 * yet stays fully reachable and readable (subject / rows / rows-history all 200);
 * every write is refused with 409 (code edit, a second tombstone, a row upsert)
 * and the tombstoned code is never freed for reuse (EC9). The 404↔409 distinction
 * and the status-filter validation come from §5.13, and capability gating stays
 * intact (a non-member is denied 403). The two UI affordances: the Subjects list
 * defaults to Active and hides the tombstoned subject (the Tombstoned filter
 * reveals it), and the tombstoned detail page is read-only — a "Tombstoned on
 * <date> by <who>" banner, no Edit/Tombstone actions, History still viewable.
 *
 * Data is provisioned per run through the public API (self-contained, no seed
 * dependence — NFR3); the browser is authenticated from fresh admin tokens
 * (AXI-1264) and pointed at the fixture workspace.
 */

interface TombstoneFixture {
  ws: string;
  orgId: string;
  userId: string;
  timepoint: string;
  /** An active subject that stays in the default (Active) list. */
  alive: SubjectFixture;
  /** A subject tombstoned in beforeAll — the read/filter/refusal/UI target. */
  dead: SubjectFixture;
}

let adminApi: APIRequestContext;
let adminTokens: { accessToken: string; refreshToken: string };
let fx: TombstoneFixture;

/** Give a fresh subject one row of history, then return it. */
async function subjectWithHistory(ws: string, tp: string, code: string): Promise<SubjectFixture> {
  const subject = await createSubject(adminApi, ws, code);
  await putRow(adminApi, ws, subject.id, tp, {
    age_at_enrollment: { state: 'present', value: 54 },
    treatment_arm: { state: 'present', value: 'A' },
    clinician_notes: { state: 'not_applicable' },
    bmi: { state: 'present', value: 24.1 },
  });
  return subject;
}

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  adminTokens = await roleTokens('admin');

  const ws = await createWorkspace(adminApi, ctx.orgId, ctx.userId, 'subject-tombstone');
  await publishSchema(adminApi, ws);
  const timepoint = await createTimepoint(adminApi, ws, 'Baseline', 1);

  const alive = await subjectWithHistory(ws, timepoint, 'SUBJ-ALIVE');
  const dead = await subjectWithHistory(ws, timepoint, 'SUBJ-3000');
  // Tombstone the target once; every downstream read/refusal is idempotent.
  await send(adminApi, 'delete', `/api/v1/workspaces/${ws}/subjects/${dead.id}`, ws, {
    reason: 'Withdrew consent',
  });

  fx = { ws, orgId: ctx.orgId, userId: ctx.userId, timepoint, alive, dead };
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** GET a workspace-scoped route with the admin token. */
function adminGet(path: string) {
  return adminApi.get(apiUrl(path), { headers: { 'X-Workspace-Id': fx.ws } });
}

test.describe('AXI-1249 — subject tombstone lifecycle (FR15/AC7/EC9)', () => {
  // ─── API: the tombstone transition (§4.10 step 1) ──────────────────

  test('FR15 AC7 — DELETE with a reason tombstones the subject (200, status tombstoned)', async () => {
    const fresh = await subjectWithHistory(fx.ws, fx.timepoint, 'SUBJ-KILL');
    const res = await adminApi.delete(apiUrl(`/api/v1/workspaces/${fx.ws}/subjects/${fresh.id}`), {
      headers: { 'X-Workspace-Id': fx.ws },
      data: { reason: 'Withdrew consent' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('tombstoned');
    expect(body.id).toBe(fresh.id);
  });

  // ─── API: active-only default + status filters (§4.10 step 2) ───────

  test('FR15 AC7 — the default list is active-only; ?status resolves tombstoned / all', async () => {
    const active = await (await adminGet(`/api/v1/workspaces/${fx.ws}/subjects`)).json();
    const activeCodes = active.subjects.map((s: SubjectFixture) => s.code);
    expect(activeCodes).toContain(fx.alive.code);
    expect(activeCodes).not.toContain(fx.dead.code);

    // ?status=active matches the omitted default exactly.
    const explicit = await (await adminGet(`/api/v1/workspaces/${fx.ws}/subjects?status=active`)).json();
    expect(explicit.subjects.map((s: SubjectFixture) => s.code).sort()).toEqual(activeCodes.sort());

    const tombstoned = await (await adminGet(`/api/v1/workspaces/${fx.ws}/subjects?status=tombstoned`)).json();
    const tombCodes = tombstoned.subjects.map((s: SubjectFixture) => s.code);
    expect(tombCodes).toContain(fx.dead.code);
    expect(tombCodes).not.toContain(fx.alive.code);

    const all = await (await adminGet(`/api/v1/workspaces/${fx.ws}/subjects?status=all`)).json();
    const allCodes = all.subjects.map((s: SubjectFixture) => s.code);
    expect(allCodes).toContain(fx.alive.code);
    expect(allCodes).toContain(fx.dead.code);
  });

  test('NFR4 — an unknown status filter is refused 400 naming the allowed values', async () => {
    const res = await adminGet(`/api/v1/workspaces/${fx.ws}/subjects?status=purged`);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.message).toMatch(/active/);
    expect(body.message).toMatch(/tombstoned/);
    expect(body.message).toMatch(/all/);
  });

  // ─── API: reads stay open while tombstoned (§4.10 step 3, §5.13 step 3) ──

  test('FR15 — history stays readable while tombstoned (subject, rows, rows/history all 200)', async () => {
    expect((await adminGet(`/api/v1/workspaces/${fx.ws}/subjects/${fx.dead.id}`)).status()).toBe(200);
    expect((await adminGet(`/api/v1/workspaces/${fx.ws}/subjects/${fx.dead.id}/rows`)).status()).toBe(200);
    expect((await adminGet(`/api/v1/workspaces/${fx.ws}/subjects/${fx.dead.id}/rows/history`)).status()).toBe(200);
  });

  // ─── API: every write is refused (§4.10 step 4) ────────────────────

  test('FR15 — a tombstoned subject refuses all writes: PATCH, second DELETE, PUT row all 409', async () => {
    const patch = await adminApi.patch(apiUrl(`/api/v1/workspaces/${fx.ws}/subjects/${fx.dead.id}`), {
      headers: { 'X-Workspace-Id': fx.ws },
      data: { code: 'SUBJ-RENAMED', reason: 'rename attempt' },
    });
    expect(patch.status()).toBe(409);

    const secondDelete = await adminApi.delete(apiUrl(`/api/v1/workspaces/${fx.ws}/subjects/${fx.dead.id}`), {
      headers: { 'X-Workspace-Id': fx.ws },
      data: { reason: 'again' },
    });
    expect(secondDelete.status()).toBe(409);

    const putRowRes = await adminApi.put(
      apiUrl(`/api/v1/workspaces/${fx.ws}/subjects/${fx.dead.id}/rows/${fx.timepoint}`),
      {
        headers: { 'X-Workspace-Id': fx.ws },
        data: {
          reason: 'row after tombstone',
          expectedVersion: 1,
          cells: {
            age_at_enrollment: { state: 'present', value: 60 },
            treatment_arm: { state: 'present', value: 'B' },
            clinician_notes: { state: 'not_applicable' },
            bmi: { state: 'missing_unknown' },
          },
        },
      },
    );
    expect(putRowRes.status()).toBe(409);

    // Nothing was written: the code and status are unchanged.
    const after = await (await adminGet(`/api/v1/workspaces/${fx.ws}/subjects/${fx.dead.id}`)).json();
    expect(after.code).toBe(fx.dead.code);
    expect(after.status).toBe('tombstoned');
  });

  // ─── API: 404 vs 409 kept distinct (§5.13 step 1) ──────────────────

  test('FR15 NFR4 — 404 (unknown id) and 409 (already tombstoned) stay distinct', async () => {
    const unknown = await adminApi.delete(
      apiUrl(`/api/v1/workspaces/${fx.ws}/subjects/11111111-1111-1111-1111-111111111111`),
      { headers: { 'X-Workspace-Id': fx.ws }, data: { reason: 'x' } },
    );
    expect(unknown.status()).toBe(404);

    const alreadyDead = await adminApi.delete(apiUrl(`/api/v1/workspaces/${fx.ws}/subjects/${fx.dead.id}`), {
      headers: { 'X-Workspace-Id': fx.ws },
      data: { reason: 'x' },
    });
    expect(alreadyDead.status()).toBe(409);
  });

  // ─── API: code not reusable (EC9, §4.10 step 6) ────────────────────

  test('FR15 EC9 — a tombstoned code is not reusable: POST the same code 409s', async () => {
    const res = await adminApi.post(apiUrl(`/api/v1/workspaces/${fx.ws}/subjects`), {
      headers: { 'X-Workspace-Id': fx.ws },
      data: { code: fx.dead.code, reason: 'reuse attempt' },
    });
    expect(res.status()).toBe(409);
    // The registry still holds exactly one subject with that code (the tombstone).
    const all = await (await adminGet(`/api/v1/workspaces/${fx.ws}/subjects?status=all`)).json();
    expect(all.subjects.filter((s: SubjectFixture) => s.code === fx.dead.code)).toHaveLength(1);
  });

  // ─── API: capability gating unchanged (NFR4, §5.13 step 5) ─────────

  test('NFR4 — a non-member is denied tombstone 403', async () => {
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.delete(apiUrl(`/api/v1/workspaces/${fx.ws}/subjects/${fx.alive.id}`), {
        headers: { 'X-Workspace-Id': fx.ws },
        data: { reason: 'not allowed' },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });

  // ─── UI: list defaults to Active and hides the tombstoned subject ───

  test('AC7 — the Subjects list defaults to Active and hides the tombstoned subject; the Tombstoned filter reveals it', async ({ page }) => {
    await seedBrowserSession(page, adminTokens, fx.ws, fx.orgId);
    await page.goto('/subjects');
    await expect(page.getByRole('heading', { name: 'Subjects' })).toBeVisible();

    // The status filter defaults to Active (a tombstoned subject leaves the list).
    const statusFilter = page.getByRole('combobox');
    await expect(statusFilter).toHaveValue('active');
    await expect(page.getByRole('row', { name: new RegExp(fx.alive.code) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(fx.dead.code) })).toHaveCount(0);

    // Switching to Tombstoned surfaces it; the active subject drops out.
    await statusFilter.selectOption('tombstoned');
    await expect(page.getByRole('row', { name: new RegExp(fx.dead.code) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(fx.alive.code) })).toHaveCount(0);

    // Back to Active drops the tombstoned subject out again.
    await statusFilter.selectOption('active');
    await expect(page.getByRole('row', { name: new RegExp(fx.alive.code) })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(fx.dead.code) })).toHaveCount(0);
  });

  // ─── UI: tombstoned detail is read-only (§4.10 step 8) ─────────────

  test('FR15 — the tombstoned detail is read-only: banner shown, no Edit/Tombstone actions, History still viewable', async ({ page }) => {
    await seedBrowserSession(page, adminTokens, fx.ws, fx.orgId);
    await page.goto(`/subjects/${fx.dead.id}`);

    // The "Tombstoned on <date> by <who>" banner is shown.
    await expect(page.getByText(/Tombstoned on .+ by /)).toBeVisible();

    // The mutating affordances are gone; History stays viewable.
    await expect(page.getByRole('button', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit subject id', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Tombstone', exact: true })).toHaveCount(0);

    // The History panel opens and renders (reads are never status-gated).
    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByRole('button', { name: 'Close history' })).toBeVisible();
  });
});
