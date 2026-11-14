import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import {
  ensureRoundTripTenant,
  ingestRoundTripFixture,
  ensureRoundTripAnalysis,
  type RoundTripFixture,
  type Tenant,
} from '../AXI-1911/harness/round-trip';
import { carrierRuleId } from '../AXI-1400/harness/seed';

/**
 * AXI-2448 (epic AXI-2455 - TPL FR27, EC14) - a normal statistical run still SUCCEEDS with the node
 * output-conformance check wired into the completion path, and its result table carries every
 * declared column. Two operations: a flat one (Mann-Whitney) and one with a NESTED output column
 * (`stats.cutoff_roc_youden`, `rocCoordinates` is a LIST of STRUCT - the case a flattened-schema
 * read would wrongly fail).
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md
 * ## AXI-2448. Each execution is FRESH (per-run salt in the data, `dedupedFromRunId` asserted
 * absent): a deduped submission would only re-read a run that finished before the gate existed.
 * Drift cannot be induced through the API (bio-compute writes its declared schema), so the
 * OUTPUT_NONCONFORMING path is proven by UT-RULES-7260..7265, not here.
 *
 * Meaningful as a check of the gate only against a backend carrying AXI-2448; against an older one
 * it still passes (the table conforms either way).
 */

const salt = () => (Date.now() % 100000) / 1e6 + Math.random() / 1e6;

function groupedFixture(operationId: string, params: Record<string, unknown>, roles: Record<string, unknown>): RoundTripFixture {
  const s = salt();
  return {
    method_id: `${operationId}.axi-2448.${Date.now()}`,
    operation_id: operationId,
    operand_roles: roles,
    operation_params: params,
    csv_columns: ['group', 'value'],
    rows: [
      ...[12.1, 13.4, 14.0, 15.2, 13.8, 14.6, 12.9, 13.1].map((v) => ({ group: 'A', value: String(v + s) })),
      ...[3.1, 4.2, 2.8, 5.0, 3.6, 4.4, 3.9, 4.8].map((v) => ({ group: 'B', value: String(v + s) })),
    ],
    case_kind: 'nominal',
  } as unknown as RoundTripFixture;
}

test.describe('AXI-2448 - output conformance wired into the run completion', () => {
  test.setTimeout(6 * 60_000);
  let api: Api;
  let t: Tenant;

  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureRoundTripTenant(api);
  });

  test.afterAll(async () => {
    await api.ctx.dispose();
  });

  /** Submit a FRESH run on its own freshly ingested dataset and poll it to a terminal state. */
  async function freshRun(fixture: RoundTripFixture, extra: Record<string, unknown> = {}) {
    await carrierRuleId(fixture.operation_id);
    const datasetId = await ingestRoundTripFixture(api, t, fixture);
    const analysis = await ensureRoundTripAnalysis(api, t, `AXI-2448 ${fixture.method_id}`, datasetId);
    const ruleId = await carrierRuleId(fixture.operation_id);
    let submit: { status: number; body: any } | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      submit = await api.post(
        '/api/v1/rule-runs',
        {
          ruleId,
          runKind: 'STATISTICAL',
          operationId: fixture.operation_id,
          operationParams: fixture.operation_params,
          roleBindings: fixture.operand_roles,
          ...extra,
          projectId: t.projectId,
          workspaceId: t.workspaceId,
          datasetId,
          snapshotId: analysis.snapshotId,
          viewAnalysisId: analysis.analysisId,
          scope: 'FILTERED',
        },
        t.headers,
      );
      if (!(submit.status === 400 && /profil/i.test(JSON.stringify(submit.body)))) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(submit!.status, `submit failed: ${JSON.stringify(submit!.body)}`).toBeLessThan(300);
    expect(submit!.body.dedupedFromRunId, 'run deduped onto an earlier run - not a fresh execution').toBeUndefined();
    const runId: string = submit!.body.id ?? submit!.body.ruleRunId;
    let run: any = (await api.get(`/api/v1/rule-runs/${runId}`, t.headers)).body;
    for (let i = 0; i < 90 && !['SUCCEEDED', 'FAILED', 'CANCELED'].includes(run.status); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      run = (await api.get(`/api/v1/rule-runs/${runId}`, t.headers)).body;
    }
    return { runId, run };
  }

  async function assertSucceededWithColumns(runId: string, run: any, columns: string[]) {
    expect(run.status, `run did not succeed: ${JSON.stringify(run)}`).toBe('SUCCEEDED');
    expect(run.errorCode ?? null).not.toBe('OUTPUT_NONCONFORMING');
    expect(run.statusMessage ?? '').not.toContain('output-conformance');
    const table = await api.get(`/api/v1/rule-runs/${runId}/table?page=1&limit=10`, t.headers);
    expect(table.status).toBe(200);
    for (const column of columns) {
      expect(table.body.columns, `result table lacks ${column}`).toContain(column);
    }
    return table.body;
  }

  test('AXI-2448.A1: a fresh Mann-Whitney run SUCCEEDS (not OUTPUT_NONCONFORMING) and its table carries the declared columns', { tag: ['@SI-017', '@SI-052'] }, async () => {
    const fixture = groupedFixture('stats.mann_whitney_u', { groupFrom: 'A', groupTo: 'B', alternative: 'two_sided' }, { groupColumn: 'group' });
    const { runId, run } = await freshRun(fixture, { pivot: { valueColumns: ['value'] } });
    await assertSucceededWithColumns(runId, run, ['feature', 'measurement', 'uStatistic', 'pValue', 'effectSize', 'auc', 'reason']);
  });

  test('AXI-2448.A3: a fresh ROC-Youden run (nested rocCoordinates) SUCCEEDS - a nested column is one column, not its children', { tag: ['@SI-017', '@SI-052'] }, async () => {
    const fixture = groupedFixture(
      'stats.cutoff_roc_youden',
      { positiveGroup: 'A', bootstrapSeed: 777, bootstrapIterations: 200 },
      { groupColumn: 'group', valueColumns: ['value'] },
    );
    const { runId, run } = await freshRun(fixture);
    const table = await assertSucceededWithColumns(runId, run, ['rocCoordinates']);
    for (const child of ['list', 'element', 'fpr', 'tpr']) {
      expect(table.columns, `nested child ${child} leaked as a column`).not.toContain(child);
    }
  });
});
