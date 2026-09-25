import { request as apiRequest, APIRequestContext, Page } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { ROLES, Role } from '../../../config/roles';
import { ensureAuthTokens } from '../../../config/auth';

/**
 * Self-contained provisioning for the AXI-1523 prompt-library E2E scenarios
 * (epic AXI-1518, manual-e2e §4.1-4.3 / §5.1-5.5).
 *
 * The shared ROLES registry (`config/roles.ts`) only carries `admin` (platform
 * admin) and `user` — there is no seeded editor/viewer/second-workspace-admin
 * login. Rather than skip the RBAC scenarios for want of a fixture, this module
 * follows the SAME self-provisioning convention `tests/AXI-1425/collaboration-
 * fixtures.ts` and `tests/AXI-1244/subject-fixtures.ts` already use: stand up a
 * fresh org + workspace and mint the member accounts through the public API.
 *
 * How each role's permission set is obtained matters and is deliberate:
 *  - the workspace CREATOR becomes a member with the legacy `role: 'admin'`
 *    string (org-service's `workspaces.service.ts` `create()`), which
 *    `permissionsForRole('admin')` resolves to the full set INCLUDING all
 *    three `guided_analysis_prompt:*` grants (`libs/common/src/permissions/
 *    permissions.constants.ts`) — no seed script re-run needed.
 *  - the editor is added with the legacy `role: 'editor'` string, which
 *    resolves to `view` + `manage` but NOT `manage_system` — exactly AC2/AC3's
 *    matrix, and needs no custom role object.
 *  - the viewer is added via a CUSTOM role (`POST /v1/roles`, System-Admin-only)
 *    carrying ONLY `guided_analysis_prompt:view`, rather than the legacy
 *    `'viewer'` string. This is required, not incidental: the legacy string
 *    resolves through a hard-coded map in product code, so a permission can
 *    never be revoked from it at test time. §5.2's second negative
 *    ("remove guided_analysis_prompt:view … and reload") is only reachable at
 *    all if the viewer's grant lives in a role row the harness can PATCH.
 */

const roleByName = (name: Role['name']): Role => {
  const r = ROLES.find((x) => x.name === name);
  if (!r) throw new Error(`role ${name} not configured`);
  return r;
};

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export function workspaceHeader(workspaceId: string): Record<string, string> {
  return { 'X-Workspace-Id': workspaceId };
}

/** A bearer-token API context for a configured `config/roles.ts` role. */
export async function roleContext(name: Role['name']): Promise<APIRequestContext> {
  const bootstrap = await apiRequest.newContext();
  const tokens = await ensureAuthTokens(bootstrap, roleByName(name));
  await bootstrap.dispose();
  return apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
}

/** Log in with an arbitrary email/password (the accounts this module mints). */
export async function loginTokens(email: string, password: string): Promise<Tokens> {
  const bootstrap = await apiRequest.newContext();
  try {
    const res = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
    if (!res.ok()) throw new Error(`login failed for ${email} (${res.status()}): ${await res.text()}`);
    const body = await res.json();
    return { accessToken: body.accessToken, refreshToken: body.refreshToken };
  } finally {
    await bootstrap.dispose();
  }
}

export function bearerContext(tokens: Tokens): Promise<APIRequestContext> {
  return apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
}

type Method = 'get' | 'post' | 'patch' | 'delete';

/** Issue a request and assert success (2xx unless `expectStatus` says otherwise); returns the parsed body. */
export async function send(
  api: APIRequestContext,
  method: Method,
  path: string,
  body?: unknown,
  opts: { expectStatus?: number; headers?: Record<string, string> } = {},
): Promise<any> {
  const res = await api[method](apiUrl(path), { data: body ?? undefined, headers: opts.headers });
  const ok = opts.expectStatus ? res.status() === opts.expectStatus : res.ok();
  if (!ok) {
    throw new Error(
      `${method.toUpperCase()} ${path} → ${res.status()} (expected ${opts.expectStatus ?? '2xx'}): ${await res.text()}`,
    );
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Fire a request WITHOUT asserting success; the caller inspects status/body. */
export async function attempt(
  api: APIRequestContext,
  method: Method,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await api[method](apiUrl(path), { data: body ?? undefined, headers });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { _raw: text };
  }
  return { status: res.status(), body: parsed };
}

export async function whoAmI(api: APIRequestContext): Promise<string> {
  const me = await send(api, 'get', '/api/v1/auth/me');
  return me.id;
}

const uniq = (label: string) => `E2E AXI-1523 ${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

export async function createOrganization(api: APIRequestContext, createdBy: string): Promise<string> {
  const org = await send(api, 'post', '/api/v1/organizations', {
    name: uniq(`org ${Math.random().toString(36).slice(2, 6)}`),
    type: 'biotech',
    createdBy,
  });
  return org.id;
}

export interface MintedUser {
  id: string;
  email: string;
  password: string;
}

export async function createUserInOrg(
  api: APIRequestContext,
  organizationId: string,
  label: string,
): Promise<MintedUser> {
  const email = `e2e-axi1523-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const password = 'E2eUser!23';
  const user = await send(api, 'post', '/api/v1/users', {
    email,
    password,
    firstName: 'E2E',
    lastName: label,
    organizationId,
  });
  return { id: String(user.id), email, password };
}

/** Creates a workspace owned by `organizationId`; the CALLER (`api`'s own bearer
 *  identity) becomes its admin member (org-service `create()` — FR n/a, this is
 *  just how workspace creation works). */
export async function createWorkspace(api: APIRequestContext, organizationId: string): Promise<string> {
  const ws = await send(api, 'post', '/api/v1/workspaces', {
    name: uniq('ws'),
    description: 'AXI-1523 prompt-library E2E fixture',
    type: 'internal',
    ownerOrganizationId: organizationId,
  });
  return ws.id;
}

export async function addMemberByRole(
  api: APIRequestContext,
  workspaceId: string,
  userId: string,
  organizationId: string,
  role: string,
): Promise<void> {
  await send(api, 'post', `/api/v1/workspaces/${workspaceId}/members`, {
    userId,
    organizationId,
    role,
  });
}

export async function addMemberByRoleId(
  api: APIRequestContext,
  workspaceId: string,
  userId: string,
  organizationId: string,
  roleId: string,
): Promise<void> {
  await send(api, 'post', `/api/v1/workspaces/${workspaceId}/members`, {
    userId,
    organizationId,
    roleId,
  });
}

/** System-Admin-only (the gateway's roles controller checks `req.user.role === 'ADMIN'`,
 *  which the platform admin login satisfies). */
export async function createWorkspaceRole(
  adminApi: APIRequestContext,
  permissions: string[],
  label: string,
): Promise<string> {
  const role = await send(adminApi, 'post', '/api/v1/roles', {
    name: uniq(label),
    description: `AXI-1523 E2E — ${label}`,
    scope: 'WORKSPACE',
    permissions,
  });
  return role.id;
}

export async function updateWorkspaceRolePermissions(
  adminApi: APIRequestContext,
  roleId: string,
  permissions: string[],
): Promise<void> {
  await send(adminApi, 'patch', `/api/v1/roles/${roleId}`, { permissions });
}

/**
 * FINDING (see spec file header): the page's OWN permission gating
 * (`useCurrentUserRole` → `GET /users/extended/:id` → `roleId`/`roleName`) reads
 * a role assigned to the USER GLOBALLY (`POST /users/:id/roles`,
 * `AssignRoleRequest`) — a completely different axis from the WORKSPACE
 * MEMBERSHIP role (`role`/`roleId` on `WorkspaceMember`) that
 * `WorkspacePermissionGuard` actually authorizes writes against. The product's
 * OWN "assign a workspace role" UI (`WorkspaceRoleAssignment.tsx`) only ever
 * calls `PATCH /workspaces/:id/members/:userId/role` — it never calls this
 * endpoint — so nothing in the shipped flow keeps the two in sync. Without
 * this call, a workspace member with a real `manage` grant server-side would
 * render as if they had NONE (every button locked), because the page never
 * consults the grant that actually governs the write. Called here purely to
 * make the UI-facing assertions exercise the real rendered page rather than a
 * fixture-only illusion of it — it is not a substitute for the workspace
 * membership call above, and does not change what the SERVER enforces.
 */
export async function assignGlobalRole(
  adminApi: APIRequestContext,
  userId: string,
  roleId: string,
): Promise<void> {
  await send(adminApi, 'post', `/api/v1/users/${userId}/roles`, { roleId }, { expectStatus: 204 });
}

/** Seed a page (before app scripts run) with a member's tokens + active workspace/org. */
export async function seedBrowserSession(
  page: Page,
  tokens: Tokens,
  workspaceId: string,
  orgId: string,
): Promise<void> {
  await page.addInitScript(
    ([access, refresh, ws, org]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [tokens.accessToken, tokens.refreshToken, workspaceId, orgId] as const,
  );
}

export interface Member {
  api: APIRequestContext;
  tokens: Tokens;
  userId: string;
  email: string;
}

export interface PromptLibraryFixture {
  orgId: string;
  workspaceId: string;
  admin: Member;
  editor: Member;
  /** Holds a CUSTOM role (see module doc) so §5.2's revoke negative is reachable. */
  viewer: Member & { roleId: string };
  secondWorkspace: { orgId: string; workspaceId: string; admin: Member };
}

/** Dispose every API context this fixture opened. */
export async function disposeFixture(f: PromptLibraryFixture): Promise<void> {
  await Promise.all([
    f.admin.api.dispose(),
    f.editor.api.dispose(),
    f.viewer.api.dispose(),
    f.secondWorkspace.admin.api.dispose(),
  ]);
}

export async function provisionPromptLibraryFixture(): Promise<PromptLibraryFixture> {
  const platformAdminApi = await roleContext('admin');
  const platformAdminId = await whoAmI(platformAdminApi);

  // ── Primary workspace: admin (creator) + editor + custom-role viewer ──
  const orgId = await createOrganization(platformAdminApi, platformAdminId);
  const workspaceId = await createWorkspace(platformAdminApi, orgId);
  const adminMember: Member = {
    api: platformAdminApi,
    tokens: { accessToken: '', refreshToken: '' }, // filled below
    userId: platformAdminId,
    email: roleByName('admin').email,
  };
  {
    const bootstrap = await apiRequest.newContext();
    const tokens = await ensureAuthTokens(bootstrap, roleByName('admin'));
    await bootstrap.dispose();
    adminMember.tokens = tokens;
  }

  const editorUser = await createUserInOrg(platformAdminApi, orgId, 'editor');
  await addMemberByRole(platformAdminApi, workspaceId, editorUser.id, orgId, 'editor');
  // See `assignGlobalRole` doc: the PAGE's own grants read this, not the
  // workspace-membership role just added above.
  const editorGlobalRoleId = await createWorkspaceRole(
    platformAdminApi,
    ['guided_analysis_prompt:view', 'guided_analysis_prompt:manage'],
    'editor-mirror',
  );
  await assignGlobalRole(platformAdminApi, editorUser.id, editorGlobalRoleId);
  const editorTokens = await loginTokens(editorUser.email, editorUser.password);
  const editorApi = await bearerContext(editorTokens);

  const viewerUser = await createUserInOrg(platformAdminApi, orgId, 'viewer');
  const viewerRoleId = await createWorkspaceRole(
    platformAdminApi,
    ['guided_analysis_prompt:view'],
    'viewer-only',
  );
  await addMemberByRoleId(platformAdminApi, workspaceId, viewerUser.id, orgId, viewerRoleId);
  // Same role row does double duty: it is both the WORKSPACE membership's
  // roleId (what the server checks) and the GLOBAL per-user role assignment
  // (what the page reads) — deliberately, so §5.2's revoke negative only has to
  // PATCH one row for both axes to move together.
  await assignGlobalRole(platformAdminApi, viewerUser.id, viewerRoleId);
  const viewerTokens = await loginTokens(viewerUser.email, viewerUser.password);
  const viewerApi = await bearerContext(viewerTokens);

  // ── Second workspace, owned by a second org, admin'd by a DIFFERENT user ──
  const orgId2 = await createOrganization(platformAdminApi, platformAdminId);
  const secondAdminUser = await createUserInOrg(platformAdminApi, orgId2, 'second-admin');
  const secondAdminTokens = await loginTokens(secondAdminUser.email, secondAdminUser.password);
  const secondAdminApi = await bearerContext(secondAdminTokens);
  const workspaceId2 = await createWorkspace(secondAdminApi, orgId2);

  return {
    orgId,
    workspaceId,
    admin: adminMember,
    editor: { api: editorApi, tokens: editorTokens, userId: editorUser.id, email: editorUser.email },
    viewer: {
      api: viewerApi,
      tokens: viewerTokens,
      userId: viewerUser.id,
      email: viewerUser.email,
      roleId: viewerRoleId,
    },
    secondWorkspace: {
      orgId: orgId2,
      workspaceId: workspaceId2,
      admin: {
        api: secondAdminApi,
        tokens: secondAdminTokens,
        userId: secondAdminUser.id,
        email: secondAdminUser.email,
      },
    },
  };
}
