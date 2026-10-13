import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1928 — Parity: statsmodels family (epic AXI-1912; manual-e2e
 * `AXI-1912-Method-Validation.md` § AXI-1928, Scenario 4).
 *
 * The parity evidence itself (R `lme4::lmer` / `car::Anova` fixtures run
 * through the pipeline) is command-verified in `axiome-bio-compute`; it has no
 * browser surface. What this spec proves on the RUNNING stack is that the
 * contract those fixtures validate is the contract users are actually served:
 * the same operation ids, the same bound roles, the same parameter range, the
 * same output columns field for field, and the hard (BLOCK) preconditions
 * behind the typed refusals the refusal fixtures exercise. If the served
 * descriptor drifts from the validated one, the parity evidence no longer
 * covers what runs, and this spec turns red.
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run and
 * mutates no state.
 */

interface ColumnRoleDescriptor {
  role: string;
  required: boolean;
  cardinality: string;
  requiredShape?: string | null;
  help?: { why?: string } | null;
}

interface ParameterDescriptor {
  key: string;
  required: boolean;
  default?: unknown;
  min?: number | null;
  max?: number | null;
  minExclusive?: boolean;
  maxExclusive?: boolean;
}

interface OperationDescriptor {
  operationId: string;
  runKind: string;
  columnRoles: ColumnRoleDescriptor[];
  parameters: ParameterDescriptor[];
  preconditions: Array<{ id: string; severity: string }>;
  output: { shapes: Record<string, { grain: string; columns: string[] }> };
}

// The exact output fields the parity fixtures compare (MSR io_schema outputs).
const LMM_FIXTURE_FIELDS = ['term', 'estimate', 'ciLow', 'ciHigh', 'pValue', 'reason'];
const VC_FIXTURE_FIELDS = [
  'measurement', 'n', 'diseaseVarianceShare', 'siteVarianceShare', 'batchVarianceShare',
  'residualVarianceShare', 'fStatistic', 'dofNumerator', 'dofDenominator', 'pValue', 'reason',
];

let adminTokens: Promise<{ accessToken: string }> | undefined;

function cachedAdminTokens(): Promise<{ accessToken: string }> {
  if (!adminTokens) {
    adminTokens = (async () => {
      const bootstrap = await apiRequest.newContext();
      const role = ROLES.find((r) => r.name === 'admin');
      if (!role) throw new Error('admin role missing from ROLES registry');
      const tokens = await ensureAuthTokens(bootstrap, role);
      await bootstrap.dispose();
      return { accessToken: tokens.accessToken };
    })().catch((err) => {
      adminTokens = undefined;
      throw err;
    });
  }
  return adminTokens;
}

async function adminApiContext(): Promise<APIRequestContext> {
  const { accessToken } = await cachedAdminTokens();
  return apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

async function fetchOperations(api: APIRequestContext): Promise<OperationDescriptor[]> {
  const res = await api.get(apiUrl('/api/v1/rule-runs/operations'));
  if (!res.ok()) throw new Error(`GET /rule-runs/operations → ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body?.operations ?? body?.data;
  if (!Array.isArray(list)) throw new Error('operations response is not a list');
  return list as OperationDescriptor[];
}

function served(operations: OperationDescriptor[], operationId: string): OperationDescriptor {
  const op = operations.find((candidate) => candidate.operationId === operationId);
  expect(op, `${operationId} absent from the live operation surface`).toBeTruthy();
  return op!;
}

function columnsOf(op: OperationDescriptor): string[] {
  const shapes = Object.values(op.output.shapes);
  expect(shapes, `${op.operationId} must serve exactly one output shape`).toHaveLength(1);
  return shapes[0].columns;
}

function roleMap(op: OperationDescriptor): Record<string, ColumnRoleDescriptor> {
  return Object.fromEntries(op.columnRoles.map((r) => [r.role, r]));
}

function blockIds(op: OperationDescriptor): string[] {
  return op.preconditions.filter((p) => p.severity === 'BLOCK').map((p) => p.id);
}

let api: APIRequestContext;
let operations: OperationDescriptor[];

test.beforeAll(async () => {
  api = await adminApiContext();
  operations = await fetchOperations(api);
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe(
  'AXI-1928 — statsmodels family: the validated contract is the served contract',
  { tag: ['@SI-050', '@SI-021', '@SI-023'] },
  () => {
    test('AC1 — stats.linear_mixed_model is served with exactly the output fields its parity fixtures compare', async () => {
      const op = served(operations, 'stats.linear_mixed_model');
      expect(op.runKind).toBe('STATISTICAL');
      expect(columnsOf(op)).toEqual(LMM_FIXTURE_FIELDS);
    });

    test('AC1 — stats.linear_mixed_model binds the roles and confidence range its fixtures exercise', async () => {
      const op = served(operations, 'stats.linear_mixed_model');
      const roles = roleMap(op);
      expect(Object.keys(roles).sort()).toEqual(['groupColumn', 'subjectKey', 'timeColumn', 'valueColumn']);
      expect([roles.subjectKey.required, roles.timeColumn.required, roles.valueColumn.required]).toEqual([true, true, true]);
      expect(roles.groupColumn.required).toBe(false);
      // The corpus runs at confidence 0.95 (the default) and 0.90; both must be
      // inside the served open interval (0, 1).
      const confidence = op.parameters.find((p) => p.key === 'confidence');
      expect(confidence, 'confidence parameter missing').toBeTruthy();
      expect(confidence!).toMatchObject({ required: false, default: 0.95, min: 0, max: 1, minExclusive: true, maxExclusive: true });
    });

    test('AC1 — stats.site_batch_variance_test is served with exactly the output fields its parity fixtures compare', async () => {
      const op = served(operations, 'stats.site_batch_variance_test');
      expect(op.runKind).toBe('STATISTICAL');
      expect(columnsOf(op)).toEqual(VC_FIXTURE_FIELDS);
      expect(op.parameters).toEqual([]);
      const roles = roleMap(op);
      expect(Object.keys(roles).sort()).toEqual(['batchColumn', 'diseaseColumn', 'measurementColumn', 'siteColumn']);
      expect(Object.values(roles).every((r) => r.required)).toBe(true);
      expect(roles.measurementColumn.requiredShape).toBe('numeric');
    });

    test('AC2 — the hard preconditions behind the typed refusals are BLOCK on the live surface', async () => {
      // Refusal fixtures: a missing bound column and a non-numeric time /
      // measurement column each return a typed MIXEDLM_EXEC_* refusal.
      const lmm = blockIds(served(operations, 'stats.linear_mixed_model'));
      expect(lmm).toEqual(expect.arrayContaining([
        'subject_key_bound', 'time_column_bound', 'value_column_bound', 'numeric_time', 'numeric_value',
      ]));
      const vc = blockIds(served(operations, 'stats.site_batch_variance_test'));
      expect(vc).toEqual(expect.arrayContaining([
        'measurement_column_bound', 'disease_column_bound', 'site_column_bound', 'batch_column_bound',
        'numeric_measurement',
      ]));
    });

    test('AC2 — a confounded design is declared refused, and both operations carry the undefined-row reason column', async () => {
      // The confounded fixtures (site = batch, batch nested in site) return an
      // undefined row with a reason; the served help tells the user why.
      const vc = served(operations, 'stats.site_batch_variance_test');
      expect(roleMap(vc).batchColumn.help?.why ?? '').toMatch(/confounded/i);
      expect(columnsOf(vc)).toContain('reason');
      expect(columnsOf(served(operations, 'stats.linear_mixed_model'))).toContain('reason');
    });
  },
);
