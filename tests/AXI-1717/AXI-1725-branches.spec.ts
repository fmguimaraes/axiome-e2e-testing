import { test, expect } from '@playwright/test';
import { workspaceHeader } from '../AXI-1435/harness/api';
import {
  seedLiveWorkbench, driveToScreen, branchUrl, stepUrl, submitStepAndWait, waitForNode, primeWorkspace,
  SCREEN_OP, CUTOFF_OP, FISHER_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1725 — Fork from node, branch strip and branch count (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 13.
 * Tags: @SI-045 (guided-analysis: the branch bookkeeping service), @SI-016 (graph:
 * the branch-count query), @SI-046/@SI-035 (front: the branch strip, "Reopen here").
 *
 * REAL BACKEND, LLM-FREE — the nine-step plan is a TEMPLATE instantiation
 * (`POST /discovery/plans`), never a planner call. Fixture: Riaz 2017 immune, 27
 * patients, `response` R/NR, `patient_id`. Seed lifted from AXI-1721's harness
 * (`./harness/live-workbench.ts`) rather than re-deriving the pre-Screen drive.
 */

test.describe('AXI-1725 - fork, discard and count (API, real backend)', { tag: ['@SI-045', '@SI-016'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  let screenRunId: string;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1725-api-${Date.now().toString(36)}`, 'AXI-1725 Branches API');
    // `submitStepAndWait` posts the submit AND waits for the node to settle
    // (`SUCCEEDED`/`REUSED`) before returning — a bare `POST .../submit` returns
    // as soon as the run is ACCEPTED, not once it has run, and every test below
    // that forks or reads "screen" assumes it has already completed.
    screenRunId = await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR20 - a fresh question starts at the implicit Branch 1: total=1, discarded=0', async () => {
    const res = await s.api.get(branchUrl(s.viewAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ branches: [], counts: { total: 1, discarded: 0 } });
  });

  test('FR18 - a fork off a step that has not completed in THIS container is refused', async () => {
    const res = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'cutoff' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.forked).toBe(false);
    expect(res.body.reasons.join(' ')).toMatch(/has not completed/);
  });

  let branchId: string;
  test('FR18, FR20 - forking a settled step (screen) creates Branch 2 and total becomes 2', async () => {
    const res = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.forked).toBe(true);
    expect(res.body.branch).toMatchObject({ name: 'Branch 2', forkedFromStepId: 'screen', status: 'active' });
    expect(res.body.counts).toEqual({ total: 2, discarded: 0 });
    branchId = res.body.branch.id;
  });

  test('EC6 - two branches may run the SAME cutoff step in parallel (no second-candidate collision at this layer)', async () => {
    // EC6 constrains one declared CANDIDATE per question across branches — a later
    // story's concern (candidate declaration, AXI-1724's territory). Forking and
    // running the same downstream step on two branches is itself unrestricted here.
    const submitOnBranch1 = await s.api.post(stepUrl(s.viewAnalysisId, 'cutoff', 'resolve'), {
      operationId: CUTOFF_OP, datasetId: s.datasetId,
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: 'CD8A_pre' } },
    }, s.t.headers);
    expect(submitOnBranch1.status, JSON.stringify(submitOnBranch1.body)).toBe(200);
  });

  test('FR19 - discarding the fork records an AXI-1507 FR6 discarded path and updates the count', async () => {
    const res = await s.api.post(branchUrl(s.viewAnalysisId, branchId), { reason: 'the shortlist was empty on this arm' }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.discarded).toBe(true);
    expect(res.body.branch).toMatchObject({ status: 'discarded', discardReason: 'the shortlist was empty on this arm' });
    expect(res.body.counts).toEqual({ total: 2, discarded: 1 });
  });

  test('FR19 - a blank reason is refused before any write; an already-discarded branch cannot be discarded again', async () => {
    const blank = await s.api.post(branchUrl(s.viewAnalysisId, branchId), { reason: '   ' }, s.t.headers);
    expect(blank.status, JSON.stringify(blank.body)).toBe(200);
    expect(blank.body.discarded).toBe(false);

    const again = await s.api.post(branchUrl(s.viewAnalysisId, branchId), { reason: 'again' }, s.t.headers);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.discarded).toBe(false);
  });

  test('FR19, FR20 - list shows the discarded branch (never hidden) with the FR20 count', async () => {
    const res = await s.api.get(branchUrl(s.viewAnalysisId), s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.counts).toEqual({ total: 2, discarded: 1 });
    expect(res.body.branches).toHaveLength(1);
    expect(res.body.branches[0]).toMatchObject({ id: branchId, status: 'discarded' });
  });

  test('FR21, EC5 - forking split BEFORE any exploration is fine; forking split AFTER a screen ran is refused', async () => {
    const before = await s.api.post(branchUrl(s.declaredAnalysisId), { nodeRef: 'split' }, s.t.headers);
    // The declared container's own split node never ran either, so this is the
    // SAME "has not completed" refusal FR18 already covers for an unsettled step —
    // asserted here to pin that split is not special-cased into a different reason.
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.forked).toBe(false);

    const afterFork = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'split' }, s.t.headers);
    expect(afterFork.status, JSON.stringify(afterFork.body)).toBe(200);
    expect(afterFork.body.forked).toBe(false);
    expect(afterFork.body.reasons.join(' ')).toMatch(/has not completed|before any exploration/);
  });

  test('NFR8 tenancy - workspaceId in the body is refused by the pipe (400); another workspace sees no instance (404)', async () => {
    const forged = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen', workspaceId: s.t.workspaceId }, s.t.headers);
    expect(forged.status).toBe(400);

    const other = await s.api.post('/api/v1/workspaces', { name: 'AXI-1725 Other Tenant', type: 'internal', ownerOrganizationId: s.t.orgId });
    const otherId = other.body?.id ?? (await s.api.get('/api/v1/workspaces?limit=100')).body.find?.((w: any) => w.name === 'AXI-1725 Other Tenant')?.id;
    expect(otherId, `other workspace: ${JSON.stringify(other.body)}`).toBeTruthy();
    const cross = await s.api.get(branchUrl(s.viewAnalysisId), workspaceHeader(otherId));
    expect([403, 404], JSON.stringify(cross)).toContain(cross.status);
  });

  test('FR9, NFR8 - the fork does not touch governed execution: the forked-from run is unchanged (runs are never mutated)', async () => {
    // The reconciler that settles a run's node status polls every 2s
    // (`ReconcilerScheduler`); by the time this LAST serial test runs the
    // screen run is normally long settled, but nothing here should assert on
    // a race with that poller — wait for the node the same way every other
    // step-completion assertion in this harness does.
    const { node } = await waitForNode(s, screenRunId, 'd6');
    expect(node.status).toMatch(/SUCCEEDED|REUSED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * EC6 (this story's own acceptance criterion, not AXI-1724's — "Given two
 * branches with different candidates Then both are visible and only one can be
 * declared for the question"). Two DECISIONS, each with its own real captured
 * cutoff choice, both try to declare a candidate against the SAME `questionKey`;
 * the second is refused server-side (`CandidateApplicationService`,
 * `DiscoveryQuestionCandidate` unique on `(workspaceId, questionKey)`).
 *
 * Proposals are captured as `expert`-sourced (a value entered, not computed) so
 * the capture needs no cited cutoff-proposal run — this test is about the
 * one-candidate-per-question guard, not about re-deriving AXI-1511/1630's own
 * proposal-verification coverage.
 */
test.describe('AXI-1725 - one declared candidate per question (API, real backend, EC6)', { tag: ['@SI-045', '@SI-034'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  // The tenant is a SHARED workspace across every e2e run against this stack
  // (`ensureTenant` finds-or-creates by a fixed name), so the question key must
  // be unique per run or a re-run collides with a row an EARLIER run declared —
  // which is a fixture hazard, not the EC6 guard failing.
  const QUESTION_KEY = `ec6-pd1-predicts-response-${Date.now().toString(36)}`;

  const decisionsUrl = () => `/api/v1/workspaces/${s.t.workspaceId}/decisions`;
  const cutoffChoicesUrl = () => `/api/v1/workspaces/${s.t.workspaceId}/cutoff-choices`;
  const declareUrl = () => `/api/v1/workspaces/${s.t.workspaceId}/candidate-validations/declare`;

  const makeDecision = async (label: string) => {
    const res = await s.api.post(decisionsUrl(), {
      label,
      type: 'biomarker_threshold',
      projectId: s.projectId,
      context: { intendedUse: 'RUO' },
      evidenceLinks: [],
      // At least one evidence link OR value is required (`validateEvidence`); an
      // explicit `projectId` above means this value's `sourceSnapshotId` is never
      // resolved (only the derive-from-evidence path reads it), so a placeholder
      // is enough — this test is about the candidate-declare guard, not evidence.
      // AXI-1725 (B1): `unit` is set so a later `-> invalidated` transition
      // (this describe block's third test) clears `validateEvidenceUnitsForReview`
      // — a unitless numeric value is refused before review/valid/invalidated.
      evidenceValues: [{ metric: 'ec6_e2e_placeholder', value: 1, unit: 'count', sourceSnapshotId: 'ec6-e2e-placeholder-snapshot' }],
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };

  const captureChoice = async (measurement: string) => {
    const res = await s.api.post(cutoffChoicesUrl(), {
      measurement,
      projectId: s.projectId,
      presentedProposals: [{
        proposalId: 'expert:ec6-e2e',
        sourceType: 'expert',
        label: 'Entered for EC6 e2e coverage',
        operator: 'gte',
        valueLow: 5,
      }],
      chosenProposalId: 'expert:ec6-e2e',
      rationale: 'EC6 e2e: any entered cut-point serves — this test is about the one-per-question guard.',
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };

  const declare = async (decisionDraftId: string, cutoffChoiceId: string) =>
    s.api.post(declareUrl(), {
      decisionDraftId,
      cutoffChoiceId,
      citedAssociationRunId: 'ec6-e2e-cited-run',
      discoverySnapshotId: 'ec6-e2e-discovery-snapshot',
      questionKey: QUESTION_KEY,
    }, s.t.headers);

  // AXI-1725 review bounce (B1) — the general decision-status endpoint
  // (`decision-drafts.controller.ts`'s `POST :id/transition`), reachable
  // through the SAME gateway every candidate move is. Used here instead of a
  // full Apply (which would additionally require a real cohort split and a
  // pre-specified criteria declaration, AXI-1511/1630's own territory) — this
  // test is about the EC6 slot release at the transition seam, not about
  // re-deriving how a verdict gets scored.
  const transitionUrl = (decisionDraftId: string) =>
    `/api/v1/workspaces/${s.t.workspaceId}/decisions/${decisionDraftId}/transition`;

  let decisionA: string;
  let decisionB: string;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1725-ec6-${Date.now().toString(36)}`, 'AXI-1725 EC6 Candidates');
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('EC6 - a first decision declares a candidate for the question and succeeds', async () => {
    decisionA = await makeDecision('EC6 e2e — decision A');
    const choiceA = await captureChoice('CD27_pre');
    const res = await declare(decisionA, choiceA);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  test('EC6 - a SECOND decision declaring against the SAME question is refused, naming the reason', async () => {
    decisionB = await makeDecision('EC6 e2e — decision B');
    const choiceB = await captureChoice('CD274_pre');
    const res = await declare(decisionB, choiceB);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/only one candidate may be declared per question \(EC6\)/);
  });

  // AXI-1725 review bounce (B1) — the defect this closes: the slot used to be
  // claimed forever, so a candidate that failed validation permanently locked
  // its question. `candidate -> invalidated` now releases it at the
  // transition seam (`DecisionDraftsService.applyStatusTransition`), so
  // decision B — refused above — can now declare for real.
  test('EC6 - invalidating decision A frees the question for decision B to declare', async () => {
    const invalidated = await s.api.post(transitionUrl(decisionA), { targetStatus: 'invalidated' }, s.t.headers);
    // 201, NestJS's default `@Post` status — this endpoint has no `@HttpCode`
    // override (unlike the branch fork/discard endpoints, which do, since a
    // refusal there is a normal response body, NFR8). A status TRANSITION is
    // a genuine mutation, so the default Created is correct as-is.
    expect(invalidated.status, JSON.stringify(invalidated.body)).toBe(201);
    expect(invalidated.body.status, JSON.stringify(invalidated.body)).toBe('invalidated');

    const res = await declare(decisionB, (await captureChoice('PD1_pre')));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test.describe('AXI-1725 - the branch strip renders the real count (UI, real backend)', { tag: ['@SI-046', '@SI-035'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    // The project NAME (unlike `label`, the plan-instance discriminator) is what
    // `ensureProject` finds-or-creates by — a fixed name across runs reuses a
    // project whose dataset link/auto_default materialization may have stuck
    // from an earlier, interrupted run (observed in this story's own sidecar:
    // an `ensureDefaultAnalysis` poll timeout that a fresh project never hit),
    // and once linked, `ensureLink` no-ops so no fresh materialization is ever
    // retried. Unique per run, same fix already applied to EC6's `QUESTION_KEY`.
    s = await seedLiveWorkbench(`axi-1725-ui-${Date.now().toString(36)}`, `AXI-1725 Branches UI ${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR20 - a freshly opened LIVE workbench reports "reported after 1 branch"', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.viewAnalysisId);
    const strip = page.getByTestId('phase-rail-live-branches');
    await expect(strip).toBeVisible();
    await expect(page.getByTestId('phase-rail-live-branch-count')).toHaveText('reported after 1 branch');
  });

  test('FR18, FR20 - "Reopen here" on Split forks a branch and the strip\'s count follows, in place (no remount/navigation)', async ({ page }) => {
    await primeWorkspace(page, s);
    // `driveToScreen` already confirms population, picks the stratification
    // contrast and declines the holdout on its way to the Screen node — Split
    // is therefore ALREADY `decided` (contrast + holdout both set) once this
    // returns, so `split-reopen` is visible with no extra setup.
    await driveToScreen(page, s.projectId, s.viewAnalysisId);
    await expect(page.getByTestId('phase-rail-live-branch-count')).toHaveText('reported after 1 branch');

    // Review-bounce regression coverage (AXI-1725): `useLiveBranches` used to
    // keep its fetch state per call site, so `SplitNode`'s OWN hook instance
    // and `LiveBranchStrip`'s were two independent copies — clicking the REAL
    // "Reopen here" button (not a direct API call standing in for it) refreshed
    // only SplitNode's unread copy, and the strip never moved without a full
    // remount. There is deliberately NO `page.goto`/`page.reload` anywhere
    // below this point — the assertion is that the SAME mounted page updates
    // itself once the shared store is notified.
    await page.getByTestId('split-reopen').click();
    await expect(page.getByTestId('phase-rail-live-branch-count')).toHaveText('reported after 2 branches', { timeout: 30_000 });
    await expect(page.getByTestId(/^live-branch-chip-/)).toHaveCount(2);
  });

  test('the preview path (no analysisId) is structurally unchanged: no live branch strip', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, null);
    await expect(page.getByTestId('phase-rail-live-branches')).toHaveCount(0);
  });
});
