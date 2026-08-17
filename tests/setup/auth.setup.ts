import { test as setup } from '@playwright/test';
import { BASE_URL } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES, storageStateFor } from '../../config/roles';

/**
 * Auth setup project (AXI-1264 — FR12).
 *
 * Runs once before the test projects and persists a `storageState` per role.
 * Tokens are obtained via the API, then injected into the front-end's
 * `localStorage` (the keys the app reads: `access_token` / `refresh_token`), so
 * a browser context restored from the file is already authenticated without a
 * UI login.
 */
for (const role of ROLES) {
  setup(`authenticate ${role.name}`, async ({ page, request }) => {
    const tokens = await ensureAuthTokens(request, role);
    // localStorage is origin-scoped, so load the origin before writing to it.
    await page.goto(BASE_URL);
    await page.evaluate(
      ([access, refresh]) => {
        localStorage.setItem('access_token', access);
        localStorage.setItem('refresh_token', refresh);
      },
      [tokens.accessToken, tokens.refreshToken] as const,
    );
    await page.context().storageState({ path: storageStateFor(role.name) });
  });
}
