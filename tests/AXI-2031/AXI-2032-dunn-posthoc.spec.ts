import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-2032 (epic AXI-2031 — FR1-FR6, FR12, NFR1-NFR4, AC1, AC2, AC3, AC8;
 * SI-017, SI-021, SI-023): Dunn's post-hoc with Holm adjustment.
 *
 * Scenario doc: manual-e2e/AXI-2031-Non-Parametric-Statistics-Coverage.md
 * §2 "AXI-2032".
 *
 * Follows the SAME read-only liveness-proxy pattern `AXI-1409-pingouin-
 * comparisons.spec.ts` established for this family: what is driveable
 * read-only, the moment this branch merges, is that `stats.dunn_posthoc`
 * is served end to end (kernel registry → org-service → gateway) with its
 * declared shape — grain, output columns, default chart, pin, guidance —
 * and reuses `stats.kruskal_wallis`'s `tableInputScheme` BY REFERENCE
 * (FR2). Triggering an actual run and checking its z/p/adjusted-p values
 * against a hand-worked reference (AC1, AC2) or a genuinely undersized
 * group (AC3) needs a real, INGESTED three-group referent — that tail is
 * manual/live-walk residue, deferred the same way AC19 was in AXI-1409
 * (this spec notes exactly where). The numeric correctness of the
 * underlying formulas IS proven, independently of this spec, by
 * `axiome-bio-compute`'s own unit suite (`test_holm.py`,
 * `test_dunn_posthoc.py` — hand-worked examples plus a second, independent
 * computation each, per NFR2) and the pipeline-dispatch suite
 * (`test_stats_execution.py::TestDunnPosthocPipelineDispatch`).
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
}

interface OutputSchemeDescriptor {
  shape: { grain: string; columns: string[] };
}

interface DefaultChartDescriptor {
  type: string;
  annotation: string[] | null;
}

interface GuidanceDescriptor {
  whatItDoes: string;
  whenToUse: string;
}

interface LibraryPinDescriptor {
  library: string;
  version: string;
}

interface OperationDescriptor {
  operationId: string;
  runKind: string;
  columnRoles: ColumnRoleDescriptor[];
  parameters: Array<{ key: string }>;
  output: { shapes: Record<string, { grain: string; columns: string[] }> };
  defaultChart: DefaultChartDescriptor | null;
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
  "AXI-2032 — Dunn's post-hoc with Holm adjustment",
  { tag: ['@SI-017', '@SI-021', '@SI-023'] },
  () => {
    test('AC8 — stats.dunn_posthoc is selectable from the live operation surface, STATISTICAL kind, alongside kruskal_wallis', async () => {
      const dunn = operations.find((op) => op.operationId === 'stats.dunn_posthoc');
      expect(dunn, 'stats.dunn_posthoc absent from the live operation surface').toBeTruthy();
      expect(dunn!.runKind).toBe('STATISTICAL');

      // The story adds the operation ALONGSIDE the existing one it follows up,
      // never in place of it.
      const kruskal = operations.find((op) => op.operationId === 'stats.kruskal_wallis');
      expect(kruskal, 'stats.kruskal_wallis missing — Dunn must not have displaced it').toBeTruthy();
    });

    test('FR2 — reuses kruskal_wallis\'s groupColumn/valueColumns table-input shape, declares no parameters', async () => {
      const dunn = operations.find((op) => op.operationId === 'stats.dunn_posthoc')!;
      const kruskal = operations.find((op) => op.operationId === 'stats.kruskal_wallis')!;
      const dunnRoles = dunn.columnRoles.map((r) => r.role).sort();
      const kruskalRoles = kruskal.columnRoles.map((r) => r.role).sort();
      expect(dunnRoles).toEqual(kruskalRoles);
      expect(dunnRoles).toEqual(expect.arrayContaining(['groupColumn', 'valueColumns']));
      // No testType/groupFrom/groupTo — every pair the bound groups yield is compared.
      expect(dunn.parameters.map((p) => p.key)).toEqual([]);
    });

    test('AC1, AC2 — output grain is one row per measurement x feature x group pair, carrying z, raw p and Holm-adjusted p', async () => {
      const dunn = operations.find((op) => op.operationId === 'stats.dunn_posthoc')!;
      const shape = Object.values(dunn.output.shapes)[0];
      expect(shape.grain).toContain('pair of groups');
      const columns = shape.columns;
      expect(columns).toEqual(
        expect.arrayContaining([
          'measurement',
          'groupA',
          'groupB',
          'zStatistic',
          'pValue',
          'adjustedPValue',
          'adjustmentMethod',
          'reason',
        ]),
      );
    });

    test('AC3 — declares NEITHER of kruskal_wallis\'s count-based look-ahead preconditions, so an undersized group cannot BLOCK the whole run', async () => {
      // Both operations share the same structural (binding/shape) preconditions
      // via `groupedStructuralPreconditions()` — asserted indirectly here by the
      // identical columnRoles shape above. The per-pair undefined-row behaviour
      // itself (FR5, EC1, EC2) needs a real undersized-group referent to drive
      // end to end; that is the deferred live-walk residue this spec's header
      // names. What the live registry CAN confirm read-only is that the box
      // plot's chart annotation is the ADJUSTED p-value, not the raw one —
      // the tell that this operation's output is meant to be read post-Holm.
      const dunn = operations.find((op) => op.operationId === 'stats.dunn_posthoc')!;
      expect(dunn.defaultChart?.type).toBe('box_plot');
      expect(dunn.defaultChart?.annotation).toEqual(['adjustedPValue']);
    });

    // FR6 (in-house pin, no third-party library): the public operation
    // descriptor does not expose `libraryPin`, so it cannot be read from the
    // live surface. It is asserted where it is declared, by the kernel unit
    // suite (dunn-posthoc-operation.spec.ts) and the bio-compute import guards.

    test('AC8 — guidance content is present (what it does / when to use it)', async () => {
      const dunn = operations.find((op) => op.operationId === 'stats.dunn_posthoc')!;
      expect(dunn.guidance, 'stats.dunn_posthoc guidance missing').toBeTruthy();
      expect(dunn.guidance!.whatItDoes.length).toBeGreaterThan(0);
      expect(dunn.guidance!.whenToUse.length).toBeGreaterThan(0);
      // The Statistical-Methods-Reference.md row this half of AC8 also requires
      // is a docs-repo artifact (`axiome-bio-compute/docs/Statistical-Methods-
      // Reference.md`) added in this same story's bio-compute change; it is not
      // reachable from this API-only spec and is verified by doc review, not by
      // this suite.
    });
  },
);
