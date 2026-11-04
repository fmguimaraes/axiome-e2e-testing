import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-2382 (epic AXI-2308 — slice of AXI-2377) — `stats.kruskal_wallis` gains a
 * declared minimum-detectable-effect (MDE) output, read later by the sibling
 * interpretation-rule story AXI-2381 to decide a verdict branch, with NO
 * coupling to that story's internals.
 *
 * Modelled directly on `tests/AXI-1397/AXI-1409-pingouin-comparisons.spec.ts`'s
 * read-only descriptor-liveness harness (manual-e2e §4.12.7): triggering an
 * actual run needs a real, ingested referent with a 3+-level grouping column —
 * that tail is manual residue, already deferred by AXI-1409 itself (AC19) and
 * not re-opened here. What IS driveable read-only, the moment this branch
 * merges, is that the live operation descriptor surface
 * (`GET /api/v1/rule-runs/operations`, DB registry -> org-service -> gateway)
 * serves the four new parameters and the six new output columns with no
 * frontend change (NFR7). The numerics themselves are bio-compute's own unit
 * suite (`UT-BC-IO-2382-01..08`, tests/test_adapters/test_pingouin_comparisons.py).
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run
 * and mutates no state.
 */

interface ParameterDescriptor {
  key: string;
  required: boolean;
  default?: unknown;
  constraints?: { min?: number; max?: number; minExclusive?: boolean; maxExclusive?: boolean };
}

interface OutputShape {
  grain: string;
  columns: string[];
}

interface OperationDescriptor {
  operationId: string;
  runKind: string;
  parameters: ParameterDescriptor[];
  output: { shapes: Record<string, OutputShape> };
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
  'AXI-2382 — stats.kruskal_wallis minimum-detectable-effect declaration (§4.12.7-adjacent)',
  { tag: ['@SI-045'] },
  () => {
    test('AC1 (AXI-2382.2) — declares alpha/declaredPower (defaulted) and dRef/dRefProvenance (undefaulted) alongside correlation_matrix\'s own alpha', async () => {
      const kw = operations.find((op) => op.operationId === 'stats.kruskal_wallis');
      expect(kw, 'stats.kruskal_wallis absent from the live operation surface').toBeTruthy();
      expect(kw!.runKind).toBe('STATISTICAL');

      const byKey = Object.fromEntries(kw!.parameters.map((p) => [p.key, p]));
      expect(byKey.alpha, 'alpha parameter missing').toBeTruthy();
      expect(byKey.alpha.default).toBe(0.05);
      expect(byKey.alpha.constraints).toMatchObject({ min: 0, max: 1, minExclusive: true, maxExclusive: true });

      expect(byKey.declaredPower, 'declaredPower parameter missing').toBeTruthy();
      expect(byKey.declaredPower.default).toBe(0.8);

      expect(byKey.dRef, 'dRef parameter missing').toBeTruthy();
      expect(byKey.dRef.default).toBeUndefined();
      expect(byKey.dRef.required).toBe(false);

      expect(byKey.dRefProvenance, 'dRefProvenance parameter missing').toBeTruthy();
      expect(byKey.dRefProvenance.default).toBeUndefined();
      expect(byKey.dRefProvenance.required).toBe(false);

      // The new declaration must not collide with or shadow a sibling
      // operation's own pre-existing `alpha` (stats.correlation_matrix, AXI-2301).
      const correlationMatrix = operations.find((op) => op.operationId === 'stats.correlation_matrix');
      expect(correlationMatrix, 'stats.correlation_matrix missing — unrelated to this story, a canary for collision').toBeTruthy();
      const cmByKey = Object.fromEntries(correlationMatrix!.parameters.map((p) => [p.key, p]));
      expect(cmByKey.alpha?.default).toBe(0.05);
    });

    test('AC2 (AXI-2382.3) — the output shape carries the six new MDE columns after the existing nine, unreordered', async () => {
      const kw = operations.find((op) => op.operationId === 'stats.kruskal_wallis')!;
      const shape = kw.output.shapes[''];
      expect(shape, 'stats.kruskal_wallis declares no single ("") output shape').toBeTruthy();
      expect(shape.columns).toEqual([
        'measurement',
        'n',
        'nGroups',
        'hStatistic',
        'dof',
        'pValue',
        'effectSize',
        'reason',
        'minDetectable',
        'minDetectableReason',
        'minDetectablePower',
        'minDetectableMethod',
        'dRef',
        'dRefProvenance',
      ]);
    });
  },
);
