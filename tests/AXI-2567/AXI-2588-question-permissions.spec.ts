import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { Q1_TEXT, Q2_TEXT, QuestionRightsStub } from './harness/question-rights-stub';

/**
 * AXI-2588 (epic AXI-2567 — Plan Before Data; owner request 2026-11-16): SAP questions are
 * permission-protected — `sap:question_create` adds, `sap:question_update` opens the editor,
 * `sap:question_delete` removes — and the investigator's Questions table gains an inline trash
 * button on draft rows.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2567-Plan-Before-Data.md` § AXI-2588 (2.1 … 2.5).
 *
 * E2E CONTRACT — sign-in, workspace, project, membership and the INVESTIGATOR role's permissions
 * are REAL (demo gateway + demo DB, where the AXI-2588 user-service migration granted the three
 * question rights). The SAP routes are an in-memory DOUBLE (`harness/question-rights-stub.ts`):
 * a v1 draft with two questions and the question DELETE. Scenario 2.4 narrows the REAL
 * `/workspace-permissions/me` answer to drop the question rights. Scenario 2.5 (the gateway's
 * refusal) needs the AXI-2588 gateway; the shared demo stack serves `main`, so it runs only with
 * `E2E_AXI2588_GATEWAY=1` against a stack serving the story branch (owed at W5 after merge).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2588-e2e-pw!';
const QUESTION_RIGHTS = ['sap:question_create', 'sap:question_update', 'sap:question_delete'];

interface Person extends Actor { email: string; accessToken: string }

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;
let projectId: string;
let stub: QuestionRightsStub;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2588-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2588', lastName: label } });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

async function openSap(page: Page): Promise<void> {
  await stub.install(page);
  await page.addInitScript(([org, ws, p]) => {
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-active-project', p);
  }, [world.orgId, world.workspaceId, projectId] as const);
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
  await gotoSettled(page, `/investigator/projects/${projectId}/sap`);
  await expect(page.getByTestId('sap-plan-questions-table')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  projectOwner = await world.actor('owner');
  await world.addMember(projectOwner, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2588 ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  projectId = (await res.json()).id;
  const grant = await access.grant(projectOwner, projectId, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
});

test.beforeEach(() => {
  stub = new QuestionRightsStub(projectId, investigator.userId);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2588 SAP question rights: add, edit, remove @SI-031 @SI-010 @SI-030', () => {
  test('AXI-2588.1 AC-seed the Investigator role resolves the three question rights in its workspace (real gateway + DB)', async () => {
    const res = await investigator.api.get(apiUrl('/api/v1/workspace-permissions/me'));
    expect(res.status(), await res.text()).toBe(200);
    const { permissions } = await res.json();
    expect(permissions).toEqual(expect.arrayContaining(['sap:read', 'sap:update', ...QUESTION_RIGHTS]));
  });

  test('AXI-2588.2 AC-delete the trash button asks "Remove question Q2 from the draft?" and removes Q2 at the read revision, without opening the editor', async ({ page }) => {
    await openSap(page);
    await expect(page.getByTestId('sap-plan-questions-row-Q2')).toContainText(Q2_TEXT);
    const prompts: string[] = [];
    page.once('dialog', async (dialog) => { prompts.push(dialog.message()); await dialog.accept(); });
    await page.getByTestId('sap-plan-questions-row-Q2').hover();
    await page.getByTestId('sap-plan-questions-remove-Q2').click();
    await expect(page.getByTestId('sap-plan-questions-row-Q2')).toHaveCount(0);
    expect(prompts).toEqual(['Remove question Q2 from the draft?']);
    const deletes = stub.writesTo('DELETE', `/draft/questions/${stub.questionId(2)}`);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].search).toContain('basedOnRevision=3');
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap(\\?.*)?$`));
    await expect(page.getByTestId('sap-plan-questions-row-Q1')).toContainText(Q1_TEXT);
  });

  test('AXI-2588.3 AC-delete a declined confirmation removes nothing', async ({ page }) => {
    await openSap(page);
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByTestId('sap-plan-questions-row-Q1').hover();
    await page.getByTestId('sap-plan-questions-remove-Q1').click();
    await expect(page.getByTestId('sap-plan-questions-row-Q1')).toBeVisible();
    expect(stub.writesTo('DELETE', `/draft/questions/${stub.questionId(1)}`)).toHaveLength(0);
  });

  test('AXI-2588.3b AC-edit with the update right a row click opens the question editor; with create the header offers Add question', async ({ page }) => {
    await openSap(page);
    await expect(page.getByTestId('sap-plan-add-question')).toBeVisible();
    await page.getByTestId('sap-plan-questions-row-Q1').locator('td').nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/sap/questions/${stub.questionId(1)}$`));
  });

  test('AXI-2588.4 AC-gate without the question rights: no Add question, no trash column, a row does not open the editor', async ({ page }) => {
    await QuestionRightsStub.withoutQuestionRights(page);
    await openSap(page);
    await expect(page.getByTestId('sap-plan-questions-row-Q1')).toBeVisible();
    await expect(page.getByTestId('sap-plan-add-question')).toHaveCount(0);
    await expect(page.getByTestId('sap-plan-questions-remove-Q1')).toHaveCount(0);
    await page.getByTestId('sap-plan-questions-row-Q1').locator('td').nth(1).click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap(\\?.*)?$`));
    expect(stub.writes).toHaveLength(0);
  });

  test('AXI-2588.5 AC-guard the gateway refuses a question removal without sap:question_delete (needs the AXI-2588 gateway)', async () => {
    test.skip(process.env.E2E_AXI2588_GATEWAY !== '1', 'The shared demo stack serves main; run with E2E_AXI2588_GATEWAY=1 against a stack serving AXI-2588 (owed at W5).');
    // The project owner is an Editor: the migration granted it the question rights too, so the
    // refusal is asserted for a Viewer (sap:read only) — 403 names the question right.
    const viewer = await world.actor('viewer');
    await world.addMember(viewer, 'viewer');
    const res = await viewer.api.delete(apiUrl(`/api/v1/projects/${projectId}/saps/00000000-0000-4000-8000-000000000001/draft/questions/00000000-0000-4000-8000-000000000002?basedOnRevision=1`));
    expect(res.status()).toBe(403);
    expect(await res.text()).toContain('sap:question_delete');
  });
});
