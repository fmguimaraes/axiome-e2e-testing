import { test, expect, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1330 / AXI-1328 — Onboarding checklist + runner (epic AXI-1324).
 * Manual-E2E §AXI-1324-Onboarding §8/§8d.
 *
 * Originally drove the placeholder `welcome` tour; AXI-1360 (epic AXI-1354)
 * retired that placeholder in favour of the real ten-tour set, and the tour's
 * OWN targets weren't attached to real controls yet — both specs were
 * `.skip`-ped pending AXI-1362.
 *
 * *** Re-pointed and UN-SKIPPED as of AXI-1362 ***: drives the real
 * `orientation` tour (id `orientation`, registered in
 * `axiome-front/src/onboarding/registry.ts`). Its step 0 target
 * (`app-shell.nav-sidebar`) is now attached to the desktop nav `<nav>` in
 * `Layout.tsx`, so the runner presents a real step instead of timing out.
 *
 * @SI-030. ACs: AC1 (registered tour appears in the checklist), FR26/FR27
 * (header entry + manual restart), FR11-14 (controlled runner presents the
 * step anchored to its target).
 *
 * State note: onboarding state is server-persisted per user, so each test seeds
 * the `orientation` tour to a known status via the API before asserting UI.
 *
 * NOT executed against a live stack in this story (no `make local-up` run in
 * this environment, consistent with AXI-1360/AXI-1361's own deferral, see
 * `manual-e2e/AXI-1354-Onboarding-Content-Corpus.md` §9) — selectors and copy
 * were verified against the real registry/locale source, not against a
 * running app. Whoever runs the stack next should execute this file first.
 */

const ORIENTATION = {
  id: 'orientation',
  title: 'Orientation',
  step0Body:
    'Axiome organizes work into workspaces, projects and views. Each layer holds a different kind of decision.',
};

async function adminToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const admin = ROLES.find((r) => r.name === 'admin')!;
  const tokens = await ensureAuthTokens(request, admin);
  return tokens.accessToken;
}

async function putOrientation(request: import('@playwright/test').APIRequestContext, token: string, status: string): Promise<void> {
  const res = await request.put(apiUrl('/api/v1/onboarding-state'), {
    headers: { Authorization: `Bearer ${token}` },
    data: { tourId: ORIENTATION.id, tourVersion: 1, status, stepIndex: 0 },
  });
  expect(res.ok(), `seed orientation=${status} → ${res.status()}`).toBeTruthy();
}

/** Open an authenticated route and wait for the header onboarding entry point. */
async function gotoAuthed(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('button', { name: 'Getting started' })).toBeVisible();
}

test.describe('AXI-1330 — onboarding checklist & runner (AC1/FR26/FR27)', () => {
  test('AC1/FR26 — the header checklist lists the registered orientation tour with its status', { tag: ['@SI-030'] }, async ({ page, request }) => {
    await putOrientation(request, await adminToken(request), 'completed');
    await gotoAuthed(page, '/subjects');

    await page.getByRole('button', { name: 'Getting started' }).click();

    const panel = page.getByRole('dialog', { name: 'Onboarding checklist' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(ORIENTATION.title)).toBeVisible();
    // FR29 completion tally is rendered ("n / m completed").
    await expect(panel.getByText(/\d+\s*\/\s*\d+\s*completed/i)).toBeVisible();
  });

  test('FR27/FR11-14 — restarting a tour from the checklist launches the runner on its target', { tag: ['@SI-030'] }, async ({ page, request }) => {
    await putOrientation(request, await adminToken(request), 'completed');
    await gotoAuthed(page, '/subjects');

    await page.getByRole('button', { name: 'Getting started' }).click();
    const panel = page.getByRole('dialog', { name: 'Onboarding checklist' });
    // A completed tour offers a Restart action (FR27).
    await panel.getByRole('button', { name: /restart/i }).click();

    // The controlled runner presents step 0: its body text is shown, anchored
    // to the app-shell nav sidebar target (data-tour="app-shell.nav-sidebar",
    // attached AXI-1362).
    await expect(page.getByText(ORIENTATION.step0Body)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip tour' })).toBeVisible();
  });
});
