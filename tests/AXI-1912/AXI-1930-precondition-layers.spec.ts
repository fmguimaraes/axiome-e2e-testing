import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';
import { MSR_DIR, MsrPrecondition, loadAllPreconditions } from './harness/msr-preconditions';

/**
 * AXI-1930: precondition and numerical-edge enforcement (epic AXI-1912;
 * manual-e2e `AXI-1912-Method-Validation.md` § AXI-1930, Scenario 5).
 *
 * The coverage check and the NaN/Inf invariant are command-verified in
 * `axiome-bio-compute` and have no browser surface. FR16 also asks that each
 * MSR NAME THE LAYER THAT REFUSES. For a precondition the MSR assigns to the
 * control plane, that claim can be checked on the RUNNING stack. This spec
 * reads every MSR's `preconditions:` block and requires that each
 * `enforcing_layer: control_plane` precondition is declared by the served
 * operation (`GET /api/v1/rule-runs/operations`) under the same id, at the
 * matching severity: hard is BLOCK and soft is WARN.
 *
 * KNOWN_DRIFT is the drift measured on 2026-10-13. It works as a RATCHET, the
 * same as `known-gaps.json` in bio-compute:
 *   - a NEW drift fails, naming it;
 *   - a known entry that is no longer drift fails too, so the list only shrinks.
 * Fixing an entry belongs to the MSR owner (rename the id to the one the
 * control plane serves, or move the layer) or to the registry. It does not
 * belong to this spec.
 *
 * ONE direction only: MSR to served registry. The reverse (a served
 * precondition that no MSR names) is deliberately NOT asserted. FR16
 * constrains what an MSR CLAIMS about the refusing layer. A registry-only
 * guard (an input-shape check, a parameter validator) is legitimate, needs no
 * MSR line, and asserting on it would fail on every new guard added to the
 * control plane.
 *
 * The titles carry FR16, not AC1: AC1 ("a precondition with no fixture fails
 * the check, naming it") is the bio-compute coverage check (manual-e2e
 * Scenario 2). This spec checks the layer claim behind it.
 *
 * Read-only against the ambient operation registry (NFR5). It triggers no run
 * and mutates no state.
 */

interface OperationDescriptor {
  operationId: string;
  preconditions?: Array<{ id: string; severity: string }> | null;
}

const SERVED_SEVERITY: Record<MsrPrecondition['severity'], string> = { hard: 'BLOCK', soft: 'WARN' };

// `<method_id>/<precondition_id>`. Measured 2026-10-13 against the demo stack;
// none of these is served under that id on that operation.
const KNOWN_DRIFT: readonly string[] = [
  // "by design" entries: they record that a check is ABSENT, so no layer refuses anything.
  'describe.count/group_columns_optional_by_design',
  'describe.count/distinct_key_optional',
  'describe.count/no_direction_parameter',
  'stats.anosim/no_count_based_lookahead_by_design',
  'stats.chi_square/no_count_precondition_by_design',
  'stats.correlation/no_count_precondition_by_design',
  'stats.correlation_trimmed/primary_correlation_preconditions_reused',
  'stats.linear_mixed_model/no_count_based_lookahead_by_design',
  'stats.permanova/no_count_based_lookahead_by_design',
  'stats.permdisp/no_count_based_lookahead_by_design',
  'stats.site_batch_variance_test/no_count_based_lookahead_by_design',
  // The MSR names one id; the control plane serves the check under other ids
  // (for example `categorical_row`/`categorical_column`, `numeric_x`/`numeric_y`,
  // `sufficient_group_members`).
  'stats.chi_square/categorical_pair_role_bound',
  'stats.correlation/two_column_role_bound',
  'stats.correlation/numeric_columns',
  'stats.fisher_exact/categorical_pair_bound',
  'stats.kruskal_wallis/groups_have_members',
  'stats.one_way_anova/groups_have_members',
  'stats.deseq2_differential_expression/group_column_bound',
  // Parameter or role validation: no operation precondition carries it.
  'describe.below_limit_count/declared_limits_not_inferred',
  'describe.below_limit_count/unit_required',
  'describe.subject_coverage/required_timepoints_declared',
  'describe.top_n/n_and_direction_required_params',
  'stats.cutoff_tally/cutoff_choice_id_required',
  'stats.correlation_trimmed/declared_criterion_and_value',
  'stats.correlation_trimmed/percentile_below_half',
  // The served operation declares nothing that matches.
  'stats.deseq2_differential_expression/counts_are_non_negative_integers',
  'stats.deseq2_differential_expression/groups_have_members',
  'stats.deseq2_differential_expression/sufficient_samples_per_condition',
];

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

async function fetchOperations(api: APIRequestContext): Promise<OperationDescriptor[]> {
  const res = await api.get(apiUrl('/api/v1/rule-runs/operations'));
  if (!res.ok()) throw new Error(`GET /rule-runs/operations → ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body?.operations ?? body?.data;
  if (!Array.isArray(list)) throw new Error('operations response is not a list');
  return list as OperationDescriptor[];
}

function servedSeverities(operations: OperationDescriptor[]): Map<string, string> {
  const pairs = operations.flatMap((op) =>
    (op.preconditions ?? []).map((p) => [`${op.operationId}/${p.id}`, p.severity] as const),
  );
  return new Map(pairs);
}

const keyOf = (p: MsrPrecondition): string => `${p.methodId}/${p.id}`;

/** A control-plane MSR precondition the served registry does not match, named; `undefined` if it matches. */
function drift(p: MsrPrecondition, served: Map<string, string>): string | undefined {
  const severity = served.get(keyOf(p));
  if (severity === SERVED_SEVERITY[p.severity]) return undefined;
  return severity === undefined ? 'not served' : `served as ${severity}, MSR says ${p.severity}`;
}

let api: APIRequestContext;
let controlPlane: MsrPrecondition[];
let served: Map<string, string>;
let servedOperationIds: Set<string>;

test.beforeAll(async () => {
  if (!MSR_DIR) throw new Error('MSR directory not found: set PARITY_MSR_DIR or AXIOME_DOCS_ROOT');
  controlPlane = loadAllPreconditions(MSR_DIR).filter((p) => p.layer === 'control_plane');
  const { accessToken } = await cachedAdminTokens();
  api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const operations = await fetchOperations(api);
  served = servedSeverities(operations);
  servedOperationIds = new Set(operations.map((op) => op.operationId));
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe(
  'AXI-1930 — every MSR precondition assigned to the control plane is declared by the served control plane',
  { tag: ['@SI-050', '@SI-021', '@SI-017'] },
  () => {
    test('FR16 — the MSR corpus is read in full: control-plane preconditions exist to check (never vacuous)', () => {
      expect(controlPlane.length, `no control_plane preconditions read from ${MSR_DIR}`).toBeGreaterThan(100);
      const methods = new Set(controlPlane.map((p) => p.methodId));
      expect(methods.size).toBeGreaterThan(20);
    });

    test('FR16 — every operation an MSR assigns a control-plane precondition to is served', () => {
      const absent = [...new Set(controlPlane.map((p) => p.methodId))].filter((m) => !servedOperationIds.has(m));
      expect(absent, 'operations named by an MSR but absent from /rule-runs/operations').toEqual([]);
    });

    test('FR16 — no NEW drift: each control-plane precondition is served under its id at hard=BLOCK / soft=WARN', () => {
      const known = new Set(KNOWN_DRIFT);
      const fresh = controlPlane
        .filter((p) => !known.has(keyOf(p)))
        .map((p) => [keyOf(p), drift(p, served)] as const)
        .filter(([, problem]) => problem !== undefined)
        .map(([key, problem]) => `${key}: ${problem}`);
      expect(fresh, 'MSR says the control plane refuses these, the running control plane does not declare them').toEqual([]);
    });

    test('FR16 — the known-drift list only shrinks: every entry is still declared by its MSR and still drifts', () => {
      const declared = new Map(controlPlane.map((p) => [keyOf(p), p]));
      const stale = KNOWN_DRIFT.filter((key) => {
        const p = declared.get(key);
        return p === undefined || drift(p, served) === undefined;
      });
      expect(stale, 'remove these from KNOWN_DRIFT: closed, or no longer a control-plane MSR precondition').toEqual([]);
    });
  },
);
