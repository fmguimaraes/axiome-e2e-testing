import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1407 — DESeq2 migrated to a governed operation, S0.7
 * (manual-e2e §4.10.4; FR20, AC8).
 *
 * `deseq2` (the pre-migration, non-rule-run pipeline) is re-declared as the
 * governed `stats.deseq2_differential_expression` — a NEW operation landing
 * ALONGSIDE `deseq2`, which stays untouched and un-retired (AC8; S0.8 retires
 * it once its consumers move). This is also the FIRST operation over the
 * COUNTS role shape and the third per-library dispatch AXI-1403 decided
 * (`deseq2_execution`, a pipeline separate from `stats_execution`/pingouin's
 * and `kaplan_meier_execution`/lifelines').
 *
 * This spec is the READ-ONLY liveness proxy (manual-e2e §4.10.4), mirroring
 * §4.1/§4.4/§4.7/§4.9.5's own approach for a shape/operation whose FULL
 * trigger-a-run scenario needs a real, INGESTED counts referent
 * (§4.10.1-4.10.3) — that tail is manual residue, the same class §4.6/§4.9
 * already document, not a gap this spec tries to paper over. What IS
 * driveable read-only, the moment this branch merges, is that the descriptor
 * is served end-to-end (DB registry → org-service → gateway) with the
 * declared counts role vocabulary — proof the executor imported the new
 * operation and did not die on pydeseq2.
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run
 * and mutates no state.
 */

interface ColumnRoleDescriptor {
  role: string;
  required: boolean;
  cardinality: string;
}

interface ParameterDescriptor {
  key: string;
  type: string;
  required: boolean;
}

interface OperationDescriptor {
  operationId: string;
  kind: string;
  runKind: string;
  columnRoles: ColumnRoleDescriptor[];
  parameters: ParameterDescriptor[];
}

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
  'AXI-1407 — DESeq2 migrated to a governed operation (§4.10.4)',
  { tag: ['@SI-017', '@SI-020'] },
  () => {
    test('FR20/AC8 — stats.deseq2_differential_expression is dispatchable on the live surface, alongside paired_ttest and kaplan_meier', async () => {
      const deseq2 = operations.find(
        (op) => op.operationId === 'stats.deseq2_differential_expression',
      );
      expect(
        deseq2,
        'stats.deseq2_differential_expression absent from the live operation surface',
      ).toBeTruthy();
      expect(deseq2!.kind).toBe('STATISTICAL');
      expect(deseq2!.runKind).toBe('STATISTICAL');

      // AC8: the migration lands ALONGSIDE the existing operations, not in
      // place of any of them — all three must be reachable at once.
      const paired = operations.find((op) => op.operationId === 'stats.paired_ttest');
      const km = operations.find((op) => op.operationId === 'stats.kaplan_meier');
      expect(paired, 'stats.paired_ttest missing — the migration must not have displaced it').toBeTruthy();
      expect(km, 'stats.kaplan_meier missing — the migration must not have displaced it').toBeTruthy();
    });

    test('FR6 — the descriptor exposes the declared COUNTS role vocabulary the resolver reads off', async () => {
      const deseq2 = operations.find(
        (op) => op.operationId === 'stats.deseq2_differential_expression',
      )!;
      const roles = deseq2.columnRoles.map((r) => r.role).sort();
      // Exactly the roles the counts-shape resolver binds — read off the
      // definition (operand-roles.ts COUNTS_ROLES + the reused subjectKey
      // structural role), never hard-coded per operation.
      expect(roles).toEqual(['countColumns', 'subjectKey']);

      for (const role of deseq2.columnRoles) {
        // Both roles are required (§10 of the feature doc's Counts row): a
        // DESeq2 run with no sample identity or no count columns has nothing
        // to fit.
        expect(role.required, `${role.role} should be required for stats.deseq2_differential_expression`).toBe(
          true,
        );
      }

      const countColumns = deseq2.columnRoles.find((r) => r.role === 'countColumns')!;
      expect(countColumns.cardinality).toBe('many');
    });

    test('FR11/FR12 — sampleConditionMap is declared as a required structured (json) parameter', async () => {
      const deseq2 = operations.find(
        (op) => op.operationId === 'stats.deseq2_differential_expression',
      )!;
      const param = deseq2.parameters.find((p) => p.key === 'sampleConditionMap');
      expect(param, 'sampleConditionMap absent from the declared parameter scheme').toBeTruthy();
      expect(param!.type).toBe('json');
      expect(param!.required).toBe(true);
    });
  },
);
