import { test, expect } from '@playwright/test';

/**
 * AXI-1458 — Guided Analysis isolated page liveness (@SI-046).
 * (manual-e2e AXI-1458-Guided-Analysis-Spike.md §3.)
 *
 * The isolated page (no subdomain) is hosted by the app shell at
 * `/guided-analysis`. This spec is the read-only liveness proxy: it proves the
 * route is registered and the page shell renders under the authenticated shell.
 * The full click-through (Profile → Compute → Star, asserting the effect+CI and
 * "what this cannot say" block render) runs against a seeded project in the
 * epic's Workflow-5 live walk — the same convention siblings use when the
 * happy path needs a fully seeded referent.
 */
test('@SI-046 the Guided Analysis page renders under the app shell', async ({ page }) => {
  await page.goto('/guided-analysis');

  await expect(page.getByRole('heading', { name: 'Guided Analysis' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ga-start')).toBeVisible();
});
