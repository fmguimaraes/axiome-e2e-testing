import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, type Actor } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { silenceTours } from '../AXI-1904/harness/tours';
import { askQuestion, choose, gotoSettled } from '../AXI-2308/harness/new-analysis';
import { SapApiStub, apiCallOf, pinNewestT1, questionInput, uploadArmScoreDataset, type ApiCall } from './harness/sap-api-stub';

/**
 * AXI-2553 (epic AXI-2433 — Structured Statistical Analysis Plan; owner finding 2026-11-15, MAG4
 * handover §5 step 3): plan mode's question routes take the SAME focus layout as the ordinary
 * New analysis wizard on each surface (no docked sidebar), and the wizard rail header names what
 * is being built ("New SAP question" / "Edit SAP question") instead of "Analysis steps".
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md`
 * § AXI-2553 (AXI-2553.1 … AXI-2553.4).
 *
 * E2E CONTRACT — every route REAL on the demo gateway: sign-in, fixture workspace/project/
 * dataset, AXI-2438's draft + question routes. No SAP route is doubled.
 *
 * Self-provisioned: a fresh workspace whose platform admin leaves it; a throwaway team editor and
 * an Investigator. Run with `--no-deps`.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2553-e2e-pw!';
const QUESTION = 'Does the score differ between the two arms?';

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let editor: UiActor;
let investigator: Person;
let call: ApiCall;
let datasetId: string;

interface Fixture {
  projectId: string;
  stub: SapApiStub;
}

/** A project with the fixture dataset linked, and its SAP double. */
async function newProject(label: string): Promise<Fixture> {
  const name = `E2E AXI-2553 ${label} ${Date.now()}`;
  const res = await editor.api.post(apiUrl('/api/v1/projects'), { data: { name, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const projectId = (await res.json()).id;
  const link = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  return { projectId, stub: new SapApiStub(projectId, editor.userId, datasetId) };
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2553-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2553', lastName: label },
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

async function signIn(page: Page): Promise<void> {
  await page.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(page, editor, world.workspaceId);
}

async function signInInvestigator(page: Page): Promise<void> {
  await page.addInitScript(
    ([org, ws]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [world.orgId, world.workspaceId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
}

/** Question → chosen intent — enough to see the wizard rail without finishing the analysis. */
async function toTheRail(page: Page): Promise<void> {
  await askQuestion(page, QUESTION);
  await expect(page.getByTestId('na-step-intent')).toBeVisible();
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await uiActor('editor', world.workspaceId);
  investigator = await person('investigator', world.workspaceId);
  await world.addMember(editor, 'editor');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.leaveWorkspace();
  await silenceTours(editor.accessToken);
  await silenceTours(investigator.accessToken);
  datasetId = await uploadArmScoreDataset(world, editor.api, 'axi2553');
  call = apiCallOf(editor.api);
  await pinNewestT1(call, (await newProject('catalogue')).projectId); // seeds pin the registry's newest
});

test.afterAll(async () => {
  for (const a of [editor, investigator]) await a?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2553 plan-mode layout: focus chrome and a descriptive rail title @SI-030 @SI-066', () => {
  test('AXI-2553.1 team: plan mode takes the focus layout, title names the action @SI-030', async ({ page }) => {
    // Arrange — an empty open draft
    const { projectId, stub } = await newProject('team-new');
    await stub.seedDraft(call, []);
    await signIn(page);

    // Act
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);

    // Assert — the Discovery Workbench's own minimal top bar, no docked "New analysis" rail pill
    // (only ever rendered by the docked team sidebar, never the focus top bar); the project/draft
    // fetch can outlast Playwright's default timeout on a live stack.
    await expect(page.getByTestId('na-page')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('rail-new-analysis')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(page.getByTestId('na-rail-title')).toHaveText('New SAP question');

    // Assert — the breadcrumb (rendered inside that same top bar) still leads back to the plan
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs.getByRole('link', { name: 'Statistical Analysis Plan' })).toHaveAttribute('href', `/projects/${projectId}/sap`);
  });

  test('AXI-2553.2 team: editing a question reads "Edit SAP question", and Ready returns to the plan with it highlighted @SI-030', async ({ page }) => {
    // Arrange — a draft already holding one question
    const { projectId, stub } = await newProject('team-edit');
    const seeded = await stub.seedDraft(call, [questionInput(1, 'primary')]);
    const questionId = seeded.plan.questions[0].questionId;
    await signIn(page);

    // Act
    await gotoSettled(page, `/projects/${projectId}/sap/questions/${questionId}`);

    // Assert
    await expect(page.getByTestId('na-step-ready')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('na-rail-title')).toHaveText('Edit SAP question');
    await expect(page.getByTestId('na-page')).toBeVisible();

    // Act — save; AXI-2553 §3: Ready returns automatically, the edited question highlighted
    await choose(page, 'na-plan-save');

    // Assert — back on the SAME team SAP page, with that question named in the return URL
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap\\?highlight=${questionId}$`));
    await expect(page.getByTestId('sap-plan-tab')).toBeVisible();
    await expect(page.getByTestId('sap-add-question')).toBeVisible();
  });

  test('AXI-2553.3 investigator: plan mode takes the focus layout, no docked rail @SI-066', async ({ page }) => {
    // Arrange — an Investigator with sap:read/update (default seed) and an open draft on his project
    const { projectId, stub } = await newProject('investigator');
    await stub.seedDraft(call, []);

    // Act
    await signInInvestigator(page);
    await gotoSettled(page, `/investigator/projects/${projectId}/sap/questions/new`);

    // Assert — the docked investigator rail's own items are absent
    await expect(page.getByTestId('na-page')).toBeVisible({ timeout: 60_000 });
    for (const testId of ['investigator-nav-uploads', 'investigator-nav-results', 'investigator-nav-settings']) {
      await expect(page.getByTestId(testId)).toHaveCount(0);
    }
    await expect(page.getByTestId('investigator-focus-menu-button')).toBeVisible();
    await expect(page.getByTestId('na-rail-title')).toHaveText('New SAP question');

    // Assert — the hamburger opens the generic drawer nav, his way back to the plan
    // (Statistical plan → the project's SAP page); no project-specific breadcrumb on his surface.
    await page.getByTestId('investigator-focus-menu-button').click();
    await expect(page.getByTestId('investigator-nav-statistical-plan')).toBeVisible();
  });

  test('AXI-2553.4 the ordinary wizard keeps "Analysis steps" @SI-030 @SI-066', async ({ page }) => {
    // Arrange — the ordinary wizard runs on an active project's data
    const { projectId } = await newProject('ordinary-wizard');
    await page.addInitScript((project) => localStorage.setItem('axiome-active-project', project), projectId);
    await signIn(page);

    // Act
    await gotoSettled(page, '/new-analysis');
    await toTheRail(page);

    // Assert — plan mode's title override never leaks into the ordinary wizard
    await expect(page.getByTestId('na-rail-title')).toHaveText('Analysis steps');
  });
});
