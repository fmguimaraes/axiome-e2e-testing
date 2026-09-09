import { request as apiRequest, APIRequestContext, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ROLES, Role } from '../../config/roles';
import { ensureAuthTokens } from '../../config/auth';

// Fixtures for AXI-1425 (Organization Collaborations). Self-contained: every
// spec provisions its own organizations / users / workspaces through the public
// API, so there is no dependence on seed data beyond the auth accounts.

const roleByName = (name: 'admin' | 'user'): Role => {
  const r = ROLES.find((x) => x.name === name);
  if (!r) throw new Error(`role ${name} not configured`);
  return r;
};

/** A bearer-token API context for a configured role (admin = platform admin). */
export async function roleContext(name: 'admin' | 'user'): Promise<APIRequestContext> {
  const bootstrap = await apiRequest.newContext();
  const tokens = await ensureAuthTokens(bootstrap, roleByName(name));
  await bootstrap.dispose();
  return apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
  });
}

type Method = 'get' | 'post' | 'delete' | 'patch';

/** Issue a request and assert a 2xx (or an expected status), returning the JSON body. */
export async function send(
  api: APIRequestContext,
  method: Method,
  path: string,
  body?: unknown,
  opts: { expectStatus?: number; headers?: Record<string, string> } = {},
): Promise<any> {
  const res = await api[method](apiUrl(path), {
    data: body ?? undefined,
    headers: opts.headers,
  });
  if (opts.expectStatus) {
    expect(res.status(), `${method.toUpperCase()} ${path}`).toBe(opts.expectStatus);
  } else {
    expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()}`).toBeTruthy();
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Fire a request WITHOUT asserting success; return status + parsed body. Used
 *  for negative paths so the spec can assert the OUTCOME (state unchanged)
 *  rather than an exact status — microservice-thrown domain errors surface
 *  platform-wide as 500 at the gateway, so status is not a reliable contract. */
export async function attempt(
  api: APIRequestContext,
  method: Method,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await api[method](apiUrl(path), { data: body ?? undefined, headers });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

const uniq = (label: string) => `E2E ${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

export async function whoAmI(api: APIRequestContext): Promise<string> {
  const me = await send(api, 'get', '/api/v1/auth/me');
  return me.id;
}

export async function createOrganization(api: APIRequestContext, createdBy: string): Promise<string> {
  const org = await send(api, 'post', '/api/v1/organizations', {
    name: uniq('Collab Org'),
    type: 'biotech',
    createdBy,
  });
  return org.id;
}

export async function createUserInOrg(
  api: APIRequestContext,
  organizationId: string,
): Promise<{ id: string; email: string }> {
  const email = `e2e-collab-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const user = await send(api, 'post', '/api/v1/users', {
    email,
    password: 'E2eUser!23',
    firstName: 'E2E',
    lastName: 'Collaborator',
    organizationId,
  });
  return { id: String(user.id), email };
}

export async function createWorkspace(
  api: APIRequestContext,
  ownerOrganizationId: string,
  createdBy: string,
): Promise<string> {
  const ws = await send(api, 'post', '/api/v1/workspaces', {
    name: uniq('Collab WS'),
    description: 'AXI-1425 collaboration E2E fixture',
    type: 'internal',
    ownerOrganizationId,
    createdBy,
  });
  return ws.id;
}

export async function inviteCandidates(api: APIRequestContext, workspaceId: string): Promise<any[]> {
  const res = await send(api, 'get', `/api/v1/users/workspace-invite-candidates/${workspaceId}`, undefined, {
    headers: { 'X-Workspace-Id': workspaceId },
  });
  return res.data ?? [];
}
