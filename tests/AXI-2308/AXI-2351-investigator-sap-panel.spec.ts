import { randomUUID } from 'crypto';
import { Page, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from './harness/new-analysis';

/**
 * AXI-2351 (epic AXI-2308 — Platform Opening: Human Guided) — the Investigator writes his
 * project's SAP on his own surface: a "Statistical plan" entry in the investigator navigation
 * renders AXI-2350's SAP panel for his active project (FR16 "Paul pastes it on first visit",
 * AC12, D16). He holds `sap:write` (AXI-2338) by the server's Investigator fallback; the
 * client mirror must follow it — `GET /roles` is refused to him, so no role record ever
 * reaches the page.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2351
 * (.2–.6). Self-provisioned: a fresh fixture workspace whose platform admin leaves it; a
 * throwaway Investigator (membership role id …0105) and a throwaway team Editor (API
 * cross-checks only). Fresh storage state per test; the active scope is seeded in
 * localStorage and the Investigator signs in through the UI. Run with `--no-deps`.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2351-e2e-pw!';

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let editor: Actor;
let projectId: string;

const saps = (project: string, suffix = '') => apiUrl(`/api/v1/projects/${project}/saps${suffix}`);

function unique(label: string): string {
  return `axi2351-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function content(overrides: Record<string, unknown> = {}) {
  return {
    title: `E2E AXI-2351 SAP ${Date.now()}`,
    questionText: 'Does CCL19 differ between active and inactive disease?',
    planText: 'Primary: Mann–Whitney U on CCL19, active vs inactive, α = 0.05.',
    linkedMethods: [],
    ...overrides,
  };
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2351', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

async function newProject(label: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2351 ${label} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function listSaps(project: string): Promise<any[]> {
  const res = await editor.api.get(saps(project));
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data;
}

/** Sign in through the UI with `project` as his active project; lands on `/investigator`. */
async function signIn(page: Page, project: string): Promise<void> {
  await page.addInitScript(
    ([org, ws, p]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', p);
    },
    [world.orgId, world.workspaceId, project] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
}

/**
 * Signed in, then the Statistical plan through his navigation (client-side, no reload).
 * The sign-in flow clears the active scope on main today (WorkspaceContext / selectors —
 * AXI-2323 owns the study landing), so exactly one `goto` after sign-in lets the init
 * script re-seed it, as AXI-2325's spec does.
 */
async function openPlan(page: Page, project: string): Promise<void> {
  await signIn(page, project);
  await gotoSettled(page, '/investigator');
  await page.getByTestId('investigator-nav-statistical-plan').click();
  await expect(page).toHaveURL(/\/investigator\/statistical-plan$/);
}

async function fillPlan(page: Page, plan: { title: string; questionText: string; planText: string }) {
  await page.getByTestId('sap-field-title').fill(plan.title);
  await page.getByTestId('sap-field-questionText').fill(plan.questionText);
  await page.getByTestId('sap-field-planText').fill(plan.planText);
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  editor = await world.actor('editor');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(editor, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  projectId = await newProject('study');
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2351 Investigator Statistical plan @SI-066 @SI-031', () => {
  test('AC12 AXI-2351.2 his navigation offers the Statistical plan; the empty state offers him the write @SI-066 @SI-031', async ({ page }) => {
    // Arrange — the roles catalogue is refused to him: the page must not need it
    const roles = await investigator.api.get(apiUrl('/api/v1/roles'));
    expect(roles.status()).toBe(403);

    // Act
    await openPlan(page, projectId);

    // Assert
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
    await expect(page.getByTestId('investigator-statistical-plan')).toBeVisible();
    await expect(page.getByTestId('sap-empty-state')).toContainText('no statistical analysis plan');
    await expect(page.getByTestId('sap-empty-state')).toContainText('labelled exploratory');
    await expect(page.getByTestId('sap-write-first')).toBeVisible();
    await expect(page.getByTestId('sap-read-only-note')).toHaveCount(0);
  });

  test('AC12 AXI-2351.3 he pastes the SAP as version 1; the team reads the same SAP @SI-066 @SI-031 @SI-030', async ({ page }) => {
    // Arrange
    const plan = content({ planText: 'Primary: Mann–Whitney U on CCL19.\n\nSecondary: none.' });
    await openPlan(page, projectId);

    // Act
    await page.getByTestId('sap-write-first').click();
    await fillPlan(page, plan);
    await page.getByTestId('sap-save').click();

    // Assert
    await expect(page.getByTestId('sap-current-version')).toHaveText('Version 1 · current');
    await expect(page.getByTestId('sap-current-text-title')).toHaveText(plan.title);
    await expect(page.getByTestId('sap-current-text-plan')).toHaveText(plan.planText, { useInnerText: true });
    await expect(page.getByTestId('sap-history-table').locator('tbody tr')).toHaveCount(1);
    const listed = await listSaps(projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      version: 1, title: plan.title, questionText: plan.questionText, planText: plan.planText,
      authorUserId: investigator.userId,
    });
  });

  test('AC12 AXI-2351.4 saving again creates version 2; v1 stays listed; no delete or edit-in-place @SI-066 @SI-031', async ({ page }) => {
    // Arrange
    const [v1] = await listSaps(projectId);
    await openPlan(page, projectId);
    const newPlan = 'Primary: Mann–Whitney U on CCL19, Holm-adjusted across two outcomes.';

    // Act
    await page.getByTestId('sap-write-version').click();
    await expect(page.getByTestId('sap-field-title')).toHaveValue(v1.title);
    await page.getByTestId('sap-field-planText').fill(newPlan);
    await expect(page.getByTestId('sap-save')).toHaveText('Save as version 2');
    await page.getByTestId('sap-save').click();

    // Assert
    await expect(page.getByTestId('sap-current-version')).toHaveText('Version 2 · current');
    await expect(page.getByTestId('sap-current-text-plan')).toHaveText(newPlan);
    await expect(page.getByTestId('sap-history-row-2')).toContainText('Current');
    await expect(page.getByTestId('sap-history-row-1')).toContainText('Superseded');
    const panel = page.getByTestId('investigator-statistical-plan');
    await expect(panel.getByRole('button', { name: /delete|remove/i })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /^edit/i })).toHaveCount(0);
    const versions = await (await editor.api.get(saps(projectId, `/${v1.id}/versions`))).json();
    expect(versions.map((v: any) => v.version)).toEqual([1, 2]);
  });

  test('AC12 AXI-2351.5 a stale create is refused 409 (errorCode SAP_ALREADY_EXISTS) and the panel shows the existing SAP @SI-066 @SI-031 @SI-030', async ({ page }) => {
    // Arrange — a second project of his workspace, with no SAP yet
    const raced = await newProject('race');
    await openPlan(page, raced);
    await page.getByTestId('sap-write-first').click();
    await fillPlan(page, content({ title: 'Typed by the Investigator' }));
    const winner = content({ title: 'Written by the team first' });
    const created = await editor.api.post(saps(raced), { data: winner });
    expect(created.status(), await created.text()).toBe(201);
    const refusal = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/projects/${raced}/saps`));

    // Act
    await page.getByTestId('sap-save').click();

    // Assert — the wire carries the typed code as `errorCode`; the panel recovers to the server's truth
    const answer = await refusal;
    expect(answer.status()).toBe(409);
    expect((await answer.json()).errorCode).toBe('SAP_ALREADY_EXISTS');
    await expect(page.getByTestId('sap-write-error')).toContainText('already has its analysis plan');
    await expect(page.getByTestId('sap-current-text-title')).toHaveText(winner.title);
    const listed = await listSaps(raced);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ version: 1, title: winner.title });
  });

  test('AC12 AXI-2351.6 a project he cannot open reads as not found and the way back stays on his surface @SI-066 @SI-031', async ({ page }) => {
    // Arrange
    await openPlan(page, randomUUID());

    // Act
    const back = page.getByTestId('project-not-found-return');
    await expect(page.getByTestId('project-not-found')).toBeVisible();
    await expect(back).toHaveText('Return to my study');
    await back.click();

    // Assert
    await expect(page).toHaveURL(/\/investigator$/);
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
  });
});
