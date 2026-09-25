import { test, expect } from '@playwright/test';

/**
 * AXI-1458 — reconciled by AXI-1626 (epic AXI-1603).
 *
 * This spec used to assert the standalone `/guided-analysis` route was
 * REMOVED. That was true for exactly three commits, within AXI-1462 itself:
 * `7dc4b20` deleted the route in favour of an in-project launch overlay, then
 * `d6bfe66` (same epic, "reinstate a standalone page for the whole flow")
 * brought it straight back — the overlay needed the full viewport, a capped
 * modal box did not fit the graph. This spec's assertion was never revisited
 * after the reinstatement and has been silently false ever since: it was
 * passing only because the `ga-start` testid it also probed for never
 * existed under that name in the reinstated page (a vacuous pass hiding
 * behind a real one — see the `guided-analysis-flow`/`RestatedQuestionPanel`
 * story notes on that failure mode).
 *
 * The route is live, reachable directly (no click-through), and is exactly
 * how the epic AXI-1603 UI specs (`tests/AXI-1603/epic-unsupported-plan-ui.spec.ts`)
 * reach `GuidedAnalysisPanel` today — `/guided-analysis?scope=project&...`.
 * This spec now asserts that liveness instead of the removal that never
 * shipped past AXI-1462's own mid-epic revert. `GuidedAnalysisPage.tsx`
 * renders the panel even with no query params (defaulting to dataset scope
 * with empty ids), so a bare `/guided-analysis` visit is enough to prove the
 * route is live without needing a seeded project referent — the click-through
 * with a real project/dataset stays the epic's own Workflow-5 live walk, per
 * the convention siblings use for that happy path.
 */
test('@SI-046 the standalone /guided-analysis route is live and renders the guided-launch panel', async ({ page }) => {
  await page.goto('/guided-analysis');

  await expect(page.getByRole('heading', { name: 'Guided Analysis', exact: true })).toHaveCount(1);
  await expect(page.getByTestId('ga-question')).toBeVisible();
  await expect(page.getByTestId('ga-send')).toBeVisible();
  await expect(page.getByTestId('ga-strategy')).toBeVisible();
});
