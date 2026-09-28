import { test, expect, type Page } from '@playwright/test';
import {
  seedLiveWorkbench, primeWorkspace, declineHoldoutUrl, branchUrl, submitStepAndWait, SCREEN_OP, type Seeded,
} from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1793 - Workbench reload restore and backend guiding question
 * (epic AXI-1775, FR7, FR8; AC2, AC12; EC2, EC3).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 7.
 * Tags: @SI-046 (the workbench's restore seam + guiding question), @SI-035 (per-branch phase
 * rail state), @SI-030 (the reload route restores into the correct phase).
 *
 * REAL BACKEND, LLM-FREE - a TEMPLATE instantiation, never a planner call. Every state below
 * is recorded through the API in a session that never opens the browser (or by a prior
 * mount), so a page that shows it can only have read it back from
 * `GET /discovery/analyses/:viewAnalysisId/plan` (EC2: each test opens a NEW page on the
 * same analysis). No test clicks take/decline to produce the state it asserts.
 */
const QUESTION = 'Which pre-treatment immune marker separates responders?';
const PLACEHOLDER = 'For the 24 immune panel genes';
const PLAN_READ = /\/discovery\/analyses\/[^/]+\/plan(\?|$)/;

const open = (page: Page, s: Seeded, analysisId: string | null) =>
  page.goto(`/projects/${s.projectId}/discovery-workbench${analysisId ? `?analysisId=${analysisId}` : ''}`);

const restored = (page: Page) => expect(page.getByTestId('discovery-workbench')).toHaveAttribute('data-restore-status', 'restored', { timeout: 60_000 });

function countPlanReads(page: Page): { count: () => number } {
  const seen: string[] = [];
  page.on('request', (req) => { if (req.method() === 'GET' && PLAN_READ.test(req.url())) seen.push(req.url()); });
  return { count: () => seen.length };
}

test.describe('AXI-1793 - a reloaded live workbench restores what the server recorded (UI, real backend)', { tag: ['@SI-046', '@SI-035', '@SI-030'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  const REASON = 'axi-1793: declined in an earlier session';

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1793-${tag}`, `AXI-1793 Reload restore ${tag}`);
    // The DECLARED container's holdout is declined through the API - never through this suite's browser.
    const declined = await s.api.post(declineHoldoutUrl(s.declaredAnalysisId, 'split'), { reason: REASON }, s.t.headers);
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.declined).toBe(true);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC2 FR7 - the guiding question is the one the backend stored, in the breadcrumb and on the canvas - never the placeholder', async ({ page }) => {
    await primeWorkspace(page, s);
    await open(page, s, s.viewAnalysisId);
    await restored(page);
    await expect(page.getByTestId('workbench-question-crumb')).toContainText(QUESTION);
    await expect(page.getByTestId('workbench-question-crumb')).not.toContainText(PLACEHOLDER);
    await expect(page.getByTestId('workbench-question')).toContainText(QUESTION);
    await page.getByTestId('workbench-question-crumb').click();
    await expect(page.getByTestId('workbench-question-text')).toHaveText(QUESTION);
  });

  test('FR7 - the PREVIEW workbench (no analysis) still shows the placeholder and makes no plan read', async ({ page }) => {
    const reads = countPlanReads(page);
    await primeWorkspace(page, s);
    await open(page, s, null);
    await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('workbench-question-crumb')).toContainText(PLACEHOLDER);
    expect(reads.count()).toBe(0);
  });

  test('AC2 - an instance with no records restores nothing: base unconfirmed, no decision, the read is the only extra request', async ({ page }) => {
    const reads = countPlanReads(page);
    await primeWorkspace(page, s);
    await open(page, s, s.viewAnalysisId);
    await restored(page);
    await expect(page.getByTestId('population-confirm')).toBeEnabled({ timeout: 60_000 });
    await expect(page.getByTestId('population-confirmed')).toHaveCount(0);
    await expect(page.getByTestId('split-holdout-decision')).toHaveCount(0);
    await expect(page.getByTestId('workbench-restore-error')).toHaveCount(0);
    expect(reads.count()).toBe(1);
  });

  test('AC2 FR8 EC2 - a holdout declined in an earlier session is restored with NO click: base confirmed, decision + reason, rail routed past Split', async ({ page }) => {
    const reads = countPlanReads(page);
    await primeWorkspace(page, s);
    await open(page, s, s.declaredAnalysisId);
    await restored(page);
    await expect(page.getByTestId('population-confirmed')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('split-holdout-decision')).toContainText(REASON, { timeout: 30_000 });
    await expect(page.getByTestId('split-take-holdout')).toHaveCount(0);
    // Restore routing into the correct phase: Context and Split settled, Screen is the current step.
    await expect(page.getByTestId('phase-rail-step-screen')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('phase-rail-step-context')).not.toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('workbench-screen-node')).toBeVisible({ timeout: 30_000 });
    expect(reads.count()).toBe(1);
  });

  test('EC2 - a RELOAD of that page restores the same state again (one read per mount)', async ({ page }) => {
    const reads = countPlanReads(page);
    await primeWorkspace(page, s);
    await open(page, s, s.declaredAnalysisId);
    await restored(page);
    await expect(page.getByTestId('split-holdout-decision')).toContainText(REASON, { timeout: 30_000 });
    await page.reload();
    await restored(page);
    await expect(page.getByTestId('population-confirmed')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('split-holdout-decision')).toContainText(REASON, { timeout: 30_000 });
    await expect(page.getByTestId('phase-rail-step-screen')).toHaveAttribute('aria-current', 'step');
    expect(reads.count()).toBe(2);
  });

  test('EC3 AC12 - a fact the server does not state is shown unconfirmed, never defaulted: the restored decline says the validation dataset is not confirmed', async ({ page }) => {
    await primeWorkspace(page, s);
    await open(page, s, s.declaredAnalysisId);
    await restored(page);
    const decision = page.getByTestId('split-holdout-decision');
    await expect(decision).toContainText('validation dataset assignment not confirmed', { timeout: 30_000 });
    await expect(decision).not.toContainText('validation dataset assigned');
  });

  test('AC2 FR3 - the rail is per branch and comes from the server: Branch 2 (a screen run on it) reads differently from Branch 1', async ({ page }) => {
    const fork = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen' }, s.t.headers);
    expect(fork.body.forked, JSON.stringify(fork.body)).toBe(true);
    await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP, { branchId: fork.body.branch.id });

    await primeWorkspace(page, s);
    await open(page, s, s.viewAnalysisId);
    await restored(page);
    const chips = page.getByTestId('phase-rail-branch');
    await expect(chips.getByRole('button', { name: fork.body.branch.name })).toBeVisible({ timeout: 30_000 });
    // Branch 1 has no record of its own: the first step is still open.
    await expect(page.getByTestId('phase-rail-step-context')).toHaveAttribute('aria-current', 'step');
    await chips.getByRole('button', { name: fork.body.branch.name }).click();
    // Branch 2 ran the screen: Context is settled (a run cannot exist over an unconfirmed base) and Split is next.
    await expect(page.getByTestId('phase-rail-step-context')).not.toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('phase-rail-step-split')).toHaveAttribute('aria-current', 'step');
  });

  test('EC3 - a FAILED read is reported, not rendered as "nothing recorded"', async ({ page }) => {
    await primeWorkspace(page, s);
    await page.route(PLAN_READ, (route) => route.abort());
    await open(page, s, s.declaredAnalysisId);
    await expect(page.getByTestId('workbench-restore-error')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('discovery-workbench')).toHaveAttribute('data-restore-status', 'failed');
    await expect(page.getByTestId('workbench-question-crumb')).toContainText('could not be loaded');
    await expect(page.getByTestId('workbench-question-crumb')).not.toContainText(PLACEHOLDER);
    await expect(page.getByTestId('split-holdout-decision')).toHaveCount(0);
  });
});
