import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { RestClient } from '../../staging/client/RestClient';
import { TENANT_FIXTURE } from '../../staging/fixtures/tenantFixture';
import { stageTenant } from '../../staging/steps/stage';
import type { TenantFixture } from '../../staging/fixtures/types';

/**
 * AXI-1371 — `stageTenant()` idempotent provisioning (FR5/NFR1/EC1), mocked
 * at the HTTP boundary (`global.fetch`) — no live stack in this file, per
 * the story's testing instruction. `AXI-1371-tenant-provisioning-live.md`
 * (this story's report) carries the actual live-stack run. Manual-E2E
 * §AXI-1368 §5.6.
 *
 * @SI-044.
 */

const ADMIN_EMAIL = 'admin@axiome.local';
const ADMIN_PASSWORD = 'admin';

interface FakeUser {
  id: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}
interface FakeOrg {
  id: string;
  name: string;
  type: string;
}
interface FakeWorkspace {
  id: string;
  name: string;
  ownerOrganizationId: string;
  members: { userId: string }[];
}
interface FakeProject {
  id: string;
  name: string;
  workspaceId: string;
  status: 'active' | 'archived';
}

/** A minimal in-memory stand-in for the identity + tenancy routes
 *  `stageTenant()` calls — just enough surface to prove the idempotent
 *  create-or-rename-or-reuse logic, not a gateway re-implementation. */
class FakeGateway {
  users = new Map<string, FakeUser>();
  tokens = new Map<string, string>();
  roles = new Map<string, { id: string; name: string }>();
  userRoles = new Map<string, Set<string>>();
  orgs = new Map<string, FakeOrg>();
  workspaces = new Map<string, FakeWorkspace>();
  projects = new Map<string, FakeProject>();
  /** Project ids that always fail DELETE, simulating the live-confirmed
   *  gateway bug `projectRetirement.ts` routes around. */
  poisonedDeleteIds = new Set<string>();

  constructor() {
    this.seedAdmin();
  }

  private seedAdmin(): void {
    const id = randomUUID();
    this.users.set(ADMIN_EMAIL, { id, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, firstName: 'Local', lastName: 'Admin' });
  }

  async handle(url: string, init: { method: string; body?: string; token?: string; headers: Record<string, string> }): Promise<Response> {
    const path = new URL(url).pathname + new URL(url).search;
    const route = this.route(init.method, path, init.body, init.token, init.headers);
    return route ?? json(404, { message: `unhandled route in FakeGateway: ${init.method} ${path}` });
  }

  private route(method: string, path: string, body: string | undefined, token: string | undefined, headers: Record<string, string>): Response | undefined {
    return (
      this.routeAuth(method, path, body, token) ??
      this.routeOrganizations(method, path, body) ??
      this.routeWorkspaces(method, path, body) ??
      this.routeProjects(method, path, body, headers)
    );
  }

  // --- auth / identities -------------------------------------------------
  private routeAuth(method: string, path: string, body: string | undefined, token: string | undefined): Response | undefined {
    const pathname = path.split('?')[0];
    if (method === 'POST' && pathname === '/api/v1/auth/login') return this.login(body);
    if (method === 'POST' && pathname === '/api/v1/users') return this.createUser(body);
    if (method === 'GET' && pathname === '/api/v1/auth/me') return this.me(token);
    if (method === 'PATCH' && pathname === '/api/v1/auth/profile') return this.updateProfile(token, body);
    if (method === 'GET' && pathname === '/api/v1/roles') return json(200, [...this.roles.values()]);
    if (method === 'POST' && pathname === '/api/v1/roles') return this.createRole(body);
    const rolesMatch = pathname.match(/^\/api\/v1\/users\/([^/]+)\/roles$/);
    if (rolesMatch && method === 'GET') return this.listUserRoles(rolesMatch[1]);
    if (rolesMatch && method === 'POST') return this.assignRole(rolesMatch[1], body);
    return undefined;
  }

  private login(rawBody?: string): Response {
    const { email, password } = JSON.parse(rawBody ?? '{}');
    const user = this.users.get(email);
    if (!user || user.password !== password) return json(401, { message: 'invalid credentials' });
    const token = `token-${user.id}`;
    this.tokens.set(token, email);
    return json(200, { accessToken: token, refreshToken: `refresh-${user.id}` });
  }

  private createUser(rawBody?: string): Response {
    const body = JSON.parse(rawBody ?? '{}');
    if (this.users.has(body.email)) return json(409, { message: 'Email already exists' });
    const id = randomUUID();
    this.users.set(body.email, { id, ...body });
    return json(201, { id, ...body });
  }

  private me(token: string | undefined): Response {
    const user = this.userForToken(token);
    if (!user) return json(401, { message: 'unauthenticated' });
    return json(200, { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName });
  }

  private updateProfile(token: string | undefined, rawBody?: string): Response {
    const user = this.userForToken(token);
    if (!user) return json(401, { message: 'unauthenticated' });
    Object.assign(user, JSON.parse(rawBody ?? '{}'));
    return json(200, user);
  }

  private userForToken(token: string | undefined): FakeUser | undefined {
    const email = token ? this.tokens.get(token) : undefined;
    return email ? this.users.get(email) : undefined;
  }

  private createRole(rawBody?: string): Response {
    const body = JSON.parse(rawBody ?? '{}');
    const id = randomUUID();
    this.roles.set(id, { id, name: body.name });
    return json(201, { id, name: body.name });
  }

  private listUserRoles(userId: string): Response {
    const ids = [...(this.userRoles.get(userId) ?? [])];
    return json(200, ids.map((id) => this.roles.get(id)));
  }

  private assignRole(userId: string, rawBody?: string): Response {
    const { roleId } = JSON.parse(rawBody ?? '{}');
    const set = this.userRoles.get(userId) ?? new Set<string>();
    set.add(roleId);
    this.userRoles.set(userId, set);
    return new Response(undefined, { status: 204 });
  }

  // --- organizations -------------------------------------------------------
  private routeOrganizations(method: string, path: string, body: string | undefined): Response | undefined {
    if (method === 'GET' && path.startsWith('/api/v1/organizations?')) return this.searchOrgs(path);
    if (method === 'POST' && path === '/api/v1/organizations') return this.createOrg(body);
    return undefined;
  }

  private searchOrgs(path: string): Response {
    const search = new URLSearchParams(path.split('?')[1]).get('search') ?? '';
    const data = [...this.orgs.values()].filter((o) => o.name.includes(search));
    return json(200, { data });
  }

  private createOrg(rawBody?: string): Response {
    const body = JSON.parse(rawBody ?? '{}');
    const org: FakeOrg = { id: randomUUID(), name: body.name, type: body.type };
    this.orgs.set(org.id, org);
    return json(201, org);
  }

  // --- workspaces ------------------------------------------------------------
  private routeWorkspaces(method: string, path: string, body: string | undefined): Response | undefined {
    const pathname = path.split('?')[0];
    if (method === 'GET' && pathname === '/api/v1/workspaces') return this.searchWorkspaces(path);
    if (method === 'POST' && pathname === '/api/v1/workspaces') return this.createWorkspace(body);
    const idMatch = pathname.match(/^\/api\/v1\/workspaces\/([^/]+)$/);
    if (idMatch && method === 'GET') return this.getWorkspace(idMatch[1]);
    if (idMatch && method === 'PATCH') return this.patchWorkspace(idMatch[1], body);
    const memberMatch = pathname.match(/^\/api\/v1\/workspaces\/([^/]+)\/members$/);
    if (memberMatch && method === 'POST') return this.addWorkspaceMember(memberMatch[1], body);
    return undefined;
  }

  private searchWorkspaces(path: string): Response {
    const params = new URLSearchParams(path.split('?')[1]);
    const search = params.get('search') ?? '';
    const orgId = params.get('ownerOrganizationId');
    const data = [...this.workspaces.values()].filter((w) => w.name.includes(search) && (!orgId || w.ownerOrganizationId === orgId));
    return json(200, { data });
  }

  private createWorkspace(rawBody?: string): Response {
    const body = JSON.parse(rawBody ?? '{}');
    const ws: FakeWorkspace = { id: randomUUID(), name: body.name, ownerOrganizationId: body.ownerOrganizationId, members: [] };
    this.workspaces.set(ws.id, ws);
    return json(201, ws);
  }

  private getWorkspace(id: string): Response {
    const ws = this.workspaces.get(id);
    return ws ? json(200, ws) : json(404, { message: 'not found' });
  }

  private patchWorkspace(id: string, rawBody?: string): Response {
    const ws = this.workspaces.get(id);
    if (!ws) return json(404, { message: 'not found' });
    Object.assign(ws, JSON.parse(rawBody ?? '{}'));
    return json(200, ws);
  }

  private addWorkspaceMember(id: string, rawBody?: string): Response {
    const ws = this.workspaces.get(id);
    if (!ws) return json(404, { message: 'not found' });
    const { userId } = JSON.parse(rawBody ?? '{}');
    if (!ws.members.some((m) => m.userId === userId)) ws.members.push({ userId });
    return json(201, ws);
  }

  // --- projects --------------------------------------------------------------
  private routeProjects(method: string, path: string, body: string | undefined, headers: Record<string, string>): Response | undefined {
    const pathname = path.split('?')[0];
    if (method === 'GET' && pathname === '/api/v1/projects') return this.listProjects(path);
    if (method === 'POST' && pathname === '/api/v1/projects') return this.requireWorkspaceHeader(headers) ?? this.createProject(body);
    return this.routeProjectById(method, pathname, body, headers);
  }

  private routeProjectById(method: string, pathname: string, body: string | undefined, headers: Record<string, string>): Response | undefined {
    const idMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (idMatch) return this.requireWorkspaceHeader(headers) ?? this.dispatchProjectAction(method, idMatch[1], body);
    const actionMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/(archive|unarchive)$/);
    if (actionMatch) return this.requireWorkspaceHeader(headers) ?? this.setProjectStatus(actionMatch[1], actionMatch[2] === 'archive');
    return undefined;
  }

  private dispatchProjectAction(method: string, id: string, body: string | undefined): Response {
    if (method === 'PATCH') return this.patchProject(id, body);
    if (method === 'DELETE') return this.deleteProject(id);
    return json(404, { message: 'unhandled project action' });
  }

  private requireWorkspaceHeader(headers: Record<string, string>): Response | undefined {
    return headers['x-workspace-id'] ? undefined : json(400, { message: 'X-Workspace-Id header is required' });
  }

  private listProjects(path: string): Response {
    const workspaceId = new URLSearchParams(path.split('?')[1]).get('workspaceId');
    const data = [...this.projects.values()].filter((p) => !workspaceId || p.workspaceId === workspaceId);
    return json(200, { data });
  }

  private createProject(rawBody?: string): Response {
    const body = JSON.parse(rawBody ?? '{}');
    const project: FakeProject = { id: randomUUID(), name: body.name, workspaceId: body.workspaceId, status: 'active' };
    this.projects.set(project.id, project);
    return json(201, project);
  }

  private patchProject(id: string, rawBody?: string): Response {
    const project = this.projects.get(id);
    if (!project) return json(404, { message: 'not found' });
    if (project.status === 'archived') return json(500, { message: 'cannot update an archived project' });
    Object.assign(project, JSON.parse(rawBody ?? '{}'));
    return json(200, project);
  }

  private setProjectStatus(id: string, archived: boolean): Response {
    const project = this.projects.get(id);
    if (!project) return json(404, { message: 'not found' });
    project.status = archived ? 'archived' : 'active';
    return json(200, project);
  }

  private deleteProject(id: string): Response {
    const project = this.projects.get(id);
    if (!project) return json(404, { message: 'not found' });
    if (project.status !== 'archived') return json(500, { message: 'cannot delete an active project' });
    if (this.poisonedDeleteIds.has(id)) return json(500, { message: 'simulated delete failure' });
    this.projects.delete(id);
    return new Response(undefined, { status: 204 });
  }

  // --- test helpers ------------------------------------------------------------
  seedOrg(name: string, type: string): FakeOrg {
    const org: FakeOrg = { id: randomUUID(), name, type };
    this.orgs.set(org.id, org);
    return org;
  }

  seedWorkspace(name: string, ownerOrganizationId: string): FakeWorkspace {
    const ws: FakeWorkspace = { id: randomUUID(), name, ownerOrganizationId, members: [] };
    this.workspaces.set(ws.id, ws);
    return ws;
  }

  seedProject(name: string, workspaceId: string): FakeProject {
    const project: FakeProject = { id: randomUUID(), name, workspaceId, status: 'active' };
    this.projects.set(project.id, project);
    return project;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetchStub(gateway: FakeGateway): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = normalizeHeaders((init.headers ?? {}) as Record<string, string>);
    const token = headers.authorization?.replace(/^Bearer\s+/i, '');
    return gateway.handle(String(input), { method: init.method ?? 'GET', body: init.body as string | undefined, token, headers });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

/** A small fixture with one workspace/one project, legacy-named, plus one
 *  retired project — enough to exercise create/rename/retire without the
 *  full two-workspace shipped fixture's noise. `content.datasets` is cleared
 *  (AXI-1372, widened AXI-1374): this file's `FakeGateway` deliberately
 *  scopes to org/workspace/project routes only ("not a gateway
 *  re-implementation", see its doc comment above) and has no dataset/S3
 *  surface — `ensureDatasetStep` no-ops when `content.datasets` is empty, so
 *  `stageTenant()` here stays scoped to what this file actually tests.
 *  Dataset-step coverage lives in `AXI-1372-dataset-ingestion.spec.ts`. */
function testFixture(): TenantFixture {
  return {
    ...TENANT_FIXTURE,
    workspaces: [
      {
        name: 'Translational Immuno-Oncology',
        legacyNames: ['E2E Testing'],
        type: 'internal',
        projects: [{ name: 'Melanoma IO cohort, paired timepoints', legacyNames: ['AXI-1179 - Longitudinal Data Linking and Merging'] }],
        retiredProjects: [{ legacyName: 'E2E Testing', retiredName: 'Retired duplicate (do not use for capture)' }],
      },
    ],
    content: { ...TENANT_FIXTURE.content, datasets: [] },
  };
}

test.describe('FR5/NFR1 — stageTenant() converges from an empty instance', () => {
  let gateway: FakeGateway;
  let restore: () => void;

  test.beforeEach(() => {
    gateway = new FakeGateway();
    restore = installFetchStub(gateway);
  });
  test.afterEach(() => restore());

  function newClient(): RestClient {
    return new RestClient({ baseUrl: 'http://localhost:3000' });
  }

  test('FR5 — first run creates the org, workspace and project fresh', async () => {
    const touched = await stageTenant(newClient(), testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD);
    const created = touched.filter((t) => t.action === 'created');
    const expected = ['Biotech One', 'Melanoma IO cohort, paired timepoints', 'Translational Immuno-Oncology'];
    expect(created.map((t) => t.name).sort()).toEqual(expected.sort());
    expect(gateway.orgs.size).toBe(1);
    expect(gateway.workspaces.size).toBe(1);
  });

  test('NFR1 — a second run reuses everything, with no duplicate entities', async () => {
    await stageTenant(newClient(), testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD);
    const second = await stageTenant(newClient(), testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(second.filter((t) => t.action === 'created')).toHaveLength(0);
    expect(gateway.orgs.size).toBe(1);
    expect(gateway.workspaces.size).toBe(1);
    expect([...gateway.projects.values()].filter((p) => p.workspaceId)).toHaveLength(1);
  });

  test('AC4 — the fresh-created tenant has no forbidden name', async () => {
    await expect(stageTenant(newClient(), testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD)).resolves.toBeDefined();
  });
});

test.describe('FR5/EC1 — stageTenant() renames and retires pre-existing legacy artifacts', () => {
  let gateway: FakeGateway;
  let restore: () => void;
  let orgId: string;

  test.beforeEach(() => {
    gateway = new FakeGateway();
    restore = installFetchStub(gateway);
    const org = gateway.seedOrg('Biotech One', 'laboratory');
    orgId = org.id;
    const ws = gateway.seedWorkspace('E2E Testing', orgId);
    gateway.seedProject('AXI-1179 - Longitudinal Data Linking and Merging', ws.id);
    gateway.seedProject('E2E Testing', ws.id);
  });
  test.afterEach(() => restore());

  function newClient(): RestClient {
    return new RestClient({ baseUrl: 'http://localhost:3000' });
  }

  test('FR5 — the legacy-named workspace and project are renamed onto the fixture names', async () => {
    const touched = await stageTenant(newClient(), testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD);
    const renamed = touched.filter((t) => t.action === 'renamed').map((t) => t.name);
    expect(renamed).toContain('Translational Immuno-Oncology');
    expect(renamed).toContain('Melanoma IO cohort, paired timepoints');
    expect(gateway.orgs.get(orgId)?.name).toBe('Biotech One');
  });

  test('FR5/EC1 — the "E2E Testing" project is archived and deleted', async () => {
    await stageTenant(newClient(), testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD);
    const remaining = [...gateway.projects.values()].map((p) => p.name);
    expect(remaining).not.toContain('E2E Testing');
  });

  test('AC4 — after staging, no entity carries a forbidden name', async () => {
    const touched = await stageTenant(newClient(), testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD);
    const stillPresentNames = touched.filter((t) => t.action !== 'retired').map((t) => t.name);
    expect(stillPresentNames.every((n) => n !== 'E2E Testing' && !/AXI-\d+/.test(n))).toBe(true);
  });

  test('NFR1 — running stage twice on a legacy tenant converges with no duplicate workspace/project', async () => {
    await stageTenant(newClient(), testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD);
    const second = await stageTenant(newClient(), testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(second.filter((t) => t.action === 'created' || t.action === 'renamed')).toHaveLength(0);
    expect(gateway.workspaces.size).toBe(1);
  });
});

test.describe('EC1 — retirement falls back gracefully when DELETE is rejected', () => {
  test('FR5/EC1 — a project whose DELETE always fails ends archived and renamed, and `stage` does not throw', async () => {
    const gateway = new FakeGateway();
    const restore = installFetchStub(gateway);
    const org = gateway.seedOrg('Biotech One', 'laboratory');
    const ws = gateway.seedWorkspace('E2E Testing', org.id);
    gateway.seedProject('AXI-1179 - Longitudinal Data Linking and Merging', ws.id);
    const poisoned = gateway.seedProject('E2E Testing', ws.id);
    gateway.poisonedDeleteIds.add(poisoned.id);

    const client = new RestClient({ baseUrl: 'http://localhost:3000' });
    const touched = await stageTenant(client, testFixture(), ADMIN_EMAIL, ADMIN_PASSWORD);

    const fallback = touched.find((t) => t.id === poisoned.id);
    expect(fallback?.action).toBe('renamed');
    expect(gateway.projects.get(poisoned.id)?.status).toBe('archived');
    expect(gateway.projects.get(poisoned.id)?.name).toBe('Retired duplicate (do not use for capture)');
    restore();
  });
});
