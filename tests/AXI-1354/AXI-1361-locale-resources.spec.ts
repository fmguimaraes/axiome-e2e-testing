import { test, expect, type Page, type APIRequestContext, type Browser } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1361 — Step and microcopy locale resources, EN and FR
 * (epic AXI-1354, Onboarding Content Corpus).
 * Manual-E2E §AXI-1354-Onboarding-Content-Corpus §4.2/§5.2.
 *
 * *** AC11/EC3 UN-SKIPPED as of AXI-1362 ***: both drive `orientation`'s step
 * 0, anchored to `app-shell.nav-sidebar`, now attached to the desktop nav
 * `<nav>` in `Layout.tsx`. They are written against the real checklist/runner
 * UI contract (AXI-1324/1328/1330) and the real
 * `src/locales/onboarding/{en,fr}.ts` resource files AXI-1361 added — they
 * SHOULD work once run against a live app, but have NOT actually been
 * executed in this environment (no `make local-up`, no Playwright browser
 * available here). Do not trust a green run of this file until someone
 * confirms it against the running stack (Testing/W5).
 *
 * Locale emulation: Playwright's `locale` context option sets
 * `navigator.language`, which is exactly what `useHelpLocale()`
 * (`src/lib/help/locale.ts`) and onboarding's `useOnboardingCopy()` read —
 * no app-level locale switcher exists, so a French run means launching a
 * browser CONTEXT with `locale: 'fr-FR'`, not a UI toggle.
 *
 * @SI-038. ACs: AC11 (a French-locale user renders every tour/microcopy
 * string in French with zero English fallback and no language badge), AC13
 * (onboarding locale resources are fully removable with the module).
 */

async function tokenFor(request: APIRequestContext, role: 'admin' | 'user'): Promise<string> {
  const r = ROLES.find((x) => x.name === role)!;
  return (await ensureAuthTokens(request, r)).accessToken;
}

/** Clears every onboarding-state row for the given user (fresh first-run). */
async function clearOnboardingState(request: APIRequestContext, token: string, tourIds: string[]): Promise<void> {
  for (const tourId of tourIds) {
    await request.put(apiUrl('/api/v1/onboarding-state'), {
      headers: { Authorization: `Bearer ${token}` },
      data: { tourId, tourVersion: 1, status: 'not_started', stepIndex: 0 },
    });
  }
}

async function waitForShell(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Getting started' })).toBeVisible();
}

/** A page in a fresh browser context with the given interface locale (AC11/EC3). */
async function pageInLocale(browser: Browser, locale: string): Promise<Page> {
  const context = await browser.newContext({ locale });
  return context.newPage();
}

test.describe('AXI-1361 — locale resources (AC11/AC13)', () => {
  test('AC11 — a French-locale user sees French throughout, zero fallback, no badge', { tag: ['@SI-038'] }, async ({ browser, request }) => {
    const token = await tokenFor(request, 'user');
    await clearOnboardingState(request, token, ['orientation']);

    const page = await pageInLocale(browser, 'fr-FR');
    await page.goto('/');
    await waitForShell(page);

    // orientation autostarts (first-run, FR1/AC7) — its first step is French.
    const tooltip = page.getByRole('dialog').filter({ hasText: 'niveaux' }).or(page.locator('.react-joyride__tooltip'));
    await expect(tooltip.getByText('Trois niveaux de la plateforme')).toBeVisible();
    // No English fallback string anywhere in the tooltip (AC11).
    await expect(tooltip.getByText('Three layers of the platform')).toHaveCount(0);
    // No fallback-language badge for a supported locale (AC11).
    await expect(tooltip.getByText('EN', { exact: true })).toHaveCount(0);

    // Runner controls are French (FR9 microcopy).
    await expect(tooltip.getByRole('button', { name: 'Suivant' })).toBeVisible();
    await expect(tooltip.getByRole('button', { name: 'Ignorer la visite' })).toBeVisible();

    // The checklist surface is French too.
    await page.getByRole('button', { name: 'Prise en main' }).click();
    const panel = page.getByRole('dialog', { name: 'Liste de suivi de la prise en main' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/terminées/)).toBeVisible();
    await expect(panel.getByText('EN', { exact: true })).toHaveCount(0);
  });

  test('EC3 contrast — an unsupported locale renders English with a visible fallback badge', { tag: ['@SI-038'] }, async ({ browser, request }) => {
    // A locale that is neither English nor French (EC3) must still render
    // (the default, English) AND must show the fallback badge — the mirror
    // image of the AC11 test above.
    const token = await tokenFor(request, 'user');
    await clearOnboardingState(request, token, ['orientation']);

    const page = await pageInLocale(browser, 'de-DE');
    await page.goto('/');
    await waitForShell(page);

    const tooltip = page.locator('.react-joyride__tooltip');
    await expect(tooltip.getByText('Three layers of the platform')).toBeVisible();
    await expect(tooltip.getByText('EN', { exact: true })).toBeVisible(); // the fallback badge (EC3)
  });

  test.skip('AC13 — deleting the onboarding module leaves no onboarding locale resource', { tag: ['@SI-038'] }, async () => {
    // This AC is verified at the filesystem/build level (manual-e2e §5.2:
    // delete src/onboarding + src/locales/onboarding + the vite hook, then
    // tsc/build clean and grep for leaked tour.* keys elsewhere in src/) —
    // not a browser flow, so there is nothing for Playwright to drive here.
    // Left `skip` honestly rather than a vacuous pass; tracked as a manual
    // check — see the manual-e2e doc for the actual steps.
  });
});
