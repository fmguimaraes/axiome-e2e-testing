import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';
import { ROLES } from '../../config/roles';

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
 * Both scenarios need a non-admin, non-single-org identity: a workspace-role
 * `admin` member (grants `workspace:update`, the flag the removed entry was
 * gated on) of TWO organizations — single-org users are auto-selected into
 * `orgNav` on login (`TopMenu.tsx`), which would mask the bug this spec
 * proves fixed. The identity is minted fresh per run through the public API
 * (never a committed credential, NFR3), the same way AXI-1149's tenancy
 * harness and AXI-1886's `registerZeroOrgUser` do it.
 */

const API = `${API_BASE_URL}/api/v1`;

async function json(res: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<any> }, what: string) {
  if (!res.ok()) throw new Error(`${what} failed: ${res.status()} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`AXI-2487 spec needs env ${name} (see scenario doc §2)`);
  return value;
}

const BOOTSTRAP = ROLES.find((r) => r.name === 'admin')!;

async function bootstrapCtx(): Promise<APIRequestContext> {
  const anon = await apiRequest.newContext();
  const res = await anon.post(`${API}/auth/login`, { data: { email: BOOTSTRAP.email, password: requireEnv('E2E_TEST_PASSWORD') } });
  const { accessToken } = await json(res, 'bootstrap login');
  await anon.dispose();
  return apiRequest.newContext({ extraHTTPHeaders: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' } });
}

interface MultiOrgUser { email: string; password: string }

/** Mints a fresh user who is a workspace-role `admin` (workspace:update,
 *  never platform userType=admin) of two disjoint organizations, so neither
 *  org is ever auto-selected on login. */
async function provisionMultiOrgUser(): Promise<MultiOrgUser> {
  const admin = await bootstrapCtx();
  try {
    const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    const email = `axi2487-${tag}@axiome.local`;
    const password = `Axi2487!${tag}Zz`;
    const user = await json(
      await admin.post(`${API}/users`, { data: { email, password, firstName: 'AXI2487', lastName: 'MultiOrg' } }),
      'create user',
    );
    for (const n of ['A', 'B']) {
      const org = await json(
        await admin.post(`${API}/organizations`, { data: { name: `AXI2487 Org ${n} ${tag}`, type: 'biotech' } }),
        `org ${n}`,
      );
      const ws = await json(
        await admin.post(`${API}/workspaces`, { data: { name: `AXI2487 WS ${n} ${tag}`, type: 'internal', ownerOrganizationId: org.id } }),
        `ws ${n}`,
      );
      await json(
        await admin.post(`${API}/workspaces/${ws.id}/members`, { data: { userId: user.id, organizationId: org.id, role: 'admin' } }),
        `add member ${n}`,
      );
    }
    return { email, password };
  } finally {
    await admin.dispose();
  }
}

// A fresh user's onboarding tours auto-start and navigate() away from the
// current page (undocumented pre-existing gap, see memory
// reference_onboarding_tour_hijacks_navigation) — mark every tour skipped
// before signing in through the UI so it never fires here. Mirrors AXI-1886.
const TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets',
  'evidence-decisions', 'graph-rules', 'charts-views', 'help', 'admin', 'collaboration',
];
async function silenceTours(who: MultiOrgUser): Promise<void> {
  const anon = await apiRequest.newContext();
  const res = await anon.post(`${API}/auth/login`, { data: { email: who.email, password: who.password } });
  const { accessToken } = await json(res, 'silence-tours login');
  await anon.dispose();
  const api = await apiRequest.newContext();
  try {
    for (const tourId of TOUR_IDS) {
      await api.put(`${API}/onboarding-state`, {
        data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
  } finally {
    await api.dispose();
  }
}

async function signIn(page: Page, who: MultiOrgUser) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

const SIDEBAR_NAV = 'nav[data-tour="app-shell.nav-sidebar"]';
const WORKSPACES_NAV_ITEM = `${SIDEBAR_NAV} a[href="/workspaces"]`;

/** Waits for the sidebar to actually be at base (no-org) scope — "Your Work"
 *  is the same header `scopeLabel` drives for both the docked rail and the
 *  workbench drawer — so a bare `toHaveCount(0)` can't pass on a sidebar
 *  that simply hasn't rendered yet. */
async function expectBaseScope(page: Page) {
  await expect(page.locator(SIDEBAR_NAV)).toBeVisible();
  await expect(page.getByText('Your Work', { exact: true })).toBeVisible();
}

test.describe('AXI-2487 - admin-extras Workspaces entry no longer leaks at base scope', { tag: ['@SI-030'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('no "Workspaces" link under YOUR WORK with no organization selected @SI-030', async ({ page }) => {
    const who = await provisionMultiOrgUser();
    await silenceTours(who);
    await signIn(page, who);
    await page.goto('/overview');
    await expectBaseScope(page);
    await expect(page.locator(WORKSPACES_NAV_ITEM)).toHaveCount(0);
  });

  test('exactly one "Workspaces" link once an organization is selected @SI-030', async ({ page }) => {
    const who = await provisionMultiOrgUser();
    await silenceTours(who);
    await signIn(page, who);
    await page.goto('/overview');
    await expectBaseScope(page);

    // Two orgs → the top bar renders a dropdown (shouldUseOrgPickerModal is
    // false under its 20-org threshold); open it and pick the first org.
    await page.getByRole('button', { name: /no organization/i }).click();
    await page.getByRole('button', { name: /^AXI2487 Org/ }).first().click();

    await expect(page.locator(WORKSPACES_NAV_ITEM)).toHaveCount(1);
  });
});
