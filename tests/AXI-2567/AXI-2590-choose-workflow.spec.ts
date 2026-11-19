import { expect, test } from '@playwright/test';
import { PlanQuestionStub, QUESTION } from './harness/plan-question-stub';
import { PlanQuestionWorld } from './harness/plan-question-world';

/**
 * AXI-2590 (epic AXI-2567 — FR63, FR64, FR67): Plan a question, "1 · Workflow" (reference qp1).
 * Scenarios: `axiome-docs/manual-e2e/AXI-2567-Plan-Before-Data.md` § AXI-2590 (2.1, 2.2).
 *
 * E2E CONTRACT — sign-in, a throwaway workspace + project, membership and the INVESTIGATOR
 * role's permissions are REAL (demo gateway). The SAP routes are an in-memory DOUBLE
 * (`harness/plan-question-stub.ts`): the shared stack serves `main`, which has neither the
 * AXI-2590 `workflow` catalogue facts nor a migrated v2 draft. Owed at W5: re-run with the double
 * removed against a stack serving the AXI-2590 back branch.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let w: PlanQuestionWorld;

test.beforeAll(async () => { w = await PlanQuestionWorld.create('choose'); });
test.afterAll(async () => { await w?.dispose(); });

test.describe('AXI-2590 plan a question — choose a workflow @SI-030 @SI-066 @SI-031', () => {
  test('AXI-2590.1 FR63 FR64 validated workflows ranked by fit, BEST FIT tagged, the impossible one greyed with its reason', async ({ page }) => {
    const stub = new PlanQuestionStub(w.projectId, w.investigator.userId);
    await w.open(page, stub);
    await expect(page.getByTestId('plan-question-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('pq-question-number')).toHaveText('Q1 · Primary');
    await expect(page.getByTestId('pq-question-text')).toHaveText(QUESTION);
    await expect(page.getByTestId('pq-status')).toHaveText('Awaiting analysis');

    const cards = page.locator('[data-testid^="pq-workflow-card-"]');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toHaveAttribute('data-testid', 'pq-workflow-card-T1');
    await expect(cards.nth(0)).toHaveAttribute('data-best-fit', 'true');
    await expect(cards.nth(0)).toContainText('Compare two groups');
    await expect(cards.nth(0)).toContainText('Needs a group variable with 2 levels and a measurement.');
    await expect(cards.nth(0)).toContainText('Fits: Treatment arm (A, B) and 2 measurements in your variables.');
    await expect(cards.nth(0)).toContainText('Validated v0.4');
    await expect(cards.nth(1)).toHaveAttribute('data-testid', 'pq-workflow-card-T3');
    const t2 = page.getByTestId('pq-workflow-card-T2');
    await expect(cards.nth(2)).toHaveAttribute('data-testid', 'pq-workflow-card-T2');
    await expect(t2).toHaveAttribute('data-possible', 'false');
    await expect(t2).toBeDisabled();
    await expect(t2).toContainText('Not possible: no group variable with 3 or more levels in your variables.');

    // Nothing is chosen for the author; the panel waits; Save names the first missing item.
    await expect(page.locator('[data-testid^="pq-workflow-card-"][aria-checked="true"]')).toHaveCount(0);
    await expect(page.getByTestId('pq-panel')).toContainText('Choose a workflow to see what it does');
    await expect(page.getByTestId('pq-section-data')).toHaveAttribute('data-dimmed', 'true');
    await expect(page.getByTestId('pq-save')).toBeDisabled();
    await expect(page.getByTestId('pq-first-missing')).toHaveText('Choose a workflow to continue.');

    // No template id, slot key or camelCase on screen.
    const text = await page.getByTestId('plan-question-page').innerText();
    for (const raw of ['groupingColumn', 'T1', 'T2', 'T3', 'mann_whitney', 'at-e2e', 'field-']) expect(text).not.toContain(raw);
  });

  test('AXI-2590.2 FR63 a BLOCKed version is never offered; search narrows by name and method', async ({ page }) => {
    const stub = new PlanQuestionStub(w.projectId, w.investigator.userId);
    await w.open(page, stub);
    await expect(page.getByTestId('pq-workflow-card-T1')).toContainText('Validated v0.4');
    await expect(page.getByTestId('plan-question-page')).not.toContainText('v0.5');
    await page.getByTestId('pq-workflow-search').fill('spearman');
    await expect(page.locator('[data-testid^="pq-workflow-card-"]')).toHaveCount(1);
    await expect(page.getByTestId('pq-workflow-card-T3')).toBeVisible();
    await page.getByTestId('pq-workflow-search').fill('nothing like this');
    await expect(page.getByTestId('pq-section-workflow')).toContainText('No workflow matches this search.');
  });

  test('AXI-2590.3 FR64 FR65 choosing a workflow collapses the list, pre-selects variables and draws the workflow', async ({ page }) => {
    const stub = new PlanQuestionStub(w.projectId, w.investigator.userId);
    await w.open(page, stub);
    await page.getByTestId('pq-workflow-card-T1').click();
    await expect(page.getByTestId('pq-workflow-chosen')).toContainText('Compare two groups');
    await expect(page.getByTestId('pq-workflow-chosen')).toContainText('Mann-Whitney U test · v0.4 · validated');
    await expect(page.getByTestId('pq-chip-groupingColumn-field-arm')).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('pq-chip-groupingColumn-field-arm')).toContainText('pre-selected');
    await expect(page.getByTestId('pq-levels-groupingColumn')).toHaveText('Compares A with B · levels declared on the variable');
    const panel = page.getByTestId('pq-panel');
    await expect(panel).toContainText('Selected workflow');
    await expect(panel).toContainText('Validator PASS');
    await expect(panel).toContainText('Tests whether one group tends to have higher values');
    await expect(panel).toContainText('Default chart: Boxplot');
    await expect(page.getByTestId('template-flow-graph')).toHaveAttribute('data-compact', 'true');
    await expect(page.getByTestId('template-flow-graph')).toHaveAttribute('data-read-only', 'true');
    await expect(page.getByTestId('template-graph-binding-groupingColumn')).toContainText('Treatment arm');
    await expect(page.getByTestId('pq-workflow-change')).toBeVisible();
  });
});
