import { APIRequestContext, expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, asList, type Api } from '../AXI-1400/harness/api';
import { silenceTours } from '../AXI-1904/harness/tours';

/**
 * AXI-2323 (epic AXI-2308 — Platform Opening: Human Guided) — owner-created scope,
 * org-transparent navigation and the selector count rule (FR7, FR8, FR9; AC5–AC8, EC1, EC2).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2323.2–.9.
 *
 * Self-provisioned. The platform admin creates fresh workspaces/projects in its first
 * organization and adds memberships; every Investigator / team user is a throwaway
 * self-registered account holding ONLY the membership the scenario arranges. No demo project,
 * no seeded user other than the admin. Fixture workspaces are archived in afterAll.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2323-e2e-pw!';
const DENIED = 'This endpoint is not available to the Investigator role';
const NO_STUDY = 'No study assigned yet — contact Axiome';
const ORG_BY_ID = /\/api\/v1\/organizations\/[0-9a-f-]{36}(\?|$)/;
const ORG_LIST = /\/api\/v1\/organizations(\?|$)/;
// A hard load of the unbundled dev server restores the session, asks /surface, then resolves the scope.
const LOAD_MS = 30_000;
const ROLES_LIST = /\/api\/v1\/roles(\?|$)/;
const CREATE_LABEL = /new workspace|new project|create workspace|create project/i;

interface Person {
  label: string;
  email: string;
  userId: string;
  accessToken: string;
  api: APIRequestContext;
}

interface Scope {
  id: string;
  name: string;
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
let admin: Api;
let orgId: string;
const createdWorkspaces: string[] = [];
const people: Person[] = [];

const w: Record<'w1' | 'w2a' | 'w2b' | 'w3' | 'w4' | 'w5' | 'wb', Scope> = {} as never;
const p: Record<'p1' | 'p2a' | 'p2b' | 'p3a' | 'p3b' | 'p5', Scope> = {} as never;
let inv1: Person;
let inv2: Person;
let inv3: Person;
let inv4: Person;
let inv5: Person;
let mixed: Person;
let editor: Person;

function ok<T = any>(what: string, res: { status: number; body: T }): T {
  expect(res.status, `${what} -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}

async function workspace(label: string): Promise<Scope> {
  const name = `AXI-2323 ${label} ${RUN}`;
  const ws = ok('create workspace', await admin.post('/api/v1/workspaces', {
    name, description: 'AXI-2323 count-rule E2E fixture', type: 'internal', ownerOrganizationId: orgId,
  }));
  createdWorkspaces.push(ws.id);
  return { id: ws.id, name };
}

async function project(ws: Scope, label: string): Promise<Scope> {
  const name = `AXI-2323 ${label} ${RUN}`;
  const body = ok('create project', await admin.post('/api/v1/projects', { name, workspaceId: ws.id }, { 'X-Workspace-Id': ws.id }));
  return { id: body.id, name };
}

async function person(label: string): Promise<Person> {
  const email = `axi2323-${label}-${RUN}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2323', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  const who = { label, email, userId: me.id, accessToken, api };
  people.push(who);
  return who;
}

async function member(ws: Scope, who: Person, membership: { role: string } | { roleId: string }): Promise<void> {
  ok(`add ${who.label} to ${ws.name}`, await admin.post(`/api/v1/workspaces/${ws.id}/members`, {
    userId: who.userId, organizationId: orgId, ...membership,
  }));
}

const INVESTIGATOR = { roleId: INVESTIGATOR_ROLE_ID };

async function signIn(page: Page, who: Person, landing: RegExp): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(landing);
}

/**
 * A hard reload. The local host's Docker networks change while sibling stacks start, and
 * Chromium then aborts the dev server's module loads with ERR_NETWORK_CHANGED, leaving a blank
 * page that says nothing about the app. Only THAT transport failure is retried (twice); any
 * other outcome, including a real failure to land, is left for the assertion to judge.
 */
async function hardReload(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let networkChanged = false;
    const onFailed = (req: { failure(): { errorText: string } | null }) => {
      if (req.failure()?.errorText.includes('ERR_NETWORK_CHANGED')) networkChanged = true;
    };
    page.on('requestfailed', onFailed);
    await page.reload();
    await page.waitForLoadState('load');
    page.off('requestfailed', onFailed);
    if (!networkChanged) return;
  }
}

async function stored(page: Page): Promise<[string | null, string | null]> {
  return page.evaluate(() => [localStorage.getItem('axiome-active-workspace'), localStorage.getItem('axiome-active-project')]);
}

async function expectLanded(page: Page, ws: Scope, pr: Scope): Promise<void> {
  await expect(page.getByTestId('investigator-home-study')).toHaveText(`${ws.name} · ${pr.name}`, { timeout: LOAD_MS });
  expect(await stored(page)).toEqual([ws.id, pr.id]);
}

async function expectNoCreationPath(page: Page): Promise<void> {
  await expect(page.locator('a[href$="/workspaces/new"], a[href$="/projects/new"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: CREATE_LABEL })).toHaveCount(0);
  await expect(page.getByRole('button', { name: CREATE_LABEL })).toHaveCount(0);
}

async function expectNoOrgControl(page: Page): Promise<void> {
  await expect(page.locator('[data-testid^="scope-label-"], [data-testid^="scope-dropdown-"]')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /organi[sz]ation/i })).toHaveCount(0);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  admin = await adminApi();
  orgId = asList<{ id: string }>(ok('list organizations', await admin.get('/api/v1/organizations')))[0]?.id;
  expect(orgId, 'the admin sees an organization').toBeTruthy();

  w.w1 = await workspace('W1 single');
  p.p1 = await project(w.w1, 'P1');
  w.w2a = await workspace('W2a two-ws');
  p.p2a = await project(w.w2a, 'P2a');
  w.w2b = await workspace('W2b two-ws');
  p.p2b = await project(w.w2b, 'P2b');
  w.w3 = await workspace('W3 two-projects');
  p.p3a = await project(w.w3, 'P3a alpha');
  p.p3b = await project(w.w3, 'P3b beta');
  w.w4 = await workspace('W4 no-project');
  w.w5 = await workspace('W5 archived');
  p.p5 = await project(w.w5, 'P5');
  w.wb = await workspace('WB team');

  inv1 = await person('inv1');
  await member(w.w1, inv1, INVESTIGATOR);
  inv2 = await person('inv2');
  await member(w.w2a, inv2, INVESTIGATOR);
  await member(w.w2b, inv2, INVESTIGATOR);
  inv3 = await person('inv3');
  await member(w.w3, inv3, INVESTIGATOR);
  inv4 = await person('inv4');
  await member(w.w4, inv4, INVESTIGATOR);
  inv5 = await person('inv5');
  await member(w.w5, inv5, INVESTIGATOR);
  ok('archive W5', await admin.patch(`/api/v1/workspaces/${w.w5.id}`, { status: 'archived' }, { 'X-Workspace-Id': w.w5.id }));
  mixed = await person('mixed');
  await member(w.w1, mixed, INVESTIGATOR);
  await member(w.wb, mixed, { role: 'admin' });
  editor = await person('editor');
  await member(w.w1, editor, { role: 'editor' });

  for (const who of people) await silenceTours(who.accessToken);
});

test.afterAll(async () => {
  for (const id of createdWorkspaces) {
    await admin.patch(`/api/v1/workspaces/${id}`, { status: 'archived' }, { 'X-Workspace-Id': id }).catch(() => undefined);
  }
  for (const who of people) await who.api.dispose();
  await admin?.ctx.dispose();
});

test.describe('AXI-2323 owner-created scope & selector count rule', () => {
  test('AXI-2323.2 AC5: every scope-create call is 403 for the Investigator; the mixed user is refused in his Investigator scope only @SI-010', async () => {
    const tag = `AXI-2323 forbidden ${RUN}`;
    const as = (who: Person, ws: Scope) => ({ headers: { 'X-Workspace-Id': ws.id } });
    const calls = [
      await inv1.api.post(apiUrl('/api/v1/workspaces'), { ...as(inv1, w.w1), data: { name: tag, type: 'internal', ownerOrganizationId: orgId } }),
      await inv1.api.post(apiUrl('/api/v1/projects'), { ...as(inv1, w.w1), data: { name: tag, workspaceId: w.w1.id } }),
      await inv1.api.post(apiUrl('/api/v1/organizations'), { ...as(inv1, w.w1), data: { name: tag } }),
      await mixed.api.post(apiUrl('/api/v1/workspaces'), { ...as(mixed, w.wb), data: { name: tag, type: 'internal', ownerOrganizationId: orgId } }),
      await mixed.api.post(apiUrl('/api/v1/projects'), { ...as(mixed, w.wb), data: { name: tag, workspaceId: w.w1.id } }),
    ];
    for (const res of calls) {
      expect(res.status(), await res.text()).toBe(403);
      expect((await res.json()).message).toBe(DENIED);
    }

    const allowed = await mixed.api.post(apiUrl('/api/v1/projects'), { ...as(mixed, w.wb), data: { name: `AXI-2323 allowed ${RUN}`, workspaceId: w.wb.id } });
    expect(allowed.status(), await allowed.text()).toBe(201);

    const w1Projects = asList<Scope>(ok('W1 projects', await admin.get(`/api/v1/projects?workspaceId=${w.w1.id}&limit=100`, { 'X-Workspace-Id': w.w1.id })));
    expect(w1Projects.map((x) => x.name)).toEqual([p.p1.name]);
    const theirs = await (await inv1.api.get(apiUrl('/api/v1/workspaces?memberOnly=true'))).json();
    expect(asList<Scope>(theirs.workspaces ?? theirs).map((x) => x.name)).not.toContain(tag);
    const orgs = asList<{ name: string }>(ok('organizations', await admin.get('/api/v1/organizations?limit=100')));
    expect(orgs.map((o) => o.name)).not.toContain(tag);
  });

  test('AXI-2323.3 AC5 AC8: no creation path on his surface; team create routes send him home @SI-066 @SI-030', async ({ page }) => {
    await signIn(page, inv1, /\/investigator$/);
    for (const path of ['/investigator', '/investigator/results', '/investigator/uploads', '/investigator/new-analysis']) {
      await page.goto(path);
      await expect(page.getByTestId('investigator-surface')).toBeVisible();
      await expect(page.getByTestId('investigator-scope')).toBeVisible();
      await expectNoCreationPath(page);
    }
    for (const path of ['/workspaces/new', '/projects/new']) {
      await page.goto(path);
      await page.waitForURL(/\/investigator$/);
    }
  });

  test('AXI-2323.4 AC6 AC7: one workspace + one project auto-land, no selectors, no org selector, ONE org check, survives two reloads @SI-066 @SI-030 @SI-013', async ({ page }) => {
    const orgById: string[] = [];
    const orgList: string[] = [];
    page.on('request', (req) => {
      if (req.method() !== 'GET') return;
      if (ORG_BY_ID.test(req.url())) orgById.push(req.url());
      else if (ORG_LIST.test(req.url())) orgList.push(req.url());
    });

    await signIn(page, inv1, /\/investigator$/);
    await expect(page.getByTestId('investigator-scope-workspace-name')).toHaveText(w.w1.name);
    await expect(page.getByTestId('investigator-scope-project-name')).toHaveText(p.p1.name);
    await expect(page.getByTestId('investigator-workspace-select')).toHaveCount(0);
    await expect(page.getByTestId('investigator-project-select')).toHaveCount(0);
    await expectNoOrgControl(page);
    await expectLanded(page, w.w1, p.p1);

    for (const nav of ['investigator-nav-uploads', 'investigator-nav-results', 'investigator-nav-home']) {
      await page.getByTestId(nav).click();
      await expect(page.getByTestId('investigator-scope-workspace-name')).toHaveText(w.w1.name);
    }
    await expectLanded(page, w.w1, p.p1);
    expect(orgById, 'exactly one org check for the session').toHaveLength(1);
    expect(orgById[0]).toContain(`/organizations/${orgId}`);
    expect(orgList, 'no organization list on his surface').toEqual([]);

    for (let i = 0; i < 2; i++) {
      await hardReload(page);
      await expectLanded(page, w.w1, p.p1);
    }
  });

  test('AXI-2323.5 AC7 EC1: two workspaces → a workspace selector; the project rule applies independently; the choice survives two reloads @SI-066 @SI-030', async ({ page }) => {
    await signIn(page, inv2, /\/investigator$/);
    const select = page.getByTestId('investigator-workspace-select');
    await expect(select).toBeVisible();
    const options = await select.locator('option:not([value=""])').allTextContents();
    expect(options.sort()).toEqual([w.w2a.name, w.w2b.name].sort());
    await expect(page.getByTestId('investigator-choose-scope')).toBeVisible();
    await expect(page.getByTestId('investigator-nav')).toHaveCount(0);
    await expect(page.locator('[data-testid^="investigator-scope-project-"], [data-testid="investigator-project-select"]')).toHaveCount(0);

    await select.selectOption(w.w2b.id);
    await expect(page.getByTestId('investigator-scope-project-name')).toHaveText(p.p2b.name);
    await expect(page.getByTestId('investigator-project-select')).toHaveCount(0);
    await expectLanded(page, w.w2b, p.p2b);

    for (let i = 0; i < 2; i++) {
      await hardReload(page);
      await expectLanded(page, w.w2b, p.p2b);
      await expect(page.getByTestId('investigator-workspace-select')).toHaveValue(w.w2b.id);
    }
  });

  test('AXI-2323.6 AC7 EC1: one workspace with two projects → a project selector; the choice survives two reloads @SI-066 @SI-030', async ({ page }) => {
    await signIn(page, inv3, /\/investigator$/);
    await expect(page.getByTestId('investigator-scope-workspace-name')).toHaveText(w.w3.name);
    await expect(page.getByTestId('investigator-workspace-select')).toHaveCount(0);
    const select = page.getByTestId('investigator-project-select');
    const options = await select.locator('option:not([value=""])').allTextContents();
    expect(options).toEqual([p.p3a.name, p.p3b.name]);
    await expect(page.getByTestId('investigator-choose-scope')).toBeVisible();

    await select.selectOption(p.p3b.id);
    await expectLanded(page, w.w3, p.p3b);
    for (let i = 0; i < 2; i++) {
      await hardReload(page);
      await expectLanded(page, w.w3, p.p3b);
    }
  });

  test('AXI-2323.7 AC8 EC2: zero projects → "No study assigned yet — contact Axiome", no nav, no selector, no creation path @SI-066 @SI-030', async ({ page }) => {
    await signIn(page, inv4, /\/investigator$/);
    for (const path of ['/investigator', '/investigator/uploads']) {
      await page.goto(path);
      const none = page.getByTestId('investigator-no-study');
      await expect(none).toHaveAttribute('data-reason', 'project');
      await expect(none).toContainText(NO_STUDY);
      await expect(page.getByTestId('investigator-nav')).toHaveCount(0);
      await expect(page.locator('[data-testid$="-select"]')).toHaveCount(0);
      await expect(page.getByTestId('upload-dropzone')).toHaveCount(0);
      await expectNoCreationPath(page);
    }
  });

  test('AXI-2323.8 AC8 EC2: zero (active) workspaces → the same "No study assigned yet" state @SI-066 @SI-030', async ({ page }) => {
    await signIn(page, inv5, /\/investigator$/);
    const none = page.getByTestId('investigator-no-study');
    await expect(none).toHaveAttribute('data-reason', 'workspace');
    await expect(none).toContainText(NO_STUDY);
    await expect(page.getByTestId('investigator-nav')).toHaveCount(0);
    await expect(page.locator('[data-testid$="-select"]')).toHaveCount(0);
    await expectNoCreationPath(page);
    expect(await stored(page)).toEqual([null, null]);
  });

  test('AXI-2323.9 AC7 (team regression): a team Editor keeps the team top menu; the count rule is not applied @SI-030', async ({ page }) => {
    await signIn(page, editor, /^(?!.*\/login)(?!.*\/investigator).*$/);
    await expect(page.locator('[data-testid="scope-label-workspace"], [data-testid="scope-dropdown-workspace"]').first()).toBeVisible();
    await expect(page.getByTestId('investigator-surface')).toHaveCount(0);
    await expect(page.getByTestId('investigator-scope')).toHaveCount(0);
    expect((await stored(page))[0], 'no workspace is auto-landed for a team user').toBeNull();
  });

  test('AXI-2323.10 owner ruling Q8: GET snapshot-comments/count is re-closed for the Investigator (403); a team member still reads it @SI-010', async () => {
    const path = `/api/v1/snapshot-comments/count?anchorType=published_analysis_version&anchorId=${crypto.randomUUID()}`;
    const headers = { 'X-Workspace-Id': w.w1.id };

    const his = await inv1.api.get(apiUrl(path), { headers });
    const team = await editor.api.get(apiUrl(path), { headers });

    expect(his.status(), await his.text()).toBe(403);
    expect((await his.json()).message).toBe(DENIED);
    expect(team.status(), await team.text()).toBe(200);
  });

  test('AXI-2323.11 owner ruling Q15: the investigator surface never requests GET /roles; the team surface still loads it @SI-066 @SI-030', async ({ browser }) => {
    const watch = async (who: Person, landing: RegExp, pages: string[]) => {
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const page = await context.newPage();
      const roles: number[] = [];
      page.on('response', (res) => {
        if (res.request().method() === 'GET' && ROLES_LIST.test(res.url())) roles.push(res.status());
      });
      await signIn(page, who, landing);
      return { context, page, roles, pages };
    };

    const his = await watch(inv1, /\/investigator$/, ['/investigator', '/investigator/uploads', '/investigator/results', '/investigator/new-analysis', '/investigator/statistical-plan']);
    for (const path of his.pages) {
      await his.page.goto(path);
      await expect(his.page.getByTestId('investigator-scope-workspace-name')).toHaveText(w.w1.name, { timeout: LOAD_MS });
    }
    await his.page.goto('/investigator');
    await hardReload(his.page);
    await expectLanded(his.page, w.w1, p.p1);
    expect(his.roles, 'no GET /roles on the investigator surface').toEqual([]);
    await his.context.close();

    const team = await watch(editor, /^(?!.*\/login)(?!.*\/investigator).*$/, []);
    await expect(team.page.locator('[data-testid="scope-label-workspace"], [data-testid="scope-dropdown-workspace"]').first()).toBeVisible();
    await expect.poll(() => team.roles.length, { message: 'the team surface still loads the role catalog' }).toBeGreaterThan(0);
    expect(team.roles.every((status) => status === 200)).toBe(true);
    await team.context.close();
  });
});
