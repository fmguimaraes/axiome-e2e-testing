import { test, expect } from '@playwright/test';
import { adminApi, type Api } from './harness/api';
import {
  ensureTenant, ingestFixture, ensureLink, assignProfileAndVerify, ensureAnalysis, pollTerminal,
  type Tenant, type Analysis,
} from './harness/seed';

/**
 * AXI-1235 (epic AXI-1233) — merge covariate preservation, end to end.
 *
 * Review-gate bounce (round 2): AC5 — "a merge-result dataset carrying a
 * preserved covariate passes the Stratify compatibility gate and can be
 * partitioned by that covariate (each subject -> exactly one group)" — had
 * no automated or manual E2E coverage, only unit tests over in-memory
 * DataFrames/mocked Prisma. This spec drives the REAL gateway -> org-service
 * -> bio-compute path for the whole chain: ingest two datasets that each
 * carry a subject-constant `cohort` covariate -> merge them
 * (`POST /view-analyses/:id/merge-runs`) -> link + semantically map the
 * merge output -> execute a real `stratify.explicit_groups` run against it
 * (`POST /rule-runs`) -> read its materialized summary
 * (`GET /rule-runs/:id/summary`) and assert a clean partition.
 *
 * API-only (no browser): the merge-runs and rule-runs surfaces are plain
 * REST/RPC-backed endpoints with no UI concerned in this story's diff, so a
 * browser adds flakiness without adding coverage — the same reasoning
 * `tests/AXI-1397/*` and `tests/AXI-1435/*` document for their own API-only
 * halves.
 *
 * Fixture design (load-bearing): the merge's hard precondition (FR7) refuses
 * a run whose two inputs share NO feature column at all, so `merge_covariates_a.csv`/
 * `_b.csv` share one numeric feature, `value`. They also share subject S003
 * with the SAME `value` AND the SAME `cohort` (Arm-A) in both inputs, so a
 * `refuse` collision policy still succeeds — the merge exercises AC3's
 * collision machinery (both the numeric-cell AND the covariate path) on a
 * genuinely NON-colliding overlap rather than needing a laxer policy. The
 * five subjects split 3 Arm-A / 2 Arm-B — AC5's partition assertion is
 * meaningful (not a trivial single-group case).
 */

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let api: Api;
let tenant: Tenant;

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant(api);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-1235 — merge covariate preservation (AC1, AC5)', { tag: ['@SI-017', '@AXI-1235'] }, () => {
  test('AC1/AC5 — a merge output carrying a preserved covariate passes the Stratify gate and partitions subjects 1:1 into groups', async () => {
    // --- seed + merge ---
    const datasetIdA = await ingestFixture(api, tenant, 'merge_covariates_a.csv');
    const datasetIdB = await ingestFixture(api, tenant, 'merge_covariates_b.csv');
    await assignProfileAndVerify(api, tenant, ['patient_id']);

    const analysisA: Analysis = await ensureAnalysis(api, tenant, 'AXI-1235 merge input A', datasetIdA);

    const mergeRes = await api.post(
      `/api/v1/view-analyses/${analysisA.analysisId}/merge-runs`,
      { inputDatasetIdA: datasetIdA, inputDatasetIdB: datasetIdB, collisionPolicy: 'refuse' },
      tenant.headers,
    );
    expect(mergeRes.status, `merge-run initiate failed: ${JSON.stringify(mergeRes.body)}`).toBeLessThan(300);
    expect(mergeRes.body.status).toBe('succeeded');
    expect(mergeRes.body.outputDatasetId, 'merge succeeded but produced no output dataset').toBeTruthy();
    const outputDatasetId: string = mergeRes.body.outputDatasetId;

    // --- AC1: the merge output's queryable columns AND row values include the
    // preserved covariate. `GET /datasets/:id` never serializes `schemaJson`
    // (it is an internal-only field used for query-filter validation, never
    // projected onto the dataset response DTO) — `POST /datasets/:id/query`
    // is the one reachable surface that reports a dataset's real column list
    // (`QueryDataResponse.columns`), and asserting it over the row DATA too is
    // strictly stronger than a metadata-only schema check.
    const outputQuery = await api.post(
      `/api/v1/workspaces/${tenant.workspaceId}/datasets/${outputDatasetId}/query`,
      { limit: 20 },
      tenant.headers,
    );
    expect(outputQuery.status, `merge output query failed: ${JSON.stringify(outputQuery.body)}`).toBe(200);
    const columnNames: string[] = (outputQuery.body.columns ?? []).map((c: any) => c.name);
    expect(columnNames, 'merge output schema is missing the preserved `cohort` covariate column').toContain('cohort');
    const cohortBySubject = new Map<string, string>(
      outputQuery.body.rows.map((r: any) => [r.subject_id, r.cohort]),
    );
    expect(cohortBySubject.get('S001')).toBe('Arm-A');
    expect(cohortBySubject.get('S002')).toBe('Arm-B');
    expect(cohortBySubject.get('S003')).toBe('Arm-A');
    expect(cohortBySubject.get('S004')).toBe('Arm-B');
    expect(cohortBySubject.get('S005')).toBe('Arm-A');

    // --- link + semantically map the output so the Stratify gate can resolve its subject key ---
    await ensureLink(api, tenant, outputDatasetId);
    await assignProfileAndVerify(api, tenant, ['patient_id']);

    const outputAnalysis: Analysis = await ensureAnalysis(api, tenant, 'AXI-1235 merge output', outputDatasetId);

    // --- AC5: execute a real stratification over the preserved covariate ---
    const partitionRule = {
      field: 'cohort',
      kind: 'categorical',
      groups: [
        { id: 'arm_a', label: 'Arm A', levels: ['Arm-A'] },
        { id: 'arm_b', label: 'Arm B', levels: ['Arm-B'] },
      ],
    };
    const runRes = await api.post('/api/v1/rule-runs', {
      ruleId: tenant.stratifyRuleId,
      // `RuleRunsService.validateInputSource` requires `datasetId` on every
      // EXECUTE call regardless of `snapshotId` (a backward-compat artifact of
      // the pre-AXI-1136 dataset-scoped path, per that service's own doc
      // comment on `assertCallerMayUseSnapshotReferent`) — omitting it 400s
      // even though `snapshotId` is what actually resolves the referent.
      datasetId: outputDatasetId,
      runKind: 'STRATIFY',
      operationId: 'stratify.explicit_groups',
      workspaceId: tenant.workspaceId,
      projectId: tenant.projectId,
      viewAnalysisId: outputAnalysis.analysisId,
      snapshotId: outputAnalysis.snapshotId,
      partitionRule,
    }, tenant.headers);
    expect(runRes.status, `rule-run execute failed: ${JSON.stringify(runRes.body)}`).toBeLessThan(300);

    // `POST /rule-runs` (ExecuteRuleRunResponse) keys the new run `ruleRunId`,
    // distinct from `GET /rule-runs/:id` (RuleRunResponse), which keys it `id`.
    const finalRun = await pollTerminal(api, tenant, runRes.body.ruleRunId);
    expect(
      ['SUCCEEDED', 'DEDUPED'],
      `stratify run did not succeed: ${JSON.stringify(finalRun)}`,
    ).toContain(finalRun.status);

    // FR10/FR11, FR15: a re-run against identical inputs is fingerprint-deduped
    // rather than re-executed — it never materializes its OWN stratification
    // (its own `/summary` 404s, "No materialized stratification run found"),
    // it points at the run whose group nodes it reused (`dedupedFromRunId`).
    // Both are a genuine AC5 pass: the compatibility gate accepted the
    // referent and a (possibly earlier) real execution partitioned it.
    const summaryRunId = finalRun.status === 'DEDUPED' ? finalRun.dedupedFromRunId : finalRun.id;
    const summaryRes = await api.get(`/api/v1/rule-runs/${summaryRunId}/summary`, tenant.headers);
    expect(summaryRes.status, `stratify summary fetch failed: ${JSON.stringify(summaryRes.body)}`).toBe(200);
    const summary = summaryRes.body;

    // Every one of the 5 merged subjects lands in EXACTLY one declared group:
    // none unassigned, none overlapping, and the per-group counts partition
    // the whole scope (AC5's "each subject -> exactly one group").
    expect(summary.scopeN, 'unexpected subject scope — fixture has 5 subjects (S001-S005)').toBe(5);
    expect(summary.unassignedN).toBe(0);
    expect(summary.overlappingN).toBe(0);
    const byId = new Map(summary.groups.map((g: any) => [g.groupId, g.n]));
    expect(byId.get('arm_a')).toBe(3);
    expect(byId.get('arm_b')).toBe(2);
    expect((byId.get('arm_a') as number) + (byId.get('arm_b') as number)).toBe(summary.scopeN);
  });
});
