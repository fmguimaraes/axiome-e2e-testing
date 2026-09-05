import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1409 — pingouin comparison operations (Epic 1, AXI-1397, S1.1)
 * (manual-e2e §4.12.7; AC1, AC2, AC19).
 *
 * Seven new STATISTICAL operations over the ALREADY-pinned, ALREADY-sole-
 * importer pingouin (`==0.5.5`), all dispatching to the EXISTING
 * `stats_execution` run_type: `stats.wilcoxon_signed_rank` (paired),
 * `stats.unpaired_ttest` / `stats.mann_whitney_u` (grouped, pairwise),
 * `stats.kruskal_wallis` / `stats.one_way_anova` (grouped, all-groups),
 * `stats.correlation` (two-column), `stats.chi_square` (categorical-pair).
 *
 * This spec is the READ-ONLY liveness proxy (manual-e2e §4.12.7), mirroring
 * §4.4/§4.7/§4.9.5/§4.10.4's own approach: triggering an actual run needs a
 * real, INGESTED referent per shape (§4.12.1-4.12.6) — that tail is manual
 * residue, deferred to the Epic-1 Workflow-5 live walk per AC19. What IS
 * driveable read-only, the moment this branch merges, is that all seven
 * descriptors are served end-to-end (DB registry → org-service → gateway)
 * with their declared Axiome-named vocabulary and no frontend change (NFR7).
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
  'AXI-1409 — pingouin comparison operations (§4.12.7)',
  { tag: ['@SI-017', '@SI-021', '@SI-023'] },
  () => {
    const NEW_OPERATION_IDS = [
      'stats.wilcoxon_signed_rank',
      'stats.unpaired_ttest',
      'stats.mann_whitney_u',
      'stats.kruskal_wallis',
      'stats.one_way_anova',
      'stats.correlation',
      'stats.chi_square',
    ] as const;

    test('AC1 — all seven new operations are dispatchable on the live surface, alongside paired_ttest', async () => {
      for (const id of NEW_OPERATION_IDS) {
        const op = operations.find((candidate) => candidate.operationId === id);
        expect(op, `${id} absent from the live operation surface`).toBeTruthy();
        expect(op!.kind).toBe('STATISTICAL');
        expect(op!.runKind).toBe('STATISTICAL');
      }

      // The story adds operations ALONGSIDE the existing conformance proof,
      // never in place of it.
      const paired = operations.find((op) => op.operationId === 'stats.paired_ttest');
      expect(paired, 'stats.paired_ttest missing — the new operations must not have displaced it').toBeTruthy();
    });

    test('FR6 — the grouped pairwise operations expose groupColumn/valueColumns roles', async () => {
      for (const id of ['stats.unpaired_ttest', 'stats.mann_whitney_u'] as const) {
        const op = operations.find((candidate) => candidate.operationId === id)!;
        const roles = op.columnRoles.map((r) => r.role).sort();
        expect(roles).toEqual(['groupColumn', 'valueColumns'].sort());
      }
    });

    test('FR4 — the pairwise grouped operations declare groupFrom/groupTo, never a testType parameter', async () => {
      for (const id of ['stats.unpaired_ttest', 'stats.mann_whitney_u'] as const) {
        const op = operations.find((candidate) => candidate.operationId === id)!;
        const keys = op.parameters.map((p) => p.key);
        expect(keys).toEqual(expect.arrayContaining(['groupFrom', 'groupTo']));
        expect(keys).not.toContain('testType');
        expect(keys).not.toContain('test');
      }
    });

    test('FR6 — correlation exposes xColumn/yColumn, no confidence parameter', async () => {
      const correlation = operations.find((op) => op.operationId === 'stats.correlation')!;
      const roles = correlation.columnRoles.map((r) => r.role).sort();
      expect(roles).toEqual(['xColumn', 'yColumn']);

      // Discovered during AXI-1409 dev: pingouin 0.5.5's `corr` cannot honour a
      // configurable confidence level (silently ignored for pearson, raises for
      // spearman) — declaring the parameter would be dishonest, so it is absent.
      const keys = correlation.parameters.map((p) => p.key);
      expect(keys).not.toContain('confidence');
    });

    test('FR6 — chi-square exposes rowColumn/columnColumn, both required', async () => {
      const chiSquare = operations.find((op) => op.operationId === 'stats.chi_square')!;
      const roles = chiSquare.columnRoles.map((r) => r.role).sort();
      expect(roles).toEqual(['columnColumn', 'rowColumn']);
      for (const role of chiSquare.columnRoles) {
        expect(role.required, `${role.role} should be required for stats.chi_square`).toBe(true);
      }
    });
  },
);
