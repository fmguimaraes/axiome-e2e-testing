import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1412 — statsmodels linear mixed model, random intercept (Epic 1, AXI-1397, S1.4)
 * (manual-e2e §4.13.4; AC1, AC2).
 *
 * A NEW governed STATISTICAL operation `stats.linear_mixed_model` over a
 * genuinely NEW governed library (`statsmodels==0.14.6`), dispatching to its OWN
 * `mixed_model_execution` run_type (per-library pipeline, FR18/FR19). It
 * introduces the first LONGITUDINAL role shape (subjectKey / timeColumn /
 * valueColumn, optional groupColumn).
 *
 * This spec is the READ-ONLY liveness proxy (manual-e2e §4.13.4), mirroring
 * §4.9.5/§4.10.4/§4.12.7's own approach: triggering an actual run needs a real,
 * INGESTED longitudinal referent (§4.13.1-4.13.3) — that tail is manual residue,
 * deferred to the Epic-1 Workflow-5 live walk. What IS driveable read-only, the
 * moment this branch merges, is that the descriptor is served end-to-end (DB
 * registry → org-service → gateway) with its declared Axiome-named vocabulary and
 * no frontend change (NFR7).
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
  'AXI-1412 — linear mixed model (§4.13.4)',
  { tag: ['@SI-017', '@SI-021', '@SI-023', '@SI-020'] },
  () => {
    const OPERATION_ID = 'stats.linear_mixed_model';

    test('AC1 — the mixed model is dispatchable on the live surface, alongside the existing operations', async () => {
      const op = operations.find((candidate) => candidate.operationId === OPERATION_ID);
      expect(op, `${OPERATION_ID} absent from the live operation surface`).toBeTruthy();
      expect(op!.kind).toBe('STATISTICAL');
      expect(op!.runKind).toBe('STATISTICAL');

      // Added ALONGSIDE the existing conformance proof, never in place of it.
      const paired = operations.find((o) => o.operationId === 'stats.paired_ttest');
      expect(paired, 'stats.paired_ttest missing — the new operation must not have displaced it').toBeTruthy();
    });

    test('FR6 — exposes the longitudinal role vocabulary (subject/time/value required, group optional)', async () => {
      const op = operations.find((candidate) => candidate.operationId === OPERATION_ID)!;
      const roles = Object.fromEntries(op.columnRoles.map((r) => [r.role, r]));
      expect(roles.subjectKey?.required).toBe(true);
      expect(roles.timeColumn?.required).toBe(true);
      expect(roles.valueColumn?.required).toBe(true);
      expect(roles.groupColumn?.required).toBe(false);
      // FR3: no upstream statsmodels vocabulary leaks onto the surface.
      expect(op.columnRoles.map((r) => r.role)).not.toContain('const');
    });

    test('FR4 — declares only a confidence parameter, nothing that changes which model is fit', async () => {
      const op = operations.find((candidate) => candidate.operationId === OPERATION_ID)!;
      const keys = op.parameters.map((p) => p.key);
      // The fit method, REML flag and random-effects structure are FIXED
      // properties, never author-settable knobs — no `method`/`test`/`reml` key.
      expect(keys).not.toContain('method');
      expect(keys).not.toContain('reml');
      expect(keys).not.toContain('test');
    });
  },
);
