import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminContext } from '../AXI-1244/subject-fixtures';

/**
 * AXI-1685 — Debug mode on the back: caller debugMode resolved server-side,
 * @RequireDebugMode guard + CallerScope.debugMode, proof endpoint (epic
 * AXI-1604). API-only — no UI surface for this story (that is AXI-1684).
 *
 * Everything is self-provisioned per run (the AXI-1244 precedent's
 * determinism doctrine): a throwaway role, a throwaway self-registered
 * holder user assigned to it, and cleanup at the end.
 *
 * AC1 — GET /api/v1/debug/ping returns 200 with the expected shape for a
 *   holder of a debugMode role.
 * AC2 — GET /api/v1/debug/ping returns 403 for a caller with no debugMode
 *   role.
 * AC3 — flipping the role's debugMode off is reflected within the resolver's
 *   60s cache TTL (never a stale 200 past that window).
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
    throw new Error(`AXI-1685 fixture ${method.toUpperCase()} ${path} -> ${res.status()}: ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function login(email: string, password: string): Promise<Tokens> {
  const bootstrap = await apiRequest.newContext();
  try {
    return await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
  } finally {
    await bootstrap.dispose();
  }
}

async function registerHolder(): Promise<{ userId: string; tokens: Tokens; email: string; password: string }> {
  const email = `axi1685-${Date.now()}@axiome.local`;
  const password = 'AXI1685-e2e-pw!';
  const bootstrap = await apiRequest.newContext();
  const tokens: Tokens = await send(bootstrap, 'post', '/api/v1/auth/register', {
    email,
    password,
    firstName: 'AXI1685',
    lastName: 'Holder',
  });
  const registeredApi = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  const me = await send(registeredApi, 'get', '/api/v1/auth/me');
  await registeredApi.dispose();
  await bootstrap.dispose();
  return { userId: me.id, tokens, email, password };
}

// The gateway's DebugModeResolver caches a resolution for this long; a flip
// is only guaranteed visible once we sleep past it (AC3, no test-only cache
// eviction endpoint is exposed by this story).
const CACHE_TTL_MS = 60_000;

test.describe(
  'AXI-1685 — debug mode on the back: guard + resolver + proof endpoint (AC1-AC3)',
  { tag: ['@SI-011', '@SI-030', '@SI-031'] },
  () => {
    let adminApi: APIRequestContext;
    let roleId: string;
    let holderUserId: string;
    let holderTokens: Tokens;
    let nonHolderTokens: Tokens;

    test.beforeAll(async () => {
      const ctx = await adminContext();
      adminApi = ctx.api;

      // A throwaway role with debugMode ON.
      const role = await send(adminApi, 'post', '/api/v1/roles', {
        name: `E2E Debug Ping Role ${Date.now()}`,
        scope: 'SYSTEM',
        permissions: [],
        debugMode: true,
      });
      roleId = role.id;

      // A holder, assigned to that role.
      const holder = await registerHolder();
      holderUserId = holder.userId;
      await send(adminApi, 'post', `/api/v1/users/${holderUserId}/roles`, { roleId });
      holderTokens = await login(holder.email, holder.password);

      // A non-holder — a plain self-registered user, no role assignment at all.
      const nonHolder = await registerHolder();
      nonHolderTokens = await login(nonHolder.email, nonHolder.password);
    });

    test.afterAll(async () => {
      await send(adminApi, 'delete', `/api/v1/users/${holderUserId}/roles/${roleId}`).catch(() => {});
      await send(adminApi, 'delete', `/api/v1/roles/${roleId}`).catch(() => {});
      await adminApi?.dispose();
    });

    test('AC1 — GET /debug/ping returns 200 with the expected shape for a debugMode holder', async () => {
      const holderApi = await apiRequest.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${holderTokens.accessToken}` },
      });
      try {
        const res = await holderApi.get(apiUrl('/api/v1/debug/ping'));
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ debugMode: true, userId: holderUserId, cacheTtlMs: CACHE_TTL_MS });
        expect(typeof body.resolvedAt).toBe('string');
        expect(Number.isNaN(Date.parse(body.resolvedAt))).toBe(false);
      } finally {
        await holderApi.dispose();
      }
    });

    test('AC2 — GET /debug/ping returns 403 for a caller with no debugMode role', async () => {
      const nonHolderApi = await apiRequest.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${nonHolderTokens.accessToken}` },
      });
      try {
        const res = await nonHolderApi.get(apiUrl('/api/v1/debug/ping'));
        expect(res.status()).toBe(403);
      } finally {
        await nonHolderApi.dispose();
      }
    });

    test('AC2 — GET /debug/ping returns 401 with no Authorization header at all', async () => {
      const anonApi = await apiRequest.newContext();
      try {
        const res = await anonApi.get(apiUrl('/api/v1/debug/ping'));
        expect(res.status()).toBe(401);
      } finally {
        await anonApi.dispose();
      }
    });

    test('AC3 — flipping the role off is reflected on /debug/ping within the 60s cache TTL', async () => {
      test.setTimeout(120_000);

      // Sanity: the holder is still admitted before the flip.
      const holderApi = await apiRequest.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${holderTokens.accessToken}` },
      });
      try {
        const before = await holderApi.get(apiUrl('/api/v1/debug/ping'));
        expect(before.status()).toBe(200);

        // Flip the role's debugMode off.
        await send(adminApi, 'patch', `/api/v1/roles/${roleId}`, { debugMode: false });

        // Wait past the resolver's cache TTL, then expect a 403.
        await new Promise((resolve) => setTimeout(resolve, CACHE_TTL_MS + 5_000));
        const after = await holderApi.get(apiUrl('/api/v1/debug/ping'));
        expect(after.status()).toBe(403);
      } finally {
        // Restore debugMode:true so afterAll's cleanup order stays irrelevant,
        // and so a re-run of just this file starts from a known role state.
        await send(adminApi, 'patch', `/api/v1/roles/${roleId}`, { debugMode: true }).catch(() => {});
        await holderApi.dispose();
      }
    });
  },
);
