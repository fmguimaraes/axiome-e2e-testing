import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureProject, findQcRuleId, ingestFixture, ensureDefaultAnalysis, pollRunTerminal, resolveMaterialisedRow, NAMES } from './harness/seed';

/**
 * AXI-1482 (epic AXI-1474) — dataset-referent QC placement and the strip's read
 * contract (§4.1-4.3 of manual-e2e/AXI-1474-Executable-QC-Result-Snapshots.md).
 *
 * These three scenarios were manual-only until AXI-1474-validation (W5) fixed
 * the platform gap the doc names: `ProjectsService.linkDataset` never
 * materialized a project's `auto_default` view analysis, so a dataset-referent
 * QC run had no container to land in and the doc's own precondition (§2)
 * could not be satisfied outside a hand-seeded environment. That gap is closed
 * (`materializeDefaultAnalysis` now called unconditionally on link), so these
 * scenarios are automated here for the first time.
 *
 * §4.4 (visual differentiation) and §4.5 (staleness on a second ingestion) stay
 * manual — the former is a by-design human visual check, the latter needs a
 * real second ingestion to completion and is left as follow-up debt.
 */
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let api: Api;
let t: Awaited<ReturnType<typeof ensureTenant>>;
let ruleId: string;
let datasetId: string;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  ruleId = await findQcRuleId(api, t);
  datasetId = await ingestFixture(api, t);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

function qcRunBody(projectId: string) {
  return {
    ruleId, runKind: 'QC', operationId: 'qc.rule_gate',
    projectId, workspaceId: t.workspaceId, datasetId,
  };
}

test('AC19 — a dataset-version QC run lands in the dataset default analysis', { tag: ['@SI-017', '@SI-013', '@SI-002'] }, async () => {
  const projectId = await ensureProject(api, t, NAMES.project);
  const analysisId = await ensureDefaultAnalysis(api, t, projectId, datasetId);

  const before = await api.get(`/api/v1/view-analyses?projectId=${projectId}`, t.headers);
  const countBefore = before.body.length ?? before.body.data?.length ?? before.body._list?.length;

  const submit = await api.post('/api/v1/rule-runs', qcRunBody(projectId), t.headers);
  expect(submit.status, `QC submit: ${JSON.stringify(submit.body)}`).toBeLessThan(300);
  const polled = await pollRunTerminal(api, t, submit.body.ruleRunId);
  expect(polled.status, `QC run status: ${JSON.stringify(polled)}`).toMatch(/SUCCEEDED|DEDUPED/);
  // A re-run of this idempotent seed against the same referent legitimately
  // dedupes; resolve the canonical materialised run either way.
  const row = await resolveMaterialisedRow(api, t, polled);

  const after = await api.get(`/api/v1/view-analyses?projectId=${projectId}`, t.headers);
  const countAfter = after.body.length ?? after.body.data?.length ?? after.body._list?.length;
  expect(countAfter, 'no new analysis was created for the QC run').toBe(countBefore);

  // On dedup, the ORIGINAL submission's own analysis holds the real snapshot —
  // the fingerprint keys on the referent, not on which analysis re-submitted it.
  const snapshotAnalysisId: string = submit.body?.existingViewAnalysisId ?? analysisId;
  const snaps = await api.get(`/api/v1/view-analyses/${snapshotAnalysisId}/snapshots?page=1&limit=200`, t.headers);
  const list = Array.isArray(snaps.body) ? snaps.body : snaps.body.data ?? snaps.body._list ?? [];
  const derived = list.find((s: any) => s.origin === 'rule_derived' && s.ruleRunId === row.id);
  expect(derived, 'the QC result is a rule_derived snapshot in the pre-existing default analysis').toBeTruthy();
  // AXI-1474-validation (this epic's own W5 backend fix): a rule execution
  // always derives from a snapshot — the container's v1 baseline — so the
  // result parents to it, not null (the doc's older "no referent snapshot"
  // wording predates that fix and is stale; see qc-dataset-container.service.ts).
  expect(derived.parentSnapshotId, 'the QC result parents to the container baseline snapshot').toBeTruthy();
});

test('AC19 — a dataset with no default analysis is refused, not accommodated', { tag: ['@SI-017'] }, async () => {
  const projectId = await ensureProject(api, t, NAMES.refusalProject);
  const analysisId = await ensureDefaultAnalysis(api, t, projectId, datasetId);
  const archived = await api.patch(`/api/v1/view-analyses/${analysisId}/archive`, {}, t.headers);
  expect(archived.status, `archive default analysis: ${JSON.stringify(archived.body)}`).toBeLessThan(300);

  const runsBefore = await api.get(`/api/v1/rule-runs?workspaceId=${t.workspaceId}&projectId=${projectId}&limit=100`, t.headers);
  const runCountBefore = (runsBefore.body.data ?? runsBefore.body._list ?? runsBefore.body ?? []).length ?? 0;

  const submit = await api.post('/api/v1/rule-runs', qcRunBody(projectId), t.headers);
  expect(submit.status, 'a dataset with no default analysis must be refused').toBe(400);
  expect(String(submit.body?.message ?? '')).toContain('has no default view analysis for the project');
  expect(submit.body?.ruleRunId ?? null, 'no run row on a refusal').toBeFalsy();

  const runsAfter = await api.get(`/api/v1/rule-runs?workspaceId=${t.workspaceId}&projectId=${projectId}&limit=100`, t.headers);
  const runCountAfter = (runsAfter.body.data ?? runsAfter.body._list ?? runsAfter.body ?? []).length ?? 0;
  expect(runCountAfter, 'no run row was created by the refused submission').toBe(runCountBefore);
});

test('AC20 — the QC strip reports the verdict for the §4.1 run', { tag: ['@SI-032', '@SI-030', '@SI-010'] }, async () => {
  const projectId = await ensureProject(api, t, NAMES.project);
  await ensureDefaultAnalysis(api, t, projectId, datasetId);

  const strip = await api.get(
    `/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/qc-strip?projectId=${projectId}`,
    t.headers,
  );
  expect(strip.status, `qc-strip: ${JSON.stringify(strip.body)}`).toBe(200);
  expect(strip.body.viewAnalysisId, 'strip resolves the default analysis, not null').toBeTruthy();

  const row = (strip.body.entries ?? []).find((e: any) => e.ruleCode === NAMES.qcRuleCode);
  expect(row, `strip carries a row for ${NAMES.qcRuleCode}`).toBeTruthy();
  expect(['pass', 'block', 'degrade']).toContain(row.verdict);
  expect(row.rowsEvaluated, 'rowsEvaluated is reported').toBeGreaterThan(0);
  expect(row.viewAnalysisId, 'the row points at the default analysis').toBe(strip.body.viewAnalysisId);
  expect(row.ruleRunId, 'the row names the run it came from').toBeTruthy();
});
