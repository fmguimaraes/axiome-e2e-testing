import { test, expect, type Page, type Request } from '@playwright/test';
import {
  seedLiveWorkbench, primeWorkspace, declineHoldoutUrl, stepUrl, waitForNode, associationAttemptsUrl, submitStepAndWait,
  SCREEN_OP, CUTOFF_OP, FISHER_OP, type Seeded,
} from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1796 - Candidate declaration wiring, verdict vocabulary and templates, promote and close endpoints
 * (epic AXI-1775, FR23, FR24, FR25, FR28; AC7, AC8; EC7; NFR1, NFR2, NFR6).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 13.
 * Tags: @SI-015 (the candidate declaration + application objects), @SI-034 (the declaration
 * steps and the criterion templates), @SI-046 (the workbench Candidate / Validation surface),
 * @SI-002 (the additive gateway routes and their contracts).
 *
 * REAL BACKEND, LLM-FREE - a TEMPLATE instantiation, never a planner call. Everything up to the
 * Candidate is seeded through the API on the DECLARED container (holdout declined, screen on
 * Branch 1, marker chosen, cutoff settled, ONE Fisher attempt run and CHOSEN), so the suite
 * drives only this story's surface. SERIAL on that one analysis: the question holds ONE
 * candidate slot, declared once through the UI; every later test opens a NEW page, so what it
 * asserts was read back from the server, never carried over from a click in the same page.
 */
const MARKER = 'CD8A_pre';
const DECLARE = /\/candidate-validations\/declare$/;
const PROMOTE = /\/discovery\/analyses\/[^/]+\/candidate\/promote$/;
const RATIONALE = 'e2e: held on an independent cohort with the frozen cut-point';
const CLOSE_NOTE = 'e2e: answered — candidate promoted';

const open = (page: Page, va: string, s: Seeded) => page.goto(`/projects/${s.projectId}/discovery-workbench?analysisId=${va}`);
const restored = (page: Page) => expect(page.getByTestId('discovery-workbench')).toHaveAttribute('data-restore-status', 'restored', { timeout: 60_000 });
const promoteUrl = (va: string) => `/api/v1/discovery/analyses/${va}/candidate/promote`;
const closeUrl = (va: string) => `/api/v1/discovery/analyses/${va}/question/close`;

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

/** Holdout declined, screen + marker on Branch 1, cutoff settled, ONE Fisher attempt run and chosen. */
async function seedToCandidate(s: Seeded, va: string): Promise<string> {
  const declined = await s.api.post(declineHoldoutUrl(va, 'split'), { reason: 'axi-1796: exploratory arm' }, s.t.headers);
  expect(declined.body.declined, JSON.stringify(declined.body)).toBe(true);
  const screenRunId = await submitStepAndWait(s, va, 'screen', SCREEN_OP, { branchId: null });
  const chosen = await s.api.post(`/api/v1/discovery/analyses/${va}/screen-choice`, { branchId: null, runId: screenRunId, marker: MARKER, rationale: 'axi-1796 seed', deviationRationale: null }, s.t.headers);
  expect(chosen.body.chosen, JSON.stringify(chosen.body)).toBe(true);
  const cutoffRunId = await submitStepAndWait(s, va, 'cutoff', CUTOFF_OP, { selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: MARKER } } });
  const cutoffNodeId = ((await planRead(s, va)).nodes ?? []).find((n: any) => n.runId === cutoffRunId)?.nodeId;
  expect(cutoffNodeId, 'the plan read names the settled cutoff node').toBeTruthy();
  const res = await s.api.post(stepUrl(va, 'outcome_association', 'submit'), {
    operationId: FISHER_OP, datasetId: s.datasetId, projectId: s.projectId, branchId: null,
    selection: { kind: 'cutoff_choice', nodeId: cutoffNodeId, runId: cutoffRunId, values: { marker: MARKER } },
  }, s.t.headers);
  expect(res.body.submitted, JSON.stringify(res.body)).toBe(true);
  await waitForNode(s, res.body.runId, res.body.nodeId);
  const choose = await s.api.post(associationAttemptsUrl(va, 'choose'), { branchId: null, runId: res.body.runId, note: 'axi-1796: the one attempt' }, s.t.headers);
  expect(choose.body.chosen, JSON.stringify(choose.body)).toBe(true);
  return res.body.runId as string;
}

async function seedDecision(s: Seeded): Promise<string> {
  const res = await s.api.post(`/api/v1/workspaces/${s.t.workspaceId}/decisions`, {
    label: 'AXI-1796 e2e decision', type: 'biomarker_threshold', projectId: s.projectId,
    context: { intendedUse: 'RUO' }, evidenceLinks: [],
    evidenceValues: [{ metric: 'axi_1796_e2e_placeholder', value: 1, unit: 'count', sourceSnapshotId: 'axi-1796-e2e-placeholder-snapshot' }],
  }, s.t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/** The OPEN container's whole-dataset baseline — a snapshot the cutoff was NOT fitted on. */
async function independentTarget(s: Seeded): Promise<string> {
  const res = await s.api.get(`/api/v1/view-analyses/${s.viewAnalysisId}/snapshots?limit=200`, s.t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const rows: any[] = Array.isArray(res.body) ? res.body : res.body?.data ?? [];
  const baseline = rows.find((r) => !r.parentSnapshotId && !r.ruleRunId);
  expect(baseline, 'the open container carries a baseline snapshot').toBeTruthy();
  return baseline.id as string;
}

async function openCandidate(page: Page, s: Seeded): Promise<void> {
  await primeWorkspace(page, s);
  await open(page, s.declaredAnalysisId, s);
  await restored(page);
  const expand = page.getByTestId('candidate-expand');
  await expect(expand).toBeEnabled({ timeout: 30_000 });
  await expand.click();
}

async function openValidation(page: Page, s: Seeded): Promise<ReturnType<Page['getByTestId']>> {
  await primeWorkspace(page, s);
  await open(page, s.declaredAnalysisId, s);
  await restored(page);
  await expect(page.getByTestId('validation-expand')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('validation-expand').click();
  const outcome = page.getByTestId('live-candidate-outcome');
  await expect(outcome).toBeVisible({ timeout: 30_000 });
  return outcome;
}

test.describe('AXI-1796 - the Candidate is declared LIVE on the branch, restores, and promote/close are server records (UI + API, real backend)', { tag: ['@SI-015', '@SI-034', '@SI-046', '@SI-002'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  let s: Seeded;
  let attemptRunId: string;
  let questionKey: string;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1796-${tag}`, `AXI-1796 Candidate live ${tag}`);
    attemptRunId = await seedToCandidate(s, s.declaredAnalysisId);
    await seedDecision(s);
    questionKey = (await planRead(s, s.declaredAnalysisId)).instance.questionKey;
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR24 FR25 NFR2 NFR1 - the templates route serves the vocabulary, templates with author thresholds NULL, and the policy; tenancy is never read from the body', async () => {
    const res = await s.api.get('/api/v1/discovery/verdict-criterion-templates', s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.metrics).toEqual(expect.arrayContaining(['sensitivity', 'fisherP', 'oddsRatio', 'oddsRatioCiLow', 'oddsRatioCiHigh', 'logRankP']));
    const byId = Object.fromEntries(res.body.templates.map((t: any) => [t.id, t]));
    expect(byId.same_direction.criteria).toEqual([{ metric: 'oddsRatio', operator: 'gt', threshold: 1, thresholdSource: 'definitional' }]);
    expect(byId.sensitivity_and_specificity.criteria.map((c: any) => c.threshold)).toEqual([null, null]);
    expect(res.body.policy).toHaveProperty('approved');
    expect(['fails', 'inconclusive', null]).toContain(res.body.policy.nonEstimableVerdict);
    const smuggled = await s.api.post(promoteUrl(s.declaredAnalysisId), { branchId: null, rationale: 'x', workspaceId: s.t.workspaceId }, s.t.headers);
    expect(smuggled.status, 'forbidNonWhitelisted refuses a body-supplied workspace').toBe(400);
  });

  test('FR23 FR24 AC7 NFR2 - the panel is bound to Branch 1, the instance question and the CHOSEN attempt; a template leaves author thresholds blank; the declaration names the branch', async ({ page }) => {
    const declares = record(page, DECLARE);
    await openCandidate(page, s);
    await expect(page.getByTestId('live-candidate-question')).toHaveText(questionKey, { timeout: 30_000 });
    await expect(page.getByTestId('live-candidate-cited-attempt')).toContainText(attemptRunId);

    const radios = page.locator('input[data-testid^="cutoff-proposal-"]');
    await expect(radios.first()).toBeVisible({ timeout: 15_000 });
    await radios.first().click();
    await page.getByTestId('cutoff-rationale').fill('AXI-1796: the ROC/Youden proposal on this branch.');
    await page.getByTestId('cutoff-submit').click();
    await expect(page.getByTestId('cutoff-record')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('criteria-template-select').selectOption('sensitivity_and_specificity');
    const thresholds = page.locator('input[data-testid^="criteria-threshold-"]');
    await expect(thresholds).toHaveCount(2);
    for (let i = 0; i < 2; i += 1) await expect(thresholds.nth(i)).toHaveValue('');
    await expect(page.getByTestId('criteria-non-estimable')).toBeVisible();
    await expect(page.getByTestId('criteria-live-unseal')).toBeVisible();
    await expect(page.getByTestId('criteria-question-key')).toHaveCount(0);
    await thresholds.nth(0).fill('0.6');
    await thresholds.nth(1).fill('0.5');
    await page.getByTestId('criteria-decision-select').selectOption({ index: 1 });
    await page.getByTestId('criteria-narrative').fill('AXI-1796: sensitivity and specificity at least as stated.');
    await page.getByTestId('criteria-submit').click();
    await expect(page.getByTestId('criteria-record')).toBeVisible({ timeout: 20_000 });

    await expect(page.getByTestId('candidate-live-citation')).toContainText(attemptRunId);
    await expect(page.getByTestId('candidate-association-select')).toHaveCount(0);
    await page.getByTestId('candidate-submit').click();
    await expect(page.getByTestId('candidate-record')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => declares.bodies().length, { timeout: 30_000 }).toBe(1);
    expect(declares.bodies()[0]).toMatchObject({ branchId: null, questionKey, citedAssociationRunId: attemptRunId });

    const slot = await slotOf(s, s.declaredAnalysisId);
    expect(slot).toMatchObject({ citedAssociationRunId: attemptRunId, applicationCount: 0, promotion: null, closure: null });
    expect(slot.criteria.criteria).toEqual([
      { metric: 'sensitivity', operator: 'gte', threshold: 0.6 },
      { metric: 'specificity', operator: 'gte', threshold: 0.5 },
    ]);
  });

  test('FR23 AC7 - a fresh visit restores the slot from the plan read: the node reads declared, the modal shows the frozen server record', async ({ page }) => {
    await openCandidate(page, s);
    const slot = page.getByTestId('live-candidate-slot');
    await expect(slot).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('live-candidate-slot-cited-association-run')).toHaveText(attemptRunId);
    await expect(page.getByTestId('live-candidate-slot-criteria')).toContainText('Sensitivity ≥ 0.6');
    await expect(page.getByTestId('live-candidate-slot-question')).toHaveText('open');
    await expect(page.getByTestId('cutoff-submit')).toHaveCount(0);
  });

  test('FR28 AC8 - before any Apply, promote and close are REFUSED as 200 outputs with reasons, and nothing is recorded; the panel waits', async ({ page }) => {
    const promote = await s.api.post(promoteUrl(s.declaredAnalysisId), { branchId: null, rationale: RATIONALE }, s.t.headers);
    expect(promote.status, JSON.stringify(promote.body)).toBe(200);
    expect(promote.body.promoted).toBe(false);
    expect(promote.body.reasons.join(' ')).toMatch(/no validation Apply on this candidate held/);
    const close = await s.api.post(closeUrl(s.declaredAnalysisId), { branchId: null, note: null }, s.t.headers);
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    expect(close.body.closed).toBe(false);
    expect(close.body.reasons.join(' ')).toMatch(/nothing was applied to this candidate yet/);
    expect(await slotOf(s, s.declaredAnalysisId)).toMatchObject({ promotion: null, closure: null });

    const outcome = await openValidation(page, s);
    await expect(outcome.getByTestId('candidate-outcome-waiting')).toBeVisible();
    await expect(outcome.getByTestId('candidate-promote')).toHaveCount(0);
    await expect(outcome.getByTestId('candidate-close')).toHaveCount(0);
  });

  test('NFR1 - an unknown analysis id is a 404 (its foreign-workspace twin, the same 404, is unit-pinned by UT-GUIDED-1796-1145); a malformed branch id is a 400', async () => {
    const missing = await s.api.post(promoteUrl('00000000-0000-4000-8000-000000000000'), { branchId: null, rationale: RATIONALE }, s.t.headers);
    expect(missing.status, JSON.stringify(missing.body)).toBe(404);
    const bad = await s.api.post(closeUrl(s.declaredAnalysisId), { branchId: 'not-a-uuid' }, s.t.headers);
    expect(bad.status, JSON.stringify(bad.body)).toBe(400);
  });

  test('FR28 AC8 - after a HELD Apply, Promote lands the server record once; Close lands once; both refuse a second time; the rail completes on reload', async ({ page }) => {
    const slot = await slotOf(s, s.declaredAnalysisId);
    const target = await independentTarget(s);
    const apply = await s.api.post(`/api/v1/workspaces/${s.t.workspaceId}/candidate-validations/apply`, {
      decisionDraftId: slot.decisionDraftId, cutoffChoiceId: slot.cutoffChoiceId, projectId: s.projectId,
      appliedCutoff: { measurement: slot.cutoff.measurement, operator: slot.cutoff.operator, valueLow: slot.cutoff.valueLow, valueHigh: slot.cutoff.valueHigh },
      discoverySnapshotId: slot.discoverySnapshotId, targetSnapshotId: target, questionKey, branchId: null,
      counts: { truePositive: 9, falsePositive: 2, trueNegative: 8, falseNegative: 1 }, fisherP: null,
      criteriaDeclarationId: slot.criteria.declarationId,
    }, s.t.headers);
    expect(apply.status, `the Apply this leg stands on was refused: ${JSON.stringify(apply.body)}`).toBeLessThan(300);
    expect(apply.body.verdict, JSON.stringify(apply.body)).toBe('holds');

    const promotes = record(page, PROMOTE);
    const outcome = await openValidation(page, s);
    await outcome.getByTestId('candidate-outcome-reread').click();
    await expect(outcome.getByTestId('candidate-promote')).toBeDisabled({ timeout: 30_000 });
    await outcome.getByTestId('candidate-promote-rationale').fill(RATIONALE);
    await outcome.getByTestId('candidate-promote').click();
    await expect(outcome.getByTestId('candidate-promoted')).toContainText(RATIONALE, { timeout: 30_000 });
    expect(promotes.bodies()).toEqual([{ branchId: null, rationale: RATIONALE }]);
    expect((await slotOf(s, s.declaredAnalysisId)).promotion).toMatchObject({ rationale: RATIONALE });

    const again = await s.api.post(promoteUrl(s.declaredAnalysisId), { branchId: null, rationale: 'twice' }, s.t.headers);
    expect(again.body.promoted).toBe(false);
    expect(again.body.reasons.join(' ')).toMatch(/already promoted/);

    await outcome.getByTestId('candidate-close-note').fill(CLOSE_NOTE);
    await outcome.getByTestId('candidate-close').click();
    await expect(outcome.getByTestId('candidate-closed')).toContainText(CLOSE_NOTE, { timeout: 30_000 });
    const closedAgain = await s.api.post(closeUrl(s.declaredAnalysisId), { branchId: null, note: 'twice' }, s.t.headers);
    expect(closedAgain.body.closed).toBe(false);
    expect(closedAgain.body.reasons.join(' ')).toMatch(/the question is closed/);
    expect((await slotOf(s, s.declaredAnalysisId)).closure).toMatchObject({ note: CLOSE_NOTE });

    await page.reload();
    await restored(page);
    await expect(page.getByTestId('workbench-candidate-node')).toContainText('question closed', { timeout: 60_000 });
  });
});
