import { APIRequestContext, request as apiRequest } from '@playwright/test';
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

/** Authenticate as `test@axiomebio.com` and build a gateway client. */
export async function testIdentityApi(): Promise<Api> {
  const bootstrap = await apiRequest.newContext();
  const loginRes = await bootstrap.post(apiUrl('/api/v1/auth/login'), {
    data: { email: TEST_IDENTITY_EMAIL, password: testIdentityPassword() },
  });
  if (!loginRes.ok()) {
    throw new Error(`login failed for ${TEST_IDENTITY_EMAIL} (${loginRes.status()}): ${await loginRes.text()}`);
  }
  const { accessToken } = await loginRes.json();
  await bootstrap.dispose();

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
