import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1410 — scikit-bio community operations (Epic 1, AXI-1397, S1.2)
 * (manual-e2e §4.13.5; AC1, AC2).
 *
 * Four new STATISTICAL operations over a NEW governed library, scikit-bio
 * (`skbio`, pinned `==0.6.3`), all dispatching to a NEW `community_execution`
 * run_type behind its own import guard: `stats.alpha_diversity` (per-sample
 * metric then group comparison) and the three permutation-based
 * community-structure tests `stats.permanova` / `stats.anosim` /
 * `stats.permdisp`. All bind the COMMUNITY role shape (`featureColumns` = many
 * numeric taxa columns + `groupColumn`).
 *
 * This spec is the READ-ONLY liveness proxy (manual-e2e §4.13.5), mirroring
 * AXI-1409's own approach: triggering an actual run needs a real, INGESTED
 * community feature table per §4.13.1-4.13.3 — that tail is manual residue,
 * deferred to the Epic-1 Workflow-5 live walk. What IS driveable read-only, the
 * moment this branch merges, is that all four descriptors are served end-to-end
 * (DB registry → org-service → gateway) with their declared Axiome-named
 * vocabulary and no frontend change (NFR7).
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
  constraints?: { allowedValues?: string[] };
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
  'AXI-1410 — scikit-bio community operations (§4.13.5)',
  { tag: ['@SI-017', '@SI-020', '@SI-021', '@SI-023'] },
  () => {
    const COMMUNITY_IDS = [
      'stats.alpha_diversity',
      'stats.permanova',
      'stats.anosim',
      'stats.permdisp',
    ] as const;
    const TEST_IDS = ['stats.permanova', 'stats.anosim', 'stats.permdisp'] as const;

    test('AC1 — all four community operations are dispatchable on the live surface, alongside the existing statistical ops', async () => {
      for (const id of COMMUNITY_IDS) {
        const op = operations.find((candidate) => candidate.operationId === id);
        expect(op, `${id} absent from the live operation surface`).toBeTruthy();
        expect(op!.kind).toBe('STATISTICAL');
        expect(op!.runKind).toBe('STATISTICAL');
      }
      // Added alongside, never displacing the existing conformance proof.
      const paired = operations.find((op) => op.operationId === 'stats.paired_ttest');
      expect(paired, 'stats.paired_ttest missing — the new operations must not have displaced it').toBeTruthy();
    });

    test('FR6 — every community operation exposes the featureColumns + groupColumn role shape', async () => {
      for (const id of COMMUNITY_IDS) {
        const op = operations.find((candidate) => candidate.operationId === id)!;
        const roles = op.columnRoles.map((r) => r.role).sort();
        expect(roles).toEqual(['featureColumns', 'groupColumn'].sort());
        const features = op.columnRoles.find((r) => r.role === 'featureColumns')!;
        expect(features.cardinality).toBe('many');
        expect(features.required).toBe(true);
      }
    });

    test('FR4 — alpha diversity declares metric as its only param; the three tests declare none', async () => {
      const alpha = operations.find((op) => op.operationId === 'stats.alpha_diversity')!;
      const metric = alpha.parameters.find((p) => p.key === 'metric');
      expect(metric, 'alpha diversity should declare a metric parameter').toBeTruthy();
      expect(metric!.constraints?.allowedValues).toEqual(['shannon', 'simpson', 'observed_features']);
      // No parameter that changes WHICH test runs.
      const alphaKeys = alpha.parameters.map((p) => p.key);
      expect(alphaKeys).not.toContain('test');
      expect(alphaKeys).not.toContain('distanceMetric');
      expect(alphaKeys).not.toContain('nPermutations');

      for (const id of TEST_IDS) {
        const op = operations.find((candidate) => candidate.operationId === id)!;
        expect(op.parameters, `${id} must declare no parameters (fixed properties only)`).toHaveLength(0);
      }
    });

    test('FR3 — no upstream scikit-bio vocabulary leaks into a declared parameter key', async () => {
      const FORBIDDEN = ['pseudo-F', 'test statistic', 'p-value', 'braycurtis', 'skbio'];
      for (const id of COMMUNITY_IDS) {
        const op = operations.find((candidate) => candidate.operationId === id)!;
        for (const param of op.parameters) {
          for (const forbidden of FORBIDDEN) {
            expect(param.key).not.toContain(forbidden);
          }
        }
      }
    });
  },
);
