import { test, expect, APIRequestContext, request } from '@playwright/test';
import { apiUrl, HAS_TEST_MAILBOX, TEST_MAILBOX_ADDRESS, TEST_MAILBOX_SKIP_REASON } from '../../config/env';
import { waitForMessageTo, readResetToken } from '../../config/test-mailbox';

/**
 * AXI-2315 — Auth suite + backend/email (Mailjet). manual-e2e
 * AXI-2309-Platform-Opening-Headless.md §4.1-4.3/§5.1-5.3 (AC8, FR22-FR25,
 * NFR8). API-only against the gateway — no browser, no `setup`-project
 * storageState dependency (same shape as AXI-1831's `shadow-run-api` /
 * AXI-2065's `evidence-api` projects); every test self-registers its own
 * fresh account so runs never collide and leave no shared-account residue.
 */

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext();
});

test.afterAll(async () => {
  await api.dispose();
});

function uniqueEmail(label: string): string {
  return `e2e-auth-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@axiome.test`;
}

async function registerAndLogin(email: string, password: string) {
  const register = await api.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password, firstName: 'E2E', lastName: 'Auth' },
  });
  expect(register.ok(), `register failed: ${register.status()} ${await register.text()}`).toBe(true);

  const login = await api.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(login.ok()).toBe(true);
  return login.json() as Promise<{ accessToken: string; refreshToken: string }>;
}

test.describe('AXI-2315 — auth suite (@SI-011)', () => {
  test('AC8 §4.1 — login, /auth/me, and logout', { tag: '@SI-011' }, async () => {
    const email = uniqueEmail('login');
    const { accessToken } = await registerAndLogin(email, 'InitialPass1');

    const me = await api.get(apiUrl('/api/v1/auth/me'), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(me.ok()).toBe(true);
    expect((await me.json()).email).toBe(email);

    const logout = await api.post(apiUrl('/api/v1/auth/logout'), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(logout.ok()).toBe(true);
  });

  test('AC8 §4.2 — change password invalidates the old password', { tag: '@SI-011' }, async () => {
    const email = uniqueEmail('changepw');
    const { accessToken } = await registerAndLogin(email, 'OldPass123');

    const change = await api.post(apiUrl('/api/v1/auth/change-password'), {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { currentPassword: 'OldPass123', newPassword: 'NewPass123' },
    });
    expect(change.ok(), `change-password failed: ${change.status()} ${await change.text()}`).toBe(true);

    const loginOld = await api.post(apiUrl('/api/v1/auth/login'), {
      data: { email, password: 'OldPass123' },
    });
    expect(loginOld.status()).toBe(401);

    const loginNew = await api.post(apiUrl('/api/v1/auth/login'), {
      data: { email, password: 'NewPass123' },
    });
    expect(loginNew.ok()).toBe(true);
  });

  test('AC8 §5.1 — wrong credentials are rejected generically', { tag: '@SI-011' }, async () => {
    const email = uniqueEmail('wrongcreds');
    await registerAndLogin(email, 'CorrectPass1');

    const wrong = await api.post(apiUrl('/api/v1/auth/login'), {
      data: { email, password: 'TotallyWrongPass1' },
    });
    expect(wrong.status()).toBe(401);
    const body = await wrong.json();
    expect(JSON.stringify(body).toLowerCase()).not.toContain('does not exist');
  });

  test('AC8 §5.2 — session expiry: a logged-out session cannot be refreshed', { tag: '@SI-011' }, async () => {
    const email = uniqueEmail('sessionexpiry');
    const { accessToken, refreshToken } = await registerAndLogin(email, 'SessionPass1');

    const logout = await api.post(apiUrl('/api/v1/auth/logout'), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(logout.ok()).toBe(true);

    const refresh = await api.post(apiUrl('/api/v1/auth/refresh'), { data: { refreshToken } });
    expect(refresh.status()).toBe(401);
  });

  test('AC8 §5.3 — forgot password for an unregistered email never discloses non-existence', { tag: '@SI-011' }, async () => {
    const unregistered = uniqueEmail('unregistered');
    const res = await api.post(apiUrl('/api/v1/auth/request-password-reset'), {
      data: { email: unregistered },
    });
    expect(res.ok()).toBe(true);
    expect((await res.json()).message).toMatch(/if the email exists/i);
  });

  test('AC8 §4.3 — forgot password: real Mailjet send, reset email read from the test mailbox via API', { tag: '@SI-011' }, async () => {
    test.skip(!HAS_TEST_MAILBOX, TEST_MAILBOX_SKIP_REASON);

    const email = TEST_MAILBOX_ADDRESS;
    const password = 'ForgotPass123';
    // Register/ensure the account exists for this mailbox address so the
    // reset really targets a real user (anti-enumeration path is covered by
    // §5.3 above instead).
    const register = await api.post(apiUrl('/api/v1/auth/register'), {
      data: { email, password, firstName: 'E2E', lastName: 'Mailbox' },
    });
    if (!register.ok() && register.status() !== 409) {
      throw new Error(`register failed: ${register.status()} ${await register.text()}`);
    }

    const requestedAt = new Date().toISOString();
    const requestReset = await api.post(apiUrl('/api/v1/auth/request-password-reset'), {
      data: { email },
    });
    expect(requestReset.ok()).toBe(true);

    const message = await waitForMessageTo(api, email, requestedAt);
    const token = await readResetToken(api, message.id);

    const resetPassword = await api.post(apiUrl('/api/v1/auth/reset-password'), {
      data: { token, newPassword: 'ResetPass456' },
    });
    expect(resetPassword.ok(), `reset-password failed: ${resetPassword.status()}`).toBe(true);

    const loginOld = await api.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
    expect(loginOld.status()).toBe(401);

    const loginNew = await api.post(apiUrl('/api/v1/auth/login'), {
      data: { email, password: 'ResetPass456' },
    });
    expect(loginNew.ok()).toBe(true);
  });

  // AXI-2315 bounce #1, B3 — gateway userId-spread IDOR regression. The
  // reviewer proved live that `change-password`, `PATCH /profile` and
  // `PATCH /preferences` built `{ userId: user.sub, ...body }`, letting a
  // client-supplied `userId` in the body override the JWT-derived one. This
  // test uses its OWN freshly-created accounts (never the reviewer's
  // throwaway `e2e-review-idor-*@axiome.test` PoC accounts, which have been
  // deleted from the shared demo DB) and proves account A sending account
  // B's userId in any of the three routes leaves B completely unchanged.
  test('AC8 regression (bounce #1, B3) — a hostile userId in the body cannot mutate another account', { tag: '@SI-011' }, async () => {
    const emailA = uniqueEmail('idor-a');
    const emailB = uniqueEmail('idor-b');
    const { accessToken: tokenA } = await registerAndLogin(emailA, 'AccountAPass1');
    const { accessToken: tokenB } = await registerAndLogin(emailB, 'AccountBPass1');

    const meB = await api.get(apiUrl('/api/v1/auth/me'), {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(meB.ok()).toBe(true);
    const userB = await meB.json();

    // Attempt 1: account A tries to change account B's password by supplying
    // B's userId in the body, authenticated as A.
    const hostileChangePassword = await api.post(apiUrl('/api/v1/auth/change-password'), {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: {
        currentPassword: 'AccountAPass1',
        newPassword: 'AttackerChosenPass1',
        userId: userB.id,
      },
    });
    // Whatever this call returns about A's own account, B's original
    // password must still work — it must never have been touched.
    void hostileChangePassword;
    const loginBStillWorks = await api.post(apiUrl('/api/v1/auth/login'), {
      data: { email: emailB, password: 'AccountBPass1' },
    });
    expect(loginBStillWorks.ok()).toBe(true);

    // Attempt 2: account A tries to take over B's email via /profile.
    const hostileProfile = await api.patch(apiUrl('/api/v1/auth/profile'), {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { firstName: 'Attacker', userId: userB.id, email: 'attacker-takeover@axiome.test' },
    });
    void hostileProfile;
    const meBAfterProfileAttack = await api.get(apiUrl('/api/v1/auth/me'), {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(meBAfterProfileAttack.ok()).toBe(true);
    expect((await meBAfterProfileAttack.json()).email).toBe(emailB);

    // Attempt 3: account A tries to flip B's theme preference.
    const originalThemeB = userB.themePreference;
    const hostilePreferences = await api.patch(apiUrl('/api/v1/auth/preferences'), {
      headers: { Authorization: `Bearer ${tokenA}` },
      data: { themePreference: 'dark-attacker', userId: userB.id },
    });
    void hostilePreferences;
    const meBAfterPreferencesAttack = await api.get(apiUrl('/api/v1/auth/me'), {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(meBAfterPreferencesAttack.ok()).toBe(true);
    expect((await meBAfterPreferencesAttack.json()).themePreference).toBe(originalThemeB);
  });
});
