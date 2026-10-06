import { test, expect, type Page } from '@playwright/test';

/**
 * AXI-1884 (epic AXI-1883) — top-menu single-scope collapse (FR1–FR3, AC1).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1884-Top-Menu-Single-Scope.md` §4.1–4.7.
 * Tag: @SI-030.
 *
 * Two identities, both credentials from the environment (never the repo, NFR3):
 *   - SINGLE: `E2E_TEST_EMAIL` (default e2e-single@axiomebio.com — a DEDICATED
 *     fixture account, deliberately not the shared `test@axiomebio.com` identity,
 *     because another story is expected to move test organizations onto
 *     `test@axiomebio.com` later and would silently falsify "exactly one scope"
 *     here) with `E2E_TEST_PASSWORD`.
 *     Fixture: exactly one organization, one workspace, one project.
 *   - MULTI:  `E2E_MULTI_WORKSPACE_EMAIL` (default e2e-multi@axiomebio.com) with
 *     `E2E_MULTI_WORKSPACE_PASSWORD`.
 *     Fixture: one organization holding two or more workspaces.
 *
 * A missing credential or fixture is a red run, never a skip.
 */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`AXI-1884 spec needs env ${name} (see scenario doc §2)`);
  return value;
}

const SINGLE = {
  email: process.env.E2E_TEST_EMAIL?.trim() || 'e2e-single@axiomebio.com',
  password: requireEnv('E2E_TEST_PASSWORD'),
};
const MULTI = {
  email: process.env.E2E_MULTI_WORKSPACE_EMAIL?.trim() || 'e2e-multi@axiomebio.com',
  password: requireEnv('E2E_MULTI_WORKSPACE_PASSWORD'),
};

/** Sign in through the login form; the tests opt out of the shared admin storageState. */
async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('AXI-1884 - top-menu single-scope collapse', { tag: ['@SI-030'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AC1 - a single organization renders as a name label, not a combobox @SI-030', async ({ page }) => {
    await signIn(page, SINGLE);
    await page.goto('/overview');
    const label = page.getByTestId('scope-label-organization');
    await expect(label).toHaveCount(1);
    await expect(label).toHaveText(/\S/);
  });

  test('AC1 - clicking the single organization name navigates to the organization scope @SI-030', async ({ page }) => {
    await signIn(page, SINGLE);
    await page.goto('/datasets');
    await page.getByTestId('scope-label-organization').click();
    await expect(page).toHaveURL(/\/overview$/);
  });

  test('AC1 - a single workspace renders as a name label and its dropdown is absent @SI-030', async ({ page }) => {
    await signIn(page, SINGLE);
    await page.goto('/overview');
    await expect(page.getByTestId('scope-label-workspace')).toHaveCount(1);
    await expect(page.getByTestId('scope-dropdown-workspace')).toHaveCount(0);
  });

  test('AC1 - clicking the single workspace name navigates to the workspace scope @SI-030', async ({ page }) => {
    await signIn(page, SINGLE);
    await page.goto('/datasets');
    await page.getByTestId('scope-label-workspace').click();
    await expect(page).toHaveURL(/\/overview$/);
  });

  // The workspace is never auto-selected (FR3 preserves existing behavior — only the
  // organization level auto-selects); a project only resolves once a workspace is
  // active, so both project scenarios select the single workspace label first.
  test('AC1 - a single project renders as a name label and its dropdown is absent @SI-030', async ({ page }) => {
    await signIn(page, SINGLE);
    await page.goto('/overview');
    await page.getByTestId('scope-label-workspace').click();
    await expect(page.getByTestId('scope-label-project')).toHaveCount(1);
    await expect(page.getByTestId('scope-dropdown-project')).toHaveCount(0);
  });

  test('AC1 - clicking the single project name navigates to the project scope @SI-030', async ({ page }) => {
    await signIn(page, SINGLE);
    await page.goto('/overview');
    await page.getByTestId('scope-label-workspace').click();
    await page.goto('/datasets');
    await page.getByTestId('scope-label-project').click();
    await expect(page).toHaveURL(/\/overview$/);
  });

  test('AC1 - one organization with several workspaces keeps the workspace combobox @SI-030', async ({ page }) => {
    await signIn(page, MULTI);
    await page.goto('/overview');
    // Only the workspace level collapses on a single-org user: the org is still a label...
    await expect(page.getByTestId('scope-label-organization')).toHaveCount(1);
    // ...but the workspace is a dropdown, never a name label.
    await expect(page.getByTestId('scope-label-workspace')).toHaveCount(0);
    const trigger = page.getByTestId('scope-dropdown-workspace');
    await expect(trigger).toHaveCount(1);
    await trigger.click();
    // The menu lists more than one workspace choice.
    await expect(trigger.locator('xpath=following-sibling::div//button').first()).toBeVisible();
    await expect.poll(() => trigger.locator('xpath=following-sibling::div//button').count()).toBeGreaterThanOrEqual(2);
  });
});
