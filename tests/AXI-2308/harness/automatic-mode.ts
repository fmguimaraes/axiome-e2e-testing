import { request as apiRequest, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { workspaceHeader, type Api } from '../../AXI-1400/harness/api';
import type { Tenant } from '../../AXI-1400/harness/seed';

/**
 * AXI-2341 (epic AXI-2308 — FR25, FR27, NFR11; @SI-045 @SI-010). Helpers for the
 * Automatic-mode spec: the two Automatic routes, and a throwaway debug-mode holder
 * to read the call log back through the debug-mode route (the AXI-1689 recipe — the
 * platform admin never receives a debugMode role, so the gateway's 60 s debug-mode
 * cache can only ever hold `false` for it).
 */

export const AUTOMATIC_PATH = '/api/v1/guided-analysis/automatic';

/** POST /automatic/plan; the raw response (a refusal is a 2xx with `ok: false`). */
export function automaticPlan(api: Api, t: Tenant, dataset: unknown, question: string) {
  return api.post(`${AUTOMATIC_PATH}/plan`, { projectId: t.projectId, question, dataset }, t.headers);
}

export function automaticDataFlow(api: Api, t: Tenant) {
  return api.get(`${AUTOMATIC_PATH}/data-flow`, t.headers);
}

async function send(ctx: APIRequestContext, method: 'post' | 'get' | 'delete', path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await ctx[method](apiUrl(path), { data: body as any, headers });
  if (!res.ok()) throw new Error(`AXI-2341 fixture ${method.toUpperCase()} ${path} -> ${res.status()}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export interface DebugHolder {
  api: APIRequestContext;
  cleanup(): Promise<void>;
}

/** A throwaway debugMode role held by a throwaway user who is a member of the tenant workspace. */
export async function debugHolder(admin: Api, t: Tenant): Promise<DebugHolder> {
  const stamp = Date.now();
  const role = await send(admin.ctx, 'post', '/api/v1/roles', {
    name: `E2E AXI-2341 Debug Role ${stamp}`, scope: 'SYSTEM', permissions: [], debugMode: true,
  });
  const email = `axi2341-${stamp}@axiome.local`;
  const password = 'AXI2341-e2e-pw!';
  const anon = await apiRequest.newContext();
  const tokens = await send(anon, 'post', '/api/v1/auth/register', { email, password, firstName: 'AXI2341', lastName: 'Holder' });
  await anon.dispose();
  const registered = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
  const me = await send(registered, 'get', '/api/v1/auth/me');
  await registered.dispose();
  await send(admin.ctx, 'post', `/api/v1/users/${me.id}/roles`, { roleId: role.id });
  await send(admin.ctx, 'post', `/api/v1/workspaces/${t.workspaceId}/members`,
    { userId: me.id, organizationId: t.orgId, role: 'editor' }, workspaceHeader(t.workspaceId));
  const login = await apiRequest.newContext();
  const fresh = await send(login, 'post', '/api/v1/auth/login', { email, password });
  await login.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${fresh.accessToken}` } });
  return {
    api,
    async cleanup() {
      await send(admin.ctx, 'delete', `/api/v1/users/${me.id}/roles/${role.id}`).catch(() => {});
      await send(admin.ctx, 'delete', `/api/v1/roles/${role.id}`).catch(() => {});
      await api.dispose();
    },
  };
}

/** The project's call-log rows (newest first) through the debug-mode read-back route. */
export async function callLogRows(holder: DebugHolder, t: Tenant): Promise<any[]> {
  const page = await send(holder.api, 'get', `/api/v1/guided-analysis/projects/${t.projectId}/intent-attempts?page=1&limit=100`,
    undefined, workspaceHeader(t.workspaceId));
  return page.items as any[];
}
