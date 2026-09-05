import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1416 — `statistical_table` frontend consumer (manual-e2e
 * AXI-1396-Governed-Statistical-Analysis-Surface.md §4.20; epic AXI-1398;
 * FR26, AC11 — closes KI-3).
 *
 * The real acceptance value (§4.20.1 — a completed STATISTICAL run's
 * `MaterializedView` node opens `StatisticalTableResult`, not Delta's
 * `DerivedTableModal`) needs a real, ingested statistical referent with a
 * SUCCEEDED run materialized on it — the same residue class §4.6/§4.9/§4.12
 * already document for every other "trigger a governed run" scenario in this
 * feature, so it is manual residue here too.
 *
 * What IS genuinely reachable headless, deterministically, with no dataset or
 * run: the live operation descriptor still exposes the two fields this
 * story's frontend routing reads — `runKind` (the `isStatisticalOperation`
 * discriminator, `src/lib/rules/statisticalResult.ts`) and `defaultChart`
 * (AXI-1414's registry slot, the AXI-1415 chart-mount seam). Mirrors the
 * descriptor-liveness approach `AXI-1402-armed-preconditions.spec.ts` already
 * established for this same feature.
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run
 * and mutates no state.
 */

interface OperationDefaultChart {
  type: string;
  roles: Record<string, string>;
  annotation: string[];
}

interface OperationDescriptor {
  operationId: string;
  runKind: string;
  defaultChart: OperationDefaultChart | null;
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

test.describe('AXI-1416 — statistical_table frontend consumer routing predicate stays declared (§4.20.2)', { tag: ['@SI-035'] }, () => {
  test('FR26/AC11 — a STATISTICAL operation declares runKind + a non-null defaultChart', async () => {
    const paired = operations.find((op) => op.operationId === 'stats.paired_ttest');
    expect(paired, 'stats.paired_ttest absent from the live operation surface').toBeTruthy();

    // The exact discriminator `isStatisticalOperation` reads
    // (`src/lib/rules/statisticalResult.ts`) — regressing this silently
    // routes a statistical MaterializedView node back onto Delta's
    // "View table" branch with nothing else noticing at the API surface.
    expect(paired!.runKind).toBe('STATISTICAL');

    // The exact shape `buildChartMountProps` maps onto AXI-1415's chart-mount
    // seam (`{ defaultChart, resultColumns, summary }`).
    expect(paired!.defaultChart, 'stats.paired_ttest declares no defaultChart').toBeTruthy();
    expect(typeof paired!.defaultChart!.type).toBe('string');
    expect(paired!.defaultChart!.roles).toBeTruthy();
    expect(Array.isArray(paired!.defaultChart!.annotation)).toBe(true);
  });

  test('FR26/AC11 — a non-STATISTICAL operation declares no chart (the negative case the branch split depends on)', async () => {
    const delta = operations.find((op) => op.runKind !== 'STATISTICAL');
    expect(delta, 'no non-STATISTICAL operation on the live surface to assert the negative case against').toBeTruthy();

    expect(delta!.defaultChart).toBeNull();
  });
});
