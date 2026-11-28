import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { expect, test, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';

/**
 * AXI-2807 (epic AXI-2802 — Semantic Profile Management, area A5): profile versions, following the
 * latest, re-match. Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md`
 * § AXI-2807 (4.1–4.4, 5.1–5.5, §6).
 *
 * E2E CONTRACT — an A/B over the REAL gateway, API level, as `admin@cro-one.com` only:
 *   - REFERENCE = `REF_API_BASE_URL` (default `http://localhost:3000`, the shared demo = `main`);
 *   - STORY     = `API_BASE_URL`: the branch's sidecar (`axiome-2807-backend`, own RabbitMQ vhost)
 *     whose organization AND user databases are the THROWAWAY `E2E_2807_DB` (default
 *     `axiome_axi2807`, a clone of A4's `axiome_axi2806`), migrated by the branch at its boot.
 *     Its canonical-file directory is the scratch copy `E2E_2807_SEED_DIR`, bind-mounted over
 *     `semantic-profiles/config`, so 4.4 can ship a newer file without touching the branch.
 * The only A/B read (4.1) runs before any version is added. Writes go to the story stack only; SQL
 * runs only against `E2E_2807_DB`. The SQL writes are fixtures no route can make yet: the
 * organization profile (no create route before A8), one `human` mapping row, a fault trigger
 * (dropped in 5.2) and a role holding the profile rights that admin's membership is pointed at
 * (restored at the end; the unchanged admin role is first shown to be refused).
 */

const REF_API_BASE_URL = (process.env.REF_API_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = process.env.E2E_2807_EMAIL?.trim() || 'admin@cro-one.com';
const PASSWORD = process.env.E2E_2807_PASSWORD?.trim() || 'admin';
const STORY_DB = process.env.E2E_2807_DB?.trim() || 'axiome_axi2807';
const SEED_DIR = process.env.E2E_2807_SEED_DIR?.trim() || '';
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'axiome-localhost';

if (!/^axiome_axi2807[a-z0-9_]*$/.test(STORY_DB)) throw new Error(`E2E_2807_DB must name a throwaway axiome_axi2807* database, got ${STORY_DB}`);
if (REF_API_BASE_URL === API_BASE_URL) throw new Error('AXI-2807 is an A/B: API_BASE_URL must be the story sidecar, not the reference stack');

const WS_A = '8946e06a-4fe6-45ee-8d9a-58f7142e803a'; // Mag4
const WS_B = '81bc7740-7dd0-45d6-9b8e-b7fdef861078'; // Public Datasets — IO Benchmarks
const DEMO_2411 = '634d1c6d-4209-446a-aa0d-733d825c1fea'; // Mag4, immune_mediated_microbiota, final SAP versions
const DS_ORGANS = 'd111027c-e03b-48a7-9f2e-fe8282b24cf0'; // 03-organ-involvement.csv: organ_canonical, term_as_written unmatched
const DS_STATS = '547a3b06-878c-4b61-b601-e7fdf4f44c18'; // a statistical result table: coefficient, … unmatched
const SOURCE_PROFILE = 'immune_mediated_microbiota';
const RUN = Date.now().toString(36);
const KEY = `e2e_2807_v_${RUN}`;
const PROJECT_PREFIX = 'E2E AXI-2807';
const FAULT = 'e2e_2807_fault';
const P = '/api/v1/semantic-profiles';

interface Stack { name: string; base: string; api: APIRequestContext }
let ref: Stack;
let story: Stack;
let orgA: string;
let adminId: string;
let editorRole: string | undefined;
const memberships: { id: string; roleId: string }[] = [];
const created: string[] = [];
let seedFileBackup: { file: string; body: string }[] = [];

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

function psql(statement: string): string[] {
  if (!STORY_DB.startsWith('axiome_axi2807')) throw new Error(`refusing SQL on ${STORY_DB}`);
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
async function call(s: Stack, method: Method, p: string, ws: string, data?: unknown): Promise<Answer> {
  const res = await s.api.fetch(`${s.base}${p}`, { method, headers: { 'X-Workspace-Id': ws }, timeout: 60_000, ...(data === undefined ? {} : { data }) });
  const raw = await res.text();
  let body: any = raw;
  try { body = JSON.parse(raw); } catch { /* text */ }
  return { status: res.status(), body };
}

async function ok<T = any>(s: Stack, method: Method, p: string, ws: string, data?: unknown): Promise<T> {
  const a = await call(s, method, p, ws, data);
  expect(a.status, `${s.name} ${method} ${p}: ${JSON.stringify(a.body)}`).toBeLessThan(300);
  return a.body as T;
}

async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, withinMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await read();
    if (done(v) || Date.now() - start > withinMs) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function createProject(label: string, profile: Record<string, unknown>): Promise<string> {
  const a = await call(story, 'POST', '/api/v1/projects', WS_A, { name: `${PROJECT_PREFIX} ${label} ${RUN}`, workspaceId: WS_A, ...profile });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  created.push(a.body.id);
  return a.body.id;
}

async function deleteProject(id: string): Promise<void> {
  for (const d of sql(`SELECT dataset_id FROM project_dataset_links WHERE project_id = ${lit(id)}`)) await call(story, 'DELETE', `/api/v1/projects/${id}/datasets/${d}`, WS_A);
  await call(story, 'DELETE', `/api/v1/projects/${id}`, WS_A);
}

/** Every mapping row of a project, one string per row, ordered. */
const rowsOf = (projectId: string) => sql(
  `SELECT id || '|' || dataset_id || '|' || source_field || '|' || coalesce(canonical_field, '-') || '|' || status || '|' || source || '|' || config_version || '|' || coalesce(qualifiers::text, '-') ` +
    `FROM project_field_mappings WHERE project_id = ${lit(projectId)} ORDER BY dataset_id, source_field, id`,
);
const rowOf = (projectId: string, datasetId: string, header: string) => rowsOf(projectId).find((r) => r.split('|')[1] === datasetId && r.split('|')[2] === header)!;
const versionsOf = (key: string) => sql(`SELECT v.version FROM semantic_profile_versions v JOIN semantic_profiles p ON p.id = v.profile_id WHERE p.key = ${lit(key)} ORDER BY v.created_at, v.version`);
const rematchOf = (projectId: string, ws = WS_A) => ok<any>(story, 'GET', `${P}/projects/${projectId}/rematch`, ws);
const settled = (projectId: string, withinMs = 30_000) => eventually(() => rematchOf(projectId), (r) => r.status === 'succeeded' || r.status === 'failed', withinMs);

interface Latest { version: string; manifest: any; registries: any[] }
function latestOf(key: string): Latest {
  const [row] = sql(
    `SELECT json_build_object('version', v.version, 'manifest', v.manifest_json::json, 'registries', v.registries_json::json)::text ` +
      `FROM semantic_profile_versions v JOIN semantic_profiles p ON p.id = v.profile_id WHERE p.key = ${lit(key)} ORDER BY v.created_at DESC LIMIT 1`,
  );
  return JSON.parse(row);
}

/** A registry overlay: the latest version's registry `id`, with `entries[field]` gaining `tokens`. */
function withAliases(latest: Latest, registryId: string, add: Record<string, string[]>): any {
  const reg = structuredClone(latest.registries.find((r) => r.registry_id === registryId));
  expect(reg, `registry ${registryId} in the latest snapshot`).toBeTruthy();
  for (const [field, tokens] of Object.entries(add)) reg.entries[field] = [...(reg.entries[field] ?? []), ...tokens];
  return reg;
}

const saveVersion = (body: unknown, ws = WS_A, key = KEY) => call(story, 'POST', `${P}/${key}/versions`, ws, body);

/** The organization profile under test: a copy of `immune_mediated_microbiota`'s latest version, owned by org A. */
function insertOrganizationProfile(): void {
  sql(
    `WITH src AS (SELECT v.* FROM semantic_profile_versions v JOIN semantic_profiles s ON s.id = v.profile_id WHERE s.key = ${lit(SOURCE_PROFILE)} ORDER BY v.created_at DESC LIMIT 1), ` +
      `p AS (INSERT INTO semantic_profiles (id, key, scope, organization_id, display_name, origin, copied_from_version_id, created_by, updated_at) ` +
      `SELECT gen_random_uuid()::text, ${lit(KEY)}, 'organization', ${lit(orgA)}, ${lit(`E2E 2807 ${KEY}`)}, 'copied', src.id, 'e2e:axi-2807', now() FROM src RETURNING id) ` +
      `INSERT INTO semantic_profile_versions (id, profile_id, version, manifest_json, registries_json, content_identity, authored_by) ` +
      `SELECT gen_random_uuid()::text, p.id, src.version, jsonb_set(src.manifest_json::jsonb, '{profile_id}', to_jsonb(${lit(KEY)}::text))::text, src.registries_json, src.content_identity, 'e2e:axi-2807' FROM p, src`,
  );
}

/** Points admin's memberships of both workspaces at a role = Admin's rights + the profile-version rights. */
function grantProfileRights(): void {
  const [adminPerms] = sql(`SELECT r.permissions::text FROM user_svc.roles r WHERE r.id = ${lit(memberships[0].roleId)}`);
  const perms = Array.from(new Set([...JSON.parse(adminPerms), 'semantic_profile:update', 'semantic_profile:archive']));
  [editorRole] = sql(
    `INSERT INTO user_svc.roles (id, name, description, permissions, scope, updated_at, created_by) ` +
      `VALUES (gen_random_uuid()::text, 'E2E 2807 profile editor', 'AXI-2807 E2E', '${JSON.stringify(perms)}'::jsonb, 'WORKSPACE', now(), 'e2e:axi-2807') RETURNING id`,
  );
  for (const m of memberships) sql(`UPDATE workspace_members SET role_id = ${lit(editorRole!)} WHERE id = ${lit(m.id)}`);
}

function restoreRights(): void {
  for (const m of memberships) sql(`UPDATE workspace_members SET role_id = ${lit(m.roleId)} WHERE id = ${lit(m.id)}`);
  if (editorRole) sql(`DELETE FROM user_svc.roles WHERE id = ${lit(editorRole)}`);
  editorRole = undefined;
}

const dropFault = () => sql(`DROP TRIGGER IF EXISTS ${FAULT} ON project_field_mappings; DROP FUNCTION IF EXISTS ${FAULT}()`);

async function questionDataOf(s: Stack, projectId: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const row of sql(`SELECT v.sap_id || '|' || v.id FROM sap_versions v JOIN saps s ON s.id = v.sap_id WHERE s.project_id = ${lit(projectId)} AND v.status = 'final' ORDER BY v.id`)) {
    const [sapId, versionId] = row.split('|');
    out[versionId] = await ok(s, 'GET', `/api/v1/projects/${projectId}/saps/${sapId}/versions/${versionId}/question-data`, WS_A);
  }
  return out;
}

const sapVersionsDigest = (projectId: string) => sql(`SELECT md5(string_agg(md5(v::text), '' ORDER BY v.id)) FROM sap_versions v JOIN saps s ON s.id = v.sap_id WHERE s.project_id = ${lit(projectId)}`)[0];

// ─── suite ───────────────────────────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(async () => {
  ref = await open('reference', REF_API_BASE_URL);
  story = await open('story', API_BASE_URL);
  [adminId] = sql(`SELECT id FROM user_svc.users WHERE email = ${lit(EMAIL)}`);
  [orgA] = sql(`SELECT owner_organization_id FROM workspaces WHERE id = ${lit(WS_A)}`);
  for (const ws of [WS_A, WS_B]) {
    const [row] = sql(`SELECT id || '|' || role_id FROM workspace_members WHERE workspace_id = ${lit(ws)} AND user_id = ${lit(adminId)}`);
    const [id, roleId] = row.split('|');
    memberships.push({ id, roleId });
  }
  dropFault();
  insertOrganizationProfile();
  // Served by the story stack once its catalog poll (2 s) sees the insert.
  const served = await eventually(() => call(story, 'GET', `${P}/${KEY}/resolved`, WS_A), (a) => a.status === 200, 10_000);
  expect(served.status, JSON.stringify(served.body)).toBe(200);
});

test.afterAll(async () => {
  dropFault();
  if (memberships.length) restoreRights();
  for (const { file, body } of seedFileBackup) fs.writeFileSync(file, body);
  if (story) for (const id of created) await deleteProject(id);
  // Organization profiles cannot be deleted from under their audit trail: archive them (not served, not listed).
  sql(`UPDATE semantic_profiles SET archived_at = now(), updated_at = now() WHERE key LIKE 'e2e_2807_%' AND archived_at IS NULL`);
  await ref?.api.dispose();
  await story?.api.dispose();
});

test.describe('AXI-2807 profile versions, following the latest, re-match @SI-014 @SI-013 @SI-065 @SI-010 @SI-002', () => {
  test('NFR2 — 4.1: before any new version, Demo 2411 reads as on main (contract, mappings, question data)', { tag: ['@SI-014', '@SI-065'] }, async () => {
    expect(versionsOf(SOURCE_PROFILE), `a previous run seeded a version: recreate ${STORY_DB} from its template first`).toEqual(['1.0.0']);
    for (const p of [`/api/v1/projects/${DEMO_2411}/semantic-contract`, `/api/v1/projects/${DEMO_2411}/field-mappings`]) {
      const [a, b] = [await ok(ref, 'GET', p, WS_A), await ok(story, 'GET', p, WS_A)];
      expect(JSON.stringify(b), p).toBe(JSON.stringify(a));
    }
    const [qa, qb] = [await questionDataOf(ref, DEMO_2411), await questionDataOf(story, DEMO_2411)];
    expect(Object.keys(qa).length).toBeGreaterThan(0);
    expect(JSON.stringify(qb)).toBe(JSON.stringify(qa));
    expect(await rematchOf(DEMO_2411)).toEqual({ projectId: DEMO_2411, status: 'none' });
  });

  test('FR31 — the save and archive need their own rights: the unchanged Admin role is refused (403)', { tag: ['@SI-010'] }, async () => {
    const latest = latestOf(KEY);
    expect((await saveVersion({ baseVersion: latest.version })).status).toBe(403);
    expect((await call(story, 'POST', `${P}/${KEY}/archive`, WS_A)).status).toBe(403);
    expect(versionsOf(KEY)).toEqual([latest.version]);
    grantProfileRights();
  });

  let project: string;
  let human: string;
  let rowsBeforeRematch: string[] = [];
  test('FR50, FR51 — 4.2: a no-op save writes nothing; a change is numbered by the server, audited and served', { tag: ['@SI-014', '@SI-010', '@SI-002'] }, async () => {
    project = await createProject('rematch', { semanticProfileIds: [KEY] });
    for (const d of [DS_ORGANS, DS_STATS]) await ok(story, 'POST', `/api/v1/projects/${project}/datasets`, WS_A, { datasetId: d });
    expect(rowOf(project, DS_ORGANS, 'organ_canonical')).toContain('|-|unmatched|auto|');
    // One matched row made `human` (no route writes one today).
    human = rowOf(project, DS_ORGANS, 'subject_id').split('|')[0];
    sql(`UPDATE project_field_mappings SET source = 'human' WHERE id = ${lit(human)}`);

    const latest = latestOf(KEY);
    const noop = await saveVersion({ baseVersion: latest.version, manifest: { version: '9.9.9' }, registries: latest.registries });
    expect(noop.status, JSON.stringify(noop.body)).toBe(201);
    expect(noop.body).toEqual({ profileId: KEY, version: latest.version, unchanged: true });
    expect(versionsOf(KEY)).toEqual([latest.version]);

    rowsBeforeRematch = rowsOf(project);
    const saved = await saveVersion({
      baseVersion: latest.version,
      manifest: { version: '9.9.9', display_name: `E2E 2807 ${KEY} v2` },
      registries: [withAliases(latest, 'aliases.microbiota_coating.default.v1', { organ_involvement: ['organ_canonical'] })],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ profileId: KEY, version: '1.1.0', unchanged: false, rematchRequested: 1 });
    expect(saved.body.contentIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(versionsOf(KEY)).toEqual(['1.0.0', '1.1.0']);
    const [audit] = sql(`SELECT json_build_object('actor', actor, 'before', before, 'after', after)::text FROM semantic_profile_audit_log WHERE action = 'version_saved' AND target = ${lit(`profile:${KEY}`)}`).map((r) => JSON.parse(r));
    expect(audit).toMatchObject({ actor: adminId, before: { version: '1.0.0' }, after: { version: '1.1.0', contentIdentity: saved.body.contentIdentity, rematchRequested: 1 } });
    const resolved = await ok(story, 'GET', `${P}/${KEY}/resolved`, WS_A);
    expect(resolved.profile.version).toBe('1.1.0');
    expect(resolved.aliasMap.organ_involvement).toContain('organ_canonical');
    expect(rowsBeforeRematch.length).toBeGreaterThan(0);
  });

  test('AC43, AC45, FR52, FR54, EC23 — 4.3: the re-match fills the new alias, keeps the human row and deletes nothing', { tag: ['@SI-014', '@SI-013'] }, async () => {
    const run = await settled(project);
    expect(run, JSON.stringify(run)).toMatchObject({ status: 'succeeded', failedDatasetIds: [] });
    expect(run.report.totals).toMatchObject({ filled: 1, preservedHuman: 1, failed: 0 });
    const rows = rowsOf(project);
    const humanRow = rows.find((r) => r.startsWith(`${human}|`))!;
    expect(humanRow).toMatch(/\|human\|[^|]*@1\.0\.0\+cid1:/); // byte-identical: still the old identity
    expect(rowOf(project, DS_ORGANS, 'organ_canonical')).toMatch(new RegExp(`\\|organ_involvement\\|matched\\|auto\\|${KEY}@1\\.1\\.0\\+cid1:${(await ok(story, 'GET', `${P}/${KEY}/resolved`, WS_A)).registryHash}\\|`));
    // Nothing deleted, nothing added (every column already had a row), and only the filled row moved.
    const ids = (rs: string[]) => rs.map((r) => r.split('|')[0]).sort();
    expect(ids(rows)).toEqual(ids(rowsBeforeRematch));
    const moved = rows.filter((r) => !rowsBeforeRematch.includes(r));
    expect(moved.map((r) => r.split('|')[2])).toEqual(['organ_canonical']);
    // AC45: no declaration, no recomputed column profile.
    expect(sql(`SELECT count(*) FROM dataset_semantic_declarations WHERE dataset_id IN (${lit(DS_ORGANS)}, ${lit(DS_STATS)})`)).toEqual(['0']);
  });

  test('EC21, FR50 — 5.1: two saves on one base at once: one is written, the other is refused as stale', { tag: ['@SI-014'] }, async () => {
    const latest = latestOf(KEY);
    const bodies = ['e2e_2807_race_a', 'e2e_2807_race_b'].map((t) => ({
      baseVersion: latest.version,
      registries: [withAliases(latest, 'aliases.microbiota_coating.default.v1', { coating_pct: [t] })],
    }));
    const answers = await Promise.all(bodies.map((b) => saveVersion(b)));
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
    const refused = answers.find((a) => a.status === 409)!;
    expect(String(refused.body.message)).toMatch(/^semantic_profile_version_stale/);
    expect(versionsOf(KEY)).toEqual(['1.0.0', '1.1.0', '1.2.0']);
    expect((await settled(project)).status).toBe('succeeded');
  });

  test('AC44, FR53, EC12 — 5.2: a failing dataset keeps its rows, is named, and the retry fills it', { tag: ['@SI-014', '@SI-013'] }, async () => {
    const statsRows = rowsOf(project).filter((r) => r.split('|')[1] === DS_STATS);
    const statsHeader = statsRows.find((r) => r.includes('|-|unmatched|'))!.split('|')[2];
    sql(
      `CREATE FUNCTION ${FAULT}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id = ${lit(project)} AND NEW.dataset_id = ${lit(DS_ORGANS)} THEN RAISE EXCEPTION 'e2e fault'; END IF; RETURN NEW; END $$; ` +
        `CREATE TRIGGER ${FAULT} BEFORE INSERT OR UPDATE ON project_field_mappings FOR EACH ROW EXECUTE FUNCTION ${FAULT}()`,
    );
    const organsBefore = rowsOf(project).filter((r) => r.split('|')[1] === DS_ORGANS);
    const latest = latestOf(KEY);
    const saved = await saveVersion({
      baseVersion: latest.version,
      registries: [withAliases(latest, 'aliases.microbiota_coating.default.v1', { autoantibody: ['term_as_written'], cell_count: [statsHeader] })],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const failed = await settled(project);
    expect(failed, JSON.stringify(failed)).toMatchObject({ status: 'failed', failedDatasetIds: [DS_ORGANS] });
    expect(JSON.stringify(failed.report)).not.toContain('e2e fault'); // codes only, never messages (NFR15)
    expect(rowsOf(project).filter((r) => r.split('|')[1] === DS_ORGANS)).toEqual(organsBefore);
    expect(rowOf(project, DS_STATS, statsHeader)).toContain('|cell_count|matched|auto|');

    dropFault();
    const retry = await call(story, 'POST', `${P}/projects/${project}/rematch`, WS_A);
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    const after = await eventually(() => rematchOf(project), (r) => r.status === 'succeeded' && r.attempts > failed.attempts);
    expect(after, JSON.stringify(after)).toMatchObject({ status: 'succeeded', failedDatasetIds: [] });
    expect(rowOf(project, DS_ORGANS, 'term_as_written')).toContain('|autoantibody|matched|auto|');
    expect(rowsOf(project).find((r) => r.startsWith(`${human}|`))).toContain('|human|');
  });

  test('FR57, EC11 — 5.3: a version that breaks a selection is refused, naming the project; nothing written', { tag: ['@SI-014'] }, async () => {
    const pair = await createProject('pair', { semanticProfileIds: [KEY, 'immune_mediated'] });
    const latest = latestOf(KEY);
    const versions = versionsOf(KEY);
    const refused = await saveVersion({
      baseVersion: latest.version,
      registries: [withAliases(latest, 'aliases.immunology.default.v1', { patient_id: ['e2e_2807_shared'] })],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(String(refused.body.message)).toMatch(/^profile_version_breaks_selection/);
    expect(JSON.stringify(refused.body)).toContain(pair);
    const errors = refused.body.errors as { rule: string; projectId: string }[];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.projectId === pair)).toBe(true);
    expect(errors.map((e) => e.rule)).toContain('registry-snapshot-conflict');
    expect(versionsOf(KEY)).toEqual(versions);
    expect(await rematchOf(pair)).toMatchObject({ status: 'none' });
  });

  test('FR35, FR50 — 5.4: a frozen profile, another organization, and malformed bodies are refused', { tag: ['@SI-014', '@SI-010'] }, async () => {
    const latest = latestOf(KEY);
    const versions = versionsOf(KEY);
    const frozen = await saveVersion({ baseVersion: '2.0.0' }, WS_A, 'immunology');
    expect(frozen.status, JSON.stringify(frozen.body)).toBe(409);
    expect(String(frozen.body.message)).toMatch(/^semantic_profile_frozen/);
    const foreign = await saveVersion({ baseVersion: latest.version }, WS_B);
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    const noId = await saveVersion({ baseVersion: latest.version, registries: [{ entries: {} }] });
    expect(noId.status, JSON.stringify(noId.body)).toBe(400);
    for (const body of [{ baseVersion: latest.version, version: '9.9.9' }, { baseVersion: latest.version, registries: 'x' }]) {
      const a = await saveVersion(body);
      expect(a.status, `${JSON.stringify(body)} → ${JSON.stringify(a.body)}`).toBe(400);
    }
    const stale = await saveVersion({ baseVersion: '1.0.0', manifest: { display_name: 'stale' } });
    expect(stale.status).toBe(409);
    expect(versionsOf(KEY)).toEqual(versions);
  });

  test('AC46, FR55, EC22 — 4.4: a seeded new system version re-matches Demo 2411 by the merge rule; its finalised plans do not move', { tag: ['@SI-014', '@SI-065', '@SI-013'] }, async () => {
    test.skip(!SEED_DIR, 'E2E_2807_SEED_DIR (the sidecar canonical-file directory) is not set');
    const sapBefore = sapVersionsDigest(DEMO_2411);
    const rowsBefore = rowsOf(DEMO_2411);
    const qBefore = await questionDataOf(story, DEMO_2411);
    const stored = versionsOf(SOURCE_PROFILE);
    const next = `1.${Number(stored.at(-1)!.split('.')[1]) + 1}.0`;
    const profileFile = path.join(SEED_DIR, 'profiles', `${SOURCE_PROFILE}.json`);
    const aliasFile = path.join(SEED_DIR, 'registries', 'aliases.microbiota_coating.default.v1.json');
    seedFileBackup = [profileFile, aliasFile].map((file) => ({ file, body: fs.readFileSync(file, 'utf8') }));
    const manifest = JSON.parse(seedFileBackup[0].body);
    const aliases = JSON.parse(seedFileBackup[1].body);
    aliases.entries.coating_pct = [...aliases.entries.coating_pct, `e2e_2807_seeded_${RUN}`];
    fs.writeFileSync(profileFile, JSON.stringify({ ...manifest, version: next }, null, 2));
    fs.writeFileSync(aliasFile, JSON.stringify(aliases, null, 2));

    const seeded = await ok(story, 'POST', `${P}/seed`, WS_A);
    expect(JSON.stringify(seeded)).toContain(SOURCE_PROFILE);
    expect(seeded.rematch?.projectsRequested).toBeGreaterThan(0);
    expect(versionsOf(SOURCE_PROFILE)).toEqual([...stored, next]);
    const run = await eventually(() => rematchOf(DEMO_2411), (r) => r.status === 'succeeded' || r.status === 'failed', 180_000);
    expect(run, JSON.stringify(run)).toMatchObject({ status: 'succeeded', failedDatasetIds: [] });
    const resolved = await ok(story, 'GET', `${P}/${SOURCE_PROFILE}/resolved`, WS_A);
    expect(resolved.profile.version).toBe(next); // FR51
    expect(sapVersionsDigest(DEMO_2411)).toBe(sapBefore); // FR55: no SAP row written

    // The merge rule, nothing else: the same rows, every field and status unchanged; the only rows
    // written are the ones the report names as stale-qualifier updates (rows stored before their
    // qualifiers were extracted, AXI-2390), now stamped with the new identity.
    const rowsAfter = rowsOf(DEMO_2411);
    const cols = (r: string) => r.split('|');
    expect(rowsAfter.map((r) => cols(r)[0])).toEqual(rowsBefore.map((r) => cols(r)[0]));
    expect(rowsAfter.map((r) => cols(r).slice(0, 6).join('|'))).toEqual(rowsBefore.map((r) => cols(r).slice(0, 6).join('|')));
    const updated = new Set<string>((run.report.datasets as { qualifiersUpdated: string[] }[]).flatMap((d) => d.qualifiersUpdated));
    expect(run.report.totals).toMatchObject({ filled: 0, created: 0, autoKeepDivergences: 0, failed: 0 });
    const moved = rowsAfter.filter((r) => !rowsBefore.includes(r));
    expect(new Set(moved.map((r) => cols(r)[2]))).toEqual(updated);
    for (const r of moved) expect(cols(r)[6]).toBe(`${SOURCE_PROFILE}@${next}+cid1:${resolved.registryHash}`);

    // EC22: the question data reads the same columns; a pin can only now drift onto a row the
    // re-match actually re-wrote (the new identity), never onto a row it kept.
    const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'pinDrift' ? undefined : x)));
    const qAfter = await questionDataOf(story, DEMO_2411);
    expect(strip(qAfter)).toEqual(strip(qBefore));
    const drifts = (v: unknown) => JSON.stringify(v).match(/"actualConfigVersion":"[^"]*"/g) ?? [];
    const newDrift = drifts(qAfter).filter((d) => !drifts(qBefore).includes(d));
    for (const d of newDrift) expect(d).toContain(`${SOURCE_PROFILE}@${next}+cid1:`);
    for (const { file, body } of seedFileBackup) fs.writeFileSync(file, body);
    seedFileBackup = [];
  });

  test('AC47, FR56, EC8 — 5.5: archive is refused while selected; then archived, its versions kept', { tag: ['@SI-014', '@SI-010'] }, async () => {
    const selected = await call(story, 'POST', `${P}/${KEY}/archive`, WS_A);
    expect(selected.status, JSON.stringify(selected.body)).toBe(409);
    expect(String(selected.body.message)).toMatch(/^semantic_profile_selected/);
    for (const id of created) expect(JSON.stringify(selected.body)).toContain(id);
    const system = await call(story, 'POST', `${P}/system/immunology/archive`, WS_A);
    expect(system.status, JSON.stringify(system.body)).toBe(409);
    expect(sql(`SELECT count(*) FROM semantic_profiles WHERE archived_at IS NOT NULL AND key = 'immunology'`)).toEqual(['0']);
    // The organization route never archives a system profile, nor the system route an organization one.
    expect((await call(story, 'POST', `${P}/immunology/archive`, WS_A)).status).toBe(404);
    expect((await call(story, 'POST', `${P}/system/${KEY}/archive`, WS_A)).status).toBe(404);

    const versions = versionsOf(KEY);
    while (created.length) await deleteProject(created.pop()!);
    const archived = await call(story, 'POST', `${P}/${KEY}/archive`, WS_A);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body).toMatchObject({ profileId: KEY, archivedAt: expect.any(String) });
    const listed = await eventually(() => ok<any[]>(story, 'GET', P, WS_A), (l) => !l.some((p) => p.id === KEY), 8_000);
    expect(listed.map((p) => p.id)).not.toContain(KEY);
    expect(versionsOf(KEY)).toEqual(versions);
  });

  test('FR37, NFR15 — §6: one audit row per saved version and per archive; the re-match row records its request', { tag: ['@SI-014', '@SI-013'] }, async () => {
    const actions = sql(`SELECT action || '|' || actor FROM semantic_profile_audit_log WHERE target = ${lit(`profile:${KEY}`)} ORDER BY performed_at, id`);
    expect(actions).toEqual([...Array(3).fill(`version_saved|${adminId}`), `archive|${adminId}`]);
    const [request] = sql(`SELECT reason || '|' || requested_by FROM project_semantic_profile_rematches WHERE project_id = ${lit(DEMO_2411)}`);
    expect(request).toMatch(/^.+\|.+$/);
    const sidecar = process.env.E2E_2807_SIDECAR?.trim() || 'axiome-2807-backend';
    if (!/^[a-z0-9-]+$/.test(sidecar)) throw new Error(`unsafe container name: ${sidecar}`);
    const logs = execFileSync('sh', ['-c', `docker logs ${sidecar} 2>&1`], { maxBuffer: 256 * 1024 * 1024 }).toString();
    const rematchLines = logs.split('\n').filter((l) => l.includes('semantic_profile.rematch'));
    expect(rematchLines.length).toBeGreaterThan(0);
    for (const header of ['organ_canonical', 'term_as_written', 'e2e fault']) expect(rematchLines.join('\n')).not.toContain(header);
  });
});
