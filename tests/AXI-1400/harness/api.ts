import { APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { ensureAuthTokens } from '../../../config/auth';
import { ROLES } from '../../../config/roles';

/**
 * AXI-1400-validation — Statistical Surface epic acceptance (Workflow 5).
 *
 * A thin authenticated gateway client for the whole-surface seeding + run flow.
 * The statistical execute contract is backend-only (the frontend models no
 * `STATISTICAL` runKind — AXI-1416 delivered the read consumer, not a submit
 * form), so this spec drives `POST /api/v1/rule-runs` directly, exactly as a
 * governed integration would. Mirrors the auth recipe the AXI-1396..1399 specs
 * use (`ensureAuthTokens` → Bearer), and reuses the demo defaults from
 * `config/env.ts` (API `http://localhost:3000`). Read-and-append only: it
 * creates an additive project; it never mutates existing demo data.
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

/** Gateway routes under `/api/v1/projects/*` read tenant scope from a header. */
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
    let body: unknown = undefined;
    try {
      body = text.length ? JSON.parse(text) : undefined;
    } catch {
      body = { _raw: text };
    }
    return { status: res.status(), body: body as any };
  };
  // The local demo occasionally resets a connection under load; retry the
  // transport error (never a non-2xx status, which is a real answer) a few times.
  const withRetry = async (fn: () => Promise<import('@playwright/test').APIResponse>) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return parse(await fn());
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
