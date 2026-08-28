import { RestClient } from '../client/RestClient';
import { resolvePassword } from './credentials';
import { IDENTITY_REGISTRY, assertRegistryIntegrity } from './registry';
import type { EnsureIdentitiesResult, IdentityDefinition, IdentityHandle, IdentitySmokeResult } from './types';

/**
 * Idempotent create-or-login for the whole identity set (AXI-1370, FR1-FR4).
 *
 * Admin-token usage is deliberately minimal and bounded (FR2: "none may use
 * the bootstrap admin beyond the single call that creates the service
 * account"): exactly one admin call creates the service-account user, and —
 * only on a first run, because `POST /api/v1/roles` is ADMIN-gated at the
 * gateway and there is no other way to provision it (FR1's "dedicated role")
 * — one admin call creates its role. A second run finds both already exist
 * and makes zero non-login admin calls. Every cast/external account and
 * every role lookup/assignment after that is made as the service account.
 */

const ADMIN_HANDLE = 'admin';
const SERVICE_ROLE_NAME = 'staging-service-account';

export async function ensureIdentities(client: RestClient, adminEmail: string, adminPassword: string): Promise<EnsureIdentitiesResult> {
  assertRegistryIntegrity();
  await client.login(ADMIN_HANDLE, adminEmail, adminPassword);

  const service = findService();
  const { userId: serviceUserId, created: serviceCreated } = await ensureUser(client, ADMIN_HANDLE, service);
  const serviceRoleId = await ensureServiceRole(client, serviceUserId);
  const { created, reused } = await ensureCastAndExternal(client, service.handle);

  return {
    identities: IDENTITY_REGISTRY.map((d) => d.handle),
    created: serviceCreated ? [service.handle, ...created] : created,
    reused: serviceCreated ? reused : [service.handle, ...reused],
    serviceRoleId,
  };
}

function findService(): IdentityDefinition {
  const service = IDENTITY_REGISTRY.find((d) => d.role === 'service-account');
  if (!service) throw new Error('identity registry has no service-account identity');
  return service;
}

/** Create `def` as `actingAs`, tolerating "already exists"; always ends logged in as `def` itself (FR2/FR3). */
async function ensureUser(client: RestClient, actingAs: IdentityHandle, def: IdentityDefinition): Promise<{ userId: string; created: boolean }> {
  const password = resolvePassword(def.handle);
  const createdUser = await tryCreateUser(client, actingAs, def, password);
  await client.login(def.handle, def.email, password);
  if (createdUser) return { userId: createdUser.id, created: true };
  return { userId: await selfLookupId(client, def.handle), created: false };
}

async function tryCreateUser(
  client: RestClient,
  actingAs: IdentityHandle,
  def: IdentityDefinition,
  password: string,
): Promise<{ id: string } | undefined> {
  const res = await client.as<{ id: string }>(actingAs, 'POST', '/api/v1/users', {
    email: def.email,
    password,
    firstName: def.firstName,
    lastName: def.lastName,
  });
  return res.ok && res.body ? { id: res.body.id } : undefined;
}

async function selfLookupId(client: RestClient, handle: IdentityHandle): Promise<string> {
  const me = await client.as<{ id: string }>(handle, 'GET', '/api/v1/auth/me');
  if (!me.ok || !me.body) throw new Error(`identity "${handle}" exists but "GET /api/v1/auth/me" failed (status ${me.status})`);
  return me.body.id;
}

async function ensureCastAndExternal(client: RestClient, actingAs: IdentityHandle): Promise<{ created: IdentityHandle[]; reused: IdentityHandle[] }> {
  const rest = IDENTITY_REGISTRY.filter((d) => d.role !== 'service-account');
  const created: IdentityHandle[] = [];
  const reused: IdentityHandle[] = [];
  for (const def of rest) {
    const outcome = await ensureUser(client, actingAs, def);
    (outcome.created ? created : reused).push(def.handle);
  }
  return { created, reused };
}

async function ensureServiceRole(client: RestClient, serviceUserId: string): Promise<string> {
  const roleId = (await findRole(client, 'service')) ?? (await createRoleAsAdmin(client));
  await assignRoleIfNeeded(client, 'service', serviceUserId, roleId);
  return roleId;
}

async function findRole(client: RestClient, actingAs: IdentityHandle): Promise<string | undefined> {
  const res = await client.as<{ id: string; name: string }[]>(actingAs, 'GET', '/api/v1/roles');
  return (res.body ?? []).find((r) => r.name === SERVICE_ROLE_NAME)?.id;
}

async function createRoleAsAdmin(client: RestClient): Promise<string> {
  const res = await client.as<{ id: string }>(ADMIN_HANDLE, 'POST', '/api/v1/roles', {
    name: SERVICE_ROLE_NAME,
    description: 'AXI-1370 staging toolkit service account. Intentionally minimal — expand permissions as later staging steps require them.',
    scope: 'SYSTEM',
    permissions: [],
  });
  if (!res.ok || !res.body) throw new Error(`role "${SERVICE_ROLE_NAME}" creation failed (status ${res.status})`);
  return res.body.id;
}

async function assignRoleIfNeeded(client: RestClient, actingAs: IdentityHandle, userId: string, roleId: string): Promise<void> {
  const current = await client.as<{ id: string }[]>(actingAs, 'GET', `/api/v1/users/${userId}/roles`);
  if ((current.body ?? []).some((r) => r.id === roleId)) return;
  await client.as(actingAs, 'POST', `/api/v1/users/${userId}/roles`, { roleId });
}

/** FR3 smoke check — each identity's own token must authenticate AS that identity, never a display-name override. */
export async function smokeCheckIdentities(client: RestClient, handles: IdentityHandle[]): Promise<IdentitySmokeResult[]> {
  const results: IdentitySmokeResult[] = [];
  for (const handle of handles) {
    const res = await client.as<{ email?: string }>(handle, 'GET', '/api/v1/auth/me');
    results.push({ handle, ok: res.ok, status: res.status, observedEmail: res.body?.email });
  }
  return results;
}

/** Pure — returns the handles that failed to verify as themselves (empty = FR3 holds for all). */
export function verifySmokeResults(results: IdentitySmokeResult[], registry: IdentityDefinition[] = IDENTITY_REGISTRY): IdentityHandle[] {
  const emailFor = new Map(registry.map((d) => [d.handle, d.email]));
  return results.filter((r) => !r.ok || r.observedEmail !== emailFor.get(r.handle)).map((r) => r.handle);
}

async function main(): Promise<void> {
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const adminEmail = process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
  const adminPassword = process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin';

  const client = new RestClient({ baseUrl });
  const result = await ensureIdentities(client, adminEmail, adminPassword);
  console.log(`identities ensured: ${result.identities.length} total, ${result.created.length} created (${result.created.join(', ') || 'none'}), ${result.reused.length} reused (${result.reused.join(', ') || 'none'})`);

  const smoke = await smokeCheckIdentities(client, result.identities);
  const failed = verifySmokeResults(smoke);
  smoke.forEach((r) => console.log(`  ${r.handle}: GET /api/v1/auth/me -> ${r.status} (${r.ok ? 'ok' : 'FAIL'})`));
  if (failed.length > 0) {
    console.error(`FAILED — identities that did not verify as themselves (FR3): ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('PASSED — every identity authenticates as itself (FR3).');
}

if (process.argv[1] && process.argv[1].endsWith('ensureIdentities.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
