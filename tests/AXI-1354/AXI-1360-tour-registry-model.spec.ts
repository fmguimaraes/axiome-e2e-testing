import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1360 — Tour definitions and registration for the ten-tour set
 * (epic AXI-1354, Onboarding Content Corpus).
 * Manual-E2E §AXI-1354-Onboarding-Content-Corpus §4.1/§5.1.
 *
 * *** §4.1 UN-SKIPPED as of AXI-1362 ***: it only asserts the checklist
 * (no runner drive, no target dependency) — never blocked on target
 * attachment; it just inherited the describe-level `.skip`. Not actually
 * executed against a live stack in this story (no `make local-up` run in
 * this environment) — selectors/copy were checked against the real registry
 * and checklist contract, not against a running app.
 *
 * §5.1 STAYS a `test.skip` stub, honestly: it needs a way to revoke ONE
 * capability mid-session without a full re-login (the roles API call plus
 * the runner's own re-filter reacting to it), which this environment has no
 * mechanism for — unrelated to AXI-1362's target attachment (which IS done;
 * `workspace.*` targets are attached in `Layout.tsx`'s workspace-scoped nav).
 * Whoever gets a mid-session capability-revocation path working should
 * finish and un-skip it.
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

test.describe('AXI-1360 — ten-tour registry (AC7/AC9)', () => {
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

  test.skip('AC9 — a mid-tour capability loss skips that step silently, progress renumbered', { tag: ['@SI-038'] }, async ({ page, request }) => {
    // Seeds the admin user (bypasses all capability gates, so workspace-data's
    // capability-gated last step IS presented) then drives the runner to the
    // point where the affected step would be next, at which point a real test
    // would revoke `workspace.manage-members` for the session and assert the
    // step is dropped rather than shown or reported as unavailable.
    const token = await tokenFor(request, 'admin');
    await clearOnboardingState(request, token, ['workspace-data']);

    await page.goto('/workspaces');
    await waitForShell(page);

    // TODO(finish once there is a way to revoke a single capability
    // mid-session without a full re-login — AXI-1362's own target attachment
    // is done, `workspace.*` targets ARE real now): start workspace-data,
    // advance to the step before workspace.members-tab, revoke
    // workspace.manage-members via the roles API, advance once more, and
    // assert the tour ends (3 of 3) with NO `state.stepUnavailable` text ever
    // shown (that message is EC1-only, never for a capability skip).
  });
});
