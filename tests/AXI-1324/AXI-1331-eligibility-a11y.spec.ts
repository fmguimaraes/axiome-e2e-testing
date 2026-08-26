import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1329 / AXI-1331 — Onboarding eligibility & accessibility (epic AXI-1324).
 * Manual-E2E §AXI-1324-Onboarding §8b/§8c.
 *
 * Used the placeholder `welcome` first-visit tour.
 *
 * *** SKIPPED as of AXI-1360 (epic AXI-1354) ***: `welcome` no longer exists —
 * FR1 retired the placeholder in favour of the real ten-tour set (see
 * `axiome-docs/05 - product/features/axiome-onboarding-content-v1.md`). The
 * `WELCOME_BODY` copy this file asserts on no longer renders from any
 * registered tour. Re-point at a real tour/route pairing (`orientation` on
 * `/`) once AXI-1362 attaches that tour's `data-tour` targets to real
 * controls, and un-skip.
 *
 * @SI-030. ACs: AC7/AC8 (complete/skip suppresses re-autostart for the version),
 * AC18 (keyboard-operable; Escape closes with a recorded skip, FR30/FR32).
 */

const WELCOME_BODY = 'Open Help any time from here.';

async function adminToken(request: APIRequestContext): Promise<string> {
  const admin = ROLES.find((r) => r.name === 'admin')!;
  return (await ensureAuthTokens(request, admin)).accessToken;
}

async function seedStatus(request: APIRequestContext, token: string, status: string): Promise<void> {
  const res = await request.put(apiUrl('/api/v1/onboarding-state'), {
    headers: { Authorization: `Bearer ${token}` },
    data: { tourId: 'welcome', tourVersion: 1, status, stepIndex: 0 },
  });
  expect(res.ok(), `seed welcome=${status} → ${res.status()}`).toBeTruthy();
}

async function welcomeStatus(request: APIRequestContext, token: string): Promise<string | undefined> {
  const res = await request.get(apiUrl('/api/v1/onboarding-state'), { headers: { Authorization: `Bearer ${token}` } });
  const rows = (await res.json()) as Array<{ tourId: string; status: string }>;
  return rows.find((r) => r.tourId === 'welcome')?.status;
}

async function waitForShell(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Getting started' })).toBeVisible();
}

test.describe.skip('AXI-1331 — eligibility & accessibility (AC7/AC8/AC18) — blocked by AXI-1360 registry change, see file header', () => {
  test('FR18/FR19 — a first-visit tour autostarts when its status is not_started', { tag: ['@SI-030'] }, async ({ page, request }) => {
    const token = await adminToken(request);
    await seedStatus(request, token, 'not_started');

    await page.goto('/subjects');
    await waitForShell(page);

    // Eligibility resolves after the state store loads; the runner presents the step.
    await expect(page.getByText(WELCOME_BODY)).toBeVisible();
  });

  test('FR32/AC18 — Escape closes the tour and records a skip', { tag: ['@SI-030'] }, async ({ page, request }) => {
    const token = await adminToken(request);
    await seedStatus(request, token, 'not_started');

    await page.goto('/subjects');
    await waitForShell(page);
    await expect(page.getByText(WELCOME_BODY)).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByText(WELCOME_BODY)).toBeHidden();
    // The skip is persisted server-side (not merely a UI dismissal).
    await expect.poll(() => welcomeStatus(request, token)).toBe('skipped');
  });

  test('AC7/AC8 — a completed/skipped tour does not autostart again for its version', { tag: ['@SI-030'] }, async ({ page, request }) => {
    const token = await adminToken(request);
    await seedStatus(request, token, 'completed');

    await page.goto('/subjects');
    await waitForShell(page);

    // Give eligibility a chance to (wrongly) fire, then assert it did not.
    await expect(page.getByRole('button', { name: 'Getting started' })).toBeVisible();
    await expect(page.getByText(WELCOME_BODY)).toBeHidden();
  });
});
