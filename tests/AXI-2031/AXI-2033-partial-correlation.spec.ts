import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-2033 (epic AXI-2031 — FR7, FR8, FR9, FR12, NFR1-NFR4, AC4, AC5, AC8;
 * EC3; SI-017, SI-021, SI-010): Partial correlation.
 *
 * Scenario doc: manual-e2e/AXI-2031-Non-Parametric-Statistics-Coverage.md
 * §2 "AXI-2033".
 *
 * Follows the SAME read-only liveness-proxy pattern `AXI-2032-dunn-
 * posthoc.spec.ts` established for this epic: what is driveable read-only,
 * the moment this branch merges, is that `stats.partial_correlation` is
 * served end to end (kernel registry → org-service → gateway) with its
 * declared shape — roles, parameters, output grain/columns, library pin,
 * guidance — ADDITIVE to `stats.correlation` (FR9: the unadjusted sibling
 * is unchanged). Triggering an actual run and checking a hand-worked
 * coefficient/p-value against a reference (AC4), proving the q-value
 * reader (AXI-2034) actually consumes a persisted partial-correlation
 * result row (AC5), and driving a genuine EC3 undefined case (too few
 * complete cases / constant column / collinear covariate) all need a real,
 * INGESTED referent and/or a second completed run — that tail is
 * manual/live-walk residue, deferred the same way AC3 was in AXI-2032
 * (this spec notes exactly where). The numeric correctness of the
 * underlying adapter IS proven, independently of this spec, by
 * `axiome-bio-compute`'s own unit suite
 * (`test_pingouin_comparisons.py::TestPartialCorrelation` — a hand-worked
 * example plus a second, independent residual-regression computation per
 * NFR2) and the pipeline-dispatch suite
 * (`test_stats_execution.py::TestPartialCorrelationPipeline`, including the
 * `_role_shape` ordering regression test). The control-plane-level
 * conformance (roles, claim keys, output shape, reader parity with
 * `stats.correlation`) is pinned, independently of this spec, by
 * `axiome-back`'s `kernel/partial-correlation-operation.spec.ts`
 * (UT-RULES-2140..2147) and `correlation-run-member.reader.spec.ts`
 * (UT-RULES-2148).
 *
 * Read-only against the ambient operation registry (NFR5); triggers no
 * run and mutates no state.
 *
 * AUTHORED, NOT RUN: authored against this story's step-c design (the
 * registry shapes read directly from `operation-registry.ts` in this same
 * story's axiome-back branch); no Docker stack was brought up to execute
 * it. Do not report `e2e-pass` for this spec until it has actually been
 * run green against a live stack carrying this story's merged change.
 */

interface ColumnRoleDescriptor {
  role: string;
  required: boolean;
  cardinality: string;
  requiredShape?: string | null;
}

interface GuidanceDescriptor {
  whatItDoes: string;
  whenToUse: string;
}

interface OperationDescriptor {
  operationId: string;
  runKind: string;
  columnRoles: ColumnRoleDescriptor[];
  parameters: Array<{ key: string }>;
  output: { shapes: Record<string, { grain: string; columns: string[] }> };
  guidance: GuidanceDescriptor | null;
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
  'AXI-2033 — Partial correlation',
  { tag: ['@SI-017', '@SI-021', '@SI-010'] },
  () => {
    test('AC4 — stats.partial_correlation is selectable from the live operation surface, STATISTICAL kind, alongside stats.correlation', async () => {
      const partial = operations.find((op) => op.operationId === 'stats.partial_correlation');
      expect(partial, 'stats.partial_correlation absent from the live operation surface').toBeTruthy();
      expect(partial!.runKind).toBe('STATISTICAL');

      // Scenario 5 / FR9 — the story adds the operation ALONGSIDE the one it
      // adjusts, never in place of it.
      const correlation = operations.find((op) => op.operationId === 'stats.correlation');
      expect(correlation, 'stats.correlation missing — partial_correlation must not have displaced it').toBeTruthy();
    });

    test('FR7 — declares xColumn/yColumn (one) plus a covariateColumns role (many, numeric, required) additional to stats.correlation\'s own roles', async () => {
      const partial = operations.find((op) => op.operationId === 'stats.partial_correlation')!;
      const correlation = operations.find((op) => op.operationId === 'stats.correlation')!;

      const partialRoles = partial.columnRoles.map((r) => r.role).sort();
      expect(partialRoles).toEqual(['covariateColumns', 'xColumn', 'yColumn'].sort());

      const covariates = partial.columnRoles.find((r) => r.role === 'covariateColumns')!;
      expect(covariates.cardinality).toBe('many');
      expect(covariates.required).toBe(true);

      // Scenario 5 / FR9 — stats.correlation's own roles are byte-for-byte
      // unchanged by this story.
      const correlationRoles = correlation.columnRoles.map((r) => r.role).sort();
      expect(correlationRoles).toEqual(['xColumn', 'yColumn'].sort());
    });

    test('FR8 — declares the same method/alternative parameters as stats.correlation, no confidence parameter', async () => {
      const partial = operations.find((op) => op.operationId === 'stats.partial_correlation')!;
      const correlation = operations.find((op) => op.operationId === 'stats.correlation')!;
      const partialParams = partial.parameters.map((p) => p.key).sort();
      expect(partialParams).toEqual(expect.arrayContaining(['method', 'alternative']));
      expect(partialParams).not.toContain('confidence');

      // The parameter VOCABULARY overlaps with stats.correlation's own
      // (method/alternative); stats.correlation's own parameter list is
      // unaffected by this addition.
      expect(correlation.parameters.map((p) => p.key)).toEqual(expect.arrayContaining(partialParams));
    });

    test('AC5 / FR9 — output carries pValue named identically to stats.correlation\'s own output (AXI-2034\'s q-value reader reads either unchanged)', async () => {
      const partial = operations.find((op) => op.operationId === 'stats.partial_correlation')!;
      const correlation = operations.find((op) => op.operationId === 'stats.correlation')!;

      const partialColumns = Object.values(partial.output.shapes)[0].columns;
      expect(partialColumns).toEqual(
        expect.arrayContaining(['coefficient', 'pValue', 'ciLow', 'ciHigh', 'n', 'covariates', 'reason']),
      );
      expect(Object.values(correlation.output.shapes)[0].columns).toContain('pValue');

      // Scenario 2's full claim — that a persisted stats.partial_correlation
      // result row is actually READ by the correlation-family-adjust
      // endpoint (AXI-2034) alongside a stats.correlation row and produces a
      // q-value for both — needs two completed runs over a real ingested
      // referent and is deferred live-walk residue (same pattern as AC3 in
      // AXI-2032). The reader's unit coverage for this exact row shape is
      // `correlation-run-member.reader.spec.ts::UT-RULES-2148`.
    });

    test('AC8 — guidance content is present (what it does / when to use it)', async () => {
      const partial = operations.find((op) => op.operationId === 'stats.partial_correlation')!;
      expect(partial.guidance, 'stats.partial_correlation guidance missing').toBeTruthy();
      expect(partial.guidance!.whatItDoes.length).toBeGreaterThan(0);
      expect(partial.guidance!.whenToUse.length).toBeGreaterThan(0);
      // The Statistical-Methods-Reference.md row this half of AC8 also
      // requires is a docs-repo artifact
      // (`axiome-bio-compute/docs/Statistical-Methods-Reference.md`) added
      // in this same story's bio-compute change; it is not reachable from
      // this API-only spec and is verified by doc review, not by this
      // suite.
    });

    test('EC3 — undefined-row behaviour (too few complete cases, constant column, collinear covariate) is deferred live-walk residue', async () => {
      // Driving a genuine EC3 case through the live stack needs a real,
      // ingested referent small/degenerate enough to trip the adapter's
      // own rank-deficiency guard — not reproducible read-only against the
      // ambient operation registry. What IS confirmed here is that the
      // operation declares a `reason` output column, the carrier for an
      // undefined row's stated cause (never an exception, per P10).
      const partial = operations.find((op) => op.operationId === 'stats.partial_correlation')!;
      expect(Object.values(partial.output.shapes)[0].columns).toContain('reason');
      // The EC3 conditions themselves (min complete cases, constant
      // xColumn/yColumn/covariate, covariate collinear with xColumn or
      // yColumn, non-numeric bound columns) are proven independently by
      // `axiome-bio-compute`'s
      // `test_pingouin_comparisons.py::TestPartialCorrelation` (UT-BC-IO-2033-*)
      // against a hand-worked example and a second, independent
      // computation (NFR2); see
      // `tests/validation/AXI-2033-partial-correlation-validation-note.md`.
    });
  },
);
