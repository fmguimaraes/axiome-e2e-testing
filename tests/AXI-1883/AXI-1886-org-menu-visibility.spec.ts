import { test, expect, request as apiRequest, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-1886 — Layout organization-menu visibility (epic AXI-1883; FR6, AC3, EC1).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md` (AXI-1886
 * section). Tag: @SI-030.
 *
 * OQ-3 resolution exercised here: the "Organizations" entry in the org-scope
 * sidebar menu (`useNavItems.ts`'s `baseNav`/`orgNav`, rendered by
 * `Layout.tsx`) is shown only when the user has NO organizations at all —
 * not merely "not exactly one".
 *
 * Two identities, both credentials from the environment (never the repo,
 * NFR3):
 *   - SINGLE: `e2e-single@axiomebio.com` (one organization — the same
 *     dedicated fixture account AXI-1884's spec uses), password from
 *     `E2E_SINGLE_PASSWORD`.
 *   - ZERO: self-registered per run via `POST /auth/register` (never a
 *     committed credential) — the zero-organization case.
 *
 * A missing credential is a red run, never a skip.
 */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`AXI-1886 spec needs env ${name} (see scenario doc §2)`);
  return value;
}

const SINGLE = {
  email: process.env.E2E_SINGLE_EMAIL?.trim() || 'e2e-single@axiomebio.com',
  password: requireEnv('E2E_SINGLE_PASSWORD'),
};

/** The "Organizations" entry inside the app sidebar (never the admin section,
 *  which lists it unconditionally and is out of scope for a non-admin spec). */
const ORG_NAV_ITEM = 'nav[data-tour="app-shell.nav-sidebar"] a[href="/organizations"]';

interface Tokens { accessToken: string; refreshToken: string }

/** Self-register a fresh, zero-organization user via the public API. */
async function registerZeroOrgUser(): Promise<{ email: string; password: string; tokens: Tokens }> {
  const email = `axi1886-zero-org-${Date.now()}-${Math.floor(Math.random() * 100000)}@axiome.local`;
  const password = `AXI1886-${Math.random().toString(36).slice(2)}!`;
  const api = await apiRequest.newContext();
  try {
    const res = await api.post(apiUrl('/api/v1/auth/register'), {
      data: { email, password, firstName: 'AXI1886', lastName: 'ZeroOrg' },
    });
    expect(res.ok(), `register failed: ${await res.text()}`).toBeTruthy();
    const tokens = (await res.json()) as Tokens;
    return { email, password, tokens };
  } finally {
    await api.dispose();
  }
}

// A fresh user's onboarding tours auto-start and navigate() away from the
// current page (undocumented pre-existing gap, see memory
// reference_onboarding_tour_hijacks_navigation) — mark every tour skipped for
// the zero-org user before signing in through the UI so it never fires here.
const TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets',
  'evidence-decisions', 'graph-rules', 'charts-views', 'help', 'admin', 'collaboration',
];
async function silenceTours(accessToken: string): Promise<void> {
  const api = await apiRequest.newContext();
  try {
    for (const tourId of TOUR_IDS) {
      await api.put(apiUrl('/api/v1/onboarding-state'), {
        data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
  } finally {
    await api.dispose();
  }
}

/** Sign in through the login form; the tests opt out of the shared admin storageState. */
async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.describe('AXI-1886 - Layout organization-menu visibility', { tag: ['@SI-030'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AC3 - the Organizations nav item is absent for a user with at least one organization @SI-030', async ({ page }) => {
    await signIn(page, SINGLE);
    await page.goto('/overview');
    await expect(page.locator(ORG_NAV_ITEM)).toHaveCount(0);
  });

  test('AC3/EC1 - the Organizations nav item is present for a user with zero organizations @SI-030', async ({ page }) => {
    const zeroOrgUser = await registerZeroOrgUser();
    await silenceTours(zeroOrgUser.tokens.accessToken);
    await signIn(page, zeroOrgUser);
    await page.goto('/overview');
    await expect(page.locator(ORG_NAV_ITEM)).toHaveCount(1);
  });
});
