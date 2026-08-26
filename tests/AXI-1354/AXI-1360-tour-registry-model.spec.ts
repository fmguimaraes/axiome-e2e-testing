import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1360 — Tour definitions and registration for the ten-tour set
 * (epic AXI-1354, Onboarding Content Corpus).
 * Manual-E2E §AXI-1354-Onboarding-Content-Corpus §4.1/§5.1.
 *
 * *** SKELETON, BLOCKED ***: bringing up the full local stack (`axiome-infra`
 * `make local-up`) to drive these scenarios headless was not feasible in the
 * AXI-1360 story's environment (a structure-only registry story). Both tests
 * are written against the real `orientation`/`workspace-data` tours and the
 * real checklist/runner UI contract established by AXI-1324, so they SHOULD
 * work once run against a live app — but neither has actually been executed.
 * Do not trust a green run of this file until someone removes the
 * `test.skip` and confirms it against the running stack (Testing/W5).
 *
 * Blast-radius note: `orientation`'s own step targets (`app-shell.nav-sidebar`,
 * `app-shell.workspace-switcher`) are not yet attached to real controls
 * (AXI-1362 does that) — the runner will EC1-timeout-skip past them (~5s
 * each) to the one pre-existing attached target, `header.help-button`. §4.1
 * only asserts the checklist (no runner drive, no timing dependency); §5.1
 * drives the runner and will be slow until AXI-1362 lands — expect ~10s of
 * skip-timeout before the step assertion.
 *
 * @SI-038. ACs: AC7 (first-run offers orientation; no capability-gated tour
 * in the checklist), AC9 (a mid-tour capability loss skips that step
 * silently, progress renumbered, no skipped-step message).
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

test.describe.skip('AXI-1360 — ten-tour registry (AC7/AC9) — SKELETON, not yet run against a live stack', () => {
  test('AC7 — first-run offers orientation; comparability-gate/graph-rules/admin are absent from the checklist', { tag: ['@SI-038'] }, async ({ page, request }) => {
    const token = await tokenFor(request, 'user'); // a plain 'user' role, no elevated capabilities
    await clearOnboardingState(request, token, ['orientation']);

    await page.goto('/');
    await waitForShell(page);

    await page.getByRole('button', { name: 'Getting started' }).click();
    const panel = page.getByRole('dialog', { name: 'Onboarding checklist' });
    await expect(panel).toBeVisible();

    await expect(panel.getByText('Orientation')).toBeVisible(); // tour-level title, FR1
    // Capability-gated tours the default user does not hold (FR2/AC7).
    await expect(panel.getByText('Comparing safely')).toHaveCount(0); // comparability-gate
    await expect(panel.getByText('Rules and the graph')).toHaveCount(0); // graph-rules
    await expect(panel.getByText('Administration')).toHaveCount(0); // admin
  });

  test('AC9 — a mid-tour capability loss skips that step silently, progress renumbered', { tag: ['@SI-038'] }, async ({ page, request }) => {
    // Seeds the admin user (bypasses all capability gates, so workspace-data's
    // capability-gated last step IS presented) then drives the runner to the
    // point where the affected step would be next, at which point a real test
    // would revoke `workspace.manage-members` for the session and assert the
    // step is dropped rather than shown or reported as unavailable.
    const token = await tokenFor(request, 'admin');
    await clearOnboardingState(request, token, ['workspace-data']);

    await page.goto('/workspaces');
    await waitForShell(page);

    // TODO(un-skip + finish once AXI-1362 attaches workspace.* data-tour
    // targets and there is a way to revoke a single capability mid-session
    // without a full re-login): start workspace-data, advance to the step
    // before workspace.members-tab, revoke workspace.manage-members via the
    // roles API, advance once more, and assert the tour ends (3 of 3) with NO
    // `state.stepUnavailable` text ever shown (that message is EC1-only).
    expect(true).toBe(true);
  });
});
