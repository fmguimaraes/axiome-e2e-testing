import { test, expect } from '@playwright/test';

/**
 * AXI-1462 — the standalone `/guided-analysis` page was REMOVED. Guided runs now
 * launch **in-project** (project + 1..N datasets) via the "Guided Analysis" button
 * on the Project Datasets / Dataset Detail pages, which opens the
 * GuidedAnalysisLaunchModal overlay (the same GuidedAnalysisPanel is also embedded
 * in the View Analysis surface). This @SI-046 liveness proxy guards that the
 * standalone route stays gone; the in-project click-through (Profile → Compute →
 * Star) runs in the epic's Workflow-5 live walk against a seeded project referent,
 * per the convention siblings use when the happy path needs a fully seeded referent.
 */
test('@SI-046 the standalone /guided-analysis route is removed (guided launches in-project)', async ({ page }) => {
  await page.goto('/guided-analysis');

  // The removed standalone page renders no guided-launch control at this route.
  await expect(page.getByTestId('ga-start')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Guided Analysis', exact: true })).toHaveCount(0);
});
