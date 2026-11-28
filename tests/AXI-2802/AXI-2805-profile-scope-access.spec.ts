import { execFileSync, spawnSync } from 'child_process';
import { expect, test, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';

/**
 * AXI-2805 (epic AXI-2802 — Semantic Profile Management, area A3): profile scope, organization
 * access and permissions. Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md`
 * § AXI-2805 (4.1–4.5, 5.1–5.5, §6).
 *
 * E2E CONTRACT — an A/B over the REAL gateway, API level, as `admin@cro-one.com` only:
 *   - REFERENCE = `REF_API_BASE_URL` (default `http://localhost:3000`, the shared demo = `main`);
 *   - STORY     = `API_BASE_URL`: the branch's sidecar (`E2E_2805_SIDECAR`, default
 *     `axiome-2805-backend`) whose organization AND user databases are the THROWAWAY
 *     `E2E_2805_DB` (default `axiome_axi2805`): a `pg_dump` of the demo `organization_svc` +
 *     `user_svc`, migrated by the branch and cut over at its boot.
 * Reads that `main` also answers must be equal on both stacks. Writes go to the story stack only.
 * SQL writes run only against `E2E_2805_DB` (must start `axiome_axi2805`); the demo database is
 * read once, in a READ ONLY transaction (5.4). "Another organization" is played by admin in a
 * workspace whose owner organization does not own the profile; "without the right" by pointing
 * admin's membership `role_id` — in the throwaway database only — at a role lacking it.
 */

const REF_API_BASE_URL = (process.env.REF_API_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = process.env.E2E_2805_EMAIL?.trim() || 'admin@cro-one.com';
const PASSWORD = process.env.E2E_2805_PASSWORD?.trim() || 'admin';
const SIDECAR = process.env.E2E_2805_SIDECAR?.trim() || 'axiome-2805-backend';
const STORY_DB = process.env.E2E_2805_DB?.trim() || 'axiome_axi2805';
const DEMO_DB = process.env.E2E_2805_DEMO_DB?.trim() || 'axiome';
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'axiome-localhost';
const GRANT_MIGRATION = '/app/apps/user-service/src/prisma/migrations/20261128150000_grant_semantic_profile_permissions/migration.sql';

if (!/^axiome_axi2805[a-z0-9_]*$/.test(STORY_DB)) throw new Error(`E2E_2805_DB must name a throwaway axiome_axi2805* database, got ${STORY_DB}`);
if (REF_API_BASE_URL === API_BASE_URL) throw new Error('AXI-2805 is an A/B: API_BASE_URL must be the story sidecar, not the reference stack');

const WS_A = '8946e06a-4fe6-45ee-8d9a-58f7142e803a'; // Mag4
const WS_B = '81bc7740-7dd0-45d6-9b8e-b7fdef861078'; // Public Datasets — IO Benchmarks
const FIVE = ['immune_mediated', 'immune_mediated_microbiota', 'immuno_oncology', 'immunology', 'oncology'];
const INVESTIGATOR_ROLE = '00000000-0000-0000-0000-000000000105';
const PROJECT_PREFIX = 'E2E AXI-2805';
const RUN = Date.now().toString(36);
const OWNER_KEY = `e2e_2805_owner_${RUN}`;
const FOREIGN_KEY = `e2e_2805_foreign_${RUN}`;
const UNKNOWN_KEY = `e2e_2805_nosuch_${RUN}`;
const P = '/api/v1/semantic-profiles';

interface Stack { name: string; base: string; api: APIRequestContext }
let ref: Stack;
let story: Stack;
let adminId: string;
let orgA: string;
let orgB: string;
let memberB: { id: string; roleId: string; role: string; organizationId: string };
const createdProjects: string[] = [];
const createdRoles: string[] = [];
const startedAt = new Date().toISOString();

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

function sql(statement: string): string[] {
  if (!STORY_DB.startsWith('axiome_axi2805')) throw new Error(`refusing SQL on ${STORY_DB}`);
  const out = execFileSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'axiome', '-d', STORY_DB, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { stdio: 'pipe' }).toString();
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function sqlRefused(statement: string): string {
  const run = spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'axiome', '-d', STORY_DB, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf-8' });
  expect(run.status, `expected a refusal: ${statement}`).not.toBe(0);
  return run.stderr;
}

/** The demo database, in a READ ONLY transaction (never written). */
function demoReadOnly(select: string): string[] {
  const out = execFileSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'axiome', '-d', DEMO_DB, '-v', 'ON_ERROR_STOP=1', '-At', '-c', `BEGIN READ ONLY; ${select}; ROLLBACK;`], { stdio: 'pipe' }).toString();
  return out.split('\n').map((l) => l.trim()).filter((l) => l && l !== 'BEGIN' && l !== 'ROLLBACK');
}

const lit = (v: string) => {
  if (!/^[A-Za-z0-9_.:@ -]+$/.test(v)) throw new Error(`unsafe literal: ${v}`);
  return `'${v}'`;
};

async function open(name: string, base: string): Promise<Stack> {
  const bootstrap = await apiRequest.newContext();
  const res = await bootstrap.post(`${base}/api/v1/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  expect(res.ok(), `${name} login → ${res.status()}`).toBeTruthy();
  const { accessToken } = await res.json();
  await bootstrap.dispose();
  return { name, base, api: await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } }) };
}

interface Answer { status: number; body: any }
async function call(s: Stack, method: 'GET' | 'PUT' | 'DELETE' | 'POST' | 'PATCH', path: string, ws: string, data?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await s.api.fetch(`${s.base}${path}`, { method, headers: { 'X-Workspace-Id': ws, ...headers }, ...(data === undefined ? {} : { data }) });
  const raw = await res.text();
  let body: any = raw;
  try { body = JSON.parse(raw); } catch { /* text */ }
  return { status: res.status(), body };
}

async function ok<T = any>(s: Stack, method: 'GET' | 'PUT' | 'DELETE' | 'POST' | 'PATCH', path: string, ws: string, data?: unknown): Promise<T> {
  const a = await call(s, method, path, ws, data);
  expect(a.status, `${s.name} ${method} ${path}: ${JSON.stringify(a.body)}`).toBeLessThan(300);
  return a.body as T;
}

const ids = (list: { id: string }[]) => list.map((p) => p.id);

async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, withinMs = 6_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() - start > withinMs) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** An organization profile copied from `immunology`'s latest version under a new key (no create route before A8). */
function insertOrganizationProfile(key: string, organizationId: string): void {
  sql(
    `WITH p AS (INSERT INTO organization_svc.semantic_profiles (id, key, scope, organization_id, display_name, origin, created_by, updated_at) ` +
      `VALUES (gen_random_uuid()::text, ${lit(key)}, 'organization', ${lit(organizationId)}, ${lit(`E2E 2805 ${key}`)}, 'authored', 'e2e:axi-2805', now()) RETURNING id), ` +
      `src AS (SELECT v.* FROM organization_svc.semantic_profile_versions v JOIN organization_svc.semantic_profiles s ON s.id = v.profile_id WHERE s.key = 'immunology' ORDER BY v.created_at DESC LIMIT 1) ` +
      `INSERT INTO organization_svc.semantic_profile_versions (id, profile_id, version, manifest_json, registries_json, content_identity, authored_by) ` +
      `SELECT gen_random_uuid()::text, p.id, src.version, jsonb_set(src.manifest_json::jsonb, '{profile_id}', to_jsonb(${lit(key)}::text))::text, src.registries_json, src.content_identity, 'e2e:axi-2805' FROM p, src`,
  );
}

function setMembership(fields: { roleId?: string; organizationId?: string }): void {
  const sets = [fields.roleId ? `role_id = ${lit(fields.roleId)}` : '', fields.organizationId ? `organization_id = ${lit(fields.organizationId)}` : ''].filter(Boolean).join(', ');
  sql(`UPDATE organization_svc.workspace_members SET ${sets} WHERE id = ${lit(memberB.id)}`);
}

function restoreMembership(): void {
  sql(`UPDATE organization_svc.workspace_members SET role_id = ${lit(memberB.roleId)}, role = ${lit(memberB.role)}, organization_id = ${lit(memberB.organizationId)} WHERE id = ${lit(memberB.id)}`);
}

function createRole(name: string, permissions: string[]): string {
  const [id] = sql(
    `INSERT INTO user_svc.roles (id, name, description, permissions, scope, updated_at, created_by) VALUES (gen_random_uuid()::text, ${lit(name)}, 'AXI-2805 E2E', '${JSON.stringify(permissions)}'::jsonb, 'WORKSPACE', now(), 'e2e:axi-2805') RETURNING id`,
  );
  createdRoles.push(id);
  return id;
}

function dropCreatedRoles(): void {
  while (createdRoles.length) sql(`DELETE FROM user_svc.roles WHERE id = ${lit(createdRoles.pop()!)}`);
}

async function createProject(label: string, profile: { semanticProfileId?: string | null }): Promise<Answer> {
  const a = await call(story, 'POST', '/api/v1/projects', WS_B, { name: `${PROJECT_PREFIX} ${label} ${RUN}`, workspaceId: WS_B, ...profile });
  if (a.status === 201) createdProjects.push(a.body.id);
  return a;
}

const defaultsOf = (organizationId: string) => sql(
  `SELECT p.key FROM organization_svc.organization_semantic_profile_defaults d JOIN organization_svc.semantic_profiles p ON p.id = d.profile_id WHERE d.organization_id = ${lit(organizationId)} ORDER BY d.position`,
);

// ─── suite ───────────────────────────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(async () => {
  ref = await open('reference', REF_API_BASE_URL);
  story = await open('story', API_BASE_URL);
  [adminId] = sql(`SELECT id FROM user_svc.users WHERE email = ${lit(EMAIL)}`);
  [orgA] = sql(`SELECT owner_organization_id FROM organization_svc.workspaces WHERE id = ${lit(WS_A)}`);
  [orgB] = sql(`SELECT owner_organization_id FROM organization_svc.workspaces WHERE id = ${lit(WS_B)}`);
  const [row] = sql(`SELECT id || '|' || role_id || '|' || role || '|' || organization_id FROM organization_svc.workspace_members WHERE workspace_id = ${lit(WS_B)} AND user_id = ${lit(adminId)}`);
  const [id, roleId, role, organizationId] = row.split('|');
  memberB = { id, roleId, role, organizationId };
});

test.afterAll(async () => {
  if (memberB) restoreMembership();
  if (story) {
    await call(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: [] });
    for (const key of FIVE) await call(story, 'PUT', `${P}/access/${key}`, WS_B);
    for (const id of createdProjects) await call(story, 'DELETE', `/api/v1/projects/${id}`, WS_B);
  }
  // Organization profiles cannot be deleted from under their audit trail: archive them (not served, not listed).
  sql(`UPDATE organization_svc.semantic_profiles SET archived_at = now(), updated_at = now() WHERE key LIKE 'e2e_2805_%' AND archived_at IS NULL`);
  dropCreatedRoles();
  await ref?.api.dispose();
  await story?.api.dispose();
});

test.describe('AXI-2805 profile scope, organization access and permissions @SI-013 @SI-014 @SI-010 @SI-011 @SI-002', () => {
  test('AC28, AC29 — 4.1: the cutover keeps every profile every organization could pick', { tag: ['@SI-014', '@SI-013'] }, async () => {
    for (const ws of [WS_A, WS_B]) {
      const [a, b] = [await ok(ref, 'GET', P, ws), await ok(story, 'GET', P, ws)];
      expect(JSON.stringify(b), `list in ${ws}`).toBe(JSON.stringify(a));
      expect(ids(b).sort()).toEqual(FIVE);
    }
    const runs = sql(`SELECT ran_by || '|' || (report->>'organizations') || '|' || (report->>'grants') || '|' || jsonb_array_length(report->'widenings') || '|' || jsonb_array_length(report->'disagreeingDefaults') || '|' || jsonb_array_length(report->'skippedKeys') FROM organization_svc.semantic_profile_access_cutover`);
    expect(runs).toHaveLength(1);
    const [actor, organizations, grants, widenings, disagreeing, skipped] = runs[0].split('|');
    expect(actor).toBe('system:semantic-profile-access-cutover');
    expect([widenings, disagreeing, skipped]).toEqual(['0', '0', '0']);
    expect(Number(grants)).toBe(Number(organizations) * FIVE.length);
    const [orgs] = sql('SELECT count(*) FROM organization_svc.organizations');
    expect(Number(organizations)).toBeLessThanOrEqual(Number(orgs));
    // Every organization that existed at the cutover holds the five seeded profiles.
    const short = sql(
      `SELECT o.id FROM organization_svc.organizations o WHERE (SELECT count(*) FROM organization_svc.organization_semantic_profile_access g ` +
        `JOIN organization_svc.semantic_profiles p ON p.id = g.profile_id AND p.scope = 'system' WHERE g.organization_id = o.id) <> ${FIVE.length}`,
    );
    expect(short).toEqual([]);
    const [audit] = sql(`SELECT count(*) FROM organization_svc.semantic_profile_audit_log WHERE action = 'access_cutover'`);
    expect(audit).toBe('1');
  });

  test('AC27 — 4.2: catalog reads answer as on main for a member', { tag: ['@SI-010', '@SI-014'] }, async () => {
    for (const key of FIVE) {
      for (const leaf of ['resolved', 'config']) {
        const [a, b] = [await ok(ref, 'GET', `${P}/${key}/${leaf}`, WS_A), await ok(story, 'GET', `${P}/${key}/${leaf}`, WS_A)];
        expect(JSON.stringify(b), `${key}/${leaf}`).toBe(JSON.stringify(a));
      }
    }
    // §10.4 difference (FR30): `main` answers the workspace columns (`allowedProfileIds: []` = "no
    // restriction"); the branch answers what the owner organization SEES, explicitly. The picker the
    // front draws from it (`allowed.length ? list.filter(allowed) : list`) is the same on both.
    const picker = (list: { id: string }[], policy: { allowedProfileIds: string[] }) =>
      ids(policy.allowedProfileIds.length ? list.filter((p) => policy.allowedProfileIds.includes(p.id)) : list);
    const [refPolicy, policy] = [await ok(ref, 'GET', `${P}/workspace/${WS_A}/policy`, WS_A), await ok(story, 'GET', `${P}/workspace/${WS_A}/policy`, WS_A)];
    const storyList = await ok<any[]>(story, 'GET', P, WS_A);
    expect(policy.allowedProfileIds).toEqual(ids(storyList));
    expect(picker(storyList, policy)).toEqual(picker(await ok<any[]>(ref, 'GET', P, WS_A), refPolicy));
    expect(policy.defaultProfileId).toBe(refPolicy.defaultProfileId);
    expect(policy.defaultProfileId).toBeNull();
  });

  test('AC27, EC18 — 4.3: the list follows the workspace OWNER organization, never the member home organization', { tag: ['@SI-013', '@SI-014'] }, async () => {
    insertOrganizationProfile(OWNER_KEY, orgB);
    const listB = await eventually(() => ok<any[]>(story, 'GET', P, WS_B), (l) => ids(l).includes(OWNER_KEY));
    expect(ids(listB)).toContain(OWNER_KEY);
    expect(ids(await ok<any[]>(story, 'GET', P, WS_A))).not.toContain(OWNER_KEY);
    // admin's membership in org B's workspace now claims org A as its home organization: no change.
    setMembership({ organizationId: orgA });
    try {
      expect(ids(await ok<any[]>(story, 'GET', P, WS_B))).toContain(OWNER_KEY);
      expect((await call(story, 'GET', `${P}/${OWNER_KEY}/resolved`, WS_B)).status).toBe(200);
      expect((await call(story, 'GET', `${P}/${OWNER_KEY}/resolved`, WS_A)).status).toBe(404);
    } finally {
      restoreMembership();
    }
  });

  test('AC29, AC30, AC31, EC9, EC20 — 4.4: grant, revoke and the organization default set', { tag: ['@SI-010', '@SI-013', '@SI-014'] }, async () => {
    const access = await ok(story, 'GET', `${P}/access`, WS_B);
    expect(access.organizationId).toBe(orgB);
    expect(access.grants.map((g: any) => g.profileId).sort()).toEqual(FIVE);
    expect(access.defaults).toEqual([]);

    expect((await ok(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: ['immunology'] })).defaults).toEqual(['immunology']);
    expect((await ok(story, 'GET', `${P}/workspace/${WS_B}/policy`, WS_B)).defaultProfileId).toBe('immunology');
    // The default set holds immunology: revoke is refused (it would leave a default nobody can select).
    const inDefaults = await call(story, 'DELETE', `${P}/access/immunology`, WS_B);
    expect(inDefaults.status).toBe(409);
    expect(JSON.stringify(inDefaults.body)).toContain('default set');

    const omitted = await createProject('omitted', {});
    expect(omitted.status, JSON.stringify(omitted.body)).toBe(201);
    expect(omitted.body.semanticProfileId).toBe('immunology');
    const none = await createProject('explicit-null', { semanticProfileId: null });
    expect(none.status).toBe(201);
    expect(none.body.semanticProfileId ?? null).toBeNull();

    expect((await ok(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: [] })).defaults).toEqual([]);
    const emptyDefault = await createProject('empty-default', {});
    expect(emptyDefault.status).toBe(201);
    expect(emptyDefault.body.semanticProfileId ?? null).toBeNull();

    // A project of the organization selects immunology: revoke refused, naming it (FR69).
    const selected = await call(story, 'DELETE', `${P}/access/immunology`, WS_B);
    expect(selected.status).toBe(409);
    expect(JSON.stringify(selected.body)).toContain(omitted.body.id);

    // No org-B project selects oncology: revoke succeeds and closes every door to it.
    expect(sql(`SELECT count(*) FROM organization_svc.projects p JOIN organization_svc.workspaces w ON w.id = p.workspace_id WHERE w.owner_organization_id = ${lit(orgB)} AND p.semantic_profile_id = 'oncology' AND p.deleted_at IS NULL`)).toEqual(['0']);
    const before = ids(await ok<any[]>(story, 'GET', P, WS_B));
    const revoked = await ok(story, 'DELETE', `${P}/access/oncology`, WS_B);
    expect(revoked.grants.map((g: any) => g.profileId)).not.toContain('oncology');
    expect(revoked.grantable.map((g: any) => g.profileId)).toContain('oncology');
    expect(ids(await ok<any[]>(story, 'GET', P, WS_B))).not.toContain('oncology');
    expect((await call(story, 'GET', `${P}/oncology/resolved`, WS_B)).status).toBe(404);
    const refused = await createProject('revoked', { semanticProfileId: 'oncology' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('Invalid semantic profile: oncology');
    // Org A still sees it (the revoke was org B's alone).
    expect(ids(await ok<any[]>(story, 'GET', P, WS_A))).toContain('oncology');

    await ok(story, 'PUT', `${P}/access/oncology`, WS_B);
    expect(ids(await ok<any[]>(story, 'GET', P, WS_B))).toEqual(before);
  });

  test('AC25 — 4.5: the seed route, gated by semantic_profile:manage_system', { tag: ['@SI-010', '@SI-014'] }, async () => {
    const report = await ok(story, 'POST', `${P}/seed`, WS_B);
    expect(report.added).toEqual([]);
    expect(report.refused).toEqual([]);
    expect(report.unchanged.map((u: any) => u.key).sort()).toEqual(FIVE);
  });

  test('AC23, EC17 — 5.1: another organization profile answers exactly like an unknown id, everywhere', { tag: ['@SI-010', '@SI-014', '@SI-013'] }, async () => {
    const [foreignOrg] = sql(
      `SELECT o.id FROM organization_svc.organizations o WHERE o.id NOT IN (SELECT w.owner_organization_id FROM organization_svc.workspace_members m JOIN organization_svc.workspaces w ON w.id = m.workspace_id WHERE m.user_id = ${lit(adminId)}) ORDER BY o.id LIMIT 1`,
    );
    expect(foreignOrg).toBeTruthy();
    insertOrganizationProfile(FOREIGN_KEY, foreignOrg);
    // Served by the catalog (visible to its own organization) before probing.
    await eventually(async () => sql(`SELECT count(*) FROM organization_svc.semantic_profiles WHERE key = ${lit(FOREIGN_KEY)}`), (r) => r[0] === '1');
    await new Promise((r) => setTimeout(r, 3_000)); // > one catalog poll
    const project = createdProjects[0]; // a 4.4 project of org B's workspace
    expect(project).toBeTruthy();
    expect(ids(await ok<any[]>(story, 'GET', P, WS_B))).not.toContain(FOREIGN_KEY);
    const defaultsBefore = defaultsOf(orgB);
    const probe = async (key: string) => ({
      resolved: await call(story, 'GET', `${P}/${key}/resolved`, WS_B),
      config: await call(story, 'GET', `${P}/${key}/config`, WS_B),
      grant: await call(story, 'PUT', `${P}/access/${key}`, WS_B),
      revoke: await call(story, 'DELETE', `${P}/access/${key}`, WS_B),
      defaults: await call(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: [key] }),
      patch: await call(story, 'PATCH', `/api/v1/projects/${project}/profile`, WS_B, { profileId: key }),
      create: await createProject('foreign', { semanticProfileId: key }),
    });
    const strip = (a: Answer) => ({ status: a.status, message: String(JSON.stringify(a.body?.message ?? a.body)).replace(new RegExp(`${FOREIGN_KEY}|${UNKNOWN_KEY}`, 'g'), '<key>') });
    const foreign = await probe(FOREIGN_KEY);
    const unknown = await probe(UNKNOWN_KEY);
    for (const name of Object.keys(foreign) as (keyof typeof foreign)[]) {
      expect([name, strip(foreign[name])]).toEqual([name, strip(unknown[name])]);
    }
    expect(foreign.resolved.status).toBe(404);
    expect(foreign.config.status).toBe(404);
    expect(foreign.grant.status).toBe(404);
    expect(foreign.revoke.status).toBe(404);
    expect(foreign.defaults.status).toBe(404);
    expect(foreign.patch.status).toBe(400);
    expect(foreign.create.status).toBe(400);
    expect(defaultsOf(orgB)).toEqual(defaultsBefore);
  });

  test('AC24, EC18 — 5.2: a client-sent organization or workspace never decides the target', { tag: ['@SI-010'] }, async () => {
    const defaultsA = defaultsOf(orgA);
    const lying = await call(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: ['immunology'], organizationId: orgA });
    expect(lying.status).toBe(400);
    expect(JSON.stringify(lying.body)).toContain('organizationId should not exist');
    const header = await call(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: ['immunology'] }, { 'X-Organization-Id': orgA });
    expect(header.status).toBe(200);
    expect(header.body.organizationId).toBe(orgB);
    expect(defaultsOf(orgB)).toEqual(['immunology']);
    expect(defaultsOf(orgA)).toEqual(defaultsA);
    await ok(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: [] });
    const crossPolicy = await call(story, 'GET', `${P}/workspace/${WS_A}/policy`, WS_B);
    expect(crossPolicy.status).toBe(403);
    expect(JSON.stringify(crossPolicy.body)).not.toContain('allowedProfileIds');
  });

  test('AC25, NFR7 — 5.3: the permission matrix, whatever the role name', { tag: ['@SI-010', '@SI-011', '@SI-002'] }, async () => {
    const routes = {
      list: () => call(story, 'GET', P, WS_B),
      resolved: () => call(story, 'GET', `${P}/immunology/resolved`, WS_B),
      config: () => call(story, 'GET', `${P}/immunology/config`, WS_B),
      policy: () => call(story, 'GET', `${P}/workspace/${WS_B}/policy`, WS_B),
      access: () => call(story, 'GET', `${P}/access`, WS_B),
      defaults: () => call(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: [] }),
      seed: () => call(story, 'POST', `${P}/seed`, WS_B),
    };
    const statuses = async () => {
      const out: Record<string, number> = {};
      for (const [name, run] of Object.entries(routes)) out[name] = (await run()).status;
      return out;
    };
    const noRights = createRole(`E2E 2805 no rights ${RUN}`, ['project:read', 'guided_analysis_prompt:manage_system']);
    const investigatorWithRights = createRole(`Investigator 2805 ${RUN}`, ['semantic_profile:read', 'semantic_profile:manage_access', 'semantic_profile:manage_system']);
    try {
      // The admin role (unchanged) holds every right.
      expect(await statuses()).toEqual({ list: 200, resolved: 200, config: 200, policy: 200, access: 200, defaults: 200, seed: 200 });
      // The seeded Investigator role holds none of the semantic_profile rights it is not meant to.
      setMembership({ roleId: INVESTIGATOR_ROLE });
      expect(await statuses()).toEqual({ list: 200, resolved: 200, config: 403, policy: 403, access: 403, defaults: 403, seed: 403 });
      // Role NAME `admin` on the membership, but a role id that lacks the rights: refused.
      setMembership({ roleId: noRights });
      expect(await statuses()).toEqual({ list: 200, resolved: 200, config: 403, policy: 403, access: 403, defaults: 403, seed: 403 });
      // A role NAMED Investigator that holds the rights: admitted.
      setMembership({ roleId: investigatorWithRights });
      expect(await statuses()).toEqual({ list: 200, resolved: 200, config: 200, policy: 200, access: 200, defaults: 200, seed: 200 });
    } finally {
      restoreMembership();
      dropCreatedRoles(); // before 5.4: the grant migration would (rightly) treat them as roles to grant
    }
  });

  test('AC26 — 5.4: the grant migration is additive and idempotent', { tag: ['@SI-011'] }, async () => {
    const perms = (rows: string[]) => Object.fromEntries(rows.map((r) => { const [id, p] = r.split('|'); return [id, new Set<string>(JSON.parse(p || '[]'))]; }));
    const select = `SELECT id || '|' || coalesce(permissions::text, '[]') FROM user_svc.roles`;
    const demo = perms(demoReadOnly(select));
    const copy = perms(sql(select));
    for (const [id, had] of Object.entries(demo)) {
      if (!copy[id]) continue;
      const lost = [...had].filter((p) => !copy[id].has(p));
      const added = [...copy[id]].filter((p) => !had.has(p));
      expect([id, lost]).toEqual([id, []]);
      expect([id, added.filter((p) => !p.startsWith('semantic_profile:'))]).toEqual([id, []]);
    }
    const fingerprint = () => sql(
      `SELECT (SELECT md5(string_agg(md5(r::text), '' ORDER BY id)) FROM user_svc.roles r) || '|' || (SELECT count(*) FROM user_svc.role_versions) || '|' || (SELECT count(*) FROM user_svc.role_audit_logs)`,
    )[0];
    const before = fingerprint();
    const rerun = spawnSync('sh', ['-c', `docker exec ${SIDECAR} cat ${GRANT_MIGRATION} | docker exec -i -e PGOPTIONS=-csearch_path=user_svc ${PG_CONTAINER} psql -U axiome -d ${STORY_DB} -v ON_ERROR_STOP=1 -q`], { encoding: 'utf-8' });
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(fingerprint()).toBe(before);
  });

  test('AC23, EC24 — 5.5: an organization key may not equal or shadow a system key', { tag: ['@SI-014'] }, async () => {
    for (const key of ['immunology', 'Immunology', 'ONCOLOGY']) {
      const err = sqlRefused(
        `INSERT INTO organization_svc.semantic_profiles (id, key, scope, organization_id, display_name, origin, created_by, updated_at) VALUES (gen_random_uuid()::text, '${key}', 'organization', ${lit(orgB)}, 'Shadow', 'authored', 'e2e:axi-2805', now())`,
      );
      expect(err, key).toMatch(/duplicate key|shadow|unique/i);
    }
  });

  test('AC32 — §6: every access write is audited, append-only, with actor and organization', { tag: ['@SI-014'] }, async () => {
    const rows = sql(
      `SELECT action || '|' || target || '|' || coalesce(before::text, '') || '|' || coalesce(after::text, '') FROM organization_svc.semantic_profile_audit_log ` +
        `WHERE organization_id = ${lit(orgB)} AND actor = ${lit(adminId)} AND performed_at >= ${lit(startedAt)}::timestamptz ORDER BY performed_at`,
    );
    const actions = rows.map((r) => r.split('|')[0]);
    expect(actions).toContain('defaults_set');
    expect(actions).toContain('access_revoke');
    expect(actions).toContain('access_grant');
    expect(rows).toContainEqual(expect.stringMatching(/^access_revoke\|profile:oncology\|\{"granted": true\}\|\{"granted": false\}$/));
    expect(rows).toContainEqual(expect.stringMatching(/^defaults_set\|organization:.*\|\{"defaults": \[\]\}\|\{"defaults": \["immunology"\]\}$/));
    // The seed run wrote nothing, so it recorded nothing.
    expect(sql(`SELECT count(*) FROM organization_svc.semantic_profile_audit_log WHERE action = 'seed' AND actor = ${lit(adminId)} AND performed_at >= ${lit(startedAt)}::timestamptz`)).toEqual(['0']);
    const [one] = sql(`SELECT id FROM organization_svc.semantic_profile_audit_log WHERE organization_id = ${lit(orgB)} ORDER BY performed_at DESC LIMIT 1`);
    expect(sqlRefused(`UPDATE organization_svc.semantic_profile_audit_log SET actor = 'x' WHERE id = ${lit(one)}`)).toMatch(/append-only/);
    expect(sqlRefused(`DELETE FROM organization_svc.semantic_profile_audit_log WHERE id = ${lit(one)}`)).toMatch(/append-only/);
    // The project created with the default profile records it on its create audit row (FR37).
    const created = createdProjects[0];
    const [changes] = sql(`SELECT changes::text FROM organization_svc.project_audit_logs WHERE project_id = ${lit(created)} AND action = 'create'`);
    expect(JSON.parse(changes).semanticProfileId).toEqual({ old: null, new: 'immunology' });
  });

  test('AC28 — 4.1 step 3: a restart does not run the cutover again', { tag: ['@SI-014'] }, async () => {
    const grants = sql('SELECT count(*) FROM organization_svc.organization_semantic_profile_access');
    const since = new Date().toISOString();
    execFileSync('docker', ['restart', SIDECAR]);
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      const log = spawnSync('docker', ['logs', '--since', since, SIDECAR], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
      up = /SemanticProfilesMessageController/.test(`${log.stdout}${log.stderr}`);
    }
    expect(up, 'organization-service restarted').toBe(true);
    const list = await eventually(() => call(story, 'GET', P, WS_B), (a) => a.status === 200, 60_000);
    expect(list.status).toBe(200);
    const log = spawnSync('docker', ['logs', '--since', since, SIDECAR], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    expect(`${log.stdout}${log.stderr}`).not.toContain('"event":"semantic_profile.access_cutover"');
    expect(sql('SELECT count(*) FROM organization_svc.semantic_profile_access_cutover')).toEqual(['1']);
    expect(sql('SELECT count(*) FROM organization_svc.organization_semantic_profile_access')).toEqual(grants);
  });
});
