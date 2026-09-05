import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1411 — Cox proportional hazards (Epic 1, AXI-1397, S1.3)
 * (manual-e2e §4.12.8; AC1, AC2).
 *
 * The SECOND STATISTICAL operation over lifelines (already pinned `==0.30.3`,
 * already the sole importer), `stats.cox_proportional_hazards`, dispatching to
 * the SAME `kaplan_meier_execution` run_type as `stats.kaplan_meier` — the
 * per-library-pipeline model (FR18): a STATISTICAL operation routes to a
 * run_type by its library, so no new run_type and no new importer were added.
 *
 * This spec is the READ-ONLY liveness proxy, mirroring AXI-1409's own approach
 * (§4.12.7): triggering an actual Cox run needs a real, INGESTED survival
 * referent — that tail is manual residue, deferred to the Epic-1 Workflow-5 live
 * walk. What IS driveable read-only, the moment this branch merges, is that the
 * Cox descriptor is served end-to-end (DB registry → org-service → gateway) with
 * its declared Axiome-named survival covariate vocabulary and no frontend change
 * (NFR7).
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run and
 * mutates no state.
 */

interface ColumnRoleDescriptor {
  role: string;
  required: boolean;
  cardinality: string;
}

interface ParameterDescriptor {
  key: string;
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
  'AXI-1411 — Cox proportional hazards (§4.12.8)',
  { tag: ['@SI-017', '@SI-021', '@SI-023'] },
  () => {
    const COX_ID = 'stats.cox_proportional_hazards';

    test('AC1 — the Cox operation is dispatchable on the live surface, alongside kaplan_meier', async () => {
      const cox = operations.find((op) => op.operationId === COX_ID);
      expect(cox, `${COX_ID} absent from the live operation surface`).toBeTruthy();
      expect(cox!.kind).toBe('STATISTICAL');
      expect(cox!.runKind).toBe('STATISTICAL');

      // Cox is added ALONGSIDE the first lifelines operation, never in place of it.
      const km = operations.find((op) => op.operationId === 'stats.kaplan_meier');
      expect(km, 'stats.kaplan_meier missing — Cox must not have displaced it').toBeTruthy();
    });

    test('FR6 — Cox exposes the survival covariate roles: time/event/covariates required, strata optional', async () => {
      const cox = operations.find((op) => op.operationId === COX_ID)!;
      const roleByName = new Map(cox.columnRoles.map((r) => [r.role, r]));
      for (const required of ['timeColumn', 'eventColumn', 'covariates']) {
        expect(roleByName.get(required)?.required, `${required} should be required`).toBe(true);
      }
      // covariates is many-cardinality (one hazard-ratio row each, feature §10).
      expect(roleByName.get('covariates')?.cardinality).toBe('many');
      // strata is optional stratification, no coefficient row of its own.
      expect(roleByName.get('strata')?.required).toBe(false);
      // No groupColumn — the categorical group survival comparison is KM's.
      expect(roleByName.has('groupColumn')).toBe(false);
    });

    test('FR4 — Cox declares only a confidence parameter, never a model-selection knob', async () => {
      const cox = operations.find((op) => op.operationId === COX_ID)!;
      const keys = cox.parameters.map((p) => p.key);
      expect(keys).toContain('confidence');
      // Anything that changes WHICH model runs would be a separate operation (FR4).
      expect(keys).not.toContain('model');
      expect(keys).not.toContain('method');
      expect(keys).not.toContain('test');
    });

    test('FR3 — the Cox descriptor carries no upstream lifelines vocabulary', async () => {
      const cox = operations.find((op) => op.operationId === COX_ID)!;
      const roleNames = cox.columnRoles.map((r) => r.role.toLowerCase());
      const paramKeys = cox.parameters.map((p) => p.key.toLowerCase());
      for (const upstream of ['exp(coef)', 'coef', 'partial_hazard', 'baseline']) {
        expect(roleNames).not.toContain(upstream);
        expect(paramKeys).not.toContain(upstream);
      }
    });
  },
);
