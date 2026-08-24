import { test, expect } from '@playwright/test';

/**
 * AXI-1338 — Help: Versioning, Freshness & Language (epic AXI-1332). Manual-E2E
 * §AXI-1332-Help-System §14 (versioning/freshness/language scenarios).
 *
 * Exercises the freshness/version/language chrome over the real, bundled help
 * corpus (the seed docs ship with the frontend — no backend, FR9). This story
 * adds two seed docs that make the scenarios reachable:
 *   • `en/getting-started/legacy-import.md` — `appliesTo: "<1.0.0"`, so it is out
 *     of range on the 1.0+ release the suite runs (AC15).
 *   • `fr/getting-started/welcome.md` — a French translation sharing id `welcome`,
 *     while `subject-schema-versioning` remains English-only (AC14 fallback).
 *
 * Verifies:
 *   • AC12 — the help footer stamps the running app version + docs build date.
 *   • FR33 — a document shows its reviewed date.
 *   • AC15 — an out-of-version doc is absent from browse and shows a version
 *            notice when reached by direct link.
 *   • AC14 — under a French interface, an English-only doc renders in English
 *            with a fallback badge; a translated doc shows no badge.
 *
 * Tag @SI-037 (the help unit); @SI-030 where the app shell / locale read is
 * exercised. The default project runs authenticated as admin (AXI-1264), so
 * `/help` is reachable without a UI login. Assertions are web-first (no sleeps).
 */
test.describe('AXI-1338 — versioning, freshness & language @SI-037 @SI-030', () => {
  test('@SI-037 AC12/FR33 — footer stamps app version + build date; a doc shows its reviewed date', async ({ page }) => {
    await page.goto('/help/welcome');
    await expect(page).not.toHaveURL(/\/login/);

    const footer = page.getByTestId('help-footer');
    await expect(footer).toBeVisible();
    await expect(page.getByTestId('help-footer-version')).not.toBeEmpty();
    await expect(page.getByTestId('help-footer-built')).not.toBeEmpty();

    await expect(page.getByTestId('help-doc-reviewed')).toContainText(/Reviewed/i);
  });

  test('@SI-030 AC15 — an out-of-version doc is hidden from browse and flagged on a direct link', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByTestId('help-browse-tree')).toBeVisible();
    await expect(page.locator('[data-help-browse-doc="legacy-import"]')).toHaveCount(0);

    await page.goto('/help/legacy-import');
    await expect(page.getByTestId('help-version-notice')).toBeVisible();
  });

  test.describe('with a French interface locale', () => {
    test.use({ locale: 'fr-FR' });

    test('@SI-030 AC14 — an English-only doc falls back to the default language with a badge', async ({ page }) => {
      await page.goto('/help/subject-schema-versioning');
      await expect(page).not.toHaveURL(/\/login/);
      const badge = page.getByTestId('help-lang-badge');
      await expect(badge).toBeVisible();
      await expect(badge).toContainText(/EN/i);
    });

    test('@SI-030 AC14 — a translated doc renders in the active locale with no fallback badge', async ({ page }) => {
      await page.goto('/help/welcome');
      await expect(page.getByTestId('help-doc-reviewed')).toBeVisible();
      await expect(page.getByTestId('help-lang-badge')).toHaveCount(0);
    });
  });
});
