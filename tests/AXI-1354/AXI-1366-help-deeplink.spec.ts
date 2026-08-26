import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-1366 — Help deep-link verification across the tour set
 * (epic AXI-1354, Onboarding Content Corpus; the epic's LAST story).
 * Manual-E2E §AXI-1354-Onboarding-Content-Corpus §4.6/§5.14.
 *
 * Both scenarios below stay `test.skip`, honestly: this worktree has no
 * `node_modules` installed (matching AXI-1362/1360/1361's own note — this
 * story's environment never ran `npm install` here either) and driving
 * either scenario needs the frontend actually serving THIS worktree's
 * uncommitted onboarding+help changes (the `HelpDrawer`/`useHelpDrawer`
 * wiring), which the currently-running local stack (checked via `docker ps`
 * — a frontend container IS up) was not confirmed to be mounting; rewiring
 * the docker override to this worktree was out of scope for a story that
 * must stop at the push boundary. Selectors and flow below were checked
 * against the real component contract (`TourTooltip.tsx`, `HelpDrawer.tsx`,
 * `useHelpDrawer`), not against a running app.
 *
 * AC8's "opens at the referenced document" is verified against the deep-link
 * MECHANISM, not a resolvable corpus — the content epic's 30 `docId`s (§18)
 * still don't resolve in the real help index, so `HelpDocPane` renders its
 * graceful not-found state for any of them; the drawer opening/closing and
 * the tour's step position are what these scenarios assert, not the
 * document's rendered body.
 *
 * @SI-038 @SI-037. ACs: AC8 (help action opens the drawer at the step's
 * docId; closing returns to the same step), EC2 (help index unavailable →
 * action hidden, not disabled; tour still completes).
 */

async function tokenFor(request: APIRequestContext, role: 'admin' | 'user'): Promise<string> {
  const r = ROLES.find((x) => x.name === role)!;
  return (await ensureAuthTokens(request, r)).accessToken;
}

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

test.describe('AXI-1366 — help deep link (AC8/EC2)', () => {
  test.skip('AC8 — the step\'s Learn more action opens the help drawer at its docId, and closing it leaves the tour on the same step', { tag: ['@SI-038', '@SI-037'] }, async ({ page, request }) => {
    const token = await tokenFor(request, 'user');
    await clearOnboardingState(request, token, ['orientation']);

    await page.goto('/');
    await waitForShell(page);

    // orientation step 0 targets app-shell.nav-sidebar and declares
    // docId 'onboarding.three-layers' (registry.ts).
    const tooltip = page.getByRole('tooltip'); // react-joyride's tooltip container
    await expect(tooltip).toBeVisible();
    const progressBefore = await tooltip.locator('[aria-label*="/"]').textContent();

    await tooltip.getByRole('button', { name: 'Learn more' }).click();

    const drawer = page.getByRole('dialog', { name: 'Help' });
    await expect(drawer).toBeVisible();

    await drawer.getByTestId('help-drawer-close').click();
    await expect(drawer).toBeHidden();

    // Same step, same progress — the tour was never touched (AC8).
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator('[aria-label*="/"]')).toHaveText(progressBefore ?? '');
  });

  test.skip('FR5/EC2 — when the help index is unavailable, the Learn more action is hidden and the tour still completes', { tag: ['@SI-038', '@SI-037'] }, async ({ page, request, context }) => {
    const token = await tokenFor(request, 'user');
    await clearOnboardingState(request, token, ['orientation']);

    // TODO(once this worktree can drive the real app): block the help
    // index request (e.g. `context.route('**/help/index.json', r => r.abort())`)
    // before navigating, then start `orientation` and assert every step's
    // tooltip renders with NO "Learn more" button at all (hidden, not a
    // disabled control), and that the tour still reaches its Done state on
    // the final step's primary click.
    await context.route('**/help/index.json', (route) => route.abort());
    await page.goto('/');
    await waitForShell(page);

    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.getByRole('button', { name: 'Learn more' })).toHaveCount(0);
  });
});
