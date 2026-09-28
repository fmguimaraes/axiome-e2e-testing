import { test, expect, type Page, type Request } from '@playwright/test';
import {
  seedLiveWorkbench, primeWorkspace, declineHoldoutUrl, stepUrl, waitForNode, associationAttemptsUrl, submitStepAndWait, publishedRuleCode,
  SCREEN_OP, CUTOFF_OP, FISHER_OP, type Seeded,
} from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1795 - Association phase wired: Fisher, Kaplan-Meier, log-rank runs with CI, sentence and attempts
 * (epic AXI-1775, FR18, FR19, FR20, FR21, FR22; AC6; EC6; NFR1, NFR2).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 12.
 * Tags: @SI-046 (the workbench Association surface), @SI-045 (the governed association step,
 * its branch claim and the persisted archive/choice), @SI-048 (the server-rendered sentence).
 *
 * REAL BACKEND, LLM-FREE - a TEMPLATE instantiation, never a planner call. Everything up to
 * the Association is seeded through the API on the DECLARED container (holdout declined,
 * screen run on Branch 1, marker chosen, a real cutoff proposal settled), so the suite drives
 * only this story's surface. SERIAL on that one analysis: Branch 1 holds ONE live Fisher
 * claim, launched once through the UI; every later test opens a NEW page, so what it asserts
 * was read back from the server, never carried over from a click in the same page.
 *
 * The Riaz fixture carries a binary outcome only (`response`), so Kaplan-Meier and log-rank
 * are offered disabled with their reason; their readout path is the same route and is
 * unit-covered (UT-FE-GUIDED-1795-1011, UT-GUIDED-1795-1008).
 */
const MARKER = 'CD8A_pre';
const NOTE = 'e2e: the only Fisher attempt on Branch 1';
const SUBMIT = /\/discovery\/analyses\/[^/]+\/steps\/outcome_association\/submit$/;
const CHOOSE = /\/association-attempts\/choose$/;

const open = (page: Page, va: string, s: Seeded) => page.goto(`/projects/${s.projectId}/discovery-workbench?analysisId=${va}`);
const restored = (page: Page) => expect(page.getByTestId('discovery-workbench')).toHaveAttribute('data-restore-status', 'restored', { timeout: 60_000 });

function record(page: Page, url: RegExp): { bodies: () => any[] } {
  const seen: Request[] = [];
  page.on('request', (req) => { if (req.method() === 'POST' && url.test(req.url())) seen.push(req); });
  return { bodies: () => seen.map((r) => r.postDataJSON()) };
}

async function planAssociation(s: Seeded, va: string, branch = 0): Promise<any> {
  const plan = await s.api.get(`/api/v1/discovery/analyses/${va}/plan`, s.t.headers);
  expect(plan.status, JSON.stringify(plan.body)).toBe(200);
  return plan.body.branches?.[branch]?.association ?? null;
}

/** Holdout declined, screen on Branch 1 (branchId null = a RECORDED claim), marker chosen, cutoff settled. */
async function seedToAssociation(s: Seeded, va: string): Promise<{ cutoffRunId: string; cutoffNodeId: string }> {
  const declined = await s.api.post(declineHoldoutUrl(va, 'split'), { reason: 'axi-1795: exploratory arm' }, s.t.headers);
  expect(declined.body.declined, JSON.stringify(declined.body)).toBe(true);
  const screenRunId = await submitStepAndWait(s, va, 'screen', SCREEN_OP, { branchId: null });
  const chosen = await s.api.post(`/api/v1/discovery/analyses/${va}/screen-choice`, { branchId: null, runId: screenRunId, marker: MARKER, rationale: 'axi-1795 seed', deviationRationale: null }, s.t.headers);
  expect(chosen.body.chosen, JSON.stringify(chosen.body)).toBe(true);
  const cutoffRunId = await submitStepAndWait(s, va, 'cutoff', CUTOFF_OP, { selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: MARKER } } });
  const plan = await s.api.get(`/api/v1/discovery/analyses/${va}/plan`, s.t.headers);
  const cutoffNodeId = (plan.body.nodes ?? []).find((n: any) => n.runId === cutoffRunId)?.nodeId;
  expect(cutoffNodeId, 'the plan read names the settled cutoff node').toBeTruthy();
  return { cutoffRunId, cutoffNodeId };
}

async function openAssociation(page: Page, s: Seeded): Promise<ReturnType<Page['getByTestId']>> {
  await primeWorkspace(page, s);
  await open(page, s.declaredAnalysisId, s);
  await restored(page);
  const expand = page.getByTestId('association-expand');
  await expect(expand).toBeEnabled({ timeout: 30_000 });
  await expand.click();
  return page.getByTestId('workbench-association-modal');
}

test.describe('AXI-1795 - the Association runs on the governed path with the server CI, sentence and persisted attempts (UI, real backend)', { tag: ['@SI-046', '@SI-045', '@SI-048'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  let s: Seeded;
  let cutoffRunId: string;
  let attemptRunId: string;
  let fisherCode: string;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1795-${tag}`, `AXI-1795 Association live ${tag}`);
    ({ cutoffRunId } = await seedToAssociation(s, s.declaredAnalysisId));
    fisherCode = await publishedRuleCode(s, FISHER_OP);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR18 FR21 AC6 - Run makes ONE governed submit naming Branch 1 with the REAL cutoff choice; the attempt settles live', async ({ page }) => {
    const submits = record(page, SUBMIT);
    const modal = await openAssociation(page, s);
    await expect(modal.getByTestId('assoc-inputs')).toContainText(MARKER);
    await modal.getByTestId('assoc-outcomes').getByRole('button', { name: /response/ }).click();
    await modal.getByTestId('assoc-rules').getByRole('button', { name: new RegExp(fisherCode) }).click();
    await modal.getByTestId('assoc-run').click();
    await expect(modal.getByTestId('assoc-run-error')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => submits.bodies().length, { timeout: 30_000 }).toBe(1);
    const body = submits.bodies()[0];
    expect(body).toMatchObject({ operationId: FISHER_OP, branchId: null, selection: { kind: 'cutoff_choice', runId: cutoffRunId, values: { marker: MARKER } } });
    await expect(modal.locator('input[name="assoc-choose"]:enabled')).toHaveCount(1, { timeout: 240_000 });
    const attempts = (await planAssociation(s, s.declaredAnalysisId))?.attempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ operationId: FISHER_OP, state: 'completed', recorded: true, archive: null, choice: null });
    attemptRunId = attempts[0].runId;
  });

  test('FR19 FR20 EC6 NFR2 - the effect, CI and sentence shown are the server readout, verbatim; the CI is never a bare dash', async ({ page }) => {
    const readout = (await s.api.get(associationAttemptsUrl(s.declaredAnalysisId, attemptRunId), s.t.headers)).body;
    expect(readout).toMatchObject({ runId: attemptRunId, state: 'completed' });
    expect(['stated', 'unavailable']).toContain(readout.estimate.ciStatus);
    const modal = await openAssociation(page, s);
    const effect = modal.getByTestId('assoc-effect');
    await expect(effect).toContainText('odds ratio', { timeout: 60_000 });
    await expect(effect).toContainText(readout.estimate.ciStatus === 'stated' ? /95% CI \S+–\S+/ : 'CI unavailable — not estimable');
    await expect(effect).not.toContainText('[CI —]');
    await expect(effect).toContainText(`n = ${readout.estimate.n}`);
    if (readout.sentence) await expect(modal.getByTestId('assoc-sentence')).toHaveText(readout.sentence);
    else await expect(modal.getByTestId('assoc-sentence-withheld')).toContainText(readout.sentenceWithheldReason);
    await expect(modal.getByTestId('assoc-table')).toContainText(String(readout.counts.nBoth));
    await expect(modal.getByTestId('assoc-cutpoint-notice')).toContainText('not applied');
  });

  test('FR22 - a one-live-attempt-per-operation branch offers Fisher as "Already tried"; a second attempt means Reopen here', async ({ page }) => {
    const modal = await openAssociation(page, s);
    await modal.getByTestId('assoc-outcomes').getByRole('button', { name: /response/ }).click();
    await modal.getByTestId('assoc-rules').getByRole('button', { name: new RegExp(fisherCode) }).click();
    await expect(modal.getByTestId('assoc-run')).toHaveText('Already tried');
    await expect(modal.getByTestId('assoc-run')).toBeDisabled();
  });

  test('FR22 - Choose needs a note; the choice is the SERVER record and survives a reload (face done, chosen from 1)', async ({ page }) => {
    const chooses = record(page, CHOOSE);
    const modal = await openAssociation(page, s);
    await modal.locator('input[name="assoc-choose"]:enabled').first().check();
    await expect(modal.getByTestId('assoc-choose')).toBeDisabled();
    await modal.getByTestId('assoc-note').fill(NOTE);
    await modal.getByTestId('assoc-choose').click();
    await expect(modal).toBeHidden({ timeout: 30_000 });
    expect(chooses.bodies()).toEqual([{ branchId: null, runId: attemptRunId, note: NOTE }]);
    expect((await planAssociation(s, s.declaredAnalysisId)).attempts[0].choice).toMatchObject({ note: NOTE });
    await page.reload();
    await restored(page);
    await expect(page.getByTestId('association-face-done')).toContainText('chosen from 1', { timeout: 60_000 });
  });
});

test.describe('AXI-1795 - archive is a server record with a reason; refusals are outputs (API + UI, real backend)', { tag: ['@SI-045', '@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  let s: Seeded;
  let runId: string;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1795-arch-${tag}`, `AXI-1795 Association archive ${tag}`);
    const { cutoffRunId, cutoffNodeId } = await seedToAssociation(s, s.declaredAnalysisId);
    const res = await s.api.post(stepUrl(s.declaredAnalysisId, 'outcome_association', 'submit'), {
      operationId: FISHER_OP, datasetId: s.datasetId, projectId: s.projectId, branchId: null,
      selection: { kind: 'cutoff_choice', nodeId: cutoffNodeId, runId: cutoffRunId, values: { marker: MARKER } },
    }, s.t.headers);
    expect(res.body.submitted, JSON.stringify(res.body)).toBe(true);
    runId = res.body.runId;
    await waitForNode(s, runId, res.body.nodeId);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR22 - a choice without a note is REFUSED with its reason (200, chosen: false) and nothing is recorded', async () => {
    const res = await s.api.post(associationAttemptsUrl(s.declaredAnalysisId, 'choose'), { branchId: null, runId, note: '  ' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.chosen).toBe(false);
    expect(res.body.reasons.length).toBeGreaterThan(0);
    expect((await planAssociation(s, s.declaredAnalysisId)).attempts[0].choice).toBeNull();
  });

  test('FR22 - archive with a reason persists; the reloaded workbench shows the attempt archived with that reason and not choosable', async ({ page }) => {
    const res = await s.api.post(associationAttemptsUrl(s.declaredAnalysisId, 'archive'), { branchId: null, runId, reason: 'e2e: wrong outcome framing' }, s.t.headers);
    expect(res.body.archived, JSON.stringify(res.body)).toBe(true);
    expect((await planAssociation(s, s.declaredAnalysisId)).attempts[0].archive).toMatchObject({ reason: 'e2e: wrong outcome framing' });
    const again = await s.api.post(associationAttemptsUrl(s.declaredAnalysisId, 'archive'), { branchId: null, runId, reason: 'twice' }, s.t.headers);
    expect(again.body.archived).toBe(false);
    const modal = await openAssociation(page, s);
    await expect(modal.getByTestId('assoc-attempts')).toContainText('archived · e2e: wrong outcome framing', { timeout: 60_000 });
    await expect(modal.locator('input[name="assoc-choose"]:enabled')).toHaveCount(0);
    await expect(modal.getByTestId('assoc-counts')).toHaveText('1 tried · 1 archived');
  });
});
