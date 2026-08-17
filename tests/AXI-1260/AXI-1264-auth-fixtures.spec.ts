import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { storageStateFor } from '../../config/roles';

/**
 * Auth fixtures (AXI-1264 — FR12/FR13/FR14, NFR3, AC7/AC8).
 *
 * The `setup` project persists a storageState per role; these specs consume it
 * instead of logging in through the UI. A protected route (`/`) redirects an
 * unauthenticated context to `/login`, so "stayed off /login" is a reliable
 * signal that the stored session authenticated the browser.
 */
test.describe('AXI-1264 — auth fixtures', () => {
  test('AC7 — admin storageState authenticates the browser without a UI login', async ({ page }) => {
    // The chromium project defaults to the admin storageState (no login step here).
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login/);
    const token = await page.evaluate(() => localStorage.getItem('access_token'));
    expect(token).toBeTruthy();
  });

  test.describe('as the non-admin role', () => {
    test.use({ storageState: storageStateFor('user') });

    test('AC7 — a spec opts into another role via its storageState', async ({ page }) => {
      await page.goto('/');
      await expect(page).not.toHaveURL(/\/login/);
    });
  });

  test.describe('without a stored session', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('AC7 — an unauthenticated context is redirected to login (contrast)', async ({ page }) => {
      await page.goto('/');
      await expect(page).toHaveURL(/\/login/);
    });
  });

  test('AC8 — each role fixture carries a distinct identity, safe to run in parallel', () => {
    // The two stored sessions resolve to different users, so parallel specs on
    // different roles never collide on one shared session (FR13/FR14).
    const adminEmail = jwtEmail(storedToken('admin'));
    const userEmail = jwtEmail(storedToken('user'));
    expect(adminEmail).toBeTruthy();
    expect(userEmail).toBeTruthy();
    expect(adminEmail).not.toBe(userEmail);
  });
});

/** Read a role's persisted access token from its storageState file. */
function storedToken(name: 'admin' | 'user'): string {
  const state = JSON.parse(readFileSync(storageStateFor(name), 'utf8')) as {
    origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
  };
  for (const origin of state.origins ?? []) {
    for (const entry of origin.localStorage ?? []) {
      if (entry.name === 'access_token') return entry.value;
    }
  }
  throw new Error(`no access_token in storageState for ${name}`);
}

/** Decode the `email` claim from a JWT payload (no verification — identity only). */
function jwtEmail(token: string): string {
  const payload = token.split('.')[1];
  const json = Buffer.from(payload, 'base64url').toString('utf8');
  return (JSON.parse(json) as { email: string }).email;
}
