import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1406 — Kaplan-Meier migrated to a governed operation, S0.6
 * (manual-e2e §4.9.5; FR20, AC8, AC19).
 *
 * `survival_km` (the pre-migration, non-rule-run pipeline) is re-declared as
 * the governed `stats.kaplan_meier` — a NEW operation landing ALONGSIDE
 * `survival_km`, which stays untouched and un-retired (AC8; S0.8 retires it
 * once its `axiome-front` derived-evidence consumers move). This is also the
 * FIRST operation over the SURVIVAL role shape and the first to exercise the
 * per-library dispatch AXI-1403 decided (`kaplan_meier_execution`, a pipeline
 * separate from `stats_execution`/pingouin's).
 *
 * This spec is the READ-ONLY liveness proxy (manual-e2e §4.9.5), mirroring
 * §4.1/§4.4/§4.7's own approach for a shape/operation whose FULL trigger-a-run
 * scenario needs a real, INGESTED survival referent (§4.9.1-4.9.4) — that tail
 * is manual residue, the same class §4.6 already documents, not a gap this
 * spec tries to paper over. What IS driveable read-only, the moment this
 * branch merges, is that the descriptor is served end-to-end (DB registry →
 * org-service → gateway) with the declared survival role vocabulary — proof
 * the executor imported the new operation and did not die on lifelines
 * (AC19's "governed KM run" precondition: the operation must be reachable
 * before a run can ever be triggered against it).
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run
 * and mutates no state.
 */

interface ColumnRoleDescriptor {
  role: string;
  required: boolean;
  cardinality: string;
}

interface OperationDescriptor {
  operationId: string;
  kind: string;
  runKind: string;
  columnRoles: ColumnRoleDescriptor[];
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
  'AXI-1406 — Kaplan-Meier migrated to a governed operation (§4.9.5)',
  { tag: ['@SI-017', '@SI-020'] },
  () => {
    test('FR20/AC8 — stats.kaplan_meier is dispatchable on the live surface, alongside paired_ttest', async () => {
      const km = operations.find((op) => op.operationId === 'stats.kaplan_meier');
      expect(km, 'stats.kaplan_meier absent from the live operation surface').toBeTruthy();
      expect(km!.kind).toBe('STATISTICAL');
      expect(km!.runKind).toBe('STATISTICAL');

      // AC8: the migration lands ALONGSIDE the paired path, not in place of it —
      // both must be reachable at once.
      const paired = operations.find((op) => op.operationId === 'stats.paired_ttest');
      expect(paired, 'stats.paired_ttest missing — the migration must not have displaced it').toBeTruthy();
    });

    test('FR6 — the descriptor exposes the declared SURVIVAL role vocabulary the resolver reads off', async () => {
      const km = operations.find((op) => op.operationId === 'stats.kaplan_meier')!;
      const roles = km.columnRoles.map((r) => r.role).sort();
      // Exactly the roles the survival-shape resolver binds — read off the
      // definition (operand-roles.ts SURVIVAL_ROLES + this operation's own
      // required groupColumn), never hard-coded per operation.
      expect(roles).toEqual(['eventColumn', 'groupColumn', 'timeColumn']);

      for (const role of km.columnRoles) {
        // Unlike delta/paired's optional featureColumn, every survival role on
        // this operation is required (§10 of the feature doc: the Survival row
        // lists groupColumn with no "optional" marker) — a KM run with no
        // group binding has nothing to compare and no defined grain.
        expect(role.required, `${role.role} should be required for stats.kaplan_meier`).toBe(true);
      }
    });
  },
);
