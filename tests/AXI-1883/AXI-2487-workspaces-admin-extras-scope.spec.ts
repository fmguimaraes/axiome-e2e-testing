import { test, expect, type Page } from '@playwright/test';

/**
 * AXI-2487 — admin-extras "Workspaces" nav entry no longer duplicates orgNav's
 * own entry (epic AXI-1883, same defect class as AXI-1886's Projects
 * nav-scope fix, commit 8c88944). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md` (AXI-2487 section).
 * Tag: @SI-030.
 *
 * The sidebar's admin-extras block had its own "Workspaces" entry
 * (`showWorkspacesAdminList` in `useNavItems.ts`) shown only when NO
 * organization was selected — the opposite of where it is useful, since
 * `orgNav` already lists "Workspaces" unconditionally once an org IS
 * selected. The fix deletes the admin-extras entry entirely rather than
 * re-gating it (re-gating to "org selected" would just duplicate `orgNav`'s
 * own entry).
 *
 * Identity: `E2E_OWNER_EMAIL`/`E2E_OWNER_PASSWORD` (a workspace/org owner —
 * holds `workspace:update` without being a platform admin, so the
 * admin-extras path under test actually applies). A missing credential is a
 * red run, never a skip.
 */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`AXI-2487 spec needs env ${name} (see scenario doc §2)`);
  return value;
}

const OWNER = {
  email: process.env.E2E_OWNER_EMAIL?.trim() || 'e2e-tenant-owner@axiome.local',
  password: requireEnv('E2E_OWNER_PASSWORD'),
};

/** The "Workspaces" entry inside the app sidebar, any scope. */
const WORKSPACES_NAV_ITEM = 'nav[data-tour="app-shell.nav-sidebar"] a[href="/workspaces"]';

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Clears the active organization via the top-bar logo button (the one
 *  scope-reset affordance available regardless of single- or multi-org). */
async function clearActiveOrganization(page: Page) {
  await page.locator('button:has(img[alt="Axiome"])').click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('AXI-2487 - admin-extras Workspaces entry no longer leaks at base scope', { tag: ['@SI-030'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('no "Workspaces" link under YOUR WORK with no organization selected @SI-030', async ({ page }) => {
    await signIn(page, OWNER);
    await clearActiveOrganization(page);
    await expect(page.locator(WORKSPACES_NAV_ITEM)).toHaveCount(0);
  });

  test('exactly one "Workspaces" link once an organization is selected @SI-030', async ({ page }) => {
    await signIn(page, OWNER);
    await page.goto('/overview');
    await expect(page.locator(WORKSPACES_NAV_ITEM)).toHaveCount(1);
  });
});
