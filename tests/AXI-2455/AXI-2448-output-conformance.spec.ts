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
 * AXI-2448 (epic AXI-2455 - TPL FR27, EC14) - a normal statistical run still succeeds with the
 * node output-conformance check wired into the completion path, and its result table carries
 * every declared column (including the `feature` column the declarations now state).
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md
 * ## AXI-2448 (AXI-2448.A1). The nonconforming path (OUTPUT_NONCONFORMING) is NOT reachable
 * through the API: bio-compute writes its parquet with the declared schema, so a real run cannot
 * drift. It is proven by UT-RULES-7260..7264 (rule-runs.service.spec.ts).
 *
 * Needs the AXI-2448 backend to be meaningful as a regression check of the wired gate; against an
 * older backend it still passes (the table is conforming either way).
 */

const FIXTURE = {
  method_id: 'stats.mann_whitney_u.axi-2448',
  operation_id: 'stats.mann_whitney_u',
  operand_roles: { groupColumn: 'group' },
  operation_params: { groupFrom: 'A', groupTo: 'B', alternative: 'two_sided' },
  csv_columns: ['group', 'value'],
  rows: [
    ...[12.1, 13.4, 14.0, 15.2, 13.8, 14.6, 12.9, 13.1].map((v) => ({ group: 'A', value: String(v) })),
    ...[3.1, 4.2, 2.8, 5.0, 3.6, 4.4, 3.9, 4.8].map((v) => ({ group: 'B', value: String(v) })),
  ],
  case_kind: 'nominal',
} as unknown as RoundTripFixture;

test.describe('AXI-2448 - output conformance wired into the run completion', () => {
  test.setTimeout(6 * 60_000);
  let api: Api;
  let t: Tenant;
  let datasetId: string;

  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureRoundTripTenant(api);
    await carrierRuleId(FIXTURE.operation_id);
    datasetId = await ingestRoundTripFixture(api, t, FIXTURE);
  });

  test.afterAll(async () => {
    await api.ctx.dispose();
  });

  test('AXI-2448.A1: a Mann-Whitney run SUCCEEDS (not OUTPUT_NONCONFORMING) and its table carries the declared columns', { tag: ['@SI-017', '@SI-052'] }, async () => {
    const analysis = await ensureRoundTripAnalysis(api, t, 'AXI-2448 conformance', datasetId);
    // `valueColumns` travels on `pivot` (see AXI-1400 operationMatrix), which the shared
    // round-trip submit does not carry, so the run is submitted directly.
    const ruleId = await carrierRuleId(FIXTURE.operation_id);
    let submit: { status: number; body: any } | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      submit = await api.post(
        '/api/v1/rule-runs',
        {
          ruleId,
          runKind: 'STATISTICAL',
          operationId: FIXTURE.operation_id,
          operationParams: FIXTURE.operation_params,
          roleBindings: FIXTURE.operand_roles,
          pivot: { valueColumns: ['value'] },
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
    // A repeat of an identical submission dedups onto the earlier SUCCEEDED run; read that one.
    const runId: string = submit!.body.id ?? submit!.body.ruleRunId;
    const resolvedId: string = submit!.body.dedupedFromRunId ?? runId;
    let run: any = (await api.get(`/api/v1/rule-runs/${resolvedId}`, t.headers)).body;
    for (let i = 0; i < 60 && !['SUCCEEDED', 'FAILED', 'CANCELED'].includes(run.status); i++) {
      await new Promise((r) => setTimeout(r, 2000));
      run = (await api.get(`/api/v1/rule-runs/${resolvedId}`, t.headers)).body;
    }

    expect(run.status, `run did not succeed: ${JSON.stringify(run)}`).toBe('SUCCEEDED');
    const read = await api.get(`/api/v1/rule-runs/${resolvedId}`, t.headers);
    expect(read.status).toBe(200);
    expect(read.body.errorCode ?? null).not.toBe('OUTPUT_NONCONFORMING');
    expect(read.body.statusMessage ?? '').not.toContain('output-conformance');

    const table = await api.get(`/api/v1/rule-runs/${resolvedId}/table?page=1&limit=10`, t.headers);
    expect(table.status).toBe(200);
    for (const column of ['feature', 'measurement', 'uStatistic', 'pValue', 'effectSize', 'auc', 'reason']) {
      expect(table.body.columns, `result table lacks ${column}`).toContain(column);
    }
  });
});
