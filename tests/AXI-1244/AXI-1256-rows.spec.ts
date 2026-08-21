import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  newRoleRequestContext,
  roleTokens,
  seedBrowserSession,
  createWorkspace,
  publishSchema,
  createTimepoint,
  createSubject,
  putRow,
} from './subject-fixtures';

/**
 * AXI-1256 — subject data rows & missing states (manual-e2e §4.8; epic AXI-1244).
 *
 * Covers the per-subject, per-timepoint data-row surface: the idempotent
 * `PUT .../rows/:timepointId` upsert (same subject+timepoint updates the same
 * row id, never a duplicate — `@@unique([subjectId, timepointId])`, FR10), the
 * FR7 `{schemaId, schemaVersion}` stamp resolved to the ACTIVE published version
 * inside the write transaction (re-PUT after a new publish stamps the new
 * version while an untouched row keeps its original — EC1/EC2), explicit missing
 * states satisfying required columns (FR11/AC5), server-authoritative validation
 * (§5.11), and the deny-by-default non-member 403 (NFR4). The UI half exercises
 * the subject-detail data grid (AXI-1312 presentation of the AXI-1256 surface):
 * the grid renders a row per timepoint with the schema columns and the active
 * schema-version chip, a grid cell edit + mandatory reason saves through the API,
 * and an out-of-range value is refused by the server and not persisted.
 *
 * Data is provisioned per run through the public API (self-contained, no seed
 * dependence — NFR3); the browser is authenticated by injecting fresh admin
 * tokens before `goto` (AXI-1264) and pointed at the fixture workspace.
 */

let adminApi: APIRequestContext;
let orgId: string;
let userId: string;
let adminTokens: { accessToken: string; refreshToken: string };

// Shared read/UI workspace: schema stays at v1, two timepoints.
let ws: string;
let baseline: string;
let week4: string;

let seq = 0;
/** A fresh, schema-legal subject code (`^[A-Za-z0-9_-]{1,64}$`), unique per run. */
function subjectCode(tag: string): string {
  seq += 1;
  return `SUBJ-${tag}-${Date.now()}-${seq}`;
}

/** A full, valid cell payload: two present clinical values + explicit missing
 *  states for the optional analysis/biological columns. */
function cells(age: number, arm: 'A' | 'B') {
  return {
    age_at_enrollment: { state: 'present', value: age },
    treatment_arm: { state: 'present', value: arm },
    clinician_notes: { state: 'not_applicable' },
    bmi: { state: 'not_yet_collected' },
  } as Record<string, { state: string; value?: unknown }>;
}

/** Stand up a self-contained workspace with a published schema (v1) and two
 *  ordinal timepoints. */
async function provisionWorkspace(): Promise<{ ws: string; baseline: string; week4: string }> {
  const w = await createWorkspace(adminApi, orgId, userId, 'rows');
  await publishSchema(adminApi, w);
  const b = await createTimepoint(adminApi, w, 'Baseline', 1);
  const w4 = await createTimepoint(adminApi, w, 'Week 04', 2);
  return { ws: w, baseline: b, week4: w4 };
}

/** GET a workspace-scoped route with the admin token. */
function get(path: string, workspaceId: string) {
  return adminApi.get(apiUrl(path), { headers: { 'X-Workspace-Id': workspaceId } });
}

/** Raw PUT of a row (used for negatives that must read the status, not throw). */
function putRowRaw(
  workspaceId: string,
  subjectId: string,
  timepointId: string,
  body: unknown,
) {
  return adminApi.put(apiUrl(`/api/v1/workspaces/${workspaceId}/subjects/${subjectId}/rows/${timepointId}`), {
    headers: { 'X-Workspace-Id': workspaceId },
    data: body as any,
  });
}

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  orgId = ctx.orgId;
  userId = ctx.userId;
  adminTokens = await roleTokens('admin');
  const p = await provisionWorkspace();
  ws = p.ws;
  baseline = p.baseline;
  week4 = p.week4;
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

test.describe('AXI-1256 — subject data rows & missing states (§4.8)', () => {
  // ─── API surface (FR10 / FR11 / FR7 / AC5) ─────────────────────────

  test('FR10 FR7 AC5 — PUT creates a row that echoes the cells, stamps the active schema version, and lets an explicit missing state satisfy a required column', async () => {
    const subject = await createSubject(adminApi, ws, subjectCode('create'));

    // No data yet — an empty, well-shaped list.
    const empty = await (await get(`/api/v1/workspaces/${ws}/subjects/${subject.id}/rows`, ws)).json();
    expect(empty).toEqual({ rows: [], total: 0 });

    // A required column (treatment_arm) is satisfied by an explicit missing
    // state, never by silence (FR11/AC5).
    const row = await putRow(adminApi, ws, subject.id, baseline, {
      age_at_enrollment: { state: 'present', value: 54 },
      treatment_arm: { state: 'not_applicable' },
      clinician_notes: { state: 'present', value: 'stable' },
      bmi: { state: 'missing_unknown' },
    });

    expect(row.subjectId).toBe(subject.id);
    expect(row.timepointId).toBe(baseline);
    expect(row.cells.age_at_enrollment).toEqual({ state: 'present', value: 54 });
    expect(row.cells.treatment_arm).toEqual({ state: 'not_applicable' });
    expect(row.cells.bmi).toEqual({ state: 'missing_unknown' });
    // FR7 stamp: a schema id plus the ACTIVE published version (v1).
    expect(row.schemaId).toBeTruthy();
    expect(row.schemaVersion).toBe(1);
    expect(row.currentVersion).toBe(1);
  });

  test('FR10 — the row PUT is an idempotent upsert: a second write to the same subject+timepoint updates the same row id, never a duplicate', async () => {
    const subject = await createSubject(adminApi, ws, subjectCode('upsert'));

    const first = await putRow(adminApi, ws, subject.id, baseline, cells(50, 'A'));
    expect(first.currentVersion).toBe(1);

    // Same subject+timepoint again → in-place update (stable head id), not a
    // new row (@@unique([subjectId, timepointId])).
    const second = await putRow(adminApi, ws, subject.id, baseline, cells(51, 'B'), 1);
    expect(second.id).toBe(first.id);
    expect(second.cells.age_at_enrollment).toEqual({ state: 'present', value: 51 });

    const list = await (await get(`/api/v1/workspaces/${ws}/subjects/${subject.id}/rows`, ws)).json();
    expect(list.total).toBe(1);
    expect(list.rows[0].id).toBe(first.id);
  });

  test('FR10 — a second timepoint yields an independent row; the list returns both keyed by timepoint', async () => {
    const subject = await createSubject(adminApi, ws, subjectCode('two-tp'));

    const rowB = await putRow(adminApi, ws, subject.id, baseline, cells(40, 'A'));
    const rowW = await putRow(adminApi, ws, subject.id, week4, cells(41, 'B'));
    expect(rowW.id).not.toBe(rowB.id);

    const list = await (await get(`/api/v1/workspaces/${ws}/subjects/${subject.id}/rows`, ws)).json();
    expect(list.total).toBe(2);
    const byTp = new Map<string, string>(list.rows.map((r: any) => [r.timepointId, r.id]));
    expect(byTp.get(baseline)).toBe(rowB.id);
    expect(byTp.get(week4)).toBe(rowW.id);
  });

  test('FR7 EC1 EC2 — re-PUTting a row after publishing a new schema version stamps the new version, while an untouched row keeps its original stamp', async () => {
    // A dedicated workspace so the version bump never disturbs the shared one.
    const w = await provisionWorkspace();
    const subject = await createSubject(adminApi, w.ws, subjectCode('versioned'));

    await putRow(adminApi, w.ws, subject.id, w.baseline, cells(54, 'A'));
    await putRow(adminApi, w.ws, subject.id, w.week4, cells(55, 'B'));

    // Publish a second schema version (active becomes v2).
    await publishSchema(adminApi, w.ws, undefined, 'AXI-1256 E2E v2');

    // Re-PUT only the Week 04 row → re-resolved to the NEW active version.
    const restamped = await putRow(adminApi, w.ws, subject.id, w.week4, cells(56, 'B'), 1);
    expect(restamped.schemaVersion).toBe(2);

    const list = await (await get(`/api/v1/workspaces/${w.ws}/subjects/${subject.id}/rows`, w.ws)).json();
    const stamp = new Map<string, number>(list.rows.map((r: any) => [r.timepointId, r.schemaVersion]));
    expect(stamp.get(w.baseline)).toBe(1); // untouched → original stamp (EC1/EC2)
    expect(stamp.get(w.week4)).toBe(2); // re-written → new active version
  });

  test('FR11 AC5 — server-side validation is authoritative: an out-of-range value and an omitted required column are each rejected 400, and the row is left unchanged', async () => {
    const subject = await createSubject(adminApi, ws, subjectCode('validate'));
    const good = await putRow(adminApi, ws, subject.id, baseline, cells(50, 'A'));

    // Out-of-range number (max 120).
    const overRange = await putRowRaw(ws, subject.id, baseline, {
      reason: 'bad range',
      expectedVersion: 1,
      cells: cells(130, 'A'),
    });
    expect(overRange.status()).toBe(400);

    // A required column addressed by neither a value nor a missing state.
    const { age_at_enrollment, ...withoutRequired } = cells(50, 'A');
    const omitted = await putRowRaw(ws, subject.id, baseline, {
      reason: 'omit required',
      expectedVersion: 1,
      cells: withoutRequired,
    });
    expect(omitted.status()).toBe(400);

    // The row survived both rejections unchanged.
    const list = await (await get(`/api/v1/workspaces/${ws}/subjects/${subject.id}/rows`, ws)).json();
    expect(list.total).toBe(1);
    expect(list.rows[0].id).toBe(good.id);
    expect(list.rows[0].currentVersion).toBe(1);
    expect(list.rows[0].cells.age_at_enrollment).toEqual({ state: 'present', value: 50 });
  });

  test('NFR4 — a non-member (no subject:read) is denied 403 on both the rows list and the row PUT', async () => {
    const subject = await createSubject(adminApi, ws, subjectCode('deny'));
    const userApi = await newRoleRequestContext('user');
    try {
      const listRes = await userApi.get(apiUrl(`/api/v1/workspaces/${ws}/subjects/${subject.id}/rows`), {
        headers: { 'X-Workspace-Id': ws },
      });
      expect(listRes.status()).toBe(403);

      const putRes = await userApi.put(
        apiUrl(`/api/v1/workspaces/${ws}/subjects/${subject.id}/rows/${baseline}`),
        { headers: { 'X-Workspace-Id': ws }, data: { reason: 'x', expectedVersion: 0, cells: cells(30, 'A') } },
      );
      expect(putRes.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });

  // ─── UI surface (subject detail data grid — FR10 / FR11 / AC5) ──────
  //
  // The live subject-detail data surface is a DataTable-Explorer grid (rows =
  // timepoints, columns = subject_id · timepoint · timestamp · schema columns).
  // A schema-column cell is edited by double-click, which STAGES the value; the
  // "Save changes" bar (enabled only once every required column is filled)
  // opens the mandatory-reason modal, whose "Save change" persists the row.

  /** The subject-data grid, disambiguated from the linked-datasets table by its
   *  unique `subject_id` column header. */
  function dataGrid(page: Page) {
    return page
      .getByRole('table')
      .filter({ has: page.getByRole('columnheader', { name: 'subject_id', exact: true }) });
  }

  /** The nth-schema-column offset: checkbox · # · subject_id · timepoint ·
   *  timestamp precede the schema columns, so `age_at_enrollment` is cell 5 and
   *  `treatment_arm` is cell 6. */
  const AGE_CELL = 5;
  const ARM_CELL = 6;

  /** Stage the two required columns of a timepoint row (number then enum). */
  async function stageRequired(page: Page, row: ReturnType<Page['getByRole']>, age: string, arm: string) {
    await row.getByRole('cell').nth(AGE_CELL).dblclick();
    const number = page.getByRole('spinbutton');
    await number.fill(age);
    await number.press('Enter');
    await row.getByRole('cell').nth(ARM_CELL).dblclick();
    await page.getByRole('combobox').selectOption(arm);
    await page.keyboard.press('Enter');
  }

  test('FR10 FR11 — the subject detail grid renders a row per timepoint with the schema columns and the active schema-version chip', async ({ page }) => {
    const subject = await createSubject(adminApi, ws, subjectCode('ui-render'));
    await putRow(adminApi, ws, subject.id, baseline, cells(54, 'A'));

    await seedBrowserSession(page, adminTokens, ws, orgId);
    await page.goto(`/subjects/${subject.id}`);

    await expect(page.getByRole('heading', { name: new RegExp(subject.code) })).toBeVisible();
    // FR7 surface: the active schema version is shown as a chip.
    await expect(page.getByText('Schema v1')).toBeVisible();

    const grid = dataGrid(page);
    // The grid columns are subject_id · timepoint · timestamp · schema columns.
    await expect(grid.getByRole('columnheader', { name: 'timepoint', exact: true })).toBeVisible();
    await expect(grid.getByRole('columnheader', { name: /Treatment arm/ })).toBeVisible();

    // One row per timepoint; the Baseline row carries the entered age.
    const baselineRow = grid.getByRole('row', { name: /Baseline/ });
    await expect(baselineRow).toBeVisible();
    await expect(baselineRow.getByRole('cell').nth(AGE_CELL)).toHaveText('54');
    await expect(grid.getByRole('row', { name: /Week 04/ })).toBeVisible();
  });

  test('AC5 FR10 — staging a timepoint row and confirming with a mandatory reason saves it, and it re-renders after reload', async ({ page }) => {
    const subject = await createSubject(adminApi, ws, subjectCode('ui-save'));

    await seedBrowserSession(page, adminTokens, ws, orgId);
    await page.goto(`/subjects/${subject.id}`);

    const week4Cell = () => dataGrid(page).getByRole('row', { name: /Week 04/ }).getByRole('cell').nth(AGE_CELL);
    await stageRequired(page, dataGrid(page).getByRole('row', { name: /Week 04/ }), '60', 'A');

    // The "Save changes" bar is enabled once the required columns are filled.
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.getByPlaceholder('Why is this data being recorded or changed?').fill('AXI-1256 E2E grid entry');
    await page.getByRole('button', { name: 'Save change', exact: true }).click();

    await expect(week4Cell()).toHaveText('60');
    // Persisted, not merely staged: it survives a reload from the API.
    await page.reload();
    await expect(week4Cell()).toHaveText('60');
  });

  test('FR8 — an out-of-range value staged in the grid is blocked inline: Save is disabled and the invalid field flagged before any write (AXI-1321)', async ({ page }) => {
    const subject = await createSubject(adminApi, ws, subjectCode('ui-block'));
    await putRow(adminApi, ws, subject.id, baseline, cells(50, 'A'));

    await seedBrowserSession(page, adminTokens, ws, orgId);
    await page.goto(`/subjects/${subject.id}`);

    const baselineCell = () => dataGrid(page).getByRole('row', { name: /Baseline/ }).getByRole('cell').nth(AGE_CELL);
    await expect(baselineCell()).toHaveText('50');

    // Stage an out-of-range age (schema max 120).
    await baselineCell().dblclick();
    await page.getByRole('spinbutton').fill('130');
    await page.getByRole('spinbutton').press('Enter');

    // FR8 mirror: the invalid value is blocked BEFORE any submission — the Save
    // button is disabled and the bar names the invalid field (no server round-trip).
    const saveButton = page.getByRole('button', { name: 'Save changes' });
    await expect(saveButton).toBeDisabled();
    await expect(page.getByText(/fix invalid value/i)).toBeVisible();

    // Correcting to an in-range value releases the gate.
    await baselineCell().dblclick();
    await page.getByRole('spinbutton').fill('60');
    await page.getByRole('spinbutton').press('Enter');
    await expect(saveButton).toBeEnabled();

    // The invalid value was never written: discarding (reload) restores the original.
    await page.reload();
    await expect(baselineCell()).toHaveText('50');
  });
});
