import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { expect, test, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE_URL, BASE_URL } from '../../config/env';

/**
 * AXI-2810 (epic AXI-2802 — Semantic Profile Management, area A8): the semantic profile CRUD page.
 * Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md` § AXI-2810 (2810.1–2810.14).
 *
 * E2E CONTRACT — the REAL page in a real browser, as `admin@cro-one.com` only:
 *   - FRONT = `BASE_URL`: the branch's front-end on its own Vite (5174+, own cacheDir), never :5173;
 *   - API   = `API_BASE_URL`: the branch's backend sidecar (`axiome-axi2810-backend`, own RabbitMQ
 *     vhost `axi-2810`) whose organization AND user databases are the THROWAWAY `E2E_2810_DB`
 *     (default `axiome_axi2810`, a clone of A5's `axiome_axi2807`).
 * Every write goes through the UI or the branch's routes. The only SQL writes (on `E2E_2810_DB`
 * only, all undone in `afterAll`) are what no route can do: two roles admin's Mag4 membership is
 * pointed at (the seeded Admin role holds neither `semantic_profile:create/update/archive` — Super
 * Admin does, no login holds it here — nor a "no read" variant), and one `human` mapping row (no
 * route writes one today). There is no Investigator or platform-admin login in this environment.
 */

const EMAIL = process.env.E2E_2810_EMAIL?.trim() || 'admin@cro-one.com';
const PASSWORD = process.env.E2E_2810_PASSWORD?.trim() || 'admin';
const STORY_DB = process.env.E2E_2810_DB?.trim() || 'axiome_axi2810';
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'axiome-localhost';

if (!/^axiome_axi2810[a-z0-9_]*$/.test(STORY_DB)) throw new Error(`E2E_2810_DB must name a throwaway axiome_axi2810* database, got ${STORY_DB}`);
if (/:(3000|5173)$/.test(API_BASE_URL) || /:5173$/.test(BASE_URL)) throw new Error('AXI-2810 runs against the story sidecar and a worktree Vite, never the shared demo stack');

const WS = '8946e06a-4fe6-45ee-8d9a-58f7142e803a'; // Mag4
const DEMO_2411 = '634d1c6d-4209-446a-aa0d-733d825c1fea'; // Mag4, immune_mediated_microbiota, final SAP versions pinned to 1.0.0
const DS_ORGANS = 'd111027c-e03b-48a7-9f2e-fe8282b24cf0'; // 03-organ-involvement.csv (Mag4)
const SOURCE = 'immune_mediated';
const RUN = Date.now().toString(36);
const COPY = `e2e_2810_c_${RUN}`;
const EMPTY = `e2e_2810_e_${RUN}`;
const PROMOTED = `e2e_2810_s_${RUN}`;
const PARTNER = `e2e_2810_p_${RUN}`;
const PROJECT = `E2E AXI-2810 ${RUN}`;
const P = '/api/v1/semantic-profiles';
const XLSX_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'AXI-2810', 'two-sheets.xlsx');
const PROFILE_PERMS = ['semantic_profile:create', 'semantic_profile:update', 'semantic_profile:archive'];

let api: APIRequestContext;
let token: { access: string; refresh: string };
let orgId: string;
let membership: { id: string; roleId: string };
const roles: { noRead?: string; editor?: string } = {};
let projectId: string | undefined;
let defaultsBefore: string[] = [];

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

function psql(statement: string): string[] {
  if (!STORY_DB.startsWith('axiome_axi2810')) throw new Error(`refusing SQL on ${STORY_DB}`);
  const out = execFileSync('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'axiome', '-d', STORY_DB, '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, stdio: 'pipe' }).toString();
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}
const sql = (select: string) => psql(`SET search_path TO organization_svc; ${select}`).filter((l) => l !== 'SET');
const lit = (v: string) => {
  if (!/^[A-Za-z0-9_.:@+ -]+$/.test(v)) throw new Error(`unsafe literal: ${v}`);
  return `'${v}'`;
};

interface Answer { status: number; body: any }
async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', p: string, data?: unknown): Promise<Answer> {
  const res = await api.fetch(`${API_BASE_URL}${p}`, { method, headers: { 'X-Workspace-Id': WS }, timeout: 60_000, ...(data === undefined ? {} : { data }) });
  const raw = await res.text();
  let body: any = raw;
  try { body = JSON.parse(raw); } catch { /* text */ }
  return { status: res.status(), body };
}

function makeRole(name: string, perms: string[]): string {
  const [id] = sql(
    `INSERT INTO user_svc.roles (id, name, description, permissions, scope, updated_at, created_by) ` +
      `VALUES (gen_random_uuid()::text, ${lit(name)}, 'AXI-2810 E2E', '${JSON.stringify(perms)}'::jsonb, 'WORKSPACE', now(), 'e2e:axi-2810') RETURNING id`,
  );
  return id;
}
/**
 * Points admin's Mag4 membership at a role, then waits until the gateway serves it: the gateway
 * caches a caller's workspace permissions for 60 s (`WorkspacePermissionsResolver`), and the page
 * reads that same answer (`GET /workspace-permissions/me`).
 */
async function pointMembershipAt(roleId: string): Promise<void> {
  sql(`UPDATE workspace_members SET role_id = ${lit(roleId)} WHERE id = ${lit(membership.id)}`);
  const [expected] = sql(`SELECT permissions::text FROM user_svc.roles WHERE id = ${lit(roleId)}`);
  const want = (JSON.parse(expected) as string[]).filter((p) => p.startsWith('semantic_profile:')).sort();
  await expect.poll(async () => {
    const me = await call('GET', '/api/v1/workspace-permissions/me');
    return ((me.body?.permissions ?? []) as string[]).filter((p) => p.startsWith('semantic_profile:')).sort();
  }, { timeout: 90_000, intervals: [2_000] }).toEqual(want);
}

async function signIn(page: Page): Promise<void> {
  await page.addInitScript(([access, refresh, org, ws]) => {
    localStorage.setItem('access_token', access);
    localStorage.setItem('refresh_token', refresh);
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', ws);
  }, [token.access, token.refresh, orgId, WS] as const);
}

async function openPage(page: Page, route: string): Promise<void> {
  await signIn(page);
  await page.goto(`${BASE_URL}${route}`);
}

async function openDetail(page: Page, key: string): Promise<void> {
  await openPage(page, `/admin/semantic-profiles/${key}`);
  await expect(page.getByTestId('semantic-profile-detail')).toHaveAttribute('data-profile-id', key, { timeout: 30_000 });
}

/** Review (dry run), then save; returns the version the page wrote. */
async function reviewAndSave(page: Page): Promise<string> {
  await page.getByTestId('semantic-profile-review').click();
  const save = page.getByTestId('semantic-profile-save');
  await expect(save).toBeVisible({ timeout: 30_000 });
  const version = (await save.textContent())!.replace('Save version ', '').trim();
  await save.click();
  await expect(page.getByTestId('semantic-profile-notice')).toHaveText(new RegExp(`Saved version ${version.replace(/\./g, '\\.')}`), { timeout: 30_000 });
  return version;
}

const resolved = async (key: string) => {
  const a = await call('GET', `${P}/${key}/resolved`);
  expect(a.status, JSON.stringify(a.body)).toBe(200);
  return a.body;
};

/** A resolved profile's CONTENT: what a column means — no identity, no registry ids, no pack names. */
function contentOf(r: any): any {
  const strip = (v: any): any => Array.isArray(v) ? v.map(strip)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'registry_id').map(([k, x]) => [k, strip(x)])) : v;
  const { profile: _p, packs: _k, registryHash: _h, ...content } = r;
  return strip(content);
}

async function addSampleFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.getByTestId('semantic-profile-sample-open').click();
  await expect(page.getByTestId('sap-sample-drawer')).toBeVisible();
  await page.getByTestId('sap-sample-drawer').locator('input[type="file"]').setInputFiles(file);
}

// ─── suite ───────────────────────────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeAll(async () => {
  const anon = await apiRequest.newContext();
  const res = await anon.post(`${API_BASE_URL}/api/v1/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  expect(res.ok(), `login → ${res.status()}`).toBeTruthy();
  const { accessToken, refreshToken } = await res.json();
  await anon.dispose();
  token = { access: accessToken, refresh: refreshToken };
  api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const [adminId] = sql(`SELECT id FROM user_svc.users WHERE email = ${lit(EMAIL)}`);
  [orgId] = sql(`SELECT owner_organization_id FROM workspaces WHERE id = ${lit(WS)}`);
  const [row] = sql(`SELECT id || '|' || role_id FROM workspace_members WHERE workspace_id = ${lit(WS)} AND user_id = ${lit(adminId)}`);
  const [id, roleId] = row.split('|');
  membership = { id, roleId };
  const [adminPerms] = sql(`SELECT permissions::text FROM user_svc.roles WHERE id = ${lit(roleId)}`);
  const admin: string[] = JSON.parse(adminPerms);
  roles.noRead = makeRole(`E2E 2810 no profile read ${RUN}`, admin.filter((p) => !p.startsWith('semantic_profile:')));
  roles.editor = makeRole(`E2E 2810 profile editor ${RUN}`, Array.from(new Set([...admin, ...PROFILE_PERMS])));
});

test.afterAll(async () => {
  test.setTimeout(240_000);
  if (projectId) {
    sql(`DELETE FROM project_field_mappings WHERE project_id = ${lit(projectId)} AND source = 'human'`);
    await call('DELETE', `/api/v1/projects/${projectId}/datasets/${DS_ORGANS}`);
    await call('DELETE', `/api/v1/projects/${projectId}`);
  }
  if (roles.editor) {
    await pointMembershipAt(roles.editor);
    await call('PUT', `${P}/defaults`, { profileIds: defaultsBefore });
    await call('POST', `${P}/system/${PROMOTED}/archive`);
    for (const key of [COPY, EMPTY, PARTNER]) await call('POST', `${P}/${key}/archive`);
  }
  if (membership) sql(`UPDATE workspace_members SET role_id = ${lit(membership.roleId)} WHERE id = ${lit(membership.id)}`);
  for (const r of [roles.noRead, roles.editor]) if (r) sql(`DELETE FROM user_svc.roles WHERE id = ${lit(r)}`);
  await api?.dispose();
});

test('AXI-2810.1 FR58 — the page is gated on semantic_profile:read, never on a role name @SI-031 @SI-002', async ({ page }) => {
  await pointMembershipAt(roles.noRead!);
  expect((await call('GET', `${P}/catalog`)).status).toBe(403);
  await openPage(page, '/admin/semantic-profiles');
  await expect(page.getByTestId('semantic-profiles-denied')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('semantic-profiles-table')).toHaveCount(0);
  const navLink = page.getByRole('complementary').locator('a[href="/admin/semantic-profiles"]');
  await expect(navLink).toHaveCount(0);

  await pointMembershipAt(roles.editor!);
  await page.reload();
  await expect(page.getByTestId('semantic-profiles-table')).toBeVisible({ timeout: 30_000 });
  await expect(navLink).toBeVisible();
  await expect(page.getByTestId(`semantic-profile-row-${SOURCE}-frozen`)).toBeVisible();
  for (const tab of ['profiles', 'system', 'access', 'templates']) await expect(page.getByTestId(`semantic-profiles-tab-${tab}`)).toBeVisible();
  // FR62: a frozen seeded profile offers open + copy; nobody edits it.
  await expect(page.getByTestId(`semantic-profile-row-${SOURCE}-copy`)).toBeVisible();
  await expect(page.getByTestId(`semantic-profile-row-${SOURCE}-promote`)).toHaveCount(0);
});

test('AXI-2810.2 AC48 — a frozen profile is read only; a version save on it is refused @SI-031 @SI-014', async ({ page }) => {
  await openDetail(page, SOURCE);
  await expect(page.getByTestId('semantic-profile-frozen-note')).toBeVisible();
  await expect(page.getByTestId('semantic-profile-field-disease_group')).toBeVisible();
  await expect(page.getByTestId('semantic-profile-field-disease_group-label')).toHaveCount(0);
  await expect(page.getByTestId('semantic-profile-sample-open')).toHaveCount(0);
  await expect(page.getByTestId('semantic-profile-tab-advanced')).toHaveCount(0);
  await expect(page.getByTestId('semantic-profile-copy')).toBeVisible();
  const refused = await call('POST', `${P}/${SOURCE}/versions`, { baseVersion: '1.0.0', manifest: { display_name: 'x' } });
  expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
  expect(refused.status).toBeLessThan(500);
});

test('AXI-2810.3 AC49 — "Copy to my organization" makes an organization profile that resolves to exactly the source content @SI-031 @SI-010', async ({ page }) => {
  await openDetail(page, SOURCE);
  await page.getByTestId('semantic-profile-copy').click();
  await expect(page).toHaveURL(new RegExp(`/admin/semantic-profiles/new\\?copyFrom=${SOURCE}$`));
  await expect(page.getByTestId('semantic-profile-create-source')).toHaveValue(SOURCE);
  await expect(page.getByTestId('semantic-profile-create-key')).toHaveValue(`org_${SOURCE}`, { timeout: 30_000 });
  await page.getByTestId('semantic-profile-create-key').fill(COPY);
  await page.getByTestId('semantic-profile-create-name').fill(`E2E 2810 copy ${RUN}`);
  await page.getByTestId('semantic-profile-create-submit').click();
  await expect(page.getByTestId('semantic-profile-detail')).toHaveAttribute('data-profile-id', COPY, { timeout: 30_000 });
  await expect(page.getByTestId('semantic-profile-summary')).toContainText(`from ${SOURCE}`);
  await expect(page.getByTestId('semantic-profile-frozen-note')).toHaveCount(0);
  await expect(page.getByTestId('semantic-profile-field-disease_group-label')).toBeVisible();

  const [src, copy] = await Promise.all([resolved(SOURCE), resolved(COPY)]);
  expect(copy.profile.id).toBe(COPY);
  expect(contentOf(copy)).toEqual(contentOf(src));
  expect(copy.packs.every((p: string) => p.startsWith(`${COPY}__`))).toBe(true);
});

test('AXI-2810.4 AC51 AC52 — a CSV sample: a new column becomes a field (header as alias); the reviewed save writes a version @SI-031 @SI-065 @SI-014', async ({ page }) => {
  await openDetail(page, COPY);
  await addSampleFile(page, { name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from('crp_mg_l,patient_id\n3.1,P01\n5.4,P02\n') });
  await expect(page.getByTestId('sap-sample-row-crp_mg_l')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sap-sample-row-crp_mg_l-check').check();
  await page.getByTestId('sap-sample-add').click();
  await expect(page.getByTestId('sap-sample-drawer')).toHaveCount(0);
  await expect(page.getByTestId('semantic-profile-notice')).toContainText('1 field(s) added');
  await expect(page.getByTestId('semantic-profile-field-crp_mg_l')).toBeVisible();
  await expect(page.getByTestId('semantic-profile-field-crp_mg_l-aliases')).toHaveValue('crp_mg_l');

  const version = await reviewAndSave(page);
  await page.getByTestId('semantic-profile-tab-versions').click();
  await expect(page.getByTestId(`semantic-profile-version-${version}`)).toBeVisible();
  const r = await resolved(COPY);
  expect(r.profile.version).toBe(version);
  expect(r.canonicalFields).toContain('crp_mg_l');
  expect(r.aliasMap.crp_mg_l).toEqual(['crp_mg_l']);
});

test('AXI-2810.5 AC51 EC15 — an Excel sample asks which sheet and reads only that one; a cancelled pick reads nothing @SI-031 @SI-065', async ({ page }) => {
  await openDetail(page, COPY);
  const xlsx = { name: 'two-sheets.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fs.readFileSync(XLSX_FIXTURE) };
  await addSampleFile(page, xlsx);
  await expect(page.getByTestId('semantic-sheet-picker')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('semantic-sheet-picker-cancel').click();
  await expect(page.getByTestId('sap-sample-error')).toContainText('No sheet chosen for two-sheets.xlsx');
  await expect(page.getByTestId('sap-sample-row-il6_pg_ml')).toHaveCount(0);
  // The cancelled workbook keeps its error until removed; dropping it again asks again.
  await page.getByTestId('sap-sample-file-0-remove').click();
  await page.getByTestId('sap-sample-drawer').locator('input[type="file"]').setInputFiles(xlsx);
  await expect(page.getByTestId('semantic-sheet-picker-Notes')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('semantic-sheet-picker-Data').click();
  await page.getByTestId('semantic-sheet-picker-confirm').click();
  await expect(page.getByTestId('sap-sample-row-il6_pg_ml')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sap-sample-row-memo_text')).toHaveCount(0);
  // Adding another file re-reads the list but never asks about the workbook again.
  await page.getByTestId('sap-sample-drawer').locator('input[type="file"]').setInputFiles({ name: 'more.csv', mimeType: 'text/csv', buffer: Buffer.from('ldh_u_l\n210\n') });
  await expect(page.getByTestId('sap-sample-row-ldh_u_l')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('semantic-sheet-picker')).toHaveCount(0);
  await expect(page.getByTestId('sap-sample-row-il6_pg_ml')).toBeVisible();
  await page.getByTestId('sap-sample-row-il6_pg_ml-check').check();
  await page.getByTestId('sap-sample-add').click();
  await expect(page.getByTestId('semantic-profile-field-il6_pg_ml')).toBeVisible();
  // Nothing is saved until the reviewed save: discarding drops the working copy.
  await page.getByTestId('semantic-profile-discard').click();
  await expect(page.getByTestId('semantic-profile-field-il6_pg_ml')).toHaveCount(0);
  expect((await resolved(COPY)).canonicalFields).not.toContain('il6_pg_ml');
});

test('AXI-2810.6 FR65 FR60 — a field added by hand, its label, role and aliases edited, then saved @SI-031 @SI-014', async ({ page }) => {
  await openDetail(page, COPY);
  await page.getByTestId('profile-extension-new-field-label').fill('Ferritin level');
  await page.getByTestId('profile-extension-add-field').click();
  await expect(page.getByTestId('semantic-profile-field-ferritin_level')).toBeVisible();
  await page.getByTestId('semantic-profile-field-ferritin_level-role').selectOption('continuous_outcome');
  const aliases = page.getByTestId('semantic-profile-field-ferritin_level-aliases');
  await aliases.fill('ferritin, ferritin_ng_ml');
  await aliases.press('Enter');
  await reviewAndSave(page);
  const r = await resolved(COPY);
  expect(r.vocabulary.ferritin_level).toBe('Ferritin level');
  expect(r.templateRoles.ferritin_level).toBe('continuous_outcome');
  expect(r.aliasMap.ferritin_level).toEqual(['ferritin', 'ferritin_ng_ml']);
});

test('AXI-2810.7 AC53 EC16 — an alias another field claims is refused (case and separators ignored), on the page and by the server @SI-031 @SI-014', async ({ page }) => {
  await openDetail(page, COPY);
  const aliases = page.getByTestId('semantic-profile-field-ferritin_level-aliases');
  await aliases.fill('ferritin, DIAGNOSIS');
  await aliases.press('Enter');
  await expect(page.getByTestId('semantic-profile-refusal-message')).toHaveText('"DIAGNOSIS" is already an alias of "disease_group".');
  await expect(page.getByTestId('semantic-profile-savebar')).toHaveCount(0);

  // The server's check, reached through Advanced (the page's own check is bypassed there).
  await page.getByTestId('semantic-profile-tab-advanced').click();
  const id = `aliases.${COPY}__fields.default.v1`;
  await page.getByTestId('semantic-profile-advanced-registry').selectOption(id);
  await page.getByTestId('semantic-profile-advanced-json').fill(JSON.stringify({ registry_id: id, entries: { crp_mg_l: ['crp_mg_l'], ferritin_level: ['ferritin', 'ferritin_ng_ml', 'Study-Arm'] } }));
  await page.getByTestId('semantic-profile-advanced-apply').click();
  await page.getByTestId('semantic-profile-review').click();
  await expect(page.getByTestId('semantic-profile-refusal')).toBeVisible({ timeout: 30_000 });
  // The server names the NORMALISED header token and both fields claiming it.
  await expect(page.getByTestId('semantic-profile-refusal-issues')).toContainText('"study_arm" would be an alias of 2 fields (cohort_arm, ferritin_level)');
  await expect(page.getByTestId('semantic-profile-save')).toHaveCount(0);
  await page.getByTestId('semantic-profile-discard').click();
  expect((await resolved(COPY)).aliasMap.ferritin_level).toEqual(['ferritin', 'ferritin_ng_ml']);
});

test('AXI-2810.8 AC54 — an edit that breaks a project\'s profile combination is refused, naming the project @SI-031 @SI-030 @SI-014', async ({ page }) => {
  // A partner profile, made through the routes: one field, `patient_id`, labelled as the copy labels it.
  expect((await call('POST', P, { key: PARTNER, displayName: `E2E 2810 partner ${RUN}` })).status).toBe(201);
  const own = `${PARTNER}__fields`;
  const first = await call('POST', `${P}/${PARTNER}/versions`, {
    baseVersion: null,
    manifest: { packs: [own] },
    registries: [
      { registry_id: `canonical_fields.${own}.v1`, fields: ['patient_id'] },
      { registry_id: `vocabulary.${own}.v1`, labels: { patient_id: 'Patient ID' } },
    ],
  });
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  const created = await call('POST', '/api/v1/projects', { name: PROJECT, workspaceId: WS, semanticProfileIds: [COPY, PARTNER] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  projectId = created.body.id;
  await openDetail(page, COPY);
  await page.getByTestId('semantic-profile-tab-projects').click();
  await expect(page.getByTestId('semantic-profile-projects')).toContainText(PROJECT);
  await page.getByTestId('semantic-profile-tab-fields').click();
  // `patient_id` is labelled by the partner too: a different label makes the pair fail to combine.
  const label = page.getByTestId('semantic-profile-field-patient_id-label');
  await label.fill('Participant');
  await label.press('Enter');
  await page.getByTestId('semantic-profile-review').click();
  await expect(page.getByTestId('semantic-profile-refusal-message')).toContainText('profile_version_breaks_selection', { timeout: 30_000 });
  await expect(page.getByTestId('semantic-profile-refusal-message')).toContainText(PROJECT);
  await page.getByTestId('semantic-profile-discard').click();
  expect((await resolved(COPY)).vocabulary.patient_id).toBe('Patient ID');
});

test('AXI-2810.9 EC14 OQ-6 — removing a field previews its impact; a person\'s mapping blocks it; a field with levels is refused here @SI-031 @SI-014', async ({ page }) => {
  expect((await call('POST', `/api/v1/projects/${projectId}/datasets`, { datasetId: DS_ORGANS })).status).toBeLessThan(300);
  // OQ-6: remove `crp_mg_l` with no use → the preview shows no impact, and the save is allowed.
  await openDetail(page, COPY);
  await page.getByTestId('semantic-profile-field-disease_group-remove').click();
  await expect(page.getByTestId('semantic-profile-refusal-message')).toHaveText('"disease_group" has a levels registry; edit it in Advanced first.');
  await page.getByTestId('semantic-profile-field-crp_mg_l-remove').click();
  await page.getByTestId('semantic-profile-review').click();
  await expect(page.getByTestId('semantic-profile-preview-removed-crp_mg_l')).toContainText('0 automatic mapping row(s)', { timeout: 30_000 });
  await expect(page.getByTestId('semantic-profile-preview-rematch')).toContainText('1 project(s)');
  await page.getByTestId('semantic-profile-discard').click();

  // A person's mapping (`human`, set by SQL: no route writes one today) on `crp_mg_l` blocks the removal.
  const [row] = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      const rows = sql(`SELECT id FROM project_field_mappings WHERE project_id = ${lit(projectId!)} AND dataset_id = ${lit(DS_ORGANS)} ORDER BY source_field LIMIT 1`);
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 500));
    }
    return [];
  })();
  expect(row, 'a mapping row of the linked dataset').toBeTruthy();
  sql(`UPDATE project_field_mappings SET source = 'human', canonical_field = 'crp_mg_l', status = 'confirmed' WHERE id = ${lit(row)}`);
  await page.reload();
  await expect(page.getByTestId('semantic-profile-field-crp_mg_l-remove')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('semantic-profile-field-crp_mg_l-remove').click();
  await page.getByTestId('semantic-profile-review').click();
  await expect(page.getByTestId('semantic-profile-refusal-message')).toContainText('semantic_profile_field_in_use', { timeout: 30_000 });
  await expect(page.getByTestId('semantic-profile-refusal-message')).toContainText('crp_mg_l');
  await page.getByTestId('semantic-profile-discard').click();
  expect((await resolved(COPY)).canonicalFields).toContain('crp_mg_l');
});

test('AXI-2810.10 FR70 — Inspect shows the resolved references and the raw stored JSON; the Templates tab lists the templates @SI-031', async ({ page }) => {
  await openDetail(page, COPY);
  await page.getByTestId('semantic-profile-tab-inspect').click();
  await expect(page.getByTestId('semantic-profile-inspect')).toContainText('ferritin_level', { timeout: 30_000 });
  await page.getByTestId('semantic-profile-inspect-raw').click();
  await expect(page.getByTestId('semantic-profile-raw')).toContainText(`${COPY}__fields`);
  await page.goto(`${BASE_URL}/admin/semantic-profiles`);
  await page.getByTestId('semantic-profiles-tab-templates').click();
  await expect(page.getByTestId('semantic-profiles-page')).toContainText('faceted_grouped_boxplot_v1');
});

test('AXI-2810.11 FR59 — an empty profile: created, first field added by hand, its first save carries the platform matching rules; archived @SI-031 @SI-014 @SI-010', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await openPage(page, '/admin/semantic-profiles');
  await page.getByTestId('semantic-profiles-new').click();
  await expect(page.getByTestId('semantic-profile-create-mode-empty')).toBeChecked();
  await page.getByTestId('semantic-profile-create-key').fill('Bad__Key');
  await expect(page.getByTestId('semantic-profile-create-key-error')).toBeVisible();
  await expect(page.getByTestId('semantic-profile-create-submit')).toBeDisabled();
  // EC24: a key another profile holds (the create route checks it under the seed lock, any letter case) is refused.
  await page.getByTestId('semantic-profile-create-key').fill(COPY);
  await page.getByTestId('semantic-profile-create-name').fill(`E2E 2810 taken ${RUN}`);
  await page.getByTestId('semantic-profile-create-submit').click();
  await expect(page.getByTestId('semantic-profile-create-error')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/admin\/semantic-profiles\/new$/);
  await page.getByTestId('semantic-profile-create-key').fill(EMPTY);
  await page.getByTestId('semantic-profile-create-name').fill(`E2E 2810 empty ${RUN}`);
  await page.getByTestId('semantic-profile-create-submit').click();
  await expect(page.getByTestId('semantic-profile-detail')).toHaveAttribute('data-profile-id', EMPTY, { timeout: 30_000 });
  await expect(page.getByTestId('semantic-profile-summary')).toContainText('no version yet');
  await expect(page.getByTestId('semantic-profile-fields-empty')).toBeVisible();
  await page.getByTestId('profile-extension-new-field-label').fill('Titer');
  await page.getByTestId('profile-extension-add-field').click();
  expect(await reviewAndSave(page)).toBe('1.0.0');
  const r = await resolved(EMPTY);
  expect(r.canonicalFields).toEqual(['titer']);
  expect(r.matchingRules.registry_id).toBe('matching_rules.default.v1');
  expect(r.matchingRules.case_insensitive).toBe(true);

  await page.getByTestId('semantic-profile-archive').click();
  await expect(page).toHaveURL(/\/admin\/semantic-profiles$/, { timeout: 30_000 });
  await expect(page.getByTestId('semantic-profiles-table')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`semantic-profile-row-${EMPTY}`)).toHaveCount(0);
});

test('AXI-2810.12 AC58 FR67 — an organization profile is promoted to a new frozen system profile, granted to the promoting organization @SI-031 @SI-010', async ({ page }) => {
  await openDetail(page, COPY);
  await page.getByTestId('semantic-profile-promote-open').click();
  await expect(page.getByTestId('semantic-profile-promote')).toBeVisible();
  await page.getByTestId('semantic-profile-promote-key').fill(PROMOTED);
  await page.getByTestId('semantic-profile-promote-name').fill(`E2E 2810 system ${RUN}`);
  await page.getByTestId('semantic-profile-promote-submit').click();
  await expect(page.getByTestId('semantic-profile-detail')).toHaveAttribute('data-profile-id', PROMOTED, { timeout: 30_000 });
  await expect(page.getByTestId('semantic-profile-frozen-note')).toBeVisible();
  await expect(page.getByTestId('semantic-profile-summary')).toContainText('System');
  expect(contentOf(await resolved(PROMOTED))).toEqual(contentOf(await resolved(COPY)));

  await page.goto(`${BASE_URL}/admin/semantic-profiles`);
  await page.getByTestId('semantic-profiles-tab-system').click();
  await expect(page.getByTestId(`semantic-profile-row-${PROMOTED}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`semantic-profile-row-${PROMOTED}-frozen`)).toBeVisible();
});

test('AXI-2810.13 AC59 FR68 — "Run seed" reports the canonical profiles unchanged and changes nothing @SI-031 @SI-010', async ({ page }) => {
  const before = sql(`SELECT count(*) FROM semantic_profile_versions`)[0];
  await openPage(page, '/admin/semantic-profiles');
  await page.getByTestId('semantic-profiles-tab-system').click();
  await page.getByTestId('semantic-profiles-seed').click();
  await expect(page.getByTestId('semantic-profiles-seed-report')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('semantic-profiles-seed-unchanged')).toContainText(SOURCE);
  expect(sql(`SELECT count(*) FROM semantic_profile_versions`)[0]).toBe(before);
});

test('AXI-2810.14 FR69 — Access: revoke and re-grant a system profile; the ordered default set is saved @SI-031 @SI-002', async ({ page }) => {
  const access = await call('GET', `${P}/access`);
  expect(access.status, JSON.stringify(access.body)).toBe(200);
  defaultsBefore = (access.body.defaults ?? []).map((d: any) => (typeof d === 'string' ? d : d.profileId));
  page.on('dialog', (d) => void d.accept()); // the revoke asks for confirmation
  await openPage(page, '/admin/semantic-profiles');
  await page.getByTestId('semantic-profiles-tab-access').click();
  await expect(page.getByTestId(`semantic-access-grant-${PROMOTED}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`semantic-access-revoke-${PROMOTED}`).click();
  await expect(page.getByTestId(`semantic-access-grantable-${PROMOTED}`)).toBeVisible({ timeout: 30_000 });
  expect((await call('GET', `${P}/${PROMOTED}/detail`)).status).toBe(404);
  await page.getByTestId(`semantic-access-grant-${PROMOTED}-add`).click();
  await expect(page.getByTestId(`semantic-access-grant-${PROMOTED}`)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId(`semantic-access-default-${PROMOTED}`).check();
  await page.getByTestId('semantic-access-save-defaults').click();
  await expect.poll(async () => {
    const a = await call('GET', `${P}/access`);
    return (a.body.defaults ?? []).map((d: any) => (typeof d === 'string' ? d : d.profileId));
  }, { timeout: 30_000 }).toEqual([...defaultsBefore, PROMOTED]);
});

test('AXI-2810.15 OQ-3 — a finalised plan whose profile changed shows the read-only note on its readiness row @SI-013', async ({ page }) => {
  // The readiness rows are the questions table, which this page mounts over an open draft only (a
  // locked final shows its read-only version view): open an amendment draft, discard it at the end.
  const draft = await call('POST', `/api/v1/projects/${DEMO_2411}/saps/draft`, {});
  expect([200, 201], JSON.stringify(draft.body)).toContain(draft.status);
  try {
    const sapId: string = draft.body.sapId;
    const finals = await call('GET', `/api/v1/projects/${DEMO_2411}/saps/${sapId}/versions`);
    const latest = (Array.isArray(finals.body) ? finals.body : finals.body.versions ?? [])
      .filter((v: any) => v.status === 'final').sort((a: any, b: any) => b.version - a.version)[0];
    // Precondition read from the server, never assumed: the latest final version pins a profile
    // version whose content differs from the one the linked data was matched with.
    const qd = await call('GET', `/api/v1/projects/${DEMO_2411}/saps/${sapId}/versions/${latest.sapVersionId ?? latest.id}/question-data`);
    const drifting = (qd.body.questions ?? []).filter((q: any) => (q.resolution?.pinDrift ?? []).length > 0);
    expect(drifting.length, JSON.stringify(qd.body)).toBeGreaterThan(0);

    await openPage(page, `/projects/${DEMO_2411}/sap`);
    await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });
    const notes = page.locator('[data-testid^="sap-plan-questions-data-note-"]').filter({ hasText: 'The profile changed since this plan was finalised' });
    await expect(notes.first()).toBeVisible({ timeout: 30_000 });
    // One note per drifting question, no more (the note is per readiness row, read only).
    await expect(notes).toHaveCount(drifting.length);
  } finally {
    const open = await call('GET', `/api/v1/projects/${DEMO_2411}/sap-draft`);
    if (open.status === 200) {
      const gone = await call('DELETE', `/api/v1/projects/${DEMO_2411}/saps/${open.body.sapId}/draft?basedOnRevision=${open.body.revision}`);
      expect([200, 204], JSON.stringify(gone.body)).toContain(gone.status);
    }
  }
});
