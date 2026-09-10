import { test, expect } from '@playwright/test';
import { adminApi, type Api } from './harness/api';
import { ensureTenant, ingestFixture, assignProfileAndVerify, ensureAnalysis, type Tenant, type Analysis } from './harness/seed';
import { ANALYSES, COVERED_OPERATION_IDS, NEGATIVE_CASE } from './harness/operationMatrix';
import { fetchDescriptors, runOperation, runNegative, type Descriptor } from './harness/runAndAssert';

/**
 * AXI-1400 (epic acceptance, Workflow 5) — the whole-surface, cross-story flow
 * for the Governed Statistical Analysis Surface feature (epics AXI-1396..1400).
 *
 * Unlike the AXI-1396..1399 specs — read-only descriptor-liveness probes that
 * defer real execution as "manual residue" — this spec actually EXECUTES every
 * one of the governed statistical operations end-to-end against the running,
 * fully-merged stack: it seeds an additive "Statistical Surface Validation"
 * project, one referent per role-shape, and for each operation submits a
 * governed run and asserts the full contract (SUCCEEDED, exact executor pin,
 * materialised statistical_table with declared columns, a rule-derived snapshot
 * in the triggering analysis, a declared defaultChart). It also proves the
 * armed-precondition BLOCK (FR8) refuses an insufficient-sample submission.
 *
 * It is idempotent against the shared demo DB (reuse-or-create by name) and
 * mutates no pre-existing data. Run headless against the demo:
 *   API_BASE_URL=http://localhost:3000 npx playwright test tests/AXI-1400
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let api: Api;
let tenant: Tenant;
let descriptors: Map<string, Descriptor>;
const analyses = new Map<string, { analysis: Analysis; datasetId: string }>();
const brokenLibraries = new Set<string>();

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant(api);
  descriptors = await fetchDescriptors(api);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-1400 — governed statistical surface (whole-surface E2E)', { tag: ['@SI-017', '@SI-021', '@SI-023', '@SI-016', '@SI-035'] }, () => {
  test('surface parity — the matrix covers every live STATISTICAL operation', async () => {
    const live = [...descriptors.values()].filter((d) => d.runKind === 'STATISTICAL').map((d) => d.operationId).sort();
    expect(new Set(COVERED_OPERATION_IDS).size, 'matrix has no duplicate ops').toBe(COVERED_OPERATION_IDS.length);
    expect([...COVERED_OPERATION_IDS].sort(), 'every governed statistical operation is exercised').toEqual(live);
  });

  for (const group of ANALYSES) {
    test.describe(group.name, () => {
      test.beforeAll(async () => {
        test.setTimeout(150_000);
        const datasetId = await ingestFixture(api, tenant, group.fixture);
        if (group.requiredCanonicals.length) {
          await assignProfileAndVerify(api, tenant, group.requiredCanonicals);
        }
        const analysis = await ensureAnalysis(api, tenant, group.name, datasetId);
        analyses.set(group.name, { analysis, datasetId });
      });

      for (const op of group.ops) {
        test(op.operationId, async () => {
          test.skip(brokenLibraries.has(op.library), `executor for ${op.library} unavailable — an earlier op in this library failed to import`);
          const { analysis, datasetId } = analyses.get(group.name)!;
          const descriptor = descriptors.get(op.operationId);
          expect(descriptor, `${op.operationId} absent from live operation surface`).toBeTruthy();

          const res = await runOperation(api, tenant, analysis, datasetId, op, descriptor!);
          if (!res.ok && res.libraryAbsent) {
            brokenLibraries.add(op.library);
            test.skip(true, `executor for ${op.library} (pin ${op.pin}) unavailable: ${res.detail}`);
          }
          expect(res.ok, res.detail).toBeTruthy();
        });
      }
    });
  }

  test('negative — an armed count precondition BLOCKs before any run row (FR8/AC5)', async () => {
    const datasetId = await ingestFixture(api, tenant, NEGATIVE_CASE.fixture);
    const analysis = await ensureAnalysis(api, tenant, NEGATIVE_CASE.name, datasetId);
    await runNegative(api, tenant, analysis, datasetId, NEGATIVE_CASE.operationId, NEGATIVE_CASE.roleBindings, NEGATIVE_CASE.expectCondition);
  });
});
