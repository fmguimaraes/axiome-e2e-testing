import { test, expect, type Page, type Request } from '@playwright/test';
import {
  seedLiveWorkbench, primeWorkspace, declineHoldoutUrl, stepUrl, waitForNode, associationAttemptsUrl, submitStepAndWait,
  SCREEN_OP, CUTOFF_OP, FISHER_OP, type Seeded,
} from '../AXI-1717/harness/live-workbench';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';

/**
 * AXI-1797 - Validation wiring: time-to-event Apply, Safe Compare client, per-branch restore,
 * analysis-scoped lock (epic AXI-1775, FR8, FR23, FR26, FR27; AC2, AC7, AC8; NFR1, NFR2, NFR6, NFR8).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 14
 * (14.1-14.5 automated here; 14.6 and 14.7 are `manual` with the reason stated there).
 * Tags: @SI-015 (the candidate application + its survival citation), @SI-017 (the comparability
 * gate + its facts route), @SI-034 (the declaration the Apply is scored against), @SI-046 (the
 * workbench Validation surface), @SI-002 (the additive gateway routes and contracts).
 *
 * REAL BACKEND, LLM-FREE - a TEMPLATE instantiation, never a planner call. Everything up to the
 * Validation is seeded through the API on the DECLARED container: holdout declined, screen and
 * marker on Branch 1, cutoff settled, ONE Fisher attempt run and CHOSEN, a captured cutoff choice
 * citing the real cutoff run, criteria and a candidate declared on the INSTANCE question (so the
 * plan read states a slot). SERIAL on that one analysis; every UI test opens a NEW page, so what
 * it asserts was read back from the server.
 */
const MARKER = 'CD8A_pre';
const APPLY = /\/candidate-validations\/apply$/;
const COMPARABILITY = /\/rule-runs\/comparability$/;
const NIL_UUID = '00000000-0000-4000-8000-000000000000';

const open = (page: Page, va: string, s: Seeded) => page.goto(`/projects/${s.projectId}/discovery-workbench?analysisId=${va}`);
const restored = (page: Page) => expect(page.getByTestId('discovery-workbench')).toHaveAttribute('data-restore-status', 'restored', { timeout: 60_000 });

function record(page: Page, url: RegExp): { bodies: () => any[] } {
  const seen: Request[] = [];
  page.on('request', (req) => { if (req.method() === 'POST' && url.test(req.url())) seen.push(req); });
  return { bodies: () => seen.map((r) => r.postDataJSON()) };
}

async function planRead(s: Seeded, va: string): Promise<any> {
  const plan = await s.api.get(`/api/v1/discovery/analyses/${va}/plan`, s.t.headers);
  expect(plan.status, JSON.stringify(plan.body)).toBe(200);
  return plan.body;
}
const slotOf = async (s: Seeded, va: string) => (await planRead(s, va)).branches?.[0]?.candidate ?? null;

async function snapshotRows(s: Seeded): Promise<any[]> {
  const res = await s.api.get(`/api/v1/view-analyses/${s.declaredAnalysisId}/snapshots?limit=200`, s.t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return Array.isArray(res.body) ? res.body : res.body?.data ?? [];
}

interface SeededCandidate { cutoffRunId: string; attemptRunId: string; cutoffChoiceId: string; decisionDraftId: string; discoverySnapshotId: string }

/** Holdout declined, screen + marker on Branch 1, cutoff settled, ONE Fisher attempt run and chosen. */
async function seedToAttempt(s: Seeded, va: string): Promise<{ cutoffRunId: string; attemptRunId: string }> {
  const declined = await s.api.post(declineHoldoutUrl(va, 'split'), { reason: 'axi-1797: exploratory arm' }, s.t.headers);
  expect(declined.body.declined, JSON.stringify(declined.body)).toBe(true);
  const screenRunId = await submitStepAndWait(s, va, 'screen', SCREEN_OP, { branchId: null });
  const chosen = await s.api.post(`/api/v1/discovery/analyses/${va}/screen-choice`, { branchId: null, runId: screenRunId, marker: MARKER, rationale: 'axi-1797 seed', deviationRationale: null }, s.t.headers);
  expect(chosen.body.chosen, JSON.stringify(chosen.body)).toBe(true);
  const cutoffRunId = await submitStepAndWait(s, va, 'cutoff', CUTOFF_OP, { selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: MARKER } } });
  const cutoffNodeId = ((await planRead(s, va)).nodes ?? []).find((n: any) => n.runId === cutoffRunId)?.nodeId;
  expect(cutoffNodeId, 'the plan read names the settled cutoff node').toBeTruthy();
  await approveCarriersFor([FISHER_OP]); // AXI-1809: a governed step runs only a SERVED carrier
  const res = await s.api.post(stepUrl(va, 'outcome_association', 'submit'), {
    operationId: FISHER_OP, datasetId: s.datasetId, projectId: s.projectId, branchId: null,
    selection: { kind: 'cutoff_choice', nodeId: cutoffNodeId, runId: cutoffRunId, values: { marker: MARKER } },
  }, s.t.headers);
  expect(res.body.submitted, JSON.stringify(res.body)).toBe(true);
  await waitForNode(s, res.body.runId, res.body.nodeId);
  const choose = await s.api.post(associationAttemptsUrl(va, 'choose'), { branchId: null, runId: res.body.runId, note: 'axi-1797: the one attempt' }, s.t.headers);
  expect(choose.body.chosen, JSON.stringify(choose.body)).toBe(true);
  return { cutoffRunId, attemptRunId: res.body.runId as string };
}

/** A captured cutoff choice citing the real cutoff run, a decision, criteria and the candidate on the instance question. */
async function seedCandidate(s: Seeded, questionKey: string): Promise<SeededCandidate> {
  const ws = `/api/v1/workspaces/${s.t.workspaceId}`;
  const { cutoffRunId, attemptRunId } = await seedToAttempt(s, s.declaredAnalysisId);
  const cutoffSnapshot = (await snapshotRows(s)).find((r) => r.ruleRunId === cutoffRunId);
  const discoverySnapshotId = cutoffSnapshot?.parentSnapshotId as string;
  expect(discoverySnapshotId, 'the cutoff run records its fitted-on snapshot').toBeTruthy();
  const table = await s.api.get(`/api/v1/rule-runs/${cutoffRunId}/table?page=1&limit=50`, s.t.headers);
  const cut = (table.body?.rows ?? []).find((r: any) => r.measurement === MARKER);
  expect(cut, `the cutoff run proposed a cut-point for ${MARKER}`).toBeTruthy();
  const choice = await s.api.post(`${ws}/cutoff-choices`, {
    measurement: MARKER, projectId: s.projectId, snapshotId: discoverySnapshotId,
    presentedProposals: [{ proposalId: `data:${MARKER}`, sourceType: 'data_derived', label: 'ROC/Youden', operator: 'gte', valueLow: cut.cutoff, ruleRunId: cutoffRunId }],
    chosenProposalId: `data:${MARKER}`, rationale: 'AXI-1797 e2e: the ROC/Youden proposal on this branch.',
  }, s.t.headers);
  expect(choice.status, JSON.stringify(choice.body)).toBe(201);
  const decision = await s.api.post(`${ws}/decisions`, {
    label: 'AXI-1797 e2e decision', type: 'biomarker_threshold', projectId: s.projectId, context: { intendedUse: 'RUO' }, evidenceLinks: [],
    evidenceValues: [{ metric: 'axi_1797_e2e_placeholder', value: 1, unit: 'count', sourceSnapshotId: 'axi-1797-e2e-placeholder-snapshot' }],
  }, s.t.headers);
  expect(decision.status, JSON.stringify(decision.body)).toBe(201);
  const criteria = await s.api.post(`${ws}/verdict-criteria`, {
    decisionDraftId: decision.body.id, projectId: s.projectId, questionKey,
    criteria: [{ metric: 'sensitivity', operator: 'gte', threshold: 0.5 }], narrative: 'AXI-1797: sensitivity at least 0.5.',
  }, s.t.headers);
  expect(criteria.status, JSON.stringify(criteria.body)).toBe(201);
  const declared = await s.api.post(`${ws}/candidate-validations/declare`, {
    decisionDraftId: decision.body.id, cutoffChoiceId: choice.body.id, citedAssociationRunId: attemptRunId, discoverySnapshotId, questionKey, branchId: null,
  }, s.t.headers);
  expect(declared.status, JSON.stringify(declared.body)).toBe(201);
  return { cutoffRunId, attemptRunId, cutoffChoiceId: choice.body.id, decisionDraftId: decision.body.id, discoverySnapshotId };
}

async function openValidation(page: Page, s: Seeded): Promise<ReturnType<Page['getByTestId']>> {
  await primeWorkspace(page, s);
  await open(page, s.declaredAnalysisId, s);
  await restored(page);
  await expect(page.getByTestId('validation-expand')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('validation-expand').click();
  const panel = page.getByTestId('workbench-live-validation-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  return panel;
}

test.describe('AXI-1797 - Validation is wired LIVE: Safe Compare from server facts, survival citations judged by the server, the panel bound to the slot, the Apply lands and restores (UI + API, real backend)', { tag: ['@SI-015', '@SI-017', '@SI-034', '@SI-046', '@SI-002'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  let s: Seeded;
  let c: SeededCandidate;
  let questionKey: string;

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1797-${tag}`, `AXI-1797 Validation live ${tag}`);
    questionKey = (await planRead(s, s.declaredAnalysisId)).instance.questionKey;
    c = await seedCandidate(s, questionKey);
    const slot = await slotOf(s, s.declaredAnalysisId);
    expect(slot, 'the declaration on the instance question writes the Branch 1 slot').toMatchObject({ decisionDraftId: c.decisionDraftId, cutoffChoiceId: c.cutoffChoiceId, applicationCount: 0 });
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('14.1 FR27 AC8 NFR1 NFR2 - the comparability-facts route states the cohorts and their captured facts, never a default; a random project is a 404', async () => {
    const res = await s.api.get(`/api/v1/discovery/projects/${s.projectId}/comparability-facts`, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.projectId).toBe(s.projectId);
    const all = [...res.body.baseCohorts, ...res.body.independentCohorts];
    expect(res.body.baseCohorts.map((b: any) => b.datasetId)).toContain(s.datasetId);
    for (const cohort of all) {
      expect(Object.keys(cohort).sort()).toEqual(['analysisRole', 'captured', 'datasetId', 'name']);
      if (cohort.captured !== null) expect(Object.keys(cohort.captured).sort()).toEqual(['capturedAt', 'cryoState', 'gateParent', 'gatingVersion', 'panel', 'source']);
    }
    expect(res.body.unrecordedAxes.map((a: any) => a.ruleId)).toEqual(expect.arrayContaining(['IMM-CMP-05', 'IMM-CMP-11', 'IMM-CMP-12', 'IMM-CMP-13']));
    const missing = await s.api.get(`/api/v1/discovery/projects/${NIL_UUID}/comparability-facts`, s.t.headers);
    expect(missing.status, JSON.stringify(missing.body)).toBe(404);
  });

  test('14.3 FR26 AC7 NFR1 NFR8 - a survival citation that is not a log-rank run is refused verbatim; a missing run is refused like a foreign one; nothing is recorded', async () => {
    const slot = await slotOf(s, s.declaredAnalysisId);
    const baseline = (await snapshotRows(s)).find((r) => !r.parentSnapshotId && !r.ruleRunId);
    expect(baseline, 'the container carries a baseline snapshot').toBeTruthy();
    const body = (citedSurvivalRunId: string) => ({
      decisionDraftId: slot.decisionDraftId, cutoffChoiceId: slot.cutoffChoiceId, projectId: s.projectId,
      appliedCutoff: { measurement: slot.cutoff.measurement, operator: slot.cutoff.operator, valueLow: slot.cutoff.valueLow, valueHigh: slot.cutoff.valueHigh },
      discoverySnapshotId: slot.discoverySnapshotId, targetSnapshotId: baseline.id, questionKey, branchId: null,
      counts: { truePositive: 9, falsePositive: 2, trueNegative: 8, falseNegative: 1 }, fisherP: null,
      criteriaDeclarationId: slot.criteria.declarationId, citedSurvivalRunId,
    });
    const applyUrl = `/api/v1/workspaces/${s.t.workspaceId}/candidate-validations/apply`;
    const notLogRank = await s.api.post(applyUrl, body(c.cutoffRunId), s.t.headers);
    expect(notLogRank.status, JSON.stringify(notLogRank.body)).toBe(400);
    expect(JSON.stringify(notLogRank.body)).toContain('cited_survival_run_not_log_rank');
    expect(JSON.stringify(notLogRank.body)).toContain(CUTOFF_OP);
    const missing = await s.api.post(applyUrl, body(NIL_UUID), s.t.headers);
    expect(missing.status, JSON.stringify(missing.body)).toBe(400);
    expect(JSON.stringify(missing.body)).toContain('cited_survival_run_unreadable');
    // The foreign-workspace twin of this exact text is pinned by UT-EVID-1797-1203.
    expect(JSON.stringify(missing.body)).toContain(`The cited log-rank run ${NIL_UUID} does not exist in this workspace`);
    expect((await slotOf(s, s.declaredAnalysisId)).applicationCount).toBe(0);
  });

  test('14.4 FR23 FR26 AC7 NFR2 - the live panel is bound to the Branch 1 slot: decision and cutoff choice pre-selected, the binding named, the Apply not blocked on a pick', async ({ page }) => {
    const panel = await openValidation(page, s);
    await expect(panel.getByTestId('live-validation-binding')).toContainText(`decision ${c.decisionDraftId}, cutoff choice ${c.cutoffChoiceId}`, { timeout: 30_000 });
    await expect(panel.getByTestId('validation-decision-select')).toHaveValue(c.decisionDraftId, { timeout: 30_000 });
    await expect(panel.getByTestId('validation-choice-select')).toHaveValue(c.cutoffChoiceId, { timeout: 30_000 });
    const apply = panel.getByTestId('act-apply');
    await expect(apply.getByTestId('act-apply-derived-counts')).toBeVisible({ timeout: 30_000 });
    await expect(apply).not.toContainText('Pick the decision.');
    await expect(apply).not.toContainText('Pick the captured cutoff choice.');
    // Binary criteria (sensitivity) cite no log-rank run: the survival line stays absent (FR26).
    await expect(apply.getByTestId('act-apply-derived-survival')).toHaveCount(0);
  });

  test('14.2 FR27 AC8 NFR2 NFR6 - the Safe Compare panel asks the gate only about declared independent cohorts; with none declared it says so and sends nothing', async ({ page }) => {
    const evaluations = record(page, COMPARABILITY);
    const panel = await openValidation(page, s);
    const safe = panel.getByTestId('safe-compare-panel');
    await expect(safe).toContainText('Advisory');
    await expect(safe.getByTestId('safe-compare-referent')).toBeVisible({ timeout: 30_000 });
    await expect(safe.getByTestId('safe-compare-empty')).toHaveText('No dataset in this project is declared an independent validation cohort.');
    await expect(safe.getByTestId('safe-compare-unrecorded')).toContainText('IMM-CMP-05');
    expect(evaluations.bodies(), 'no independent cohort = no gate call (never a fabricated pass)').toEqual([]);
  });

  test('14.5 FR8 FR26 AC2 AC7 NFR2 - a live Apply moves the node face and the rail without a reload, then restores from the plan read after one', async ({ page }) => {
    const applies = record(page, APPLY);
    const panel = await openValidation(page, s);
    await expect(page.getByTestId('validation-face')).not.toContainText('Latest Apply');
    await expect(page.getByTestId('phase-rail-step-validation')).not.toHaveAttribute('data-state', 'done');
    const apply = panel.getByTestId('act-apply');
    await expect(apply.getByTestId('act-apply-derived-counts')).toBeVisible({ timeout: 30_000 });
    await apply.getByTestId('act-apply-submit').click();
    await expect.poll(() => applies.bodies().length, { timeout: 30_000 }).toBe(1);
    const error = apply.getByTestId('act-apply-error');
    const face = page.getByTestId('validation-face');
    await expect(face.filter({ hasText: 'Latest Apply' }).or(error)).toBeVisible({ timeout: 30_000 });
    if (await error.isVisible()) throw new Error(`the server refused the Apply: ${await error.innerText()}`);
    expect(applies.bodies()[0]).not.toHaveProperty('logRankP');
    expect(applies.bodies()[0]).not.toHaveProperty('citedSurvivalRunId');

    await expect.poll(async () => (await slotOf(s, s.declaredAnalysisId)).applicationCount, { timeout: 30_000 }).toBe(1);
    const slot = await slotOf(s, s.declaredAnalysisId);
    const verdict = slot.latestApply.verdict as string;
    expect(['holds', 'fails', 'inconclusive']).toContain(verdict);
    await expect(face).toHaveText(`Latest Apply: ${verdict} · 1 application`, { timeout: 30_000 });
    await expect(page.getByTestId('phase-rail-step-validation')).toHaveAttribute('data-state', 'done');

    await page.reload();
    await restored(page);
    await expect(page.getByTestId('validation-face')).toHaveText(`Latest Apply: ${verdict} · 1 application`, { timeout: 60_000 });
    await expect(page.getByTestId('phase-rail-step-validation')).toHaveAttribute('data-state', 'done');
  });
});
