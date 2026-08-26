import { test, expect, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1330 / AXI-1328 — Onboarding checklist + runner (epic AXI-1324).
 * Manual-E2E §AXI-1324-Onboarding §8/§8d.
 *
 * Drove the placeholder `welcome` tour (title "Welcome to Axiome", one step
 * anchored to the header Help button via `data-tour="header.help-button"`).
 *
 * *** SKIPPED as of AXI-1360 (epic AXI-1354) ***: the registry no longer
 * carries a `welcome` placeholder — FR1 retired it in favour of the real
 * ten-tour set (see `axiome-docs/05 - product/features/axiome-onboarding-content-v1.md`).
 * None of the ten tours' OWN targets are attached to real controls yet (that
 * placement is AXI-1362); the only pre-existing attached target is
 * `header.help-button`, and every new tour reaches it only after 1-2 EC1
 * readiness-timeout skips (~5s each) — not a meaningful, non-flaky smoke test.
 * Re-point this spec at a real tour (e.g. `orientation`) and un-skip once
 * AXI-1362 attaches `data-tour` to the app-shell controls it needs.
 *
 * @SI-030. ACs: AC1 (registered tour appears in the checklist), FR26/FR27
 * (header entry + manual restart), FR11-14 (controlled runner presents the
 * step anchored to its target).
 *
 * State note: onboarding state is server-persisted per user, so each test seeds
 * the `welcome` tour to a known status via the API before asserting UI.
 */

const WELCOME = { id: 'welcome', title: 'Welcome to Axiome', stepBody: 'Open Help any time from here.' };

async function adminToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const admin = ROLES.find((r) => r.name === 'admin')!;
  const tokens = await ensureAuthTokens(request, admin);
  return tokens.accessToken;
}

async function putWelcome(request: import('@playwright/test').APIRequestContext, token: string, status: string): Promise<void> {
  const res = await request.put(apiUrl('/api/v1/onboarding-state'), {
    headers: { Authorization: `Bearer ${token}` },
    data: { tourId: WELCOME.id, tourVersion: 1, status, stepIndex: 0 },
  });
  expect(res.ok(), `seed welcome=${status} → ${res.status()}`).toBeTruthy();
}

/** Open an authenticated route and wait for the header onboarding entry point. */
async function gotoAuthed(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('button', { name: 'Getting started' })).toBeVisible();
}

test.describe.skip('AXI-1330 — onboarding checklist & runner (AC1/FR26/FR27) — blocked by AXI-1360 registry change, see file header', () => {
  test('AC1/FR26 — the header checklist lists the registered welcome tour with its status', { tag: ['@SI-030'] }, async ({ page, request }) => {
    await putWelcome(request, await adminToken(request), 'completed');
    await gotoAuthed(page, '/subjects');

    await page.getByRole('button', { name: 'Getting started' }).click();

    const panel = page.getByRole('dialog', { name: 'Onboarding checklist' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(WELCOME.title)).toBeVisible();
    // FR29 completion tally is rendered ("n / m completed").
    await expect(panel.getByText(/\d+\s*\/\s*\d+\s*completed/i)).toBeVisible();
  });

  test('FR27/FR11-14 — restarting a tour from the checklist launches the runner on its target', { tag: ['@SI-030'] }, async ({ page, request }) => {
    await putWelcome(request, await adminToken(request), 'completed');
    await gotoAuthed(page, '/subjects');

    await page.getByRole('button', { name: 'Getting started' }).click();
    const panel = page.getByRole('dialog', { name: 'Onboarding checklist' });
    // A completed tour offers a Restart action (FR27).
    await panel.getByRole('button', { name: /restart/i }).click();

    // The controlled runner presents the step: its body text is shown, anchored
    // to the header Help button target (data-tour="header.help-button").
    await expect(page.getByText(WELCOME.stepBody)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip tour' })).toBeVisible();
  });
});
