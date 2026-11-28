import { execFileSync } from 'child_process';
import { expect, test, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';

/**
 * AXI-2806 (epic AXI-2802 — Semantic Profile Management, area A4): compose 1..N semantic profiles
 * per project (back). Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md`
 * § AXI-2806 (4.1–4.5, 5.1–5.7, §6).
 *
 * E2E CONTRACT — an A/B over the REAL gateway, API level, as `admin@cro-one.com` only:
 *   - REFERENCE = `REF_API_BASE_URL` (default `http://localhost:3000`, the shared demo = `main`);
 *   - STORY     = `API_BASE_URL`: the branch's sidecar (`axiome-2806-backend`, own RabbitMQ vhost)
 *     whose organization AND user databases are the THROWAWAY `E2E_2806_DB` (default
 *     `axiome_axi2806`, a clone of A3's `axiome_axi2805`), migrated by the branch at its boot —
 *     the migration `20261128180000_add_project_semantic_profiles` IS the cutover under test.
 * Reads `main` also answers (a one-profile project) must be equal on both stacks; `main` has no
 * `semanticProfileIds`, so that one additive field is the only allowed difference (NFR6).
 * Writes go to the story stack only. SQL runs only against `E2E_2806_DB`, and every SQL write is
 * an org-profile fixture (no create route before A8) or a rolled-back replay of the migration.
 */

const REF_API_BASE_URL = (process.env.REF_API_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = process.env.E2E_2806_EMAIL?.trim() || 'admin@cro-one.com';
const PASSWORD = process.env.E2E_2806_PASSWORD?.trim() || 'admin';
const SIDECAR = process.env.E2E_2806_SIDECAR?.trim() || 'axiome-2806-backend';
const STORY_DB = process.env.E2E_2806_DB?.trim() || 'axiome_axi2806';
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'axiome-localhost';
const CUTOVER_MIGRATION = '/app/apps/organization-service/src/prisma/migrations/20261128180000_add_project_semantic_profiles/migration.sql';

if (!/^axiome_axi2806[a-z0-9_]*$/.test(STORY_DB)) throw new Error(`E2E_2806_DB must name a throwaway axiome_axi2806* database, got ${STORY_DB}`);
if (REF_API_BASE_URL === API_BASE_URL) throw new Error('AXI-2806 is an A/B: API_BASE_URL must be the story sidecar, not the reference stack');

const WS_A = '8946e06a-4fe6-45ee-8d9a-58f7142e803a'; // Mag4
const WS_B = '81bc7740-7dd0-45d6-9b8e-b7fdef861078'; // Public Datasets — IO Benchmarks
const EXTENSION_PROJECT = '01938581-28cd-483a-a1be-06f2c2d2cec0'; // Mag4, immune_mediated_microbiota + a project extension
const PAIR = ['immune_mediated', 'immune_mediated_microbiota'];
const COMPOSITE = 'immune_mediated+immune_mediated_microbiota';
const PROJECT_PREFIX = 'E2E AXI-2806';
const RUN = Date.now().toString(36);
const LEVELS_KEY = `e2e_2806_levels_${RUN}`;
const LEVELS_PACK = 'e2e_2806_lv';
const P = '/api/v1/semantic-profiles';

interface Stack { name: string; base: string; api: APIRequestContext }
let ref: Stack;
let story: Stack;
let orgA: string;
let defaultsB: string[] = [];
const created: { id: string; ws: string }[] = [];

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

function psql(statement: string): string[] {
  if (!STORY_DB.startsWith('axiome_axi2806')) throw new Error(`refusing SQL on ${STORY_DB}`);
  const out = execFileSync('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'axiome', '-d', STORY_DB, '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, stdio: 'pipe' }).toString();
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

const sql = (select: string) => psql(`SET search_path TO organization_svc; ${select}`).filter((l) => l !== 'SET');

const lit = (v: string) => {
  if (!/^[A-Za-z0-9_.:@+ -]+$/.test(v)) throw new Error(`unsafe literal: ${v}`);
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
type Method = 'GET' | 'PUT' | 'DELETE' | 'POST' | 'PATCH';
async function call(s: Stack, method: Method, path: string, ws: string, data?: unknown): Promise<Answer> {
  const res = await s.api.fetch(`${s.base}${path}`, { method, headers: { 'X-Workspace-Id': ws }, ...(data === undefined ? {} : { data }) });
  const raw = await res.text();
  let body: any = raw;
  try { body = JSON.parse(raw); } catch { /* text */ }
  return { status: res.status(), body };
}

async function ok<T = any>(s: Stack, method: Method, path: string, ws: string, data?: unknown): Promise<T> {
  const a = await call(s, method, path, ws, data);
  expect(a.status, `${s.name} ${method} ${path}: ${JSON.stringify(a.body)}`).toBeLessThan(300);
  return a.body as T;
}

async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, withinMs = 8_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() - start > withinMs) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function createProject(ws: string, label: string, profile: Record<string, unknown>): Promise<Answer> {
  const a = await call(story, 'POST', '/api/v1/projects', ws, { name: `${PROJECT_PREFIX} ${label} ${RUN}`, workspaceId: ws, ...profile });
  if (a.status === 201) created.push({ id: a.body.id, ws });
  return a;
}

const relationOf = (projectId: string) => sql(`SELECT profile_key FROM project_semantic_profiles WHERE project_id = ${lit(projectId)} ORDER BY profile_key`);
const mirrorOf = (projectId: string) => sql(`SELECT coalesce(semantic_profile_id, '<null>') || '|' || coalesce(semantic_profile_version, '<null>') FROM projects WHERE id = ${lit(projectId)}`)[0];
const auditsOf = (projectId: string) => sql(`SELECT changes::text FROM project_audit_logs WHERE project_id = ${lit(projectId)} ORDER BY performed_at, id`).map((c) => JSON.parse(c));
const contractOf = (s: Stack, projectId: string, ws: string) => ok<any>(s, 'GET', `/api/v1/projects/${projectId}/semantic-contract`, ws);
const patchProfile = (projectId: string, ws: string, body: unknown) => call(story, 'PATCH', `/api/v1/projects/${projectId}/profile`, ws, body);
const withoutMappings = ({ fieldMappings: _ignored, ...rest }: any) => rest;
const projectFields = (p: any) => ({ id: p.id, name: p.name, workspaceId: p.workspaceId, semanticProfileId: p.semanticProfileId, semanticProfileVersion: p.semanticProfileVersion });

/** The canonical fields one profile serves, read off a fresh one-profile project on the story stack. */
async function fieldsOfSingle(key: string): Promise<string[]> {
  const a = await createProject(WS_A, `single ${key}`, { semanticProfileId: key });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  return (await contractOf(story, a.body.id, WS_A)).canonicalFields;
}

/**
 * An ORGANIZATION profile of org A copied from `immunology`'s latest version, plus one pack that
 * declares `disease_group` and a `levels` registry for it whose content differs from
 * `immune_mediated`'s (no create route before A8).
 */
function insertLevelsProfile(): void {
  const fields = { registry_id: `canonical_fields.${LEVELS_PACK}.v1`, extends: 'canonical_fields.immunology.v1', fields: ['disease_group'] };
  const levels = { registry_id: `levels.${LEVELS_PACK}.v1`, field: 'disease_group', roles: ['index', 'disease_control', 'healthy_control'], levels: { XX: { role: 'index', label: 'E2E level', aliases: [] } } };
  sql(
    `WITH p AS (INSERT INTO semantic_profiles (id, key, scope, organization_id, display_name, origin, created_by, updated_at) ` +
      `VALUES (gen_random_uuid()::text, ${lit(LEVELS_KEY)}, 'organization', ${lit(orgA)}, ${lit(`E2E 2806 ${LEVELS_KEY}`)}, 'authored', 'e2e:axi-2806', now()) RETURNING id), ` +
      `src AS (SELECT v.* FROM semantic_profile_versions v JOIN semantic_profiles s ON s.id = v.profile_id WHERE s.key = 'immunology' ORDER BY v.created_at DESC LIMIT 1) ` +
      `INSERT INTO semantic_profile_versions (id, profile_id, version, manifest_json, registries_json, content_identity, authored_by) ` +
      `SELECT gen_random_uuid()::text, p.id, src.version, ` +
      `jsonb_set(jsonb_set(src.manifest_json::jsonb, '{profile_id}', to_jsonb(${lit(LEVELS_KEY)}::text)), '{packs}', (src.manifest_json::jsonb->'packs') || to_jsonb(${lit(LEVELS_PACK)}::text))::text, ` +
      `(src.registries_json::jsonb || jsonb_build_array('${JSON.stringify(fields)}'::jsonb, '${JSON.stringify(levels)}'::jsonb))::text, src.content_identity, 'e2e:axi-2806' FROM p, src`,
  );
}

// ─── suite ───────────────────────────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(async () => {
  ref = await open('reference', REF_API_BASE_URL);
  story = await open('story', API_BASE_URL);
  [orgA] = sql(`SELECT owner_organization_id FROM workspaces WHERE id = ${lit(WS_A)}`);
  const orgB = sql(`SELECT owner_organization_id FROM workspaces WHERE id = ${lit(WS_B)}`)[0];
  defaultsB = sql(`SELECT p.key FROM organization_semantic_profile_defaults d JOIN semantic_profiles p ON p.id = d.profile_id WHERE d.organization_id = ${lit(orgB)} ORDER BY d.position`);
});

test.afterAll(async () => {
  if (story) {
    await call(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: defaultsB });
    await call(story, 'PUT', `${P}/access/immune_mediated_microbiota`, WS_B);
    await call(story, 'PATCH', `/api/v1/projects/${EXTENSION_PROJECT}/profile`, WS_A, { profileId: 'immune_mediated_microbiota' });
    for (const { id, ws } of created) await call(story, 'DELETE', `/api/v1/projects/${id}`, ws);
  }
  // Organization profiles cannot be deleted from under their audit trail: archive them (not served, not listed).
  sql(`UPDATE semantic_profiles SET archived_at = now(), updated_at = now() WHERE key LIKE 'e2e_2806_%' AND archived_at IS NULL`);
  await ref?.api.dispose();
  await story?.api.dispose();
});

test.describe('AXI-2806 compose 1..N profiles per project @SI-014 @SI-013 @SI-010 @SI-002', () => {
  test('FR38 — 4.1: the cutover wrote one row per project naming a profile, and a re-run inserts nothing', { tag: ['@SI-013', '@SI-014'] }, async () => {
    const [named] = sql(`SELECT count(*) FROM projects WHERE semantic_profile_id IS NOT NULL AND semantic_profile_id <> ''`);
    const [cutover] = sql(`SELECT count(*) FROM project_semantic_profiles WHERE added_by = 'system:cutover:AXI-2806'`);
    expect(Number(cutover)).toBeGreaterThan(0);
    expect(Number(cutover)).toBeLessThanOrEqual(Number(named));
    // Every project naming a profile has that key in its selection, and the mirror is the FIRST key (FR38, FR39).
    expect(sql(`SELECT p.id FROM projects p WHERE p.semantic_profile_id IS NOT NULL AND p.semantic_profile_id <> '' AND NOT EXISTS (SELECT 1 FROM project_semantic_profiles r WHERE r.project_id = p.id AND r.profile_key = p.semantic_profile_id)`)).toEqual([]);
    expect(sql(`SELECT p.id FROM projects p JOIN (SELECT project_id, min(profile_key) AS first FROM project_semantic_profiles GROUP BY project_id) r ON r.project_id = p.id WHERE p.semantic_profile_id IS DISTINCT FROM r.first`)).toEqual([]);
    expect(sql(`SELECT r.project_id FROM project_semantic_profiles r JOIN projects p ON p.id = r.project_id WHERE p.semantic_profile_id IS NULL GROUP BY r.project_id`)).toEqual([]);
    // Replay the migration's own INSERT (read from the branch) in a rolled-back transaction.
    const migration = execFileSync('docker', ['exec', SIDECAR, 'cat', CUTOVER_MIGRATION]).toString();
    const insert = migration.slice(migration.indexOf('INSERT INTO "project_semantic_profiles"'));
    const replay = psql(`BEGIN; SET search_path TO organization_svc; ${insert} ROLLBACK;`);
    expect(replay).toContain('INSERT 0 0');
    expect(migration.replace(/--.*$/gm, '')).not.toMatch(/^\s*(UPDATE|DELETE|DROP|TRUNCATE)\b/im);
  });

  test('AC33, NFR6 — 4.2: a one-profile project reads as on main (project and contract)', { tag: ['@SI-014', '@SI-010'] }, async () => {
    const sample = sql(
      `SELECT p.id || '|' || p.workspace_id FROM projects p WHERE p.deleted_at IS NULL AND p.workspace_id IN (${lit(WS_A)}, ${lit(WS_B)}) ` +
        `AND p.semantic_profile_id IS NOT NULL AND p.name NOT LIKE 'E2E%' ORDER BY p.semantic_profile_id, p.created_at LIMIT 12`,
    );
    expect(sample.length).toBeGreaterThan(0);
    let compared = 0;
    for (const row of sample) {
      const [id, ws] = row.split('|');
      const a = await call(ref, 'GET', `/api/v1/projects/${id}`, ws);
      if (a.status !== 200) continue; // created on the demo after the clone: no reference to compare to.
      const b = await ok(story, 'GET', `/api/v1/projects/${id}`, ws);
      expect(projectFields(b), `project ${id}`).toEqual(projectFields(a.body));
      expect(a.body).not.toHaveProperty('semanticProfileIds');
      expect(b.semanticProfileIds).toEqual([b.semanticProfileId]);
      const [ca, cb] = [await contractOf(ref, id, ws), await contractOf(story, id, ws)];
      expect(JSON.stringify(withoutMappings(cb)), `contract ${id}`).toBe(JSON.stringify(withoutMappings(ca)));
      expect(cb.profile).not.toHaveProperty('members');
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });

  let pairProject: string;
  test('AC39, AC42, AC34 — 4.3: create with two compatible profiles; the contract lists both profiles fields', { tag: ['@SI-014', '@SI-013', '@SI-002'] }, async () => {
    const singles = [await fieldsOfSingle(PAIR[0]), await fieldsOfSingle(PAIR[1])];
    const a = await createProject(WS_A, 'pair', { semanticProfileIds: [...PAIR].reverse() });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    pairProject = a.body.id;
    expect(a.body).toMatchObject({ semanticProfileId: PAIR[0], semanticProfileIds: PAIR });
    expect(relationOf(pairProject)).toEqual(PAIR);
    const contract = await contractOf(story, pairProject, WS_A);
    expect(contract.profile).toMatchObject({ id: COMPOSITE, members: PAIR });
    expect(contract.profile.configVersion).toMatch(/^immune_mediated\+immune_mediated_microbiota@[^@]+\+cid1:[0-9a-f]{64}$/);
    for (const fields of singles) expect(contract.canonicalFields).toEqual(expect.arrayContaining(fields));
    expect(contract.fallbackMode).toBe(false);
    // AC34: the other order gives the same content and identity.
    const b = await createProject(WS_A, 'pair reversed', { semanticProfileIds: PAIR });
    expect(withoutMappings(await contractOf(story, b.body.id, WS_A))).toEqual(withoutMappings(contract));
    // AC39: semanticProfileId only → one profile, both fields in the response.
    const one = await createProject(WS_A, 'legacy create', { semanticProfileId: 'oncology' });
    expect(one.body).toMatchObject({ semanticProfileId: 'oncology', semanticProfileIds: ['oncology'] });
    expect(relationOf(one.body.id)).toEqual(['oncology']);
  });

  test('AC38, FR44 — 4.4/4.5: PATCH { profileId } behaves as today; PATCH { profileIds } saves the selection', { tag: ['@SI-013', '@SI-014', '@SI-002'] }, async () => {
    const legacy = await patchProfile(pairProject, WS_A, { profileId: 'oncology' });
    expect(legacy.status, JSON.stringify(legacy.body)).toBeLessThan(300);
    expect(legacy.body).toMatchObject({ semanticProfileId: 'oncology', semanticProfileIds: ['oncology'] });
    expect(relationOf(pairProject)).toEqual(['oncology']);
    expect((await contractOf(story, pairProject, WS_A)).profile).not.toHaveProperty('members');
    const list = await patchProfile(pairProject, WS_A, { profileIds: [...PAIR].reverse() });
    expect(list.status, JSON.stringify(list.body)).toBeLessThan(300);
    expect(list.body).toMatchObject({ semanticProfileId: PAIR[0], semanticProfileIds: PAIR });
    expect(relationOf(pairProject)).toEqual(PAIR);
    expect(mirrorOf(pairProject)).toMatch(/^immune_mediated\|/);
    expect((await contractOf(story, pairProject, WS_A)).profile.id).toBe(COMPOSITE);
  });

  test('AC35, EC4, EC5, EC7 — 5.1: immune_mediated + oncology is refused with every issue, and nothing is written', { tag: ['@SI-014', '@SI-013'] }, async () => {
    const before = { relation: relationOf(pairProject), mirror: mirrorOf(pairProject), audits: auditsOf(pairProject).length };
    const refused = await patchProfile(pairProject, WS_A, { profileIds: ['immune_mediated', 'oncology'] });
    expect(refused.status).toBe(400);
    expect(String(refused.body.message)).toMatch(/^profile_combination_refused: /);
    const rules = (refused.body.errors as { rule: string; key: string }[]).map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(['vocabulary-conflict', 'alias-token-conflict']));
    const tokens = (refused.body.errors as { rule: string; key: string }[]).filter((i) => i.rule === 'alias-token-conflict').map((i) => i.key);
    expect(tokens).toEqual(expect.arrayContaining(['biomarker', 'expression']));
    expect({ relation: relationOf(pairProject), mirror: mirrorOf(pairProject), audits: auditsOf(pairProject).length }).toEqual(before);
    // The same combination on create creates no project.
    const name = `${PROJECT_PREFIX} refused ${RUN}`;
    const create = await call(story, 'POST', '/api/v1/projects', WS_A, { name, workspaceId: WS_A, semanticProfileIds: ['immune_mediated', 'oncology'] });
    expect(create.status).toBe(400);
    expect(String(create.body.message)).toMatch(/^profile_combination_refused: /);
    expect(sql(`SELECT count(*) FROM projects WHERE name = ${lit(name)}`)).toEqual(['0']);
  });

  test('AC36, EC6 — 5.2: two different levels registries are refused with levels-conflict, nothing saved', { tag: ['@SI-014'] }, async () => {
    insertLevelsProfile();
    const served = await eventually(() => call(story, 'GET', `${P}/${LEVELS_KEY}/resolved`, WS_A), (a) => a.status === 200);
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    const alone = await createProject(WS_A, 'levels alone', { semanticProfileIds: [LEVELS_KEY] });
    expect(alone.status, `the levels profile alone is valid: ${JSON.stringify(alone.body)}`).toBe(201);
    const before = relationOf(pairProject);
    const refused = await patchProfile(pairProject, WS_A, { profileIds: ['immune_mediated', LEVELS_KEY] });
    expect(refused.status).toBe(400);
    expect((refused.body.errors as { rule: string }[]).map((i) => i.rule)).toContain('levels-conflict');
    expect(relationOf(pairProject)).toEqual(before);
  });

  test('FR44, OQ-16 — 5.4: malformed selections are refused before anything is read or written', { tag: ['@SI-002', '@SI-013'] }, async () => {
    const before = relationOf(pairProject);
    for (const body of [{ profileIds: 'immunology' }, { profileIds: [1] }, { profileIds: [] }, { profileIds: ['a', 'b', 'c', 'd', 'e', 'f'] }, { profileIds: ['oncology', 'no_such_profile'] }]) {
      const a = await patchProfile(pairProject, WS_A, body);
      expect(a.status, `${JSON.stringify(body)} → ${JSON.stringify(a.body)}`).toBe(400);
    }
    expect(relationOf(pairProject)).toEqual(before);
    const disagree = await call(story, 'POST', '/api/v1/projects', WS_A, { name: `${PROJECT_PREFIX} disagree ${RUN}`, workspaceId: WS_A, semanticProfileId: 'oncology', semanticProfileIds: ['immunology'] });
    expect(disagree.status).toBe(400);
    const six = await call(story, 'POST', '/api/v1/projects', WS_A, { name: `${PROJECT_PREFIX} six ${RUN}`, workspaceId: WS_A, semanticProfileIds: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(six.status).toBe(400);
  });

  test('AC37, FR48 — 5.5: a project extension stays merged in a new compatible selection', { tag: ['@SI-014', '@SI-013'] }, async () => {
    const single = await contractOf(story, EXTENSION_PROJECT, WS_A);
    const own = (single.canonicalFields as string[]).filter((f) => f.startsWith(`project.${EXTENSION_PROJECT}.`));
    expect(own.length, 'the fixture project carries extension fields').toBeGreaterThan(0);
    const patched = await patchProfile(EXTENSION_PROJECT, WS_A, { profileIds: PAIR });
    expect(patched.status, JSON.stringify(patched.body)).toBeLessThan(300);
    const composed = await contractOf(story, EXTENSION_PROJECT, WS_A);
    expect(composed.profile.id).toBe(COMPOSITE);
    expect(composed.canonicalFields).toEqual(expect.arrayContaining(own));
    const restored = await patchProfile(EXTENSION_PROJECT, WS_A, { profileId: 'immune_mediated_microbiota' });
    expect(restored.status, JSON.stringify(restored.body)).toBeLessThan(300);
    expect(withoutMappings(await contractOf(story, EXTENSION_PROJECT, WS_A))).toEqual(withoutMappings(single));
    expect(relationOf(EXTENSION_PROJECT)).toEqual(['immune_mediated_microbiota']);
  });

  test('FR38, FR69, EC9 — 5.6: a profile selected as a SECOND key blocks its revoke', { tag: ['@SI-014', '@SI-010'] }, async () => {
    const a = await createProject(WS_B, 'revoke pair', { semanticProfileIds: PAIR });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.semanticProfileId).toBe('immune_mediated'); // the mirror does NOT name the blocking key
    const blocked = await call(story, 'DELETE', `${P}/access/immune_mediated_microbiota`, WS_B);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain(a.body.id);
    await ok(story, 'DELETE', `/api/v1/projects/${a.body.id}`, WS_B);
    const freed = await call(story, 'DELETE', `${P}/access/immune_mediated_microbiota`, WS_B);
    expect(freed.status, JSON.stringify(freed.body)).toBeLessThan(300);
    await ok(story, 'PUT', `${P}/access/immune_mediated_microbiota`, WS_B);
  });

  test('FR30, FR45 — 5.7: an omitted list applies the whole default set; [] means none', { tag: ['@SI-014', '@SI-013'] }, async () => {
    await ok(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: [...PAIR].reverse() });
    const omitted = await createProject(WS_B, 'defaults', {});
    expect(omitted.status, JSON.stringify(omitted.body)).toBe(201);
    expect(omitted.body).toMatchObject({ semanticProfileId: PAIR[0], semanticProfileIds: PAIR });
    expect(relationOf(omitted.body.id)).toEqual(PAIR);
    const none = await createProject(WS_B, 'none', { semanticProfileIds: [] });
    expect(none.status, JSON.stringify(none.body)).toBe(201);
    expect(none.body).toMatchObject({ semanticProfileId: null, semanticProfileIds: [] });
    expect(relationOf(none.body.id)).toEqual([]);
    expect((await contractOf(story, none.body.id, WS_B)).fallbackMode).toBe(true); // EC19
    await ok(story, 'PUT', `${P}/defaults`, WS_B, { profileIds: defaultsB });
  });

  test('FR37, NFR6 — §6: the audit names the list only when a side holds two or more keys', { tag: ['@SI-013', '@SI-017'] }, async () => {
    const audits = auditsOf(pairProject);
    const profileAudits = audits.filter((c) => 'semanticProfileId' in c || 'semanticProfileIds' in c);
    expect(profileAudits.at(0)).toMatchObject({ semanticProfileIds: { old: [], new: PAIR } }); // create
    expect(profileAudits).toContainEqual({ semanticProfileId: { old: PAIR[0], new: 'oncology' }, semanticProfileIds: { old: PAIR, new: ['oncology'] } });
    expect(profileAudits).toContainEqual({ semanticProfileId: { old: 'oncology', new: PAIR[0] }, semanticProfileIds: { old: ['oncology'], new: PAIR } });
    const legacy = auditsOf(EXTENSION_PROJECT).filter((c) => 'semanticProfileId' in c).at(-1);
    expect(legacy).toEqual({ semanticProfileId: { old: PAIR[0], new: 'immune_mediated_microbiota' }, semanticProfileIds: { old: PAIR, new: ['immune_mediated_microbiota'] } });
    const single = auditsOf(created.find((c) => c.ws === WS_A)!.id);
    expect(JSON.stringify(single)).not.toContain('semanticProfileIds');
  });
});
