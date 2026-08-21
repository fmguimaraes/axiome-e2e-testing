import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  adminContext,
  createWorkspace,
  newRoleRequestContext,
  publishSchema,
  send,
} from './subject-fixtures';

/**
 * AXI-1246 — schema-driven row validation, dry run (FR7, FR8, AC4 server half;
 * FR11/AC5 missing-state vocabulary; EC1/EC2 version pinning).
 *
 * The endpoint `POST /api/v1/workspaces/:ws/subject-schema/validate` validates a
 * candidate row payload against the workspace's ACTIVE PUBLISHED schema version
 * and writes nothing (it is a read, gated `subject:read`). This spec exercises
 * the deterministic, synchronous request/response surface only (manual-e2e §4.6
 * and §5.9): a fully valid payload and its `{schemaId, schemaVersion}` stamp
 * (FR7); explicit missing states satisfying a required column while an optional
 * column is omitted (FR11/AC5); inclusive numeric bounds; the type / enum /
 * required / out-of-range / unknown-column / missing-state-vocabulary rejections
 * that each return `valid:false` with per-column `{columnKey, code, message}`
 * (FR8/AC4), all defects reported in one call; the version rebind after a v2
 * publish (EC1/EC2 forward half); the schema-less 400 precondition; and the
 * deny-by-default 403. Data is provisioned per run through the public API
 * (self-contained — NFR3).
 */

let adminApi: APIRequestContext;
let ws: string;
let plainWs: string;
let schemaId: string;
let orgId: string;
let adminUserId: string;

/** The default published schema shape, mirrored for the v2 tighten test. */
const TIGHTER_COLUMNS = [
  { key: 'age_at_enrollment', label: 'Age at enrollment', type: 'number', category: 'clinical', required: true, unit: 'years', min: 18, max: 110 },
  { key: 'treatment_arm', label: 'Treatment arm', type: 'enum', category: 'clinical', required: true, enumValues: ['A', 'B'] },
  { key: 'clinician_notes', label: 'Clinician notes', type: 'text', category: 'analysis', required: false },
  { key: 'bmi', label: 'BMI', type: 'number', category: 'biological', required: false },
];

type Cells = Record<string, { state?: string; value?: unknown }>;
interface ValidateResult {
  schemaId: string;
  schemaVersion: number;
  valid: boolean;
  errors: Array<{ columnKey: string; code: string; message: string }>;
}

test.beforeAll(async () => {
  const ctx = await adminContext();
  orgId = ctx.orgId;
  adminUserId = ctx.userId;
  ws = await createWorkspace(ctx.api, orgId, adminUserId, 'row-validation');
  await publishSchema(ctx.api, ws); // active published version 1, default SCHEMA_COLUMNS
  plainWs = await createWorkspace(ctx.api, orgId, adminUserId, 'row-validation-plain'); // no schema
  const schema = await send(ctx.api, 'get', `/api/v1/workspaces/${ws}/subject-schema`, ws);
  schemaId = schema.schemaId;
  await ctx.api.dispose();
  adminApi = await newRoleRequestContext('admin');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** Dry-run validate `cells` against `workspaceId`'s active schema (200-level even
 *  when invalid, so `send` returns the body rather than throwing). */
function validate(workspaceId: string, cells: Cells): Promise<ValidateResult> {
  return send(adminApi, 'post', `/api/v1/workspaces/${workspaceId}/subject-schema/validate`, workspaceId, { cells });
}

/** Collapse the per-column errors into a `columnKey → code` lookup. */
function codesByColumn(res: ValidateResult): Record<string, string> {
  return Object.fromEntries(res.errors.map((e) => [e.columnKey, e.code]));
}

test.describe('AXI-1246 — schema-driven row validation dry run (FR7/FR8/AC4)', () => {
  test('FR7 AC4 — a fully valid payload returns valid:true, empty errors[], and the {schemaId, schemaVersion} stamp', async () => {
    const res = await validate(ws, {
      age_at_enrollment: { state: 'present', value: 54 },
      treatment_arm: { state: 'present', value: 'A' },
      clinician_notes: { state: 'present', value: 'stable at week 4' },
      bmi: { state: 'present', value: 24.1 },
    });
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
    // FR7 version stamp: the active published version (1) and this workspace's schema id.
    expect(res.schemaId).toBe(schemaId);
    expect(res.schemaVersion).toBe(1);
  });

  test('FR8 FR11 AC5 — explicit missing states satisfy a required column and an optional column may be omitted', async () => {
    // age (required) + treatment_arm (required) carry explicit missing states;
    // clinician_notes (optional) is omitted from the payload entirely.
    const res = await validate(ws, {
      age_at_enrollment: { state: 'not_yet_collected' },
      treatment_arm: { state: 'not_applicable' },
      bmi: { state: 'missing_unknown' },
    });
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
  });

  test('FR8 AC4 — numeric min/max bounds are inclusive at 18 and 120', async () => {
    for (const value of [18, 120]) {
      const res = await validate(ws, {
        age_at_enrollment: { state: 'present', value },
        treatment_arm: { state: 'present', value: 'A' },
      });
      expect(res.valid, `age ${value} is inclusive`).toBe(true);
      expect(res.errors).toEqual([]);
    }
  });

  test('FR8 AC4 — an out-of-range number (above max and below min) returns out_of_range', async () => {
    for (const value of [130, 17]) {
      const res = await validate(ws, {
        age_at_enrollment: { state: 'present', value },
        treatment_arm: { state: 'present', value: 'A' },
      });
      expect(res.valid, `age ${value} is out of range`).toBe(false);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]).toMatchObject({ columnKey: 'age_at_enrollment', code: 'out_of_range' });
      expect(res.errors[0].message).toBeTruthy();
    }
  });

  test('FR8 AC4 — type/enum/required/unknown-column violations all surface in one call as per-column {columnKey, code, message}', async () => {
    const res = await validate(ws, {
      // age_at_enrollment omitted entirely → required_missing
      treatment_arm: { state: 'present', value: 'C' }, // enum_mismatch
      clinician_notes: { state: 'present', value: true }, // type_mismatch (bool in text)
      smoking_status: { state: 'present', value: 'never' }, // unknown_column
    });
    expect(res.valid).toBe(false);
    const codes = codesByColumn(res);
    expect(codes).toMatchObject({
      age_at_enrollment: 'required_missing',
      treatment_arm: 'enum_mismatch',
      clinician_notes: 'type_mismatch',
      smoking_status: 'unknown_column',
    });
    // Every defect carries a human message (field-level rendering — AC4).
    for (const e of res.errors) {
      expect(e.message, `message for ${e.columnKey}`).toBeTruthy();
    }
  });

  test('FR11 AC5 — missing-state vocabulary violations return invalid_missing_state / value_missing / value_conflict', async () => {
    const base = {
      age_at_enrollment: { state: 'present', value: 50 },
      treatment_arm: { state: 'present', value: 'A' },
    };
    // A state outside the three-value vocabulary.
    const invalid = await validate(ws, { ...base, bmi: { state: 'unknown' } });
    expect(codesByColumn(invalid)).toMatchObject({ bmi: 'invalid_missing_state' });

    // Present without a value.
    const missing = await validate(ws, { ...base, bmi: { state: 'present' } });
    expect(codesByColumn(missing)).toMatchObject({ bmi: 'value_missing' });

    // An explicit missing state carrying a REAL value (present value XOR missing state).
    const conflict = await validate(ws, { ...base, bmi: { state: 'not_applicable', value: 22 } });
    expect(codesByColumn(conflict)).toMatchObject({ bmi: 'value_conflict' });

    // value:null alongside a missing state is the platform CellState convention — accepted.
    const nulled = await validate(ws, { ...base, bmi: { state: 'not_applicable', value: null } });
    expect(nulled.valid).toBe(true);
    expect(nulled.errors).toEqual([]);
  });

  test('FR7 — validation binds to the version active at call time: a tightened v2 re-binds and rejects a formerly-valid value', async () => {
    // A dedicated workspace so the rebind cannot perturb the v1 assertions above.
    const ctx = await adminContext();
    try {
      const rebindWs = await createWorkspace(ctx.api, ctx.orgId, ctx.userId, 'row-validation-v2');
      await publishSchema(ctx.api, rebindWs); // v1: max 120
      // Under v1, age 115 is valid.
      const underV1 = await validate(rebindWs, {
        age_at_enrollment: { state: 'present', value: 115 },
        treatment_arm: { state: 'present', value: 'A' },
      });
      expect(underV1.schemaVersion).toBe(1);
      expect(underV1.valid).toBe(true);

      // Publish v2 tightening max to 110.
      await send(ctx.api, 'put', `/api/v1/workspaces/${rebindWs}/subject-schema/draft`, rebindWs, {
        expectedDraftVersion: 0,
        columns: TIGHTER_COLUMNS,
      });
      await send(ctx.api, 'post', `/api/v1/workspaces/${rebindWs}/subject-schema/publish`, rebindWs, {
        reason: 'AXI-1246 E2E tighten age bound',
        expectedDraftVersion: 1,
      });

      // The same payload now binds to v2 and is out of range (EC1/EC2 forward half).
      const underV2 = await validate(rebindWs, {
        age_at_enrollment: { state: 'present', value: 115 },
        treatment_arm: { state: 'present', value: 'A' },
      });
      expect(underV2.schemaVersion).toBe(2);
      expect(underV2.valid).toBe(false);
      expect(codesByColumn(underV2)).toMatchObject({ age_at_enrollment: 'out_of_range' });
    } finally {
      await ctx.api.dispose();
    }
  });

  test('FR7 AC4 — a workspace with no published schema returns a clean 400 (not a valid:false, not a 500)', async () => {
    const res = await adminApi.post(apiUrl(`/api/v1/workspaces/${plainWs}/subject-schema/validate`), {
      headers: { 'X-Workspace-Id': plainWs },
      data: { cells: { age_at_enrollment: { state: 'present', value: 54 } } },
    });
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain('published subject schema');
  });

  test('NFR4 — a caller without subject:read (non-member) is denied 403 (deny-by-default)', async () => {
    const userApi = await newRoleRequestContext('user');
    try {
      const res = await userApi.post(apiUrl(`/api/v1/workspaces/${ws}/subject-schema/validate`), {
        headers: { 'X-Workspace-Id': ws },
        data: { cells: { age_at_enrollment: { state: 'present', value: 54 } } },
      });
      expect(res.status()).toBe(403);
    } finally {
      await userApi.dispose();
    }
  });
});
