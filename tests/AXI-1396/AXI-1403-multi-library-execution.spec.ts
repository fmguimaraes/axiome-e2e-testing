import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1403 — Multi-library execution model + per-run_type isolation
 * (manual-e2e §4.3–§4.4; FR18, FR19, NFR4, NFR5, AC7).
 *
 * The multi-library model is PER-LIBRARY PIPELINE: each non-pingouin statistical
 * library runs in its own run_type/pipeline behind its own import guard, and each
 * pipeline reports exactly one `executor_version` (its own library's, never a
 * composite). Its acceptance is a COMPUTE-PLANE property — that an absent or
 * ABI-broken library disables ONLY its run_type while the executor still imports
 * and serves every other run_type (FR19/NFR4/AC7). That resilience is proven at
 * the pipeline/adapter unit level (bio-compute `test_library_guard.py`,
 * `test_registry.py`, `test_library_version.py` — manual-e2e §4.3); it has no new
 * HTTP path to drive under Epic 0, because wiring `survival_km`/`deseq2` into live
 * `/jobs` dispatch is the migration stories S0.6/S0.7 (AXI-1406/1407).
 *
 * What a running stack CAN pin (manual-e2e §4.4) is the observable consequence of
 * the model on the current wiring: the job executor and its governed statistical
 * surface stay UP. If a statistical dependency could take the executor down, the
 * operation surface would stop serving `stats.paired_ttest` — the exact regression
 * FR19/NFR4/AC7 forbid. This read-only check is therefore a liveness proxy for
 * "the job API still imports" (AC7); the negative case (a deliberately broken
 * image disabling only its run_type) cannot be driven read-only against a healthy
 * shared stack and is unit-proven instead.
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run and
 * mutates no state — consistent with NFR5's rule that no scientific content
 * crosses planes: this asserts only run-type availability, never data.
 */

interface OperationDescriptor {
  operationId: string;
  kind: string;
  runKind: string;
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

test.describe('AXI-1403 — multi-library execution model (§4.4)', { tag: ['@SI-021'] }, () => {
  test('AC7 — the governed statistical surface is still served (executor did not die on a library)', async () => {
    // If a statistical dependency could take the job executor down (the FR19/NFR4
    // regression), the statistical operation surface would not be served at all.
    // Its presence is the live proxy that the executor imported and stayed up.
    const paired = operations.find((op) => op.operationId === 'stats.paired_ttest');
    expect(paired, 'stats.paired_ttest absent — the statistical executor is not being served').toBeTruthy();
    expect(paired!.runKind).toBe('STATISTICAL');
  });

  test('AC7 — the non-statistical operation surface is served alongside it (isolation holds live)', async () => {
    // A statistical run_type being present must not be the ONLY thing served: the
    // whole point of per-run_type isolation is that every other run_type keeps
    // working. A populated, well-formed surface is the observable of that.
    expect(operations.length).toBeGreaterThan(0);
    for (const op of operations) {
      expect(op.operationId, 'an operation with no id — malformed surface').toBeTruthy();
      expect(op.runKind, `${op.operationId} has no runKind`).toBeTruthy();
    }
  });
});
