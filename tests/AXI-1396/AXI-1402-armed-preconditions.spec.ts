import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1402 — Precondition evaluation + armed count look-ahead + new check
 * kinds (manual-e2e §4.7; FR7, FR9).
 *
 * The story's real acceptance value (§4.6 — a too-thin referent is BLOCKED
 * before a run row exists, naming `sufficient_pairs`; a referent between the
 * two thresholds is accepted with `small_sample` stamped as a WARNING) needs a
 * real, INGESTED statistical referent whose row count the tester controls.
 * Per this suite's own established convention for that upload→ingest→ready
 * tail (AXI-1251's residue note: it "depends on MinIO object writes and
 * RabbitMQ materialization that are non-deterministic to assert inline"),
 * §4.6 is manual residue here too, walked by hand against the demo project.
 *
 * What IS genuinely reachable headless, deterministically, with no dataset or
 * run: the live operation descriptor still DECLARES the two thresholds this
 * story arms. `sufficient_pairs`/`small_sample` predate this story (AXI-1176)
 * — what regresses if either is dropped or renamed is that FR7/FR8's BLOCK/WARN
 * silently stop firing with nothing else noticing at the API surface. Mirrors
 * the descriptor-liveness approach `AXI-1401-role-generic-input-path.spec.ts`
 * already established and the AC7 liveness-proxy pattern in
 * `AXI-1403-multi-library-execution.spec.ts`.
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run and
 * mutates no state.
 */

interface PreconditionDescriptor {
  id: string;
  description: string;
  severity: 'BLOCK' | 'WARN';
}

interface OperationDescriptor {
  operationId: string;
  runKind: string;
  preconditions: PreconditionDescriptor[];
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

test.describe('AXI-1402 — sample-size preconditions stay declared on the live surface (§4.7)', { tag: ['@SI-017'] }, () => {
  test('FR7/FR9 — stats.paired_ttest still declares the BLOCK/WARN pair the look-ahead arms', async () => {
    const paired = operations.find((op) => op.operationId === 'stats.paired_ttest');
    expect(paired, 'stats.paired_ttest absent from the live operation surface').toBeTruthy();

    const byId = new Map(paired!.preconditions.map((p) => [p.id, p]));

    // FR7/FR8 — the BLOCK half: a paired t-test needs at least 2 complete
    // pairs to be defined at all. Regressing this id/severity would silently
    // un-arm the submission-time refusal §4.6.1 exercises against real data.
    const sufficientPairs = byId.get('sufficient_pairs');
    expect(sufficientPairs, 'sufficient_pairs precondition missing').toBeTruthy();
    expect(sufficientPairs!.severity).toBe('BLOCK');

    // FR29's WARN half: fewer than 6 pairs is defined but fragile.
    const smallSample = byId.get('small_sample');
    expect(smallSample, 'small_sample precondition missing').toBeTruthy();
    expect(smallSample!.severity).toBe('WARN');
  });
});
