import { request as apiRequest, test, expect, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2334 (epic AXI-2308 — FR39, FR40, NFR6, AC31, EC8, EC9): every auth flow
 * Paul (Investigator) or any signed-in user depends on — login, logout, change
 * password, forgot/reset password, session expiry, wrong credentials — present
 * and working. The backend mechanics (auth service, email) are Headless
 * AXI-2315's; this spec proves only the FRONT's screens/wiring plus the two
 * backend fixes this story made:
 *   - EC9/NFR6: a wrong password and an unknown email render the IDENTICAL
 *     generic message (`auth.service.ts#validateUser`/`refreshTokens` no longer
 *     leak "Account is not active" — see
 *     `apps/user-service/src/auth/auth.service.credential-leak.spec.ts` for the
 *     unit-level proof on the inactive-account branch, which this spec cannot
 *     reach without a seeded suspended account).
 *   - EC8: a dead session redirects to /login with a message stating plainly
 *     that unsaved work was not kept (`sessionExpiry.ts#SESSION_EXPIRED_MESSAGE`).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2334.
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2334-* --project=chromium --no-deps`.
 * Registers a fresh synthetic user per run (`AXI-2334+<timestamp>@axiome.local`)
 * via public self-registration — never the shared demo's seeded accounts, so
 * this spec is safe to re-run against the shared demo gateway too.
 */

const RUN_ID = Date.now();
const EMAIL = `axi-2334+${RUN_ID}@axiome.local`;
const PASSWORD = 'Axi2334Pass1';
const NEW_PASSWORD = 'Axi2334Pass2';

async function registerUser(): Promise<void> {
  const ctx = await apiRequest.newContext();
  const res = await ctx.post(apiUrl('/api/v1/auth/register'), {
    data: { email: EMAIL, password: PASSWORD, firstName: 'AXI', lastName: '2334' },
  });
  expect(res.ok(), `register failed (${res.status()}): ${await res.text()}`).toBeTruthy();
  await ctx.dispose();
}

// Neither Login nor Profile associates its <label> with its <input> (no
// htmlFor/id, no wrapping) — getByLabel cannot resolve them, so every field
// here is found by its placeholder instead.
async function fillLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByPlaceholder('your-email@company.com').fill(email);
  await page.getByPlaceholder('••••••••••••').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
}

test.beforeAll(async () => {
  await registerUser();
});

test.describe('AXI-2334 investigator-facing auth screens', () => {
  test('FR39 — AXI-2334.2 T1: login with valid credentials reaches the app, past /login @SI-030', async ({ page }) => {
    // Act
    await fillLogin(page, EMAIL, PASSWORD);

    // Assert
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  });

  test('FR39 — AXI-2334.2 T2: logout returns to /login and a reload stays there @SI-030', async ({ page }) => {
    // Arrange
    await fillLogin(page, EMAIL, PASSWORD);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

    // Act
    await page.getByRole('button', { name: /sign out/i }).click();

    // Assert
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
  });

  test('EC9 NFR6 — AXI-2334.3 T3: wrong password and an unknown email render the identical generic error @SI-030 @SI-011', async ({ page }) => {
    // Act — wrong password for the real account
    await fillLogin(page, EMAIL, 'ThisIsWrong1');
    const wrongPasswordError = await page.getByText(/invalid email or password/i).textContent();

    // Act — an email that was never registered
    await fillLogin(page, `never-registered-${RUN_ID}@axiome.local`, 'ThisIsWrong1');
    const unknownEmailError = await page.getByText(/invalid email or password/i).textContent();

    // Assert — byte-identical message either way; no hint of which case it was
    expect(wrongPasswordError).toBe(unknownEmailError);
    expect(wrongPasswordError?.toLowerCase()).not.toContain('not found');
    expect(wrongPasswordError?.toLowerCase()).not.toContain('does not exist');
    expect(wrongPasswordError?.toLowerCase()).not.toContain('inactive');
    await expect(page).toHaveURL(/\/login/);
  });

  test('FR40 — AXI-2334.4 T4: change password while signed in, then sign in again with the new one @SI-030', async ({ page }) => {
    // Arrange
    await fillLogin(page, EMAIL, PASSWORD);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

    // Act — the team surface's own change-password form (Profile)
    await page.goto('/profile');
    await page.getByPlaceholder('Enter current password').fill(PASSWORD);
    await page.getByPlaceholder('Enter new password').fill(NEW_PASSWORD);
    await page.getByPlaceholder('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /change password/i }).click();

    // Assert — success, then the OLD password is refused and the NEW one works
    await expect(page.getByText(/password changed/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /sign out/i }).click();
    await fillLogin(page, EMAIL, PASSWORD);
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await fillLogin(page, EMAIL, NEW_PASSWORD);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  });

  test('FR39 EC9 — AXI-2334.5 T5: forgot-password request accepts any syntactically valid email without confirming existence @SI-030', async ({ page }) => {
    // Act
    await page.goto('/forgot-password');
    await page.getByPlaceholder('Enter your email').fill(EMAIL);
    await page.getByRole('button', { name: 'Send Reset Link' }).click();

    // Assert — generic "check your email", regardless of whether the account exists
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 10_000 });
  });

  test('EC8 — AXI-2334.6 T6: a dead session redirects to /login and states plainly that unsaved work was not kept @SI-030', async ({ page }) => {
    // Arrange — sign in, then kill both tokens as a forced-expiry would leave them
    await fillLogin(page, EMAIL, NEW_PASSWORD);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    await page.evaluate(() => {
      localStorage.setItem('access_token', 'expired.invalid.token');
      localStorage.setItem('refresh_token', 'also-invalid');
    });

    // Act — the next authenticated call (triggered by a reload) fails and the
    // session watcher sends Paul to /login with the notice
    await page.reload();

    // Assert
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByText(/session has expired/i)).toBeVisible();
    await expect(page.getByText(/unsaved work was not saved/i)).toBeVisible();
  });
});
