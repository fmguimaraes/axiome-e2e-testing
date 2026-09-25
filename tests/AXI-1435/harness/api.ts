import { APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { ensureAuthTokens } from '../../../config/auth';
import { ROLES } from '../../../config/roles';

/**
 * AXI-1435 — statistical trigger surface E2E (picker → config → run → result).
 *
 * A thin authenticated gateway client for the seeding + polling this spec
 * needs alongside its browser-driven flow. Mirrors the auth/retry recipe
 * `tests/AXI-1400/harness/api.ts` established for the same feature's
 * whole-surface acceptance spec (not yet merged to `main` at authoring time —
 * this file is a self-contained copy of that pattern, not an import from it,
 * so this story does not depend on an unmerged branch).
 */

let cachedToken: Promise<string> | undefined;

export async function adminToken(): Promise<string> {
  if (!cachedToken) {
    cachedToken = (async () => {
      const bootstrap = await apiRequest.newContext();
      const role = ROLES.find((r) => r.name === 'admin');
      if (!role) throw new Error('admin role missing from ROLES registry');
      const tokens = await ensureAuthTokens(bootstrap, role);
      await bootstrap.dispose();
      return tokens.accessToken;
    })().catch((err) => {
      cachedToken = undefined;
      throw err;
    });
  }
  return cachedToken;
}

/**
 * AXI-1677 (epic AXI-1604 — FR28/FR30, @SI-042). Drop the cached access token so
 * the next `adminToken()` mints a fresh one.
 *
 * WHY THIS EXISTS. `adminToken()` caches the token for the whole process, which
 * is right for a spec that runs in seconds and wrong for one that runs for an
 * hour. The 2026-09-25 shadow run outlasted the token's TTL partway through the
 * legacy arm: 39 of its 46 rows were 4-13 ms `401 Invalid token` responses
 * recorded as the outcome `unavailable`, indistinguishable in the report table
 * from a planner that failed to answer
 * (`axiome-docs/reports/2026-09-25-compiled-planner-shadow-run.md`). The
 * exclusion set had to be reconstructed by hand from row latencies afterwards.
 *
 * `ensureAuthTokens()` performs a real login every call (`config/auth.ts`), so
 * resetting the cache genuinely re-authenticates rather than returning the same
 * expired string. A caller that resets MUST also build a new `Api` — the
 * `Authorization` header is baked into the `APIRequestContext` at creation.
 */
export function resetAdminToken(): void {
  cachedToken = undefined;
}

/** Gateway routes under `/api/v1/projects/*` (and siblings) read tenant scope from a header. */
export function workspaceHeader(workspaceId: string): Record<string, string> {
  return { 'X-Workspace-Id': workspaceId };
}

export interface Api {
  get<T = any>(path: string, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  post<T = any>(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  patch<T = any>(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  ctx: APIRequestContext;
}

/** Build an admin-authenticated API context. Dispose it in an afterAll. */
export async function adminApi(): Promise<Api> {
  const token = await adminToken();
  const ctx = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const parse = async (res: import('@playwright/test').APIResponse) => {
    const text = await res.text();
    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : undefined;
    } catch {
      body = { _raw: text };
    }
    return { status: res.status(), body: body as any };
  };
  // The local/demo stack occasionally resets a connection under load (dev/HMR
  // reload); retry the TRANSPORT error (never a non-2xx status, which is a
  // real answer) a few times, mirroring the AXI-1400 harness.
  const withRetry = async (fn: () => Promise<import('@playwright/test').APIResponse>) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await parse(await fn());
      } catch (err) {
        lastErr = err;
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastErr;
  };
  return {
    ctx,
    async get(path, headers) {
      return withRetry(() => ctx.get(apiUrl(path), { headers }));
    },
    async post(path, body, headers) {
      return withRetry(() => ctx.post(apiUrl(path), { data: body as any, headers }));
    },
    async patch(path, body, headers) {
      return withRetry(() => ctx.patch(apiUrl(path), { data: body as any, headers }));
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalise a list response: some gateway routes return a bare array, others
 *  wrap rows in `{ data: [...] }`. Either way, get the rows. */
export function asList<T = any>(body: any): T[] {
  if (Array.isArray(body)) return body;
  return body?.data ?? body?._list ?? [];
}
