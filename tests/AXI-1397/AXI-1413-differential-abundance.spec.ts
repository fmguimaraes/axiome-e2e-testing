import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1413 — compositional differential abundance, CLR+FDR (Epic 1, AXI-1397, S1.5)
 * (manual-e2e §4.13.6; AC1, AC2).
 *
 * A NEW governed STATISTICAL operation `stats.differential_abundance` binding the
 * SAME community role shape as the scikit-bio ops (`featureColumns` many-numeric
 * taxa + `groupColumn`), dispatching to its OWN `differential_abundance_execution`
 * run_type (per-library pipeline, FR18/FR19). Unlike the scikit-bio community
 * tests it is a two-arm comparison (groupFrom/groupTo, like `stats.unpaired_ttest`)
 * that runs a per-feature CLR transform + two-group test + Benjamini-Hochberg FDR.
 * The compositional-error mitigation (§14) is baked into the definition: CLR and
 * FDR are FIXED operation properties, never author-settable parameters (FR4).
 *
 * This spec is the READ-ONLY liveness proxy (manual-e2e §4.13.6), mirroring
 * AXI-1410's own approach: triggering an actual run needs a real, INGESTED
 * community feature table per §4.13.1-4.13.3 — that tail is manual residue,
 * deferred to the Epic-1 Workflow-5 live walk. What IS driveable read-only, the
 * moment this branch merges, is that the descriptor is served end-to-end (DB
 * registry → org-service → gateway) with its declared Axiome-named vocabulary and
 * no frontend change (NFR7).
 *
 * Read-only against the ambient operation registry (NFR5); triggers no run and
 * mutates no state.
 */

interface ColumnRoleDescriptor {
  role: string;
  required: boolean;
  cardinality: string;
  requiredShape?: string;
}

interface ParameterDescriptor {
  key: string;
  type?: string;
  required: boolean;
  allowedValues?: string[] | null;
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
  'AXI-1413 — compositional differential abundance (§4.13.6)',
  { tag: ['@SI-017', '@SI-021', '@SI-023'] },
  () => {
    const OPERATION_ID = 'stats.differential_abundance';

    test('AC1 — the differential-abundance operation is dispatchable on the live surface, alongside the existing operations', async () => {
      const op = operations.find((candidate) => candidate.operationId === OPERATION_ID);
      expect(op, `${OPERATION_ID} absent from the live operation surface`).toBeTruthy();
      expect(op!.runKind).toBe('STATISTICAL');

      // Added ALONGSIDE the existing conformance proof, never in place of it, and
      // alongside its sibling community ops (it shares their role shape).
      const paired = operations.find((o) => o.operationId === 'stats.paired_ttest');
      expect(paired, 'stats.paired_ttest missing — the new operation must not have displaced it').toBeTruthy();
      const permanova = operations.find((o) => o.operationId === 'stats.permanova');
      expect(permanova, 'stats.permanova missing — the community ops must not have been displaced').toBeTruthy();
    });

    test('FR6 — exposes the community role shape (featureColumns many-numeric + groupColumn, both required)', async () => {
      const op = operations.find((candidate) => candidate.operationId === OPERATION_ID)!;
      const roles = op.columnRoles.map((r) => r.role).sort();
      expect(roles).toEqual(['featureColumns', 'groupColumn'].sort());

      const features = op.columnRoles.find((r) => r.role === 'featureColumns')!;
      expect(features.cardinality).toBe('many');
      expect(features.required).toBe(true);
      expect(features.requiredShape).toBe('numeric');

      const group = op.columnRoles.find((r) => r.role === 'groupColumn')!;
      expect(group.cardinality).toBe('one');
      expect(group.required).toBe(true);
    });

    test('FR4 — declares only the two arm-pickers; CLR and FDR are fixed properties, never test-selection knobs (§14)', async () => {
      const op = operations.find((candidate) => candidate.operationId === OPERATION_ID)!;

      // The two arm-pickers are required strings, exactly like stats.unpaired_ttest's own.
      for (const key of ['groupFrom', 'groupTo'] as const) {
        const spec = op.parameters.find((p) => p.key === key);
        expect(spec, `${key} should be declared`).toBeTruthy();
        expect(spec!.required).toBe(true);
        expect(spec!.type).toBe('string');
      }

      // AXI-1437 injects the governed `censoringSubstitution` analytic param across
      // the statistical surface — real product behaviour, not a test-selection knob.
      // Assert no SELECTION parameters remain once the two arm-pickers and the
      // governed substitution param are set aside.
      const selectionParams = op.parameters.filter(
        (p) => !['groupFrom', 'groupTo', 'censoringSubstitution'].includes(p.key),
      );
      expect(selectionParams, 'no test/transform/correction-selection parameters may be declared').toHaveLength(0);

      // The compositional mitigation (§14) is baked in, not exposed as a knob: no
      // fdr / correction / clr / alpha / test parameter — those are FIXED properties.
      const keys = op.parameters.map((p) => p.key);
      for (const forbidden of ['fdr', 'correction', 'clr', 'alpha', 'test']) {
        expect(keys).not.toContain(forbidden);
      }
    });

    test('FR3 — no upstream CLR / compositional / FDR library vocabulary leaks into a declared parameter key', async () => {
      const op = operations.find((candidate) => candidate.operationId === OPERATION_ID)!;
      const FORBIDDEN = [
        'clr',
        'ilr',
        'centered_log_ratio',
        'log-ratio',
        'benjamini',
        'hochberg',
        'fdr_bh',
        'q-value',
        'p-value',
        'aldex',
        'ancom',
        'pseudocount',
      ];
      for (const param of op.parameters) {
        for (const forbidden of FORBIDDEN) {
          expect(param.key.toLowerCase()).not.toContain(forbidden);
        }
      }
    });
  },
);
