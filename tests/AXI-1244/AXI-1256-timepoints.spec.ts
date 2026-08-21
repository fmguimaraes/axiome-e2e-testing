import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  createSubject,
  createTimepoint,
  createWorkspace,
  newRoleRequestContext,
  publishSchema,
  putRow,
  roleTokens,
  seedBrowserSession,
} from './subject-fixtures';

/**
 * AXI-1256 — workspace timepoint vocabulary (FR30; epic AXI-1244).
 *
 * The full CRUD surface of the per-workspace visit vocabulary at
 * `/api/v1/workspaces/:ws/subject-timepoints`: list, create (201), the
 * name/ordinal uniqueness 409s, rename (PATCH) with its collision 409, the
 * list-based reorder that reassigns ordinals 1..N (and its exact-set 400s), and
 * delete — including the referenced-delete 409 that protects a timepoint a data
 * row keys on (manual-e2e §4.7 / §5.11). The mandatory-reason gate and the
 * unknown-id / non-member deny matrix (NFR1/NFR4) round it out. The UI half
 * (§4.7 step 7) asserts the Timepoints section on `/subjects/schema` exposes the
 * add / rename / reorder / delete affordances to a `subject:schema_manage`
 * member, each prompting for a mandatory reason.
 *
 * Every scenario provisions its own fresh workspace through the public API
 * (self-contained, no ambient-seed dependence — NFR3); the browser is
 * authenticated by injecting fresh admin tokens before `goto` (AXI-1264).
 */

let adminApi: APIRequestContext;
let orgId: string;
let adminUserId: string;
let adminTokens: { accessToken: string; refreshToken: string };

const RANDOM_UUID = '22222222-2222-4222-8222-222222222222'; // valid v4, never a real id

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  orgId = ctx.orgId;
  adminUserId = ctx.userId;
  adminTokens = await roleTokens('admin');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** A fresh, empty-vocabulary workspace the admin owns and is a member of. */
async function freshWorkspace(): Promise<string> {
  return createWorkspace(adminApi, orgId, adminUserId, 'timepoints');
}

/** Raw workspace-scoped request with the admin token (for asserting statuses on
 *  the negative paths, where the throwing `send` helper would mask them). */
function req(
  method: 'post' | 'patch' | 'delete' | 'get',
  path: string,
  ws: string,
  body?: unknown,
) {
  return adminApi[method](apiUrl(path), {
    headers: { 'X-Workspace-Id': ws },
    data: body as any,
  });
}

const tpBase = (ws: string) => `/api/v1/workspaces/${ws}/subject-timepoints`;

async function listTimepoints(ws: string): Promise<{ timepoints: any[]; total: number }> {
  const res = await req('get', tpBase(ws), ws);
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe('AXI-1256 — workspace timepoint vocabulary (FR30)', () => {
  // ─── API: list & create ────────────────────────────────────────────

  test('FR30 — an unmanaged workspace exposes an empty vocabulary', async () => {
    const ws = await freshWorkspace();
    const body = await listTimepoints(ws);
    expect(body.timepoints).toEqual([]);
    expect(body.total).toBe(0);
  });

  test('FR30 — POST creates timepoints (201) that list ordered by ordinal with audit fields', async () => {
    const ws = await freshWorkspace();
    const created = await req('post', tpBase(ws), ws, { name: 'Baseline', ordinal: 1, reason: 'Initial visit map' });
    expect(created.status()).toBe(201);
    const row = await created.json();
    expect(row).toMatchObject({ name: 'Baseline', ordinal: 1, workspaceId: ws });
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeTruthy();
    expect(row.updatedAt).toBeTruthy();

    // Insert out of ordinal order to prove the list sorts by ordinal, not insertion.
    expect((await req('post', tpBase(ws), ws, { name: 'Week 12', ordinal: 3, reason: 'x' })).status()).toBe(201);
    expect((await req('post', tpBase(ws), ws, { name: 'Week 4', ordinal: 2, reason: 'x' })).status()).toBe(201);

    const body = await listTimepoints(ws);
    expect(body.total).toBe(3);
    expect(body.timepoints.map((t) => t.name)).toEqual(['Baseline', 'Week 4', 'Week 12']);
    expect(body.timepoints.map((t) => t.ordinal)).toEqual([1, 2, 3]);
  });

  test('FR30 — a duplicate name and a duplicate ordinal are each refused 409 (unique per workspace)', async () => {
    const ws = await freshWorkspace();
    await createTimepoint(adminApi, ws, 'Baseline', 1);
    await createTimepoint(adminApi, ws, 'Week 4', 2);

    const nameCollision = await req('post', tpBase(ws), ws, { name: 'Baseline', ordinal: 9, reason: 'dup check' });
    expect(nameCollision.status()).toBe(409);

    const ordinalCollision = await req('post', tpBase(ws), ws, { name: 'Screening', ordinal: 1, reason: 'dup check' });
    expect(ordinalCollision.status()).toBe(409);

    // Neither collision wrote a row.
    expect((await listTimepoints(ws)).total).toBe(2);
  });

  // ─── API: rename ───────────────────────────────────────────────────

  test('FR30 — PATCH renames a timepoint (200); renaming onto an existing name is 409', async () => {
    const ws = await freshWorkspace();
    await createTimepoint(adminApi, ws, 'Baseline', 1);
    const week4 = await createTimepoint(adminApi, ws, 'Week 4', 2);

    const renamed = await req('patch', `${tpBase(ws)}/${week4}`, ws, { name: 'Week 04', reason: 'Naming convention' });
    expect(renamed.status()).toBe(200);
    expect((await renamed.json()).name).toBe('Week 04');

    const collision = await req('patch', `${tpBase(ws)}/${week4}`, ws, { name: 'Baseline', reason: 'collide' });
    expect(collision.status()).toBe(409);
    // The rename that collided did not stick.
    const names = (await listTimepoints(ws)).timepoints.map((t) => t.name);
    expect(names).toEqual(['Baseline', 'Week 04']);
  });

  // ─── API: reorder ──────────────────────────────────────────────────

  test('FR30 — POST /reorder reassigns ordinals 1..N in the given order', async () => {
    const ws = await freshWorkspace();
    const baseline = await createTimepoint(adminApi, ws, 'Baseline', 1);
    const week4 = await createTimepoint(adminApi, ws, 'Week 4', 2);
    const week12 = await createTimepoint(adminApi, ws, 'Week 12', 3);

    const res = await req('post', `${tpBase(ws)}/reorder`, ws, {
      orderedIds: [week12, baseline, week4],
      reason: 'Protocol amendment',
    });
    expect(res.status()).toBe(200);

    const body = await listTimepoints(ws);
    expect(body.timepoints.map((t) => t.name)).toEqual(['Week 12', 'Baseline', 'Week 4']);
    expect(body.timepoints.map((t) => t.ordinal)).toEqual([1, 2, 3]);
  });

  test('FR30 — /reorder rejects an incomplete or foreign id set with 400', async () => {
    const ws = await freshWorkspace();
    const baseline = await createTimepoint(adminApi, ws, 'Baseline', 1);
    const week4 = await createTimepoint(adminApi, ws, 'Week 4', 2);

    // Missing an id — must contain EXACTLY the workspace's timepoints.
    const missing = await req('post', `${tpBase(ws)}/reorder`, ws, { orderedIds: [baseline], reason: 'partial' });
    expect(missing.status()).toBe(400);

    // A foreign (well-formed v4) id — likewise refused before any write.
    const foreign = await req('post', `${tpBase(ws)}/reorder`, ws, {
      orderedIds: [baseline, week4, RANDOM_UUID],
      reason: 'foreign',
    });
    expect(foreign.status()).toBe(400);

    // Order untouched by either rejection.
    expect((await listTimepoints(ws)).timepoints.map((t) => t.ordinal)).toEqual([1, 2]);
  });

  // ─── API: delete ───────────────────────────────────────────────────

  test('FR30 — DELETE removes an unreferenced timepoint (200) and it leaves the list', async () => {
    const ws = await freshWorkspace();
    await createTimepoint(adminApi, ws, 'Baseline', 1);
    const week12 = await createTimepoint(adminApi, ws, 'Week 12', 2);

    const res = await req('delete', `${tpBase(ws)}/${week12}`, ws, { reason: 'Not in protocol v2' });
    expect(res.status()).toBe(200);

    const names = (await listTimepoints(ws)).timepoints.map((t) => t.name);
    expect(names).toEqual(['Baseline']);
  });

  test('FR30 — a timepoint referenced by a data row refuses deletion (409); the row survives', async () => {
    const ws = await freshWorkspace();
    await publishSchema(adminApi, ws);
    const baseline = await createTimepoint(adminApi, ws, 'Baseline', 1);
    const week4 = await createTimepoint(adminApi, ws, 'Week 4', 2);
    const subject = await createSubject(adminApi, ws, 'SUBJ-TP01');
    await putRow(adminApi, ws, subject.id, baseline, {
      age_at_enrollment: { state: 'present', value: 40 },
      treatment_arm: { state: 'present', value: 'A' },
    });

    // Baseline now carries a row → deletion is refused.
    const referenced = await req('delete', `${tpBase(ws)}/${baseline}`, ws, { reason: 'remove referenced' });
    expect(referenced.status()).toBe(409);

    // The referenced timepoint and its row both survive; the unreferenced one still deletes.
    expect((await listTimepoints(ws)).timepoints.map((t) => t.name)).toEqual(['Baseline', 'Week 4']);
    const rows = await req('get', `/api/v1/workspaces/${ws}/subjects/${subject.id}/rows`, ws);
    expect(rows.status()).toBe(200);

    const unreferenced = await req('delete', `${tpBase(ws)}/${week4}`, ws, { reason: 'unused' });
    expect(unreferenced.status()).toBe(200);
  });

  // ─── API: deny / validation matrix (NFR1 / NFR4) ───────────────────

  test('FR30 NFR1 — every mutation demands a non-blank reason (400)', async () => {
    const ws = await freshWorkspace();
    const baseline = await createTimepoint(adminApi, ws, 'Baseline', 1);
    const week4 = await createTimepoint(adminApi, ws, 'Week 4', 2);
    const blank = '   ';

    expect((await req('post', tpBase(ws), ws, { name: 'Week 12', ordinal: 3, reason: blank })).status()).toBe(400);
    expect((await req('patch', `${tpBase(ws)}/${week4}`, ws, { name: 'Week 04', reason: blank })).status()).toBe(400);
    expect(
      (await req('post', `${tpBase(ws)}/reorder`, ws, { orderedIds: [week4, baseline], reason: blank })).status(),
    ).toBe(400);
    expect((await req('delete', `${tpBase(ws)}/${week4}`, ws, { reason: blank })).status()).toBe(400);

    // Nothing changed under any blank-reason attempt.
    expect((await listTimepoints(ws)).timepoints.map((t) => t.name)).toEqual(['Baseline', 'Week 4']);
  });

  test('FR30 NFR4 — PATCH and DELETE on an unknown id are 404 (cross-workspace isolation)', async () => {
    const ws = await freshWorkspace();
    await createTimepoint(adminApi, ws, 'Baseline', 1);

    expect((await req('patch', `${tpBase(ws)}/${RANDOM_UUID}`, ws, { name: 'Ghost', reason: 'x' })).status()).toBe(404);
    expect((await req('delete', `${tpBase(ws)}/${RANDOM_UUID}`, ws, { reason: 'x' })).status()).toBe(404);
  });

  test('FR30 NFR4 — a non-member of the workspace is denied 403 (deny-by-default)', async () => {
    const ws = await freshWorkspace();
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.post(apiUrl(tpBase(ws)), {
        headers: { 'X-Workspace-Id': ws },
        data: { name: 'Baseline', ordinal: 1, reason: 'x' },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });

  // ─── UI: the Timepoints section on /subjects/schema (§4.7 step 7) ────

  test('FR30 — the schema page Timepoints section lists the vocabulary with manage affordances that prompt for a reason', async ({ page }) => {
    // A schema-enabled workspace with a three-visit vocabulary to render.
    const ws = await freshWorkspace();
    await publishSchema(adminApi, ws);
    await createTimepoint(adminApi, ws, 'Baseline', 1);
    await createTimepoint(adminApi, ws, 'Week 4', 2);
    await createTimepoint(adminApi, ws, 'Week 12', 3);

    await seedBrowserSession(page, adminTokens, ws, orgId);
    await page.goto('/subjects/schema');

    // The section renders and lists the vocabulary by ordinal.
    const heading = page.getByRole('heading', { name: 'Timepoints' });
    await expect(heading).toBeVisible();
    const items = page.getByRole('listitem').filter({ hasText: /Baseline|Week 4|Week 12/ });
    await expect(items).toHaveText([/Baseline/, /Week 4/, /Week 12/]);

    // As a subject:schema_manage member the add + per-row affordances are present.
    await expect(page.getByRole('button', { name: 'Add timepoint' })).toBeVisible();
    const baselineRow = page.getByRole('listitem').filter({ hasText: 'Baseline' });
    await expect(baselineRow.getByRole('button', { name: 'Rename' })).toBeVisible();
    await expect(baselineRow.getByRole('button', { name: 'Delete' })).toBeVisible();
    await expect(baselineRow.getByRole('button', { name: 'Move up' })).toBeVisible();
    await expect(baselineRow.getByRole('button', { name: 'Move down' })).toBeVisible();

    // Reorder affordance: staging a move surfaces the commit control.
    await baselineRow.getByRole('button', { name: 'Move down' }).click();
    await expect(page.getByRole('button', { name: 'Save order' })).toBeVisible();

    // Every mutation prompts for a mandatory reason — the Add panel refuses a
    // blank reason with an inline error, proving the reason gate at the UI layer.
    await page.getByRole('button', { name: 'Add timepoint' }).click();
    await expect(page.getByRole('heading', { name: 'Add timepoint' })).toBeVisible();
    await expect(page.getByPlaceholder('Recorded in the audit trail')).toBeVisible();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('A reason is required for every vocabulary change.')).toBeVisible();
  });
});
