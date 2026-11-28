import { execFileSync } from 'child_process';
import { expect, test, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE_URL, BASE_URL } from '../../config/env';
import { silenceTours } from '../AXI-1904/harness/tours';

/**
 * AXI-2811 (epic AXI-2802 — Semantic Profile Management, area A9): the project-level variables page
 * and the extension retarget. Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md`
 * § AXI-2811 (2811.1–2811.11).
 *
 * E2E CONTRACT — the REAL pages in a real browser:
 *   - FRONT = `BASE_URL`: the branch's front-end on its own Vite (5174+, own cacheDir), never :5173;
 *   - API   = `API_BASE_URL`: the branch's backend sidecar (`axiome-axi2811-backend`, own RabbitMQ
 *     vhost `axi-2811`) whose organization AND user databases are the THROWAWAY `E2E_2811_DB`
 *     (default `axiome_axi2811`, a pg_dump/pg_restore clone of the demo database).
 * Every product write goes through the UI or the branch's routes. The only SQL writes (on
 * `E2E_2811_DB` only) are what no route can do for `admin@cro-one.com`: one role without
 * `semantic_profile:edit_org_variables` that admin's Mag4 membership is pointed at and back (2811.10),
 * and, for 2811.11, a Mag4 membership with the seeded Investigator role and a project grant for a
 * login the spec registers through the sidecar (there is no Investigator login otherwise).
 */

const EMAIL = process.env.E2E_2811_EMAIL?.trim() || 'admin@cro-one.com';
const PASSWORD = process.env.E2E_2811_PASSWORD?.trim() || 'admin';
const STORY_DB = process.env.E2E_2811_DB?.trim() || 'axiome_axi2811';
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'axiome-localhost';

if (!/^axiome_axi2811[a-z0-9_]*$/.test(STORY_DB)) throw new Error(`E2E_2811_DB must name a throwaway axiome_axi2811* database, got ${STORY_DB}`);
if (/:(3000|5173)$/.test(API_BASE_URL) || /:5173$/.test(BASE_URL)) throw new Error('AXI-2811 runs against the story sidecar and a worktree Vite, never the shared demo stack');

const WS = '8946e06a-4fe6-45ee-8d9a-58f7142e803a'; // Mag4
const OTHER_WS = '3ec651af-a827-435b-8d67-8e4acd52ed7e'; // Plateforme Beacon — MIB v1 (another organization)
const FROZEN = 'immune_mediated';
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const RUN = Date.now().toString(36);
const P = '/api/v1/semantic-profiles';
const INV_EMAIL = `axi2811-inv-${RUN}@axiome.local`;
const INV_PASSWORD = 'AXI2811-e2e-pw!';
const KEY = { titer: `e2e_titer_${RUN}`, ferritin: `e2e_ferritin_${RUN}`, il6: `il6_e2e_${RUN}`, tab: `e2e_tab_${RUN}`, map: `e2e_map_${RUN}`, inv: `e2e_inv_${RUN}` };

let api: APIRequestContext;
let token: { access: string; refresh: string };
let orgId: string;
let additionsKey: string;
let additionsExisted = false;
let membership: { id: string; roleId: string };
let noVariablesRole: string | undefined;
const projects: { p1?: string; q?: string; r?: string } = {};
let investigator: { userId?: string; memberId?: string; access?: string; refresh?: string } = {};

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

function psql(statement: string): string[] {
  if (!STORY_DB.startsWith('axiome_axi2811')) throw new Error(`refusing SQL on ${STORY_DB}`);
  const out = execFileSync('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'axiome', '-d', STORY_DB, '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, stdio: 'pipe' }).toString();
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}
const sql = (select: string) => psql(`SET search_path TO organization_svc; ${select}`).filter((l) => l !== 'SET');
const lit = (v: string) => {
  if (!/^[A-Za-z0-9_.:@+ -]+$/.test(v)) throw new Error(`unsafe literal: ${v}`);
  return `'${v}'`;
};

interface Answer { status: number; body: any }
async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', p: string, data?: unknown, ws = WS): Promise<Answer> {
  const res = await api.fetch(`${API_BASE_URL}${p}`, { method, headers: { 'X-Workspace-Id': ws }, timeout: 60_000, ...(data === undefined ? {} : { data }) });
  const raw = await res.text();
  let body: any = raw;
  try { body = JSON.parse(raw); } catch { /* text */ }
  return { status: res.status(), body };
}

async function newProject(name: string, profileIds: string[], ws = WS): Promise<string> {
  const created = await call('POST', '/api/v1/projects', { name, workspaceId: ws, semanticProfileIds: profileIds }, ws);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.id;
}

const variables = async (projectId: string, ws = WS) => {
  const v = await call('GET', `${P}/projects/${projectId}/variables`, undefined, ws);
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return v.body;
};
const fieldsOf = (view: any, profileId: string): string[] =>
  (view.profiles.find((p: any) => p.profileId === profileId)?.fields ?? []).map((f: any) => f.field);
const selectionOf = (projectId: string) => sql(`SELECT profile_key FROM project_semantic_profiles WHERE project_id = ${lit(projectId)} ORDER BY added_at, id`);
const contract = async (projectId: string, ws = WS) => {
  const c = await call('GET', `/api/v1/projects/${projectId}/semantic-contract`, undefined, ws);
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return c.body;
};

async function signIn(page: Page, ws = WS, as: { access: string; refresh: string } = token): Promise<void> {
  await page.addInitScript(([access, refresh, org, w]) => {
    localStorage.setItem('access_token', access);
    localStorage.setItem('refresh_token', refresh);
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', w);
  }, [as.access, as.refresh, orgId, ws] as const);
}

async function openVariables(page: Page, projectId: string): Promise<void> {
  await signIn(page);
  await page.goto(`${BASE_URL}/projects/${projectId}/profile-variables`);
  await expect(page.getByTestId('project-variables-page')).toBeVisible({ timeout: 30_000 });
}

async function addByHand(page: Page, label: string): Promise<void> {
  await page.getByTestId('profile-extension-new-field-label').fill(label);
  await page.getByTestId('profile-extension-add-field').click();
}

const section = (page: Page, profileId: string) => page.getByTestId(`project-variables-profile-${profileId}`);

async function login(email: string, password: string): Promise<{ access: string; refresh: string }> {
  const anon = await apiRequest.newContext();
  const res = await anon.post(`${API_BASE_URL}/api/v1/auth/login`, { data: { email, password } });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  const { accessToken, refreshToken } = await res.json();
  await anon.dispose();
  return { access: accessToken, refresh: refreshToken };
}

/** Points admin's Mag4 membership at a role, then waits until the gateway (60 s cache) serves it. */
async function pointMembershipAt(roleId: string): Promise<void> {
  sql(`UPDATE workspace_members SET role_id = ${lit(roleId)} WHERE id = ${lit(membership.id)}`);
  const [expected] = sql(`SELECT permissions::text FROM user_svc.roles WHERE id = ${lit(roleId)}`);
  const want = (JSON.parse(expected) as string[]).includes('semantic_profile:edit_org_variables');
  await expect.poll(async () => {
    const me = await call('GET', '/api/v1/workspace-permissions/me');
    return ((me.body?.permissions ?? []) as string[]).includes('semantic_profile:edit_org_variables');
  }, { timeout: 90_000, intervals: [2_000] }).toBe(want);
}

// ─── suite ───────────────────────────────────────────────────────────────────────────────────

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeAll(async () => {
  token = await login(EMAIL, PASSWORD);
  api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token.access}` } });
  const [adminId] = sql(`SELECT id FROM user_svc.users WHERE email = ${lit(EMAIL)}`);
  [orgId] = sql(`SELECT owner_organization_id FROM workspaces WHERE id = ${lit(WS)}`);
  additionsKey = `additions_${orgId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  additionsExisted = sql(`SELECT count(*) FROM semantic_profiles WHERE key = ${lit(additionsKey)}`)[0] !== '0';
  const [row] = sql(`SELECT id || '|' || role_id FROM workspace_members WHERE workspace_id = ${lit(WS)} AND user_id = ${lit(adminId)}`);
  const [id, roleId] = row.split('|');
  membership = { id, roleId };
  const [adminPerms] = sql(`SELECT permissions::text FROM user_svc.roles WHERE id = ${lit(roleId)}`);
  const perms = (JSON.parse(adminPerms) as string[]).filter((p) => p !== 'semantic_profile:edit_org_variables');
  [noVariablesRole] = sql(
    `INSERT INTO user_svc.roles (id, name, description, permissions, scope, updated_at, created_by) ` +
      `VALUES (gen_random_uuid()::text, ${lit(`E2E 2811 no org variables ${RUN}`)}, 'AXI-2811 E2E', '${JSON.stringify(perms)}'::jsonb, 'WORKSPACE', now(), 'e2e:axi-2811') RETURNING id`,
  );
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  if (membership) sql(`UPDATE workspace_members SET role_id = ${lit(membership.roleId)} WHERE id = ${lit(membership.id)}`);
  if (noVariablesRole) sql(`DELETE FROM user_svc.roles WHERE id = ${lit(noVariablesRole)}`);
  if (investigator.memberId) sql(`DELETE FROM workspace_members WHERE id = ${lit(investigator.memberId)}`);
  for (const [key, id] of Object.entries(projects)) {
    if (id) await call('DELETE', `/api/v1/projects/${id}`, undefined, key === 'r' ? OTHER_WS : WS);
  }
  await api?.dispose();
});

test('AXI-2811.1 FR71 FR73 AC56 — a project on frozen profiles only: every field, its profile, read only @SI-031 @SI-010', async ({ page }) => {
  projects.p1 = await newProject(`E2E AXI-2811 P1 ${RUN}`, [FROZEN]);
  const view = await variables(projects.p1);
  expect(view.profiles.map((p: any) => [p.profileId, p.editable, p.frozen])).toEqual([[FROZEN, false, true]]);
  expect(view.additionsProfileOffered).toBe(true);
  const resolved = await call('GET', `${P}/${FROZEN}/resolved`);
  expect(fieldsOf(view, FROZEN).sort()).toEqual([...resolved.body.canonicalFields].sort());

  await signIn(page);
  await page.goto(`${BASE_URL}/projects/${projects.p1}`);
  await page.getByRole('tab', { name: 'Semantic Profile' }).click();
  await page.getByTestId('project-profile-variables-link').click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projects.p1}/profile-variables$`));
  const frozen = section(page, FROZEN);
  await expect(frozen).toHaveAttribute('data-editable', 'false', { timeout: 30_000 });
  await expect(page.getByTestId(`project-variables-profile-${FROZEN}-readonly`)).toContainText('Frozen profile');
  await expect(frozen.getByTestId('semantic-profile-field-disease_group')).toBeVisible();
  await expect(frozen.locator('input')).toHaveCount(0);
  await expect(frozen.getByTestId('semantic-profile-field-disease_group-remove')).toHaveCount(0);
  await expect(page.getByTestId('profile-extension-new-field-label')).toBeVisible();
});

test('AXI-2811.2 OQ-12 — the additions offer: without a yes nothing is written @SI-031 @SI-014', async ({ page }) => {
  const profilesBefore = sql(`SELECT count(*) FROM semantic_profiles`)[0];
  const versionsBefore = sql(`SELECT count(*) FROM semantic_profile_versions`)[0];
  await openVariables(page, projects.p1!);
  await addByHand(page, `E2E titer ${RUN}`);
  await expect(page.getByTestId('project-variables-additions-offer')).toContainText('additions profile', { timeout: 30_000 });
  await page.getByTestId('project-variables-additions-decline').click();
  await expect(page.getByTestId('project-variables-additions-offer')).toHaveCount(0);
  expect(selectionOf(projects.p1!)).toEqual([FROZEN]);
  expect(sql(`SELECT count(*) FROM semantic_profiles`)[0]).toBe(profilesBefore);
  expect(sql(`SELECT count(*) FROM semantic_profile_versions`)[0]).toBe(versionsBefore);
});

test('AXI-2811.3 OQ-12 FR72 — yes creates (or reuses) the additions profile, selects it and writes there @SI-031 @SI-014 @SI-010', async ({ page }) => {
  await openVariables(page, projects.p1!);
  await addByHand(page, `E2E titer ${RUN}`);
  await page.getByTestId('project-variables-additions-accept').click();
  const notice = page.getByTestId('project-variables-notice');
  await expect(notice).toContainText(`of ${additionsKey}`, { timeout: 30_000 });
  if (!additionsExisted) await expect(notice).toContainText('additions profile was created and added to this project');
  const additions = section(page, additionsKey);
  await expect(additions).toHaveAttribute('data-editable', 'true');
  await expect(additions.getByTestId(`semantic-profile-field-${KEY.titer}`)).toBeVisible();

  expect(selectionOf(projects.p1!)).toEqual([FROZEN, additionsKey]);
  expect(sql(`SELECT scope || '|' || organization_id || '|' || frozen FROM semantic_profiles WHERE key = ${lit(additionsKey)}`)).toEqual([`organization|${orgId}|false`]);
  const r = await call('GET', `${P}/${additionsKey}/resolved`);
  expect(r.body.canonicalFields).toContain(KEY.titer);
  expect(r.body.vocabulary[KEY.titer]).toBe(`E2E titer ${RUN}`);
  const [via] = sql(`SELECT after->'via'->>'surface' || '|' || (after->'via'->>'projectId') FROM semantic_profile_audit_log a JOIN semantic_profiles p ON p.id = a.profile_id ` +
    `WHERE p.key = ${lit(additionsKey)} AND a.after->>'version' = ${lit(r.body.profile.version)} ORDER BY a.performed_at DESC LIMIT 1`);
  expect(via).toBe(`project_page|${projects.p1}`);
});

test('AXI-2811.4 AC55 — a variable added on P\'s page reaches Q of the same organization, never R of another @SI-031 @SI-010 @SI-030', async ({ page }) => {
  projects.q = await newProject(`E2E AXI-2811 Q ${RUN}`, [FROZEN, additionsKey]);
  projects.r = await newProject(`E2E AXI-2811 R ${RUN}`, [FROZEN], OTHER_WS);
  const before = (await call('GET', `${P}/${additionsKey}/resolved`)).body.profile.version;

  await openVariables(page, projects.p1!);
  await addByHand(page, `E2E ferritin ${RUN}`);
  await expect(page.getByTestId('project-variables-notice')).toContainText(`Saved version`, { timeout: 30_000 });
  const after = (await call('GET', `${P}/${additionsKey}/resolved`)).body.profile.version;
  expect(after).not.toBe(before);
  await expect(page.getByTestId('project-variables-notice')).toContainText(`Saved version ${after} of ${additionsKey}`);

  await page.goto(`${BASE_URL}/projects/${projects.q}/profile-variables`);
  await expect(section(page, additionsKey).getByTestId(`semantic-profile-field-${KEY.ferritin}`)).toBeVisible({ timeout: 30_000 });
  expect((await contract(projects.q)).canonicalFields).toContain(KEY.ferritin);
  expect(fieldsOf(await variables(projects.r, OTHER_WS), FROZEN)).not.toContain(KEY.ferritin);
  expect((await contract(projects.r, OTHER_WS)).canonicalFields).not.toContain(KEY.ferritin);
});

test('AXI-2811.5 FR72 — edit and remove a variable of the organization profile from a project; a stale base is refused @SI-031 @SI-014', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await openVariables(page, projects.q!);
  const additions = section(page, additionsKey);
  const notice = page.getByTestId('project-variables-notice');
  const stale = (await call('GET', `${P}/${additionsKey}/resolved`)).body.profile.version;

  const label = additions.getByTestId(`semantic-profile-field-${KEY.ferritin}-label`);
  await label.fill('Ferritin E2E');
  await label.press('Enter');
  await expect(notice).toContainText('Saved version', { timeout: 30_000 });
  await additions.getByTestId(`semantic-profile-field-${KEY.ferritin}-role`).selectOption('continuous_outcome');
  await expect.poll(async () => (await call('GET', `${P}/${additionsKey}/resolved`)).body.templateRoles?.[KEY.ferritin], { timeout: 30_000 }).toBe('continuous_outcome');
  const aliases = additions.getByTestId(`semantic-profile-field-${KEY.ferritin}-aliases`);
  await aliases.fill(`ferritin_e2e_${RUN}`);
  await aliases.press('Enter');
  await expect.poll(async () => (await call('GET', `${P}/${additionsKey}/resolved`)).body.aliasMap?.[KEY.ferritin], { timeout: 30_000 }).toEqual([`ferritin_e2e_${RUN}`]);
  const r = await call('GET', `${P}/${additionsKey}/resolved`);
  expect(r.body.vocabulary[KEY.ferritin]).toBe('Ferritin E2E');

  const refused = await call('POST', `${P}/projects/${projects.q}/variables`, { profileId: additionsKey, baseVersion: stale, changes: [{ action: 'update', field: KEY.ferritin, label: 'stale' }] });
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  expect((await call('GET', `${P}/${additionsKey}/resolved`)).body.vocabulary[KEY.ferritin]).toBe('Ferritin E2E');

  await page.reload();
  await section(page, additionsKey).getByTestId(`semantic-profile-field-${KEY.ferritin}-remove`).click();
  await expect.poll(async () => (await call('GET', `${P}/${additionsKey}/resolved`)).body.canonicalFields, { timeout: 30_000 }).not.toContain(KEY.ferritin);
  expect(fieldsOf(await variables(projects.p1!), additionsKey)).not.toContain(KEY.ferritin);
});

test('AXI-2811.6 FR74 — "Add from a sample file": a new column becomes a variable, its header as alias @SI-031 @SI-065 @SI-014', async ({ page }) => {
  await openVariables(page, projects.q!);
  await page.getByTestId('project-variables-sample-open').click();
  await expect(page.getByTestId('sap-sample-drawer')).toBeVisible();
  await page.getByTestId('sap-sample-drawer').locator('input[type="file"]').setInputFiles({
    name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from(`${KEY.il6},age\n3.1,40\n5.4,52\n`),
  });
  await expect(page.getByTestId(`sap-sample-row-${KEY.il6}`)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`sap-sample-row-${KEY.il6}-check`).check();
  await page.getByTestId('sap-sample-add').click();
  await expect(page.getByTestId('project-variables-notice')).toContainText('From the sample: 1 variable(s) added', { timeout: 30_000 });
  await expect(section(page, additionsKey).getByTestId(`semantic-profile-field-${KEY.il6}`)).toBeVisible();
  const r = await call('GET', `${P}/${additionsKey}/resolved`);
  expect(r.body.aliasMap[KEY.il6]).toEqual([KEY.il6]);
});

test('AXI-2811.7 OQ-11 FR75 — the Semantic Profile tab\'s "Add to profile" writes the organization profile, not the extension @SI-031 @SI-014', async ({ page }) => {
  const revisions = sql(`SELECT count(*) FROM project_semantic_profile_extensions WHERE project_id = ${lit(projects.q!)}`)[0];
  await signIn(page);
  await page.goto(`${BASE_URL}/projects/${projects.q}`);
  await page.getByRole('tab', { name: 'Semantic Profile' }).click();
  await expect(page.getByText("Add a field to this project's organization profile")).toBeVisible({ timeout: 30_000 });
  await addByHand(page, `E2E tab ${RUN}`);
  await expect.poll(async () => fieldsOf(await variables(projects.q!), additionsKey), { timeout: 30_000 }).toContain(KEY.tab);
  const view = await variables(projects.q!);
  expect(view.extensionFields.some((f: string) => f.includes(KEY.tab))).toBe(false);
  expect(sql(`SELECT count(*) FROM project_semantic_profile_extensions WHERE project_id = ${lit(projects.q!)}`)[0]).toBe(revisions);
});

test('AXI-2811.8 OQ-11 FR77 — the SAP Variables card\'s "Add & map" maps the row to the organization field @SI-031 @SI-066', async ({ page }) => {
  const started = await call('POST', `/api/v1/projects/${projects.q}/saps/draft`, { planSchemaVersion: 2 });
  expect([200, 201], JSON.stringify(started.body)).toContain(started.status);
  // A declared variable with no canonical field (the v2 draft's own write; the server numbers its fieldId).
  const saved = await call('PUT', `/api/v1/projects/${projects.q}/saps/${started.body.sapId}/draft`, {
    basedOnRevision: started.body.revision, studyPopulation: 'Adults',
    dataSpecification: { fields: [{ name: 'map_marker', label: 'Map marker', semanticRole: 'continuous', required: true }] },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const fieldId: string = saved.body.plan.dataSpecification.fields.find((f: any) => f.name === 'map_marker').fieldId;
  const row = `sap-variable-${fieldId}`;

  await signIn(page);
  await page.goto(`${BASE_URL}/projects/${projects.q}/sap`);
  await page.getByTestId(`${row}-custom`).click({ timeout: 30_000 });
  await page.getByTestId(`${row}-mint-label`).fill(`E2E map ${RUN}`);
  await page.getByTestId(`${row}-mint-submit`).click();
  await expect(page.getByTestId(`${row}-custom`)).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const d = await call('GET', `/api/v1/projects/${projects.q}/saps/${started.body.sapId}/draft`);
    return (d.body.plan?.dataSpecification?.fields ?? []).find((f: any) => f.fieldId === fieldId)?.canonicalField;
  }, { timeout: 30_000 }).toBe(KEY.map);
  expect(fieldsOf(await variables(projects.q!), additionsKey)).toContain(KEY.map);
});

test('AXI-2811.9 AC57 FR75 — the extension write is retired (410); existing revisions still resolve, read only @SI-031 @SI-014', async ({ page }) => {
  const [legacy] = sql(`SELECT e.project_id FROM project_semantic_profile_extensions e JOIN projects p ON p.id = e.project_id ` +
    `WHERE p.workspace_id = ${lit(WS)} AND p.deleted_at IS NULL GROUP BY e.project_id ORDER BY e.project_id LIMIT 1`);
  expect(legacy, 'a Mag4 project with an extension revision').toBeTruthy();
  const count = () => sql(`SELECT count(*) FROM project_semantic_profile_extensions WHERE project_id = ${lit(legacy)}`)[0];
  const before = count();
  const gone = await call('POST', `${P}/projects/${legacy}/extensions`, {
    packs: [{ registry_id: `canonical_fields.project.${legacy}.v99`, fields: [`project.${legacy}.e2e_${RUN}`] }],
  });
  expect(gone.status, JSON.stringify(gone.body)).toBe(410);
  expect(JSON.stringify(gone.body)).toContain('project_extension_retired');
  expect(count()).toBe(before);

  const view = await variables(legacy);
  expect(view.extensionFields.length).toBeGreaterThan(0);
  const served = (await contract(legacy)).canonicalFields as string[];
  for (const f of view.extensionFields) expect(served).toContain(f);
  await openVariables(page, legacy);
  const ext = page.getByTestId('project-variables-extension');
  await expect(ext).toContainText('Added to this project before');
  await expect(page.getByTestId(`project-variables-extension-field-${view.extensionFields[0]}`)).toBeVisible();
  await expect(ext.locator('input, button')).toHaveCount(0);
});

test('AXI-2811.10 OQ-10 — the writes are gated on semantic_profile:edit_org_variables, never on a role name @SI-031 @SI-002', async ({ page }) => {
  await pointMembershipAt(noVariablesRole!);
  try {
    const refused = await call('POST', `${P}/projects/${projects.q}/variables`, { changes: [{ action: 'add', label: `E2E denied ${RUN}` }] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    await openVariables(page, projects.q!);
    await expect(section(page, additionsKey)).toHaveAttribute('data-editable', 'false', { timeout: 30_000 });
    await expect(section(page, additionsKey).locator('input')).toHaveCount(0);
    await expect(page.getByTestId('profile-extension-new-field-label')).toHaveCount(0);
    await expect(page.getByTestId('project-variables-sample-open')).toHaveCount(0);
    await page.goto(`${BASE_URL}/projects/${projects.q}`);
    await page.getByRole('tab', { name: 'Semantic Profile' }).click();
    await expect(page.getByTestId('project-profile-variables-link')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('profile-extension-new-field-label')).toHaveCount(0);
  } finally {
    await pointMembershipAt(membership.roleId);
  }
});

test('AXI-2811.11 FR71 — Investigator mode: Settings → Profile variables, and an add saved to the organization profile @SI-031 @SI-002', async ({ page }) => {
  const anon = await apiRequest.newContext();
  const reg = await anon.post(`${API_BASE_URL}/api/v1/auth/register`, { data: { email: INV_EMAIL, password: INV_PASSWORD, firstName: 'AXI2811', lastName: 'Investigator' } });
  expect(reg.ok(), `register → ${reg.status()} ${await reg.text()}`).toBeTruthy();
  await anon.dispose();
  [investigator.userId] = sql(`SELECT id FROM user_svc.users WHERE email = ${lit(INV_EMAIL)}`);
  [investigator.memberId] = sql(`INSERT INTO workspace_members (id, workspace_id, user_id, organization_id, role, invited_by, role_id) VALUES ` +
    `(gen_random_uuid()::text, ${lit(WS)}, ${lit(investigator.userId!)}, ${lit(orgId)}, 'viewer', 'e2e:axi-2811', ${lit(INVESTIGATOR_ROLE_ID)}) RETURNING id`);
  sql(`INSERT INTO project_access_grants (id, project_id, user_id, level, granted_by, granted_at) VALUES ` +
    `(gen_random_uuid()::text, ${lit(projects.q!)}, ${lit(investigator.userId!)}, 'editor', 'e2e:axi-2811', now())`);
  const inv = await login(INV_EMAIL, INV_PASSWORD);
  await silenceTours(inv.access);

  await signIn(page, WS, inv);
  await page.addInitScript((p) => localStorage.setItem('axiome-active-project', p), projects.q!);
  await page.goto(`${BASE_URL}/investigator/settings`);
  await page.getByTestId('project-settings-profile-variables').click({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projects.q}/profile-variables$`));
  await expect(page.getByTestId('project-variables-page')).toHaveAttribute('data-surface', 'investigator', { timeout: 30_000 });
  await expect(section(page, additionsKey)).toHaveAttribute('data-editable', 'true');
  await addByHand(page, `E2E inv ${RUN}`);
  await expect(page.getByTestId('project-variables-notice')).toContainText(`of ${additionsKey}`, { timeout: 30_000 });
  expect(fieldsOf(await variables(projects.q!), additionsKey)).toContain(KEY.inv);
});
