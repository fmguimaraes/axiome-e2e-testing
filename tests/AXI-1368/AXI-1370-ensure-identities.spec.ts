import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { RestClient } from '../../staging/client/RestClient';
import { ensureIdentities, smokeCheckIdentities, verifySmokeResults } from '../../staging/identities/ensureIdentities';
import { IDENTITY_REGISTRY } from '../../staging/identities/registry';
import type { RestCallLog } from '../../staging/client/types';

/**
 * AXI-1370 — ensureIdentities idempotent create-or-login (FR1/FR2/FR3),
 * mocked at the HTTP boundary (`global.fetch`) per the story's testing
 * instruction — no live stack in this file. Manual-E2E §AXI-1368 §5.2.
 *
 * @SI-044.
 */

interface FakeUser {
  id: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

/** A minimal in-memory stand-in for the gateway's users/auth/roles routes — just enough surface for ensureIdentities()'s calls. */
class FakeGateway {
  private users = new Map<string, FakeUser>(); // by email
  private tokens = new Map<string, string>(); // token -> email
  private roles = new Map<string, { id: string; name: string }>();
  private userRoles = new Map<string, Set<string>>(); // userId -> roleIds

  async handle(url: string, init: { method: string; body?: string; token?: string }): Promise<Response> {
    const path = new URL(url).pathname;
    const method = init.method;
    if (method === 'POST' && path === '/api/v1/auth/login') return this.login(init.body);
    if (method === 'POST' && path === '/api/v1/users') return this.createUser(init.body);
    if (method === 'GET' && path === '/api/v1/auth/me') return this.me(init.token);
    if (method === 'GET' && path === '/api/v1/roles') return json(200, [...this.roles.values()]);
    if (method === 'POST' && path === '/api/v1/roles') return this.createRole(init.body);
    const rolesAssign = path.match(/^\/api\/v1\/users\/([^/]+)\/roles$/);
    if (rolesAssign && method === 'GET') return this.listUserRoles(rolesAssign[1]);
    if (rolesAssign && method === 'POST') return this.assignRole(rolesAssign[1], init.body);
    return json(404, { message: `unhandled route in FakeGateway: ${method} ${path}` });
  }

  seedAdmin(email: string, password: string): void {
    const id = randomUUID();
    this.users.set(email, { id, email, password, firstName: 'Admin', lastName: 'Bootstrap' });
  }

  /** Risk B repro: a user that already exists on the "server" with a password
   *  the credential store no longer remembers (e.g. the store was destroyed
   *  and just generated a fresh one). */
  seedExisting(email: string, password: string, firstName: string, lastName: string): void {
    const id = randomUUID();
    this.users.set(email, { id, email, password, firstName, lastName });
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
    this.users.set(body.email, { id, email: body.email, password: body.password, firstName: body.firstName, lastName: body.lastName });
    return json(201, { id, email: body.email, firstName: body.firstName, lastName: body.lastName, role: 'USER', status: 'ACTIVE' });
  }

  me(token: string | undefined): Response {
    const email = token ? this.tokens.get(token) : undefined;
    const user = email ? this.users.get(email) : undefined;
    if (!user) return json(401, { message: 'unauthenticated' });
    return json(200, { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: 'USER', status: 'ACTIVE' });
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

  countAdminAuthenticatedCalls(logs: RestCallLog[]): number {
    return logs.filter((l) => l.identity === 'admin').length;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetchStub(gateway: FakeGateway): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = headers.authorization?.replace(/^Bearer\s+/i, '');
    return gateway.handle(String(input), { method: init.method ?? 'GET', body: init.body as string | undefined, token });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const ADMIN_EMAIL = 'admin@axiome.local';
const ADMIN_PASSWORD = 'admin';

// `ensureIdentities` -> `ensureUser` -> `resolvePassword(handle)` reads/writes
// the REAL credential store when called with no overrides, and that store now
// defaults to `~/.axiome/staging` (Risk B fix) — a path that outlives every
// worktree ON PURPOSE, including a real live `stage:identities` run against
// this developer's machine. Without isolating it here, these mocked tests
// would read and write that same real file, corrupting both the tests and any
// live run. Point `STAGING_AUTH_DIR` at a throwaway temp dir for every test in
// this file and restore whatever was there before.
let previousAuthDir: string | undefined;
let tempAuthDir: string;

test.beforeEach(() => {
  previousAuthDir = process.env.STAGING_AUTH_DIR;
  tempAuthDir = mkdtempSync(join(tmpdir(), 'axi-1370-ensure-identities-'));
  process.env.STAGING_AUTH_DIR = tempAuthDir;
});

test.afterEach(() => {
  rmSync(tempAuthDir, { recursive: true, force: true });
  if (previousAuthDir === undefined) delete process.env.STAGING_AUTH_DIR;
  else process.env.STAGING_AUTH_DIR = previousAuthDir;
});

test.describe('FR1 FR2 — ensureIdentities() is idempotent and bounds bootstrap-admin usage', () => {
  let gateway: FakeGateway;
  let restore: () => void;
  const logs: RestCallLog[] = [];

  test.beforeEach(() => {
    gateway = new FakeGateway();
    gateway.seedAdmin(ADMIN_EMAIL, ADMIN_PASSWORD);
    restore = installFetchStub(gateway);
    logs.length = 0;
  });

  test.afterEach(() => restore());

  function newClient(): RestClient {
    return new RestClient({ baseUrl: 'http://localhost:3000', onCall: (log) => logs.push(log) });
  }

  test('FR1 — first run creates all five identities and a service role', async () => {
    const client = newClient();
    const result = await ensureIdentities(client, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(result.identities).toHaveLength(5);
    expect(result.created.sort()).toEqual(IDENTITY_REGISTRY.map((d) => d.handle).sort());
    expect(result.reused).toHaveLength(0);
    expect(result.serviceRoleId).toBeTruthy();
  });

  test('FR2 — first run makes exactly two bootstrap-admin-authenticated calls (create service user, create role)', async () => {
    const client = newClient();
    await ensureIdentities(client, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(gateway.countAdminAuthenticatedCalls(logs)).toBe(2);
  });

  test('NFR1 — a second run reuses every identity and the role, with no duplicates and no error', async () => {
    await ensureIdentities(newClient(), ADMIN_EMAIL, ADMIN_PASSWORD);
    logs.length = 0;
    const second = await ensureIdentities(newClient(), ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(second.created).toHaveLength(0);
    expect(second.reused.sort()).toEqual(IDENTITY_REGISTRY.map((d) => d.handle).sort());
  });

  test('FR2 — a second run makes at most one bootstrap-admin-authenticated call (the create-user attempt)', async () => {
    await ensureIdentities(newClient(), ADMIN_EMAIL, ADMIN_PASSWORD);
    logs.length = 0;
    await ensureIdentities(newClient(), ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(gateway.countAdminAuthenticatedCalls(logs)).toBeLessThanOrEqual(1);
  });

  test('FR3 — every identity smoke-checks as itself via GET /api/v1/auth/me', async () => {
    const client = newClient();
    const result = await ensureIdentities(client, ADMIN_EMAIL, ADMIN_PASSWORD);
    const smoke = await smokeCheckIdentities(client, result.identities);
    expect(verifySmokeResults(smoke)).toHaveLength(0);
  });

  test('FR3 — verifySmokeResults flags an identity whose observed email does not match the registry', () => {
    const bad = [{ handle: 'service', ok: true, status: 200, observedEmail: 'someone-else@axiome.local' }];
    expect(verifySmokeResults(bad)).toEqual(['service']);
  });
});

test.describe('Risk B (AXI-1371 handover) — a pre-existing identity with a mismatched password fails loudly', () => {
  let gateway: FakeGateway;
  let restore: () => void;

  test.beforeEach(() => {
    gateway = new FakeGateway();
    gateway.seedAdmin(ADMIN_EMAIL, ADMIN_PASSWORD);
    restore = installFetchStub(gateway);
  });

  test.afterEach(() => restore());

  test('rejects with a targeted diagnosis instead of silently drifting past a stale-store 401', async () => {
    // Simulate the exact drift: the server already has "service" from a prior
    // run, at a password the (now-destroyed) store no longer remembers —
    // resolvePassword() with no env/store override generates a fresh, WRONG one.
    gateway.seedExisting('staging-service@axiome.local', 'password-the-server-actually-has', 'Staging', 'Service');
    const client = new RestClient({ baseUrl: 'http://localhost:3000' });

    await expect(ensureIdentities(client, ADMIN_EMAIL, ADMIN_PASSWORD)).rejects.toThrow(
      /identity "service".*already exists on the server.*Risk B.*PATCH \/api\/v1\/users\/:id/s,
    );
  });
});
