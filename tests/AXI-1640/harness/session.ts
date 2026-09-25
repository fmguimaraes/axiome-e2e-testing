import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { request as apiRequest, type APIResponse } from '@playwright/test';
import { adminApi, sleep, type Api } from '../../AXI-1400/harness/api';
import { roleTokens, seedBrowserSession } from '../../AXI-1244/subject-fixtures';
import { ensureAuthTokens } from '../../../config/auth';
import { apiUrl } from '../../../config/env';
import type { Role } from '../../../config/roles';
import { ensureTenant, type Tenant } from './seed';

/**
 * AXI-1650 — shared arrangement + browser-session helpers for the AXI-1640 specs.
 *
 * Specs run in parallel workers; tenant provisioning (org/workspace/project/
 * dataset by fixed name) is a find-or-create, so it is serialised across workers
 * with a directory lock to avoid creating duplicates.
 */

const LOCK = join(tmpdir(), 'axiome-axi1640-tenant.lock');

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      // A crashed holder must not wedge the suite: steal locks older than 5 min.
      if (existsSync(LOCK) && Date.now() - statSync(LOCK).mtimeMs > 300_000) rmSync(LOCK, { recursive: true, force: true });
      if (Date.now() > deadline) throw new Error('tenant lock timeout');
      await sleep(500);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

/**
 * Three identities (a platform ADMIN is deliberately NOT a workspace member —
 * the tenancy layer 404s it on workspace routes, so the two concerns need two users):
 *  - `platform` — the seeded platform ADMIN (registry write, admin pages);
 *  - `owner`    — a self-registered USER who creates the tenant and is its workspace ADMIN
 *                 (evidence, antibody panels, audit reads);
 *  - `viewer`   — the suite's non-admin `user`, added to the tenant as a workspace VIEWER.
 */
export type Who = 'platform' | 'owner' | 'viewer';

const OWNER: Role = {
  name: 'user',
  email: process.env.E2E_OWNER_EMAIL?.trim() || 'e2e-tenant-owner@axiome.local',
  password: process.env.E2E_OWNER_PASSWORD?.trim() || 'E2eOwner!23',
  selfRegister: true,
};

let ownerTokens: Promise<{ accessToken: string; refreshToken: string }> | undefined;
async function ownerAuth(): Promise<{ accessToken: string; refreshToken: string }> {
  ownerTokens ??= (async () => {
    const boot = await apiRequest.newContext();
    try {
      return await ensureAuthTokens(boot, OWNER);
    } finally {
      await boot.dispose();
    }
  })();
  return ownerTokens;
}

async function tokensFor(who: Who) {
  if (who === 'owner') return ownerAuth();
  return roleTokens(who === 'platform' ? 'admin' : 'user');
}

/** Bearer-authenticated JSON client (same shape as the AXI-1400 `Api`). */
export async function apiWith(accessToken: string): Promise<Api> {
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const parse = async (res: APIResponse) => {
    const text = await res.text();
    let body: unknown;
    try { body = text.length ? JSON.parse(text) : undefined; } catch { body = { _raw: text }; }
    return { status: res.status(), body: body as any };
  };
  return {
    ctx,
    get: async (path, headers) => parse(await ctx.get(apiUrl(path), { headers })),
    post: async (path, body, headers) => parse(await ctx.post(apiUrl(path), { data: body as any, headers })),
    patch: async (path, body, headers) => parse(await ctx.patch(apiUrl(path), { data: body as any, headers })),
  };
}

export interface Arranged {
  /** Tenant-owner client (workspace ADMIN, platform USER). */
  api: Api;
  /** Platform-admin client (registry write). */
  platform: Api;
  t: Tenant;
}

/** Clients + the (idempotent) AXI-1650 tenant with an ingested DE dataset. */
export async function arrange(): Promise<Arranged> {
  const api = await apiWith((await ownerAuth()).accessToken);
  const platform = await adminApi();
  const t = await withLock(() => ensureTenant(api));
  return { api, platform, t };
}

export async function disposeArranged(a: Arranged | undefined): Promise<void> {
  await a?.api.ctx.dispose();
  await a?.platform.ctx.dispose();
}

/** Log the browser in as `who` on the AXI-1650 workspace (fresh tokens, active workspace pre-seeded). */
export async function openSession(page: Page, who: Who, t: Tenant): Promise<void> {
  await seedBrowserSession(page, await tokensFor(who), t.workspaceId, t.orgId);
}

/** Make a suite role (default: the non-admin `user`, as VIEWER) a member of the tenant workspace (idempotent). */
export async function ensureViewerMember(api: Api, t: Tenant, who: 'user' | 'admin' = 'user', role = 'viewer'): Promise<void> {
  const tokens = await roleTokens(who);
  const me = await api.ctx.get(apiUrl('/api/v1/auth/me'), { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
  const meBody = await me.json();
  const userId = meBody.userId ?? meBody.id;
  const res = await api.post(`/api/v1/workspaces/${t.workspaceId}/members`, {
    userId, organizationId: t.orgId, role,
  }, t.headers);
  // 409 = already a member from an earlier run.
  if (res.status >= 300 && res.status !== 409) {
    throw new Error(`add viewer member failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
}
