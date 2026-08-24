import { test, expect, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1330 / AXI-1328 — Onboarding checklist + runner (epic AXI-1324).
 * Manual-E2E §AXI-1324-Onboarding §8/§8d.
 *
 * Drives the real, code-registered `welcome` tour (title "Welcome to Axiome",
 * one step "Need a hand?" anchored to the header Help button via
 * `data-tour="header.help-button"`). The checklist lists offered tours and a
 * manual restart launches the controlled react-joyride runner. The default
 * project runs authenticated as admin.
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

test.describe('AXI-1330 — onboarding checklist & runner (AC1/FR26/FR27)', () => {
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
