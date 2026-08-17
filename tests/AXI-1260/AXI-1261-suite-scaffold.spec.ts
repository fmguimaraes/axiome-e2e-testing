import { test, expect } from '@playwright/test';

/**
 * Scaffold smoke (AXI-1261).
 *
 * Proves the suite is wired end-to-end: it resolves from a clean clone, reads
 * its base URL from the config facade, reaches the running front-end, and
 * renders the app shell. This is the foundation every later story's spec builds
 * on. `test()` titles lead with the AC IDs they verify (FR18).
 */
test.describe('AXI-1261 — suite scaffold', () => {
  test('AC1 AC2 — suite reaches the running app shell and renders its title', async ({ page }) => {
    await page.goto('/');
    // Web-first assertion (retries until true, no fixed sleep — NFR4): the running
    // front-end served a rendered document with the Axiome title.
    await expect(page).toHaveTitle(/Axiome/i);
  });
});
