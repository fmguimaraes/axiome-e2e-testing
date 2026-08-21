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
  send,
} from './subject-fixtures';

/**
 * AXI-1248 — change control: correction versions & per-subject history
 * (FR12, FR13, FR14, NFR5, AC6, EC3, NFR4; manual-e2e §4.9 and §5.12).
 *
 * A correction is a `PUT /rows/:timepointId` carrying a changed cell and the
 * row's current version as `expectedVersion`: it appends a new immutable version
 * on a stable row id, never overwriting the prior one. This spec pins the whole
 * versioning contract deterministically — the append-and-supersede write (FR13),
 * the newest-first per-subject history with supersedes/superseded flags and
 * who/when/why metadata (FR14), prior-version immutability across further
 * corrections (NFR5), and the optimistic-concurrency matrix (EC3): a stale token
 * → 409 with no version written, a missing/non-numeric token → 400, the
 * first-write token (`expectedVersion: 0` on a fresh timepoint → v1), and a
 * non-zero token where no row exists → 409. It also covers the reason mandate
 * (FR12) and the deny-by-default history read (NFR4). Data is provisioned per run
 * through the public API (self-contained, no seed dependence); the browser is
 * authenticated by injecting fresh admin tokens before `goto` (AXI-1264). The
 * two-tab conflict banner is left to manual verification (non-deterministic
 * cross-tab timing — see the story's manual residue).
 */

// Schema with two clinical columns + one analysis column; `age_at_enrollment`
// is the value a correction changes across versions.
const COLUMNS = [
  { key: 'age_at_enrollment', label: 'Age at enrollment', type: 'number', category: 'clinical', required: true, unit: 'years', min: 18, max: 120 },
  { key: 'treatment_arm', label: 'Treatment arm', type: 'enum', category: 'clinical', required: true, enumValues: ['A', 'B'] },
  { key: 'clinician_notes', label: 'Clinician notes', type: 'text', category: 'analysis', required: false },
];

/** A row payload at the given age; the other cells are stable across versions. */
function cellsAt(age: number) {
  return {
    age_at_enrollment: { state: 'present', value: age },
    treatment_arm: { state: 'present', value: 'A' },
    clinician_notes: { state: 'not_applicable' },
  };
}

let adminApi: APIRequestContext;
let adminTokens: { accessToken: string; refreshToken: string };
let ws: string;
let orgId: string;
let userId: string;
let tpBase: string;
let tpWeek4: string;

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  orgId = ctx.orgId;
  userId = ctx.userId;
  adminTokens = await roleTokens('admin');

  ws = await createWorkspace(adminApi, orgId, userId, 'subject-corrections');
  await publishSchema(adminApi, ws, COLUMNS);
  tpBase = await createTimepoint(adminApi, ws, 'Baseline', 1);
  tpWeek4 = await createTimepoint(adminApi, ws, 'Week 4', 2);
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** Provision a fresh subject with a v1 row at `tpBase` (age 54, reason
 *  "Baseline data entry"). Each test gets its own subject so version state
 *  never leaks across tests. Returns the subject id. */
async function subjectWithBaseRow(): Promise<string> {
  const subject = await createSubject(adminApi, ws, `SUBJ-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await putRow(adminApi, ws, subject.id, tpBase, cellsAt(54), 0, 'Baseline data entry');
  return subject.id;
}

/** Raw workspace-scoped PUT that returns the response (no throw-on-error), for
 *  asserting the exact negative status codes the builders would mask. */
function rawPut(subjectId: string, timepointId: string, body: unknown) {
  return adminApi.put(apiUrl(`/api/v1/workspaces/${ws}/subjects/${subjectId}/rows/${timepointId}`), {
    headers: { 'X-Workspace-Id': ws },
    data: body as any,
  });
}

test.describe('AXI-1248 — correction versions & per-subject history (§4.9/§5.12)', () => {
  // ─── Correction write (FR13 / AC6) ─────────────────────────────────

  test('FR13 AC6 — a correction appends a new version on a stable row id', async () => {
    const subjectId = await subjectWithBaseRow();

    // The v1 row is the optimistic-concurrency token source (EC3).
    const rows = await send(adminApi, 'get', `/api/v1/workspaces/${ws}/subjects/${subjectId}/rows`, ws);
    const baseRow = rows.rows.find((r: any) => r.timepointId === tpBase);
    expect(baseRow.currentVersion).toBe(1);

    const corrected = await putRow(
      adminApi,
      ws,
      subjectId,
      tpBase,
      cellsAt(55),
      baseRow.currentVersion,
      'Corrected age from source document',
    );
    // New current version, same stable row id (FR10 head), corrected cell.
    expect(corrected.currentVersion).toBe(2);
    expect(corrected.id).toBe(baseRow.id);
    expect(corrected.cells.age_at_enrollment.value).toBe(55);
  });

  // ─── Full per-subject history (FR14) ───────────────────────────────

  test('FR14 — history returns every version newest-first with supersedes/superseded flags', async () => {
    const subjectId = await subjectWithBaseRow();
    await putRow(adminApi, ws, subjectId, tpBase, cellsAt(55), 1, 'Corrected age from source document');

    const history = await send(adminApi, 'get', `/api/v1/workspaces/${ws}/subjects/${subjectId}/rows/history`, ws);
    expect(history.total).toBe(2);
    expect(history.versions).toHaveLength(2);

    const [current, prior] = history.versions;
    // Newest first: v2 current, pointing back at v1; v1 superseded, no pointer.
    expect(current.version).toBe(2);
    expect(current.superseded).toBe(false);
    expect(current.supersedesId).toBe(prior.id);
    expect(current.cells.age_at_enrollment.value).toBe(55);
    expect(current.reason).toBe('Corrected age from source document');

    expect(prior.version).toBe(1);
    expect(prior.superseded).toBe(true);
    expect(prior.supersedesId).toBeNull();
    expect(prior.cells.age_at_enrollment.value).toBe(54);
    expect(prior.reason).toBe('Baseline data entry');

    // Every entry carries who / when / why / schema stamp / timepoint / version.
    for (const v of history.versions) {
      expect(v.createdBy).toBe(userId);
      expect(typeof v.createdAt).toBe('string');
      expect(typeof v.reason).toBe('string');
      expect(v.schemaVersion).toBe(1);
      expect(v.timepointId).toBe(tpBase);
      expect(typeof v.version).toBe('number');
    }
  });

  // ─── Prior-version immutability (NFR5) ─────────────────────────────

  test('NFR5 — a prior version is immutable across further corrections (append-only)', async () => {
    const subjectId = await subjectWithBaseRow();
    await putRow(adminApi, ws, subjectId, tpBase, cellsAt(55), 1, 'First correction');

    const historyPath = `/api/v1/workspaces/${ws}/subjects/${subjectId}/rows/history`;
    const afterFirst = await send(adminApi, 'get', historyPath, ws);
    const v1Before = afterFirst.versions.find((v: any) => v.version === 1);

    // A third write must not disturb version 1 in any field.
    await putRow(adminApi, ws, subjectId, tpBase, cellsAt(56), 2, 'Second correction');
    const afterSecond = await send(adminApi, 'get', historyPath, ws);
    const v1After = afterSecond.versions.find((v: any) => v.version === 1);

    expect(v1After).toEqual(v1Before);
    // The head advanced; only the tail is frozen.
    expect(afterSecond.versions[0].version).toBe(3);
  });

  // ─── Optimistic concurrency (EC3 / AC6) ────────────────────────────

  test('FR13 AC6 — a stale expectedVersion is refused 409 with no new version written (EC3)', async () => {
    const subjectId = await subjectWithBaseRow();
    await putRow(adminApi, ws, subjectId, tpBase, cellsAt(55), 1, 'Advance to v2');

    // A second editor that loaded the row at v1 tries to save over v2.
    const res = await rawPut(subjectId, tpBase, {
      reason: 'Stale write',
      expectedVersion: 1,
      cells: cellsAt(99),
    });
    expect(res.status()).toBe(409);

    // No version was appended — history still holds exactly the two real ones.
    const history = await send(adminApi, 'get', `/api/v1/workspaces/${ws}/subjects/${subjectId}/rows/history`, ws);
    expect(history.total).toBe(2);
    expect(history.versions[0].version).toBe(2);
    expect(history.versions[0].cells.age_at_enrollment.value).toBe(55);
  });

  test('FR13 — the first-write token (expectedVersion 0) opens a fresh timepoint at version 1 (EC3)', async () => {
    const subjectId = await subjectWithBaseRow();
    // A different, empty timepoint on the same subject.
    const created = await putRow(adminApi, ws, subjectId, tpWeek4, cellsAt(40), 0, 'Week 4 entry');
    expect(created.currentVersion).toBe(1);
    expect(created.timepointId).toBe(tpWeek4);
  });

  test('FR13 — a non-zero expectedVersion where no row exists is refused 409 (EC3)', async () => {
    // Fresh subject, fresh timepoint, no row yet: a non-zero token is stale.
    const subject = await createSubject(adminApi, ws, `SUBJ-nr-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const res = await rawPut(subject.id, tpBase, {
      reason: 'Assumed an existing row',
      expectedVersion: 5,
      cells: cellsAt(40),
    });
    expect(res.status()).toBe(409);
  });

  // ─── Gateway DTO guards (FR13 token / FR12 reason) ─────────────────

  test('FR13 — a missing/non-numeric expectedVersion is rejected 400 at the gateway (EC3)', async () => {
    const subjectId = await subjectWithBaseRow();
    const res = await rawPut(subjectId, tpBase, {
      reason: 'No token',
      cells: cellsAt(55),
    });
    expect(res.status()).toBe(400);
  });

  test('FR12 — a correction with an empty/whitespace reason is rejected 400', async () => {
    const subjectId = await subjectWithBaseRow();
    const res = await rawPut(subjectId, tpBase, {
      reason: '   ',
      expectedVersion: 1,
      cells: cellsAt(55),
    });
    expect(res.status()).toBe(400);
  });

  // ─── History read is capability-gated (NFR4) ───────────────────────

  test('NFR4 — a non-member is denied the history read 403 (deny-by-default)', async () => {
    const subjectId = await subjectWithBaseRow();
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.get(apiUrl(`/api/v1/workspaces/${ws}/subjects/${subjectId}/rows/history`), {
        headers: { 'X-Workspace-Id': ws },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });

  // ─── History panel UI (AC6 / FR14) ─────────────────────────────────

  test('AC6 FR14 — the subject History panel lists versions newest-first and marks superseded', async ({ page }: { page: Page }) => {
    const subjectId = await subjectWithBaseRow();
    await putRow(adminApi, ws, subjectId, tpBase, cellsAt(55), 1, 'Corrected age from source document');

    await seedBrowserSession(page, adminTokens, ws, orgId);
    await page.goto(`/subjects/${subjectId}`);

    await page.getByRole('button', { name: 'History' }).click();

    // The panel opens with its heading and both versions, current + superseded.
    await expect(page.getByRole('heading', { name: 'Change history' }).first()).toBeVisible();
    await expect(page.getByText('superseded')).toBeVisible();
    await expect(page.getByText('current', { exact: true })).toBeVisible();
    // The correction's reason (who/when/why) is surfaced on the version.
    await expect(page.getByText('Corrected age from source document')).toBeVisible();
  });
});
