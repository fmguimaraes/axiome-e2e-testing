import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1401 — Role-generic input path (manual-e2e §4.1; FR5, FR6, AC4).
 *
 * The role-generic substrate is a control-plane refactor: the column resolver,
 * the operation-triple builder and the statistical dispatch now read role names
 * off `OperationDefinition.tableInputScheme` rather than hard-coding delta's four
 * roles, and the compute pipeline reads them role-generic. Its acceptance value
 * is that the paired path is UNCHANGED to any observer while the substrate
 * underneath it generalised — so what a running stack can pin end-to-end is the
 * operation SURFACE the resolver reads off: the `stats.paired_ttest` descriptor,
 * served DB → org-service → gateway, must expose exactly the declared role
 * vocabulary (`subjectKey`, `levelColumn`, `featureColumn`, `valueColumns`) that
 * the generalised resolver and dispatch bind against.
 *
 * The grouped / two-column / survival shapes have no *registered* operation until
 * Epic 1 (AXI-1397), so their role-generic support is proven by the kernel,
 * service and pipeline unit suites (manual-e2e §4.2), not reachable here. This
 * spec is a genuine end-to-end path — the descriptor projection over the running
 * registry — not a re-run of a unit test, mirroring the AXI-1322 approach for a
 * kernel unit whose full dispatch is not yet driveable over HTTP.
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run and
 * mutates no state.
 */

interface OperationDescriptor {
  operationId: string;
  kind: string;
  runKind: string;
  columnRoles: Array<{ role: string; required: boolean; cardinality: string }>;
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

test.describe('AXI-1401 — role-generic input path (§4.1)', { tag: ['@SI-017'] }, () => {
  test('FR5 — the paired t-test operation is dispatchable, named on the running surface', async () => {
    const paired = operations.find((op) => op.operationId === 'stats.paired_ttest');
    expect(paired, 'stats.paired_ttest absent from the live operation surface').toBeTruthy();
    expect(paired!.runKind).toBe('STATISTICAL');
    expect(paired!.kind).toBe('STATISTICAL');
  });

  test('FR6/AC4 — the descriptor exposes the declared role vocabulary the resolver reads off', async () => {
    const paired = operations.find((op) => op.operationId === 'stats.paired_ttest')!;
    const roles = paired.columnRoles.map((r) => r.role).sort();
    // These are exactly the roles the role-generic resolver binds for the paired
    // shape — read off the definition, not hard-coded per operation.
    expect(roles).toEqual(['featureColumn', 'levelColumn', 'subjectKey', 'valueColumns']);

    const valueColumns = paired.columnRoles.find((r) => r.role === 'valueColumns')!;
    expect(valueColumns.required).toBe(true);
    expect(valueColumns.cardinality).toBe('many');
    const featureColumn = paired.columnRoles.find((r) => r.role === 'featureColumn')!;
    expect(featureColumn.required).toBe(false);
  });
});
