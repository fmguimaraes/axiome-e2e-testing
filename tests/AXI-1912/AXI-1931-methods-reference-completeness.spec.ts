import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1931 — Methods reference completeness check (epic AXI-1912, FR27, AC18;
 * manual-e2e `AXI-1912-Method-Validation.md` § AXI-1931, Scenario 4).
 *
 * The completeness check itself runs in `axiome-bio-compute` CI
 * (`python -m tests.validation.methods_reference check`). It derives its
 * "registered operations" from the COMPUTE plane (each pipeline's closed
 * `SUPPORTED_OPERATIONS` + the function-boundary `stats.family_adjust`) and
 * exempts the `delta`/`stratify` namespaces as ARITHMETIC. pytest cannot reach
 * the CONTROL plane, whose operation registry is the source of truth users are
 * actually served. This spec closes that gap on the running stack:
 *
 *  1. the STATISTICAL and DESCRIBE operations the control plane serves are
 *     exactly the check's registered set (minus the function-boundary
 *     `stats.family_adjust`, which has no job and is never served here) — so
 *     the check demands a method record for every operation a user can run;
 *  2. no STATISTICAL or DESCRIBE operation lives in a namespace the check
 *     exempts — the exemption can never hide a statistical method;
 *  3. every operation the check exempts is served as DELTA/STRATIFY.
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run and
 * mutates no state.
 */

interface OperationDescriptor {
  operationId: string;
  runKind: string;
}

// The check's registered set: bio-compute `tests.validation.contracts.method_inventory.METHOD_IDS`
// (the Feature doc §10a D1 list), which bio-compute's own UT-BC-VAL-1931-16 proves equal to the
// compute plane's live dispatch table. A drift turns this spec red naming the id.
const CHECK_REGISTERED = [
  'stats.paired_ttest', 'stats.unpaired_ttest', 'stats.wilcoxon_signed_rank', 'stats.mann_whitney_u',
  'stats.kruskal_wallis', 'stats.one_way_anova', 'stats.correlation', 'stats.chi_square',
  'stats.correlation_trimmed', 'stats.kaplan_meier', 'stats.log_rank', 'stats.cox_proportional_hazards',
  'stats.deseq2_differential_expression', 'stats.linear_mixed_model', 'stats.site_batch_variance_test',
  'stats.alpha_diversity', 'stats.permanova', 'stats.anosim', 'stats.permdisp',
  'stats.differential_abundance', 'stats.fisher_exact', 'stats.cutoff_roc_youden', 'stats.cutoff_maxstat',
  'stats.cutoff_distribution', 'stats.cutoff_reference', 'stats.cutoff_tally', 'stats.screen_shortlist',
  'split.exploration_holdout', 'stats.family_adjust', 'describe.grouped_aggregate', 'describe.count',
  'describe.top_n', 'describe.subject_coverage', 'describe.below_limit_count', 'stats.dunn_posthoc',
  'stats.partial_correlation',
];
// Function boundary: served by bio-compute `/v1/family-adjust`, never a run-rule operation.
const FUNCTION_BOUNDARY = ['stats.family_adjust'];
// `OUT_OF_SCOPE_NAMESPACES` in bio-compute `tests/validation/methods_reference/registered.py`.
const EXEMPT_NAMESPACES = ['delta', 'stratify'];
const IN_SCOPE_RUN_KINDS = ['STATISTICAL', 'DESCRIBE'];
const ARITHMETIC_RUN_KINDS = ['DELTA', 'STRATIFY'];

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

async function fetchOperations(): Promise<OperationDescriptor[]> {
  const { accessToken } = await cachedAdminTokens();
  const api: APIRequestContext = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
  try {
    const res = await api.get(apiUrl('/api/v1/rule-runs/operations'));
    if (!res.ok()) throw new Error(`GET /rule-runs/operations → ${res.status()}: ${await res.text()}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : body?.operations ?? body?.data;
    if (!Array.isArray(list)) throw new Error('operations response is not a list');
    return list as OperationDescriptor[];
  } finally {
    await api.dispose();
  }
}

const namespaceOf = (operationId: string) => operationId.split('.', 1)[0];

test.describe('AXI-1931 methods reference completeness — the check covers what the control plane serves @SI-050 @SI-041', () => {
  let operations: OperationDescriptor[];

  test.beforeAll(async () => {
    operations = await fetchOperations();
  });

  test('AC18/FR27 — the served STATISTICAL and DESCRIBE operations are exactly the check\'s registered set', async () => {
    const served = operations
      .filter((op) => IN_SCOPE_RUN_KINDS.includes(op.runKind))
      .map((op) => op.operationId)
      .sort();
    const expected = CHECK_REGISTERED.filter((id) => !FUNCTION_BOUNDARY.includes(id)).sort();
    expect(served.filter((id) => !expected.includes(id)), 'served but the check would not require a record').toEqual([]);
    expect(expected.filter((id) => !served.includes(id)), 'required by the check but not served').toEqual([]);
    expect(served).toHaveLength(35);
  });

  test('AC18/FR27 — the function-boundary stats.family_adjust is not a served run-rule operation', async () => {
    const ids = operations.map((op) => op.operationId);
    for (const id of FUNCTION_BOUNDARY) expect(ids).not.toContain(id);
  });

  test('FR27 — no STATISTICAL or DESCRIBE operation lives in a namespace the check exempts', async () => {
    const hidden = operations
      .filter((op) => IN_SCOPE_RUN_KINDS.includes(op.runKind))
      .filter((op) => EXEMPT_NAMESPACES.includes(namespaceOf(op.operationId)))
      .map((op) => `${op.operationId} (${op.runKind})`);
    expect(hidden).toEqual([]);
  });

  test('FR27 — every served operation in an exempt namespace is ARITHMETIC (DELTA/STRATIFY)', async () => {
    const exempt = operations.filter((op) => EXEMPT_NAMESPACES.includes(namespaceOf(op.operationId)));
    expect(exempt.length).toBeGreaterThan(0);
    for (const op of exempt) {
      expect(ARITHMETIC_RUN_KINDS, `${op.operationId} runKind`).toContain(op.runKind);
    }
  });
});
