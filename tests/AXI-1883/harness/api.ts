import { APIRequestContext, Page, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../../config/env';

/**
 * AXI-1893 (epic AXI-1883) — a thin authenticated gateway client keyed to the
 * shared E2E identity `test@axiomebio.com` (platform ADMIN on the seeded
 * local/demo stack), rather than the `config/roles.ts` `admin`/`user` registry
 * used by the AXI-1435 harness family. Deliberately self-contained (mirrors
 * `tests/AXI-1435/harness/api.ts`'s shape) so this story's fixtures never
 * depend on an unmerged sibling branch.
 *
 * Password is never written here: `E2E_TEST_PASSWORD` must be set in the
 * environment the spec runs in.
 */
export interface Api {
  get<T = any>(path: string, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  post<T = any>(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  patch<T = any>(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  delete<T = any>(path: string, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  ctx: APIRequestContext;
}

export const TEST_IDENTITY_EMAIL = 'test@axiomebio.com';

function testIdentityPassword(): string {
  const value = process.env.E2E_TEST_PASSWORD;
  if (!value) {
    throw new Error('E2E_TEST_PASSWORD is not set — the test@axiomebio.com password must come from the environment, never a literal in this repo.');
  }
  return value;
}

async function parse(res: import('@playwright/test').APIResponse) {
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length ? JSON.parse(text) : undefined;
  } catch {
    body = { _raw: text };
  }
  return { status: res.status(), body: body as any };
}

export interface TestIdentityTokens { accessToken: string; refreshToken: string }

/** Log `test@axiomebio.com` in over the API and return its token pair. */
export async function testIdentityTokens(): Promise<TestIdentityTokens> {
  const bootstrap = await apiRequest.newContext();
  const loginRes = await bootstrap.post(apiUrl('/api/v1/auth/login'), {
    data: { email: TEST_IDENTITY_EMAIL, password: testIdentityPassword() },
  });
  if (!loginRes.ok()) {
    throw new Error(`login failed for ${TEST_IDENTITY_EMAIL} (${loginRes.status()}): ${await loginRes.text()}`);
  }
  const { accessToken, refreshToken } = await loginRes.json();
  await bootstrap.dispose();
  return { accessToken, refreshToken };
}

/**
 * AXI-1883 — put the browser session on `test@axiomebio.com`, the SAME identity
 * whose API client seeded the tenant (and so is a member of its workspace), with
 * that tenant's org/workspace active.
 *
 * Replaces a `/login` form fill: the `chromium` project's default
 * `storageState` is already an authenticated session, and `Login.tsx` answers
 * an authenticated visitor with `<Navigate to="/">`, so the email field never
 * rendered and `locator.fill` hung until the test timeout. Injecting the token
 * pair before any page script runs (the seam `AXI-1717`'s `primeWorkspace` and
 * `AXI-1889`'s AC8 use) overrides whatever identity that storageState holds,
 * so the spec never silently runs as a different account.
 */
export async function signInAsTestIdentity(page: Page, scope: { orgId: string; workspaceId: string }): Promise<void> {
  const { accessToken, refreshToken } = await testIdentityTokens();
  await page.addInitScript(([access, refresh, org, ws]) => {
    localStorage.setItem('access_token', access);
    localStorage.setItem('refresh_token', refresh);
    // Active org/workspace are client state `topMenuStore` reads off
    // localStorage at init; without them every workspace-scoped list on the
    // page fails with "X-Workspace-Id header is required".
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', ws);
  }, [accessToken, refreshToken, scope.orgId, scope.workspaceId] as const);
}

/** Authenticate as `test@axiomebio.com` and build a gateway client. */
export async function testIdentityApi(): Promise<Api> {
  const { accessToken } = await testIdentityTokens();

  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  return {
    ctx,
    async get(path, headers) {
      return parse(await ctx.get(apiUrl(path), { headers }));
    },
    async post(path, body, headers) {
      return parse(await ctx.post(apiUrl(path), { data: body as any, headers }));
    },
    async patch(path, body, headers) {
      return parse(await ctx.patch(apiUrl(path), { data: body as any, headers }));
    },
    async delete(path, headers) {
      return parse(await ctx.delete(apiUrl(path), { headers }));
    },
  };
}

export function workspaceHeader(workspaceId: string): Record<string, string> {
  return { 'X-Workspace-Id': workspaceId };
}

export function asList<T = any>(body: any): T[] {
  if (Array.isArray(body)) return body;
  return body?.data ?? body?._list ?? [];
}
