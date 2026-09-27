import { test, expect, Route } from '@playwright/test';
import {
  seedLiveWorkbench, driveToScreen, runLiveScreen, publishedRuleCode, primeWorkspace, submitStepAndWait,
  SCREEN_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1726 — Lock-outs at the node and reopen from history (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 16.
 * Tags: @SI-046 (canvas rendering, reopen routing), @SI-035 (the shared GuardReason path).
 *
 * REAL BACKEND, LLM-FREE (the guided-analysis plan LIST used by the reopen-leg
 * test is mocked at the Playwright route level — the same pattern
 * AXI-1718-guided-discovery-entry.spec.ts uses for its own `plans*` route —
 * never a live planner call).
 *
 * STATUS: authored 2026-09-27, NOT YET RUN against a live stack this session —
 * see manual-e2e/AXI-1717-Discovery-Workbench.md §16.6 for the honest reason
 * (the always-on shared demo stack is stale — missing AXI-1725's branch routes
 * entirely, confirmed by direct probe — and this story did not construct a
 * fresh worktree sidecar safely within the time available: `wt-up.sh` assumes
 * a superrepo-style worktree layout this and every AXI-1717 sibling story's
 * per-submodule `_worktrees/` layout does not have). Run before claiming
 * e2e-pass: `npx playwright test tests/AXI-1717/AXI-1726-lockouts.spec.ts`
 * against a stack whose `axiome-back` is at or after `origin/main`'s
 * AXI-1725 merge.
 *
 * Review-bounce pass (B1): two cases added for the OTHER leg of
 * `discoveryWorkbenchHref` — `GuidedAnalysisPanel.tsx`'s `viewOnly` Guided tab
 * (`ProjectViewAnalysisDetail.tsx`'s `?tab=guided`), mocking the resume-on-reload
 * chain (`governed-execution/in-flight`, `/latest-run-for-analysis`, `/status`)
 * alongside the existing `guided-analysis/plans*` mock. Authored only this
 * pass too, per the explicit instruction not to attempt the E2E run this bounce.
 */

const MARKER = 'CD8A_pre';

test.describe('AXI-1726 - FR22 guard-reason rendering (real backend)', { tag: ['@SI-046', '@SI-035'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1726-fr22-${Date.now().toString(36)}`, 'AXI-1726 Guard Reasons');
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR22/AC8 - a real AXI-1507 guard refusal (fork on a step that has not completed) renders verbatim through GuardReason, not a generic label', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.viewAnalysisId);

    // Split's contrast + holdout decision are taken locally (driveToScreen declines
    // the holdout), so "Reopen here" is enabled — but no governed run ever completed
    // the split step server-side, so the fork is refused with a REAL, specific reason
    // (not "error"/"blocked"/"cannot run") — confirmed end to end in AXI-1725's own
    // investigation of this exact refusal.
    const reopen = page.getByTestId('split-reopen');
    await expect(reopen).toBeVisible({ timeout: 15_000 });
    await reopen.click();

    const guard = page.getByTestId('split-reopen-error');
    await expect(guard).toBeVisible({ timeout: 15_000 });
    await expect(guard).toHaveText('step split has not completed in this analysis');
    // FR22: the ONE rendering path — the same `data-testid="guard-reason"` shape
    // `GuardReason.tsx` renders everywhere else, not a bespoke split-only element.
    // (`split-reopen-error` is the testId passed to this instance — see
    // `GuardReason.tsx`'s unit tests for the shared markup-shape proof.)
    await expect(guard).not.toContainText('error');
    await expect(guard).not.toContainText('blocked');
  });
});

test.describe('AXI-1726 - FR0f reopen leg from GuidedAnalysisHistory (mocked plan list, real workbench)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1726-fr0f-${Date.now().toString(36)}`, 'AXI-1726 Reopen From History');
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR0f/AC0b - a guided_discovery plan bound to a real analysis reopens the live Discovery Workbench, not the old view-analysis page', async ({ page }) => {
    await primeWorkspace(page, s);
    await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          planId: 'PL-1726-mock', question: 'AXI-1726 reopen leg', planner: 'anthropic', revision: 1, status: 'run',
          createdAt: new Date().toISOString(), plan: { planId: 'PL-1726-mock', question: 'AXI-1726 reopen leg', nodes: [] },
          strategy: 'guided_discovery', analysisId: s.viewAnalysisId,
        }]),
      });
    });
    await page.goto(`/projects/${s.projectId}/guided-analyses`);
    const link = page.getByTestId('history-bound-analysis').getByRole('link');
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute('href', `/projects/${s.projectId}/discovery-workbench?analysisId=${s.viewAnalysisId}`);

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/discovery-workbench\\?analysisId=${s.viewAnalysisId}`));
    // FR0f: opens "at its current phase" — the live canvas resolves each node's
    // own state by construction, so reaching the real, live workbench shell (not
    // the AXI-1719 preview mock, not the old placeholder guided-workbench shell)
    // is the whole of "current phase" for a reopened analysis.
    await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('population-confirm')).toBeVisible({ timeout: 30_000 });
  });

  test('NFR8 - a plan with no strategy keeps the pre-existing view-analysis target unchanged', async ({ page }) => {
    await primeWorkspace(page, s);
    await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          planId: 'PL-1726-none', question: 'AXI-1726 unguided', planner: 'anthropic', revision: 1, status: 'run',
          createdAt: new Date().toISOString(), plan: { planId: 'PL-1726-none', question: 'AXI-1726 unguided', nodes: [] },
          analysisId: s.declaredAnalysisId,
        }]),
      });
    });
    await page.goto(`/projects/${s.projectId}/guided-analyses`);
    const link = page.getByTestId('history-bound-analysis').getByRole('link');
    await expect(link).toBeVisible({ timeout: 15_000 });
    await expect(link).toHaveAttribute('href', `/projects/${s.projectId}/view-analyses/${s.declaredAnalysisId}`);
  });

  // AXI-1726 review bounce (B1): the OTHER leg of `discoveryWorkbenchHref` —
  // `GuidedAnalysisPanel.tsx`'s `viewOnly` Guided tab, embedded in
  // `ProjectViewAnalysisDetail.tsx` (`?tab=guided`). Mocks the same
  // `guided-analysis/plans*` route as the history-leg tests above, plus the
  // resume-on-reload chain `loadResumedRun`/`useResumableGovernedRunId` reads
  // (`governed-execution/in-flight`, `/latest-run-for-analysis`, `/status`) —
  // never a live planner or governed-execution call. AUTHORED ONLY this
  // review-bounce pass, not run against a live stack (no sidecar stood up
  // this pass — see manual-e2e §16.6).
  test('review bounce B1 - the viewOnly Guided tab offers "Open Discovery Workbench" for a guided_discovery plan, never for one with no strategy', async ({ page }) => {
    const RUN_ID = 'RUN-1726-viewonly-mock';
    const PLAN_ID = 'PL-1726-viewonly-mock';

    await primeWorkspace(page, s);
    await page.route('**/api/v1/governed-execution/in-flight*', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: null }) });
    });
    await page.route('**/api/v1/governed-execution/latest-run-for-analysis*', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: RUN_ID }) });
    });
    await page.route('**/api/v1/governed-execution/status*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ runId: RUN_ID, status: 'completed', nodes: [], planId: PLAN_ID }),
      });
    });
    await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          planId: PLAN_ID, question: 'AXI-1726 viewOnly leg', planner: 'anthropic', revision: 1, status: 'run',
          createdAt: new Date().toISOString(),
          plan: { planId: PLAN_ID, question: 'AXI-1726 viewOnly leg', nodes: [] },
          strategy: 'guided_discovery', analysisId: s.viewAnalysisId,
        }]),
      });
    });

    await page.goto(`/projects/${s.projectId}/view-analyses/${s.viewAnalysisId}?tab=guided`);
    const workbenchLink = page.getByTestId('ga-open-discovery-workbench');
    await expect(workbenchLink).toBeVisible({ timeout: 20_000 });
    await expect(workbenchLink).toHaveAttribute('href', `/projects/${s.projectId}/discovery-workbench?analysisId=${s.viewAnalysisId}`);
    await expect(workbenchLink).toHaveText('Open Discovery Workbench');
  });

  test('review bounce B1 (NFR8) - the viewOnly Guided tab offers NO discovery-workbench link for a plan with no strategy', async ({ page }) => {
    const RUN_ID = 'RUN-1726-viewonly-none';
    const PLAN_ID = 'PL-1726-viewonly-none';

    await primeWorkspace(page, s);
    await page.route('**/api/v1/governed-execution/in-flight*', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: null }) });
    });
    await page.route('**/api/v1/governed-execution/latest-run-for-analysis*', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: RUN_ID }) });
    });
    await page.route('**/api/v1/governed-execution/status*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ runId: RUN_ID, status: 'completed', nodes: [], planId: PLAN_ID }),
      });
    });
    await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          planId: PLAN_ID, question: 'AXI-1726 viewOnly leg, no strategy', planner: 'anthropic', revision: 1, status: 'run',
          createdAt: new Date().toISOString(),
          plan: { planId: PLAN_ID, question: 'AXI-1726 viewOnly leg, no strategy', nodes: [] },
          analysisId: s.viewAnalysisId,
        }]),
      });
    });

    await page.goto(`/projects/${s.projectId}/view-analyses/${s.viewAnalysisId}?tab=guided`);
    // The panel itself renders (proof the mocked resume chain worked, not a
    // false negative from a page that never loaded the Guided tab at all).
    await expect(page.getByTestId('ga-run-status-chip')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('ga-open-discovery-workbench')).toHaveCount(0);
  });
});

test.describe('AXI-1726 - ValidationNode honours its real LIVE lock state (real backend)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1726-vlock-${Date.now().toString(36)}`, 'AXI-1726 Validation Lock');
    await submitStepAndWait(s, s.declaredAnalysisId, 'screen', SCREEN_OP);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  async function toAssociationChosen(page: import('@playwright/test').Page): Promise<void> {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    const screenRuleCode = await publishedRuleCode(s, SCREEN_OP);
    await runLiveScreen(page, screenRuleCode);
    await page.getByTestId('screen-result-expand').click();
    await page.getByTestId('screen-filter').getByText('all', { exact: true }).click();
    await page.getByTestId('screen-shortlist-table').getByRole('row', { name: new RegExp(MARKER) }).click();
    await page.getByTestId('screen-choice-rationale').fill(`${MARKER} separates responders most clearly (AXI-1726)`);
    await page.getByTestId('screen-choose-marker').click();
    await expect(page.getByTestId('marker-chosen')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('association-expand').click();
    await page.getByTestId('assoc-outcomes').getByRole('button').first().click();
    await page.getByTestId('assoc-rules').getByRole('button').first().click();
    await page.getByTestId('assoc-run').click();
    await page.locator('input[name="assoc-choose"]').first().check();
    await page.getByTestId('assoc-choose').click();
  }

  test('FR22/AC8 - before any candidate is declared, Validation is locked with its real, stated reason (no forced-open)', async ({ page }) => {
    await toAssociationChosen(page);

    await expect(page.getByTestId('workbench-validation-node')).toBeVisible({ timeout: 15_000 });
    // The old behaviour forced this open the moment the workbench was live,
    // regardless of any candidate — this asserts the opposite: no expand
    // affordance, and the face shows the REAL reason, not a generic lock icon
    // with no text.
    await expect(page.getByTestId('validation-expand')).toHaveCount(0);
    await expect(page.getByTestId('validation-face')).toHaveText('Opens once a candidate has been declared for this question.');
  });

  test('FR22/AC8 - once a candidate is declared for this project, Validation unlocks on a fresh visit', async ({ page }) => {
    await toAssociationChosen(page);

    // Declare a candidate through the REAL Candidate panel (AXI-1724's write path) —
    // never a UI-only fixture.
    await page.getByTestId('candidate-expand').click();
    const panel = page.getByTestId('workbench-live-candidate-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const proposalRadios = page.locator('input[data-testid^="cutoff-proposal-"]');
    await expect(proposalRadios.first()).toBeVisible({ timeout: 15_000 });
    await proposalRadios.first().click();
    await page.getByTestId('cutoff-rationale').fill('AXI-1726: declared to prove Validation unlocks for real.');
    await page.getByTestId('cutoff-submit').click();
    await expect(page.getByTestId('cutoff-record')).toBeVisible({ timeout: 20_000 });

    // A fresh visit (this hook fetches once per mount — see the AXI-1728 comment
    // on this story re: the coarser, project-scoped signal and no live-refresh
    // trigger) now finds the real, governed write and unlocks.
    await toAssociationChosen(page);
    await expect(page.getByTestId('workbench-validation-node')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('validation-expand')).toBeVisible({ timeout: 15_000 });
  });
});
