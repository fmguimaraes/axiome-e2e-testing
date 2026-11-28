import { spawn, spawnSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { expect, test, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';

/**
 * AXI-2804 (epic AXI-2802 — Semantic Profile Management, area A2): the database profile store,
 * the seed and the cutover. Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md`
 * § AXI-2804 (4.1–4.6, 5.1–5.5; 5.6 is manual).
 *
 * E2E CONTRACT — an A/B over the REAL gateway, API level, as `admin@cro-one.com` only:
 *   - REFERENCE = `REF_API_BASE_URL` (default `http://localhost:3000`, the shared demo = `main`,
 *     profiles served from the FILES);
 *   - STORY     = `API_BASE_URL`: the branch's sidecar (`E2E_2804_SIDECAR`, default
 *     `axiome-2804-backend`), profiles served from the DATABASE. Its organization database is the
 *     THROWAWAY `E2E_2804_DB` (default `axiome_axi2804`): a read-only `pg_dump` of the demo
 *     `organization_svc`, migrated and cut over by the branch. The shared demo DB is never
 *     migrated and never written by this spec.
 * Every read is made on both stacks and must be equal (A2 allows NO §10.4 difference of its own).
 * Writes go to the story stack only, i.e. to the throwaway database: seed fixtures
 * (`fixtures/AXI-2804/`, keys `e2e_2804_`), throwaway projects (`E2E AXI-2804 …`), a dataset link.
 * SQL runs only against `E2E_2804_DB` and its `_fresh` sibling (both must start `axiome_axi2804`),
 * and the fresh sibling is dropped and re-created by 5.4. The seed CLI runs inside the sidecar.
 * NFR5 compares with the baseline the developer captured before `migrate deploy`
 * (`E2E_2804_NFR5_BASELINE`, JSON `{ table: [count, md5] }`).
 */

const REF_API_BASE_URL = (process.env.REF_API_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = process.env.E2E_2804_EMAIL?.trim() || 'admin@cro-one.com';
const PASSWORD = process.env.E2E_2804_PASSWORD?.trim() || 'admin';
const SIDECAR = process.env.E2E_2804_SIDECAR?.trim() || 'axiome-2804-backend';
const STORY_DB = process.env.E2E_2804_DB?.trim() || 'axiome_axi2804';
const FRESH_DB = `${STORY_DB}_fresh`;
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'axiome-localhost';
const NFR5_BASELINE = process.env.E2E_2804_NFR5_BASELINE?.trim();
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'AXI-2804');
const SHIPPED_CONFIG = '/app/apps/organization-service/src/semantic-profiles/config';

if (!/^axiome_axi2804[a-z0-9_]*$/.test(STORY_DB)) throw new Error(`E2E_2804_DB must name a throwaway axiome_axi2804* database, got ${STORY_DB}`);
if (REF_API_BASE_URL === API_BASE_URL) throw new Error('AXI-2804 is an A/B: API_BASE_URL must be the story sidecar, not the reference stack');

const WS_MAG4 = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const WS_IO = '81bc7740-7dd0-45d6-9b8e-b7fdef861078';
const RIAZ = { id: 'ba5d1363-a7d3-485f-8907-6e046dfce514', ws: WS_IO };
const DEMO_2411 = { id: '634d1c6d-4209-446a-aa0d-733d825c1fea', ws: WS_MAG4 };
const RIAZ_DATASET = '5cc64377-1459-4bde-a7e2-65af8c29ef49';
const FIVE = ['immune_mediated', 'immune_mediated_microbiota', 'immuno_oncology', 'immunology', 'oncology'];
const PROJECT_PREFIX = 'E2E AXI-2804';
/** Per-run suffix for the profiles whose stored history a scenario depends on (versions are never deleted). */
const RUN = Date.now().toString(36);
const BUMP = `e2e_2804_bump_${RUN}`;
const INVALID = `e2e_2804_invalid_${RUN}`;

interface Stack { name: string; base: string; api: APIRequestContext }
let ref: Stack;
let story: Stack;
const createdProjects: string[] = [];
let linked: { projectId: string; datasetId: string } | null = null;

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

function sql(statement: string, db: string = STORY_DB): string[] {
  if (!db.startsWith('axiome_axi2804')) throw new Error(`refusing SQL on ${db}`);
  const out = execFileSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'axiome', '-d', db, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { stdio: 'pipe' }).toString();
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** A SQL statement that must FAIL; returns its error text. */
function sqlRefused(statement: string): string {
  const run = spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'axiome', '-d', STORY_DB, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf-8' });
  expect(run.status, `expected a refusal: ${statement}`).not.toBe(0);
  return run.stderr;
}

const uuid = (id: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`not a uuid: ${id}`);
  return id;
};

/** The story stack's organization database URL with another database name (never printed). */
function storyDbUrl(db: string): string {
  const url = execFileSync('docker', ['exec', SIDECAR, 'printenv', 'ORGANIZATION_DATABASE_URL']).toString().trim();
  if (!url.includes(`/${STORY_DB}?`)) throw new Error('the sidecar is not on the story database');
  return url.replace(`/${STORY_DB}?`, `/${db}?`);
}

interface SeedReport {
  trigger: string;
  added: { key: string; version: string }[];
  unchanged: { key: string; version: string }[];
  refused: { key: string; version: string | null; issues: { rule: string }[] }[];
  ledgerEntriesWritten: number;
}

let seedRun = 0;
/**
 * Runs the seed CLI in the sidecar over the shipped config plus the given fixture dirs. Async (a
 * child process), so two runs started together really overlap (5.4).
 */
async function seedCli(fixtureDirs: string[], options: { db?: string; rename?: [string, string] } = {}): Promise<{ code: number; report: SeedReport }> {
  const dir = `/tmp/e2e-2804-seed-${process.pid}-${++seedRun}`;
  execFileSync('docker', ['exec', SIDECAR, 'sh', '-c', `rm -rf ${dir} && cp -r ${SHIPPED_CONFIG} ${dir}`]);
  for (const fixture of fixtureDirs) execFileSync('docker', ['cp', `${path.join(FIXTURES, fixture)}/.`, `${SIDECAR}:${dir}/`]);
  if (options.rename) {
    const [from, to] = options.rename;
    if (![from, to].every((k) => /^e2e_2804_[a-z0-9_]+$/.test(k))) throw new Error('fixture keys only');
    execFileSync('docker', ['exec', '-u', '0', SIDECAR, 'sh', '-c', `sed -i 's/"profile_id": "${from}"/"profile_id": "${to}"/' ${dir}/profiles/*.json`]);
  }
  const env = options.db ? ['-e', `ORGANIZATION_DATABASE_URL=${storyDbUrl(options.db)}`] : [];
  const args = ['exec', ...env, SIDECAR, 'node_modules/.bin/ts-node', '--transpile-only', '-r', 'tsconfig-paths/register', 'scripts/seed-semantic-profiles.ts', '--config-dir', dir, '--actor', 'e2e:axi-2804'];
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('docker', args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (c) => resolve({ code: c, stdout: out, stderr: err }));
  });
  expect([0, 3], `seed CLI exit ${code}: ${stderr.slice(-2000)}`).toContain(code);
  return { code: code!, report: JSON.parse(stdout) as SeedReport };
}

/** The sidecar's log since `since`, stdout and stderr together. */
function sidecarLog(since: string): string {
  const run = spawnSync('docker', ['logs', '--since', since, SIDECAR], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  return `${run.stdout}\n${run.stderr}`;
}

async function open(name: string, base: string): Promise<Stack> {
  const bootstrap = await apiRequest.newContext();
  const res = await bootstrap.post(`${base}/api/v1/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  expect(res.ok(), `${name} login → ${res.status()}`).toBeTruthy();
  const { accessToken } = await res.json();
  await bootstrap.dispose();
  return { name, base, api: await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } }) };
}

async function get<T = any>(s: Stack, p: string, ws?: string): Promise<T> {
  const res = await s.api.get(`${s.base}${p}`, { headers: ws ? { 'X-Workspace-Id': ws } : {} });
  expect(res.status(), `${s.name} GET ${p}: ${await res.text()}`).toBe(200);
  return res.json();
}

/** Order-sensitive: compares the JSON text, so a reordered key or array fails. */
const text = (v: unknown) => JSON.stringify(v);

async function createProject(profileId: string, label: string): Promise<string> {
  const res = await story.api.post(`${story.base}/api/v1/projects`, {
    headers: { 'X-Workspace-Id': WS_IO },
    data: { name: `${PROJECT_PREFIX} ${label} ${Date.now()}`, workspaceId: WS_IO, semanticProfileIds: [profileId] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id: string = (await res.json()).id;
  createdProjects.push(id);
  return id;
}

async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, withinMs: number): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return { value, ms: Date.now() - start };
    if (Date.now() - start > withinMs) return { value, ms: Date.now() - start };
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The CLI writes from another process: the story service serves it after its next poll (NFR9, < 5 s). */
async function servedWithin5s(profileId: string, version?: string): Promise<void> {
  const seen = await eventually(
    () => get<any[]>(story, '/api/v1/semantic-profiles'),
    (list) => list.some((p) => p.id === profileId && (!version || p.version === version)),
    5_000,
  );
  expect(seen.value.map((p) => `${p.id}@${p.version}`), `${profileId} served after ${seen.ms} ms`).toContain(`${profileId}@${version ?? seen.value.find((p) => p.id === profileId)?.version}`);
}

/** FR9 rows: count + md5 per table, excluding what this spec itself creates (`E2E AXI-2804 …`). */
function fr9Checksums(): Record<string, [number, string]> {
  const specProjects = `(SELECT id FROM organization_svc.projects WHERE name LIKE '${PROJECT_PREFIX}%')`;
  const agg = (table: string, where = '') =>
    `SELECT '${table}', count(*), md5(coalesce(string_agg(md5(t::text), '' ORDER BY md5(t::text)), '')) FROM organization_svc.${table} t ${where}`;
  const rows = sql(
    [
      agg('project_field_mappings', `WHERE t.project_id NOT IN ${specProjects}`),
      agg('sap_drafts'),
      agg('sap_versions'),
      agg('dataset_semantic_declarations'),
      agg('project_semantic_profile_extensions', `WHERE t.project_id NOT IN ${specProjects}`),
      agg('projects', `WHERE t.name NOT LIKE '${PROJECT_PREFIX}%'`),
    ].join(' UNION ALL '),
  );
  return Object.fromEntries(rows.map((r) => { const [t, c, m] = r.split('|'); return [t, [Number(c), m]]; }));
}

// ─── suite ───────────────────────────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(async () => {
  ref = await open('reference', REF_API_BASE_URL);
  story = await open('story', API_BASE_URL);
});

test.afterAll(async () => {
  if (story) {
    if (linked) await story.api.delete(`${story.base}/api/v1/projects/${linked.projectId}/datasets/${linked.datasetId}`, { headers: { 'X-Workspace-Id': WS_IO } });
    for (const id of createdProjects) await story.api.delete(`${story.base}/api/v1/projects/${id}`, { headers: { 'X-Workspace-Id': WS_IO } });
  }
  await ref?.api.dispose();
  await story?.api.dispose();
});

test.describe('AXI-2804 database profile store, seed and cutover @SI-014 @SI-013', () => {
  test('AC14, AC22, NFR5 — 5.5: the migration and cutover rewrote no stored row; re-running the migration is a no-op', { tag: ['@SI-013'] }, async () => {
    test.skip(!NFR5_BASELINE, 'E2E_2804_NFR5_BASELINE (captured before migrate deploy) is not set');
    const baseline = JSON.parse(fs.readFileSync(NFR5_BASELINE!, 'utf-8')) as Record<string, [number, string]>;
    expect(fr9Checksums()).toEqual(baseline);
    const deploy = spawnSync('docker', ['exec', SIDECAR, 'node_modules/.bin/prisma', 'migrate', 'deploy', '--schema', 'apps/organization-service/src/prisma/schema.prisma'], { encoding: 'utf-8' });
    expect(deploy.status, deploy.stderr).toBe(0);
    expect(deploy.stdout).toContain('No pending migrations to apply');
    expect(fr9Checksums()).toEqual(baseline);
  });

  test('AC15, AC22, FR22 — 4.1: the cutover seeded the five frozen system profiles and wrote the ledger', { tag: ['@SI-014', '@SI-013'] }, async () => {
    const profiles = sql(
      `SELECT p.key || '|' || p.scope || '|' || p.origin || '|' || p.frozen || '|' || string_agg(v.version, ',' ORDER BY v.created_at) ` +
        `FROM organization_svc.semantic_profiles p JOIN organization_svc.semantic_profile_versions v ON v.profile_id = p.id ` +
        `WHERE p.key NOT LIKE 'e2e_2804_%' GROUP BY p.seq, p.key, p.scope, p.origin, p.frozen ORDER BY p.seq`,
    );
    expect(profiles).toEqual(FIVE.map((k) => `${k}|system|seeded|true|${['immune_mediated', 'immune_mediated_microbiota'].includes(k) ? '1.0.0' : '2.0.0'}`));
    const ledger = sql(
      `SELECT source || '|' || count(*) || '|' || count(profile_version_id) FROM organization_svc.semantic_profile_identity_ledger GROUP BY source ORDER BY source`,
    );
    expect(ledger[1]).toBe('platform|7|7');
    const [, extensions, linkedExt] = ledger[0].split('|');
    expect(ledger[0].startsWith('extension|')).toBe(true);
    expect(Number(extensions)).toBeGreaterThan(0);
    expect(linkedExt).toBe(extensions);
    // Every distinct stored identity string is a ledger entry or a current cid1 identity (NFR5).
    const orphans = sql(
      `WITH held AS (` +
        `SELECT DISTINCT m.project_id, m.config_version AS identity FROM organization_svc.project_field_mappings m WHERE m.config_version IS NOT NULL ` +
        `UNION SELECT DISTINCT NULL, substr(d.declared_by, 25) FROM organization_svc.dataset_semantic_declarations d WHERE d.declared_by LIKE 'system:semantic-profile:%' ` +
        `UNION SELECT DISTINCT s.project_id, p #>> '{}' FROM organization_svc.sap_versions v JOIN organization_svc.saps s ON s.id = v.sap_id, jsonb_path_query(v.plan::jsonb, 'strict $.**.profilePin') p` +
        `) SELECT DISTINCT h.identity FROM held h WHERE NOT EXISTS (SELECT 1 FROM organization_svc.semantic_profile_identity_ledger l WHERE l.identity = h.identity AND (l.project_id IS NULL OR h.project_id IS NULL OR l.project_id = h.project_id)) ` +
        `AND NOT (h.identity LIKE '%+cid1:%' AND EXISTS (SELECT 1 FROM organization_svc.semantic_profile_versions sv WHERE h.identity LIKE '%+cid1:' || sv.content_identity))`,
    );
    expect(orphans).toEqual([]);
  });

  test('AC22, AC60, AC69, FR15, FR16 — 4.2: the five profiles served from the database equal the files, order included', { tag: ['@SI-014'] }, async () => {
    const [a, b] = await Promise.all([get<any[]>(ref, '/api/v1/semantic-profiles'), get<any[]>(story, '/api/v1/semantic-profiles')]);
    expect(text(b.filter((p) => !String(p.id).startsWith('e2e_2804_')))).toBe(text(a));
    for (const id of FIVE) {
      for (const route of ['resolved', 'config']) {
        const [ra, rb] = await Promise.all([get(ref, `/api/v1/semantic-profiles/${id}/${route}`), get(story, `/api/v1/semantic-profiles/${id}/${route}`)]);
        expect(text(rb), `${id}/${route}`).toBe(text(ra));
      }
    }
  });

  test('AC6, FR14 — 4.2: two fields claiming one token keep the file\'s order, so the first claimant still wins', { tag: ['@SI-014'] }, async () => {
    const { report } = await seedCli(['first-claimant']);
    expect(report.refused).toEqual([]);
    expect([...report.added, ...report.unchanged].map((o) => o.key)).toContain('e2e_2804_claim');
    await servedWithin5s('e2e_2804_claim');
    const resolved = await get(story, '/api/v1/semantic-profiles/e2e_2804_claim/resolved');
    expect(Object.entries(resolved.aliasMap)).toEqual([
      ['zeta_field', ['shared_token', 'zeta']],
      ['alpha_field', ['shared_token', 'alpha']],
      ['mid_field', ['mid']],
    ]);
    expect(resolved.canonicalFields).toEqual(['zeta_field', 'alpha_field', 'mid_field']);
  });

  test('AC22, AC61, AC66, FR7 — 4.3: existing projects read the same from the database, pin drift included', { tag: ['@SI-014', '@SI-065'] }, async () => {
    for (const p of [RIAZ, DEMO_2411]) {
      for (const route of ['semantic-contract', 'field-mappings']) {
        const [a, b] = await Promise.all([get(ref, `/api/v1/projects/${p.id}/${route}`, p.ws), get(story, `/api/v1/projects/${p.id}/${route}`, p.ws)]);
        expect(text(b), `${p.id} ${route}`).toBe(text(a));
      }
    }
    const versions = sql(
      `SELECT s.id || '|' || v.id FROM organization_svc.saps s JOIN organization_svc.sap_versions v ON v.sap_id = s.id ` +
        `WHERE s.project_id = '${uuid(DEMO_2411.id)}' AND v.status = 'final' ORDER BY v.id`,
    );
    expect(versions.length, 'Demo 2411 has final SAP versions').toBeGreaterThan(0);
    for (const row of versions) {
      const [sapId, versionId] = row.split('|');
      const p = `/api/v1/projects/${DEMO_2411.id}/saps/${sapId}/versions/${versionId}/question-data`;
      const [a, b] = await Promise.all([get(ref, p, DEMO_2411.ws), get(story, p, DEMO_2411.ws)]);
      expect(text(b), `${versionId} question data (pinDrift included)`).toBe(text(a));
    }
  });

  test('AC22, AC61, AC13 — 4.4: link-time matching from the database writes the same rows as from the files', { tag: ['@SI-014', '@SI-013'] }, async () => {
    const projectId = await createProject('immuno_oncology', 'link');
    const link = await story.api.post(`${story.base}/api/v1/projects/${projectId}/datasets`, { headers: { 'X-Workspace-Id': WS_IO }, data: { datasetId: RIAZ_DATASET } });
    expect(link.status(), await link.text()).toBe(201);
    linked = { projectId, datasetId: RIAZ_DATASET };
    const rows = await get(story, `/api/v1/projects/${projectId}/datasets/${RIAZ_DATASET}/field-mappings`, WS_IO);
    const riazRows = await get(ref, `/api/v1/projects/${RIAZ.id}/datasets/${RIAZ_DATASET}/field-mappings`, RIAZ.ws);
    expect(text(rows)).toBe(text(riazRows));
    const contract = await get(story, `/api/v1/projects/${projectId}/semantic-contract`, WS_IO);
    const refContract = await get(ref, `/api/v1/projects/${RIAZ.id}/semantic-contract`, RIAZ.ws);
    expect(contract.profile.configVersion).toBe(refContract.profile.configVersion);
    expect(sql(`SELECT DISTINCT config_version FROM organization_svc.project_field_mappings WHERE project_id = '${uuid(projectId)}'`)).toEqual([contract.profile.configVersion]);
  });

  test('AC15, AC21, FR21 — 4.5: the manual seed is idempotent', { tag: ['@SI-014'] }, async () => {
    const count = () => sql('SELECT (SELECT count(*) FROM organization_svc.semantic_profiles) || \'|\' || (SELECT count(*) FROM organization_svc.semantic_profile_versions) || \'|\' || (SELECT count(*) FROM organization_svc.semantic_profile_identity_ledger)')[0];
    const before = count();
    for (let n = 0; n < 2; n += 1) {
      const { code, report } = await seedCli([]);
      expect(code).toBe(0);
      expect(report.unchanged.map((u) => u.key)).toEqual(FIVE);
      expect(report.added).toEqual([]);
      expect(report.ledgerEntriesWritten).toBe(0);
    }
    expect(count()).toBe(before);
  });

  test('AC17, AC20, NFR9, FR19 — 4.6: a newer version is added next to the old one; projects and every instance follow it', { tag: ['@SI-014'] }, async () => {
    const first = (await seedCli(['bumped/v1'], { rename: ['e2e_2804_bump', BUMP] })).report;
    expect([...first.added, ...first.unchanged]).toContainEqual({ key: BUMP, version: '1.0.0' });
    await servedWithin5s(BUMP);
    const projectId = await createProject(BUMP, 'bump');
    const contractOf = () => get(story, `/api/v1/projects/${projectId}/semantic-contract`, WS_IO);
    expect((await contractOf()).profile.version).toBe('1.0.0');

    const second = (await seedCli(['bumped/v2'], { rename: ['e2e_2804_bump', BUMP] })).report;
    expect([...second.added, ...second.unchanged]).toContainEqual({ key: BUMP, version: '1.1.0' });
    expect(sql(`SELECT string_agg(v.version, ',' ORDER BY v.created_at) FROM organization_svc.semantic_profile_versions v JOIN organization_svc.semantic_profiles p ON p.id = v.profile_id WHERE p.key = '${BUMP}'`)).toEqual(['1.0.0,1.1.0']);
    // The seed ran in ANOTHER process (the CLI): the service serves it after its poll (NFR9: < 5 s).
    const followed = await eventually(contractOf, (c) => c.profile.version === '1.1.0', 5_000);
    expect(followed.value.profile.version, `served after ${followed.ms} ms`).toBe('1.1.0');
    expect(followed.value.canonicalFields).toContain('e2e_2804_bump_marker');
    const listed = (await get<any[]>(story, '/api/v1/semantic-profiles')).find((p) => p.id === BUMP);
    expect(listed).toMatchObject({ version: '1.1.0', displayName: 'E2E 2804 bump 1.1' });

    // A version written straight into the database, as another instance would.
    sql(
      `INSERT INTO organization_svc.semantic_profile_versions (id, profile_id, version, manifest_json, registries_json, content_identity, authored_by) ` +
        `SELECT gen_random_uuid()::text, v.profile_id, '1.2.0', replace(v.manifest_json, '"version":"1.1.0"', '"version":"1.2.0"'), v.registries_json, v.content_identity, 'e2e:axi-2804' ` +
        `FROM organization_svc.semantic_profile_versions v JOIN organization_svc.semantic_profiles p ON p.id = v.profile_id WHERE p.key = '${BUMP}' AND v.version = '1.1.0' ` +
        `AND NOT EXISTS (SELECT 1 FROM organization_svc.semantic_profile_versions x WHERE x.profile_id = v.profile_id AND x.version = '1.2.0')`,
    );
    const polled = await eventually(contractOf, (c) => c.profile.version === '1.2.0', 5_000);
    expect(polled.value.profile.version, `served after ${polled.ms} ms`).toBe('1.2.0');
  });

  test('AC16, EC1, FR20 — 5.1: a changed file whose version was not bumped is refused, the others are reported', { tag: ['@SI-014'] }, async () => {
    await seedCli(['unbumped/v1']);
    const storedBefore = sql(`SELECT md5(v::text) FROM organization_svc.semantic_profile_versions v JOIN organization_svc.semantic_profiles p ON p.id = v.profile_id WHERE p.key = 'e2e_2804_unbumped'`);
    const { code, report } = await seedCli(['unbumped/edited']);
    expect(code).toBe(3);
    expect(report.refused).toEqual([{ key: 'e2e_2804_unbumped', version: '1.0.0', issues: [expect.objectContaining({ rule: 'version-not-bumped' })] }]);
    expect(report.unchanged.map((u) => u.key)).toEqual(FIVE);
    expect(sql(`SELECT md5(v::text) FROM organization_svc.semantic_profile_versions v JOIN organization_svc.semantic_profiles p ON p.id = v.profile_id WHERE p.key = 'e2e_2804_unbumped'`)).toEqual(storedBefore);
  });

  test('AC18, FR13, FR17, NFR12 — 5.2: the database refuses to update or delete a version, or to change a key', { tag: ['@SI-013'] }, async () => {
    const [versionId] = sql(`SELECT v.id FROM organization_svc.semantic_profile_versions v JOIN organization_svc.semantic_profiles p ON p.id = v.profile_id WHERE p.key = 'oncology'`);
    expect(sqlRefused(`UPDATE organization_svc.semantic_profile_versions SET registries_json = '[]' WHERE id = '${versionId}'`)).toContain('append-only');
    expect(sqlRefused(`DELETE FROM organization_svc.semantic_profile_versions WHERE id = '${versionId}'`)).toContain('append-only');
    expect(sqlRefused(`UPDATE organization_svc.semantic_profiles SET key = 'oncology_renamed' WHERE key = 'oncology'`)).toContain('key is immutable');
    expect(sqlRefused(`DELETE FROM organization_svc.semantic_profiles WHERE key = 'oncology'`)).toContain('DELETE not allowed');
    expect(sqlRefused(`UPDATE organization_svc.semantic_profile_identity_ledger SET identity = 'x'`)).toContain('append-only');
  });

  test('AC19, EC3, FR23 — 5.3: an invalid stored version does not stop boot; its project gets the fallback contract', { tag: ['@SI-014'] }, async () => {
    await seedCli(['invalid'], { rename: ['e2e_2804_invalid', INVALID] });
    await servedWithin5s(INVALID, '1.0.0');
    const projectId = await createProject(INVALID, 'invalid');
    expect((await get(story, `/api/v1/projects/${projectId}/semantic-contract`, WS_IO)).fallbackMode).toBe(false);
    // A 1.1.0 whose aliases name a field the profile does not declare (made invalid "after a code change").
    sql(
      `INSERT INTO organization_svc.semantic_profile_versions (id, profile_id, version, manifest_json, registries_json, content_identity, authored_by) ` +
        `SELECT gen_random_uuid()::text, v.profile_id, '1.1.0', replace(v.manifest_json, '"version":"1.0.0"', '"version":"1.1.0"'), ` +
        `replace(v.registries_json, '"entries":{', '"entries":{"e2e_2804_undeclared_field":["e2e_2804_x"],'), v.content_identity, 'e2e:axi-2804' ` +
        `FROM organization_svc.semantic_profile_versions v JOIN organization_svc.semantic_profiles p ON p.id = v.profile_id WHERE p.key = '${INVALID}' AND v.version = '1.0.0' ` +
        `AND NOT EXISTS (SELECT 1 FROM organization_svc.semantic_profile_versions x WHERE x.profile_id = v.profile_id AND x.version = '1.1.0')`,
    );
    const since = new Date().toISOString();
    execFileSync('docker', ['restart', SIDECAR]);
    const booted = await eventually(
      async () => sidecarLog(since),
      (log) => log.includes('semantic_profile.catalog_loaded') && /\[gw\].*Nest application successfully started/.test(log) && /\[org\].*Nest application successfully started/.test(log),
      240_000,
    );
    expect(booted.value).toContain('semantic_profile.catalog_loaded');
    const errorLine = booted.value.split('\n').find((l) => l.includes('semantic_profile.invalid_stored_version') && l.includes(`"profileKey":"${INVALID}"`));
    expect(errorLine, 'one error names the key, the version and the issue').toBeTruthy();
    expect(errorLine).toContain(`"profileKey":"${INVALID}"`);
    expect(errorLine).toContain('"version":"1.1.0"');
    expect(errorLine).toContain('e2e_2804_undeclared_field');
    story = await open('story', API_BASE_URL);
    const contract = await get(story, `/api/v1/projects/${projectId}/semantic-contract`, WS_IO);
    expect(contract.fallbackMode).toBe(true);
    const listed = (await get<any[]>(story, '/api/v1/semantic-profiles')).map((p) => p.id);
    for (const id of FIVE) expect(listed).toContain(id);
    expect(listed).not.toContain(INVALID);
  });

  test('AC15, AC21, EC2, FR21, FR22 — 5.4: a fresh database is seeded through the same code; two seeds at once write once', { tag: ['@SI-014', '@SI-013'] }, async () => {
    sql(`DROP DATABASE IF EXISTS ${FRESH_DB}`, 'axiome_axi2804');
    sql(`CREATE DATABASE ${FRESH_DB}`, 'axiome_axi2804');
    const deploy = spawnSync(
      'docker',
      ['exec', '-e', `ORGANIZATION_DATABASE_URL=${storyDbUrl(FRESH_DB)}`, SIDECAR, 'node_modules/.bin/prisma', 'migrate', 'deploy', '--schema', 'apps/organization-service/src/prisma/schema.prisma'],
      { encoding: 'utf-8' },
    );
    expect(deploy.status, deploy.stderr.slice(-2000)).toBe(0);
    const [a, b] = await Promise.all([seedCli([], { db: FRESH_DB }), seedCli([], { db: FRESH_DB })]);
    expect(sql('SELECT count(*) FROM organization_svc.semantic_profile_versions', FRESH_DB)).toEqual(['5']);
    expect(sql('SELECT count(*) || \'|\' || count(DISTINCT identity) FROM organization_svc.semantic_profile_identity_ledger', FRESH_DB)).toEqual(['7|7']);
    expect([a.report.added.length, b.report.added.length].sort()).toEqual([0, 5]);
    expect(a.report.ledgerEntriesWritten + b.report.ledgerEntriesWritten).toBe(7);
  });
});
