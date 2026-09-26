import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, driveToScreen, runLiveScreen, publishedRuleCode, primeWorkspace, stepUrl, submitStepAndWait,
  SCREEN_OP, CUTOFF_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1724 — Judgement and validation side panels (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 13.
 * Tags: @SI-034 (the candidate-declaration / candidate-validation components this
 * story wraps, unmodified), @SI-046 (the workbench side panel that hosts them).
 *
 * REAL BACKEND, LLM-FREE. The cutoff-proposal run is seeded through the step
 * resolver's OWN submit route (the same one AXI-1721/1722 exercise) so the
 * Candidate panel's `cutoffTables` are real — never a canvas-only fixture.
 */

test.describe('AXI-1724 - Candidate and Validation side panels (real backend)', { tag: ['@SI-034', '@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;
  const MARKER = 'CD8A_pre';

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1724-${Date.now().toString(36)}`, 'AXI-1724 Judgement Panels');
    // The DECLARED container (`outcomePositiveLevel: 'R'`): its cutoff node already
    // binds `positiveGroup` from upstream, so the cutoff step is fully bound with no
    // pick (AXI-1723 territory) — this story only needs a REAL finished run to read.
    const screenRunId = await submitStepAndWait(s, s.declaredAnalysisId, 'screen', SCREEN_OP);
    // Seed a real cutoff-proposal run bound to the chosen marker (AXI-1722's selection) —
    // the Candidate panel reads this run's table through the EXISTING read routes
    // (`loadDiscoveryContext`), never a UI-only fixture.
    await submitStepAndWait(s, s.declaredAnalysisId, 'cutoff', CUTOFF_OP, {
      selection: { kind: 'shortlist_row', nodeId: 'd6', runId: screenRunId, values: { marker: MARKER } },
    });
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR15 FR16 AC6 - the Candidate side panel wraps the AXI-1598/1630 declaration steps: pre-bound measurement, nothing pre-selected, data_derived shown, rationale mandatory, real write', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    const screenRuleCode = await publishedRuleCode(s, SCREEN_OP);
    await runLiveScreen(page, screenRuleCode);

    // Choose the marker on the canvas (FR16: the platform proposes candidates, never picks).
    await page.getByTestId('screen-result-expand').click();
    await page.getByTestId('screen-filter').getByText('all', { exact: true }).click();
    await page.getByTestId('screen-shortlist-table').getByRole('row', { name: new RegExp(MARKER) }).click();
    await page.getByTestId('screen-choice-rationale').fill(`${MARKER} separates responders most clearly`);
    await page.getByTestId('screen-choose-marker').click();
    await expect(page.getByTestId('marker-chosen')).toBeVisible({ timeout: 15_000 });

    // Association: one attempt, chosen (a standing precondition of the Candidate node, unrelated to this story).
    await page.getByTestId('association-expand').click();
    await page.getByTestId('assoc-outcomes').getByRole('button').first().click();
    await page.getByTestId('assoc-rules').getByRole('button').first().click();
    await page.getByTestId('assoc-run').click();
    await page.locator('input[name="assoc-choose"]').first().check();
    await page.getByTestId('assoc-choose').click();

    // Open the Candidate side panel.
    await page.getByTestId('candidate-expand').click();
    const panel = page.getByTestId('workbench-live-candidate-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // FR15: the measurement is pre-bound to the marker the person already chose on the canvas.
    await expect(page.getByTestId('cutoff-measurement-select')).toHaveValue(MARKER);

    // FR16 / AC6: no proposal is pre-selected.
    const proposalRadios = page.locator('input[data-testid^="cutoff-proposal-"]');
    await expect(proposalRadios.first()).toBeVisible({ timeout: 15_000 });
    const count = await proposalRadios.count();
    for (let i = 0; i < count; i += 1) await expect(proposalRadios.nth(i)).not.toBeChecked();

    // AC6: the data_derived label is shown on the cutoff choice.
    await expect(page.getByText('data-derived').first()).toBeVisible();

    // Submit is blocked until BOTH a proposal is picked and a rationale is written.
    const submit = page.getByTestId('cutoff-submit');
    await expect(submit).toBeDisabled();
    await proposalRadios.first().click();
    await expect(submit).toBeDisabled();
    const rationale = 'Chosen over the others because it separates the two arms most cleanly on this cohort.';
    await page.getByTestId('cutoff-rationale').fill(rationale);
    await expect(submit).toBeEnabled();

    // The write goes through the EXISTING cutoff-choices endpoint (FR15) — the record shown is the server's own response.
    await submit.click();
    await expect(page.getByTestId('cutoff-record')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('cutoff-record')).toContainText(rationale);
  });

  test('FR17 - the Validation side panel renders Apply, Compare and Pool as three distinct acts', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToScreen(page, s.projectId, s.declaredAnalysisId);
    const screenRuleCode = await publishedRuleCode(s, SCREEN_OP);
    await runLiveScreen(page, screenRuleCode);
    await page.getByTestId('screen-result-expand').click();
    await page.getByTestId('screen-filter').getByText('all', { exact: true }).click();
    await page.getByTestId('screen-shortlist-table').getByRole('row', { name: new RegExp(MARKER) }).click();
    await page.getByTestId('screen-choice-rationale').fill('same reason, second pass');
    await page.getByTestId('screen-choose-marker').click();
    await page.getByTestId('association-expand').click();
    await page.getByTestId('assoc-outcomes').getByRole('button').first().click();
    await page.getByTestId('assoc-rules').getByRole('button').first().click();
    await page.getByTestId('assoc-run').click();
    await page.locator('input[name="assoc-choose"]').first().check();
    await page.getByTestId('assoc-choose').click();

    await expect(page.getByTestId('validation-expand')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('validation-expand').click();
    const panel = page.getByTestId('workbench-live-validation-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId('validation-subject')).toBeVisible();
    await expect(panel.getByTestId('act-apply')).toBeVisible();
    await expect(panel.getByTestId('act-compare')).toBeVisible();
    await expect(panel.getByTestId('act-pool')).toBeVisible();
    // Each act is its OWN section with its OWN submit — never a shared control.
    await expect(panel.getByTestId('act-apply-submit')).toBeVisible();
    await expect(panel.getByTestId('act-compare-submit')).toBeVisible();
    await expect(panel.getByTestId('act-pool-submit')).toBeVisible();
  });
});
