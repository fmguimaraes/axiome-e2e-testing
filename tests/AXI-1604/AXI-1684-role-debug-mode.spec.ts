import { test, expect, APIRequestContext, Page, request as apiRequest } from '@playwright/test';
import { apiUrl, BASE_URL } from '../../config/env';
import { adminContext } from '../AXI-1244/subject-fixtures';

/**
 * AXI-1684 — Role debug mode: checkbox on role edition, fanned out to holders
 * via /auth/me, useDebugMode hook + DEBUG badge (epic AXI-1604).
 *
 * Everything is self-provisioned per run (the AXI-1244 precedent's determinism
 * doctrine): a throwaway role with debugMode=true, a throwaway self-registered
 * user assigned to it, and cleanup at the end.
 *
 * AC1 — role edit persists debugMode (fixture setup uses the create API; the
 *   "flip off" scenario below exercises the real edit-page checkbox).
 * AC2 — GET /api/v1/auth/me returns debugMode=true for a holder of a debugMode
 *   role, false otherwise.
 * AC3 — flipping a role's debugMode off is reflected on the holder's next
 *   /auth/me fan-out (no stale true).
 * AC4 — the DEBUG badge (data-testid="debug-mode-badge") renders iff debugMode.
 */

interface Tokens { accessToken: string; refreshToken: string }

async function send(
  api: APIRequestContext,
  method: 'post' | 'patch' | 'delete' | 'get',
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await api[method](apiUrl(path), { data: body as any });
  if (!res.ok()) {
    throw new Error(`AXI-1684 fixture ${method.toUpperCase()} ${path} -> ${res.status()}: ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function login(email: string, password: string): Promise<Tokens> {
  const bootstrap = await apiRequest.newContext();
  try {
    return await send(bootstrap, 'post', '/auth/login', { email, password });
  } finally {
    await bootstrap.dispose();
  }
}

async function seedSession(page: Page, tokens: Tokens): Promise<void> {
  await page.addInitScript(([access, refresh]) => {
    localStorage.setItem('access_token', access as string);
    localStorage.setItem('refresh_token', refresh as string);
  }, [tokens.accessToken, tokens.refreshToken] as const);
}

test.describe('AXI-1684 — role debug mode fan-out (AC1-AC4)', { tag: ['@SI-011', '@SI-030', '@SI-031'] }, () => {
  let adminApi: APIRequestContext;
  let roleId: string;
  let holderUserId: string;
  let holderTokens: Tokens;

  test.beforeAll(async () => {
    const ctx = await adminContext();
    adminApi = ctx.api;

    // A throwaway role with debugMode ON.
    const role = await send(adminApi, 'post', '/api/v1/roles', {
      name: `E2E Debug Role ${Date.now()}`,
      scope: 'SYSTEM',
      permissions: [],
      debugMode: true,
    });
    roleId = role.id;

    // A throwaway self-registered user, assigned to that role.
    const holderEmail = `axi1684-${Date.now()}@axiome.local`;
    const holderPassword = 'AXI1684-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    const registeredTokens: Tokens = await send(bootstrap, 'post', '/auth/register', {
      email: holderEmail,
      password: holderPassword,
      firstName: 'AXI1684',
      lastName: 'Holder',
    });
    const registeredApi = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${registeredTokens.accessToken}` },
    });
    const holderMe = await send(registeredApi, 'get', '/auth/me');
    holderUserId = holderMe.id;
    await registeredApi.dispose();
    await bootstrap.dispose();

    await send(adminApi, 'post', `/api/v1/users/${holderUserId}/roles`, { roleId });
    holderTokens = await login(holderEmail, holderPassword);
  });

  test.afterAll(async () => {
    // Cleanup: drop the assignment so the role can be deleted, then the role.
    await send(adminApi, 'delete', `/api/v1/users/${holderUserId}/roles/${roleId}`).catch(() => {});
    await send(adminApi, 'delete', `/api/v1/roles/${roleId}`).catch(() => {});
    await adminApi?.dispose();
  });

  test('AC2 — /auth/me returns debugMode:true for a holder of a debugMode role', async () => {
    const holderApi = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${holderTokens.accessToken}` },
    });
    try {
      const me = await send(holderApi, 'get', '/auth/me');
      expect(me.debugMode).toBe(true);
    } finally {
      await holderApi.dispose();
    }
  });

  test('AC4 — the DEBUG badge is visible for a debugMode holder', async ({ page }) => {
    await seedSession(page, holderTokens);
    await page.goto(`${BASE_URL}/overview`);
    await expect(page.getByTestId('debug-mode-badge')).toBeVisible();
  });

  test("AC3/AC1 — flipping the role's debug mode off on the edit page clears /auth/me and the badge", async ({ page }) => {
    // Flip off through the real edit-page checkbox (AC1), as the admin.
    const adminTokens = await login(
      process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local',
      process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin',
    );
    await seedSession(page, adminTokens);

    await page.goto(`${BASE_URL}/system/roles/${roleId}/edit`);
    const checkbox = page.getByTestId('role-debug-mode-checkbox').locator('input');
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page).toHaveURL(new RegExp(`/system/roles/${roleId}$`));

    // AC3 — the holder's NEXT /auth/me fan-out reflects the flip, no stale true.
    const holderApi = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${holderTokens.accessToken}` },
    });
    try {
      const me = await send(holderApi, 'get', '/auth/me');
      expect(me.debugMode).toBe(false);
    } finally {
      await holderApi.dispose();
    }

    // AC4 — and the badge is gone for that holder.
    await seedSession(page, holderTokens);
    await page.goto(`${BASE_URL}/overview`);
    await expect(page.getByTestId('debug-mode-badge')).toHaveCount(0);
  });
});
