import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { QuestionFlowStub } from './harness/question-flow-stub';

/**
 * AXI-2589 (epic AXI-2567 — Plan Before Data FR59, FR60, FR61): the investigator's "Add a
 * question" modal replaces the full-page question flow — sidebar / header / empty-state entries,
 * the role default and the one-primary rule, Enter / Esc / discard, the post-add toast with Undo,
 * "Add and define analysis", and the no-protocol gate.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2567-Plan-Before-Data.md` § AXI-2589 (2.1 … 2.5).
 *
 * E2E CONTRACT — sign-in, workspace, project, membership and the INVESTIGATOR role's
 * permissions are REAL (demo gateway). Answered by the AXI-2570 in-memory DOUBLE
 * (`harness/question-flow-stub.ts`): the v2 SAP draft, the stub / delete routes, completeness
 * with `questionStates`, the template catalogue (with `methodName`), the protocol read; and the
 * AXI-2588 question rights are ADDED to his real `GET /workspace-permissions/me` answer. Why:
 * no running stack serves the AXI-2568/2570/2588/2589 back branches yet (v2 drafts, stub routes,
 * question rights, `methodName`). Owed at W5: re-run with the double removed.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2589-e2e-pw!';
const QUESTION = 'Does CRP fall by week 12?';
const PRIMARY_STUB = { questionId: '77777777-7777-4777-8777-000000000901', text: 'Does the drug lower CRP?', role: 'primary' };

interface Person extends Actor { email: string; accessToken: string }

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;
let projectId: string;
let stub: QuestionFlowStub;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2589-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2589', lastName: label } });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

async function openSap(page: Page, query = ''): Promise<void> {
  await stub.install(page);
  await stub.grantQuestionRights(page);
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
  await gotoSettled(page, `/investigator/projects/${projectId}/sap${query}`);
  await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });
}

const modal = (page: Page) => page.getByTestId('sap-add-question-modal');

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  projectOwner = await world.actor('owner');
  await world.addMember(projectOwner, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2589 ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  projectId = (await res.json()).id;
  const grant = await access.grant(projectOwner, projectId, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
  stub = new QuestionFlowStub(projectId, investigator.userId);
});

test.beforeEach(() => {
  stub.protocolSaved = true;
  stub.seed([]);
  stub.writes.length = 0;
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2589 add a question in a modal @SI-030 @SI-066 @SI-031', () => {
  test('AXI-2589.1 FR59 FR60 sidebar Add question → modal (focus, Primary default) → Enter → Q1 "Awaiting analysis" highlighted + toast → Undo removes it', async ({ page }) => {
    await openSap(page);
    await page.getByTestId('investigator-add-question').click();
    await expect(page).toHaveURL(/\?add=question$/);
    await expect(modal(page)).toBeVisible();
    await expect(modal(page).getByRole('heading')).toHaveText('Add a question');
    await expect(page.getByTestId('sap-add-question-text')).toBeFocused();
    await expect(page.getByTestId('sap-add-question-role-primary')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('sap-add-question-primary-helper')).toHaveCount(0);

    await page.getByTestId('sap-add-question-text').fill(QUESTION);
    await page.getByTestId('sap-add-question-text').press('Enter');

    await expect(modal(page)).toHaveCount(0);
    expect(stub.writesTo('POST', '/draft/question-stubs').map((w) => w.body)).toEqual([
      { basedOnRevision: expect.any(Number), question: { text: QUESTION, role: 'primary' } },
    ]);
    const added = stub.questions[0].questionId;
    await expect(page).toHaveURL(new RegExp(`highlight=${added}`));
    await expect(page).not.toHaveURL(/add=question/);
    const row = page.getByTestId('sap-plan-questions-row-Q1');
    await expect(row).toHaveAttribute('data-highlighted', 'true');
    await expect(page.getByTestId('sap-plan-questions-status-Q1')).toHaveText('Awaiting analysis');
    await expect(page.getByTestId('sap-plan-questions-method-Q1')).toHaveText('–');
    await expect(page.getByTestId('sap-question-added-toast-message')).toHaveText('Question added as Q1 · awaiting its analysis');
    await expect(page.getByTestId('sap-question-added-define')).toBeVisible();

    await page.getByTestId('sap-question-added-undo').click();
    await expect(page.getByTestId('sap-question-added-toast')).toHaveCount(0);
    expect(stub.writesTo('DELETE', `/draft/questions/${added}`)).toHaveLength(1);
    await expect(page.getByTestId('sap-plan-questions-row-Q1')).toHaveCount(0);
    await expect(page.getByTestId('sap-plan-no-questions')).toBeVisible();
  });

  test('AXI-2589.2 FR59 owner ruling 3 — with a primary present Primary is disabled with its helper; "Add and define analysis" opens the plan editor on the new stub', async ({ page }) => {
    stub.seed([PRIMARY_STUB]);
    await openSap(page);
    await page.getByTestId('sap-plan-add-question').click();
    await expect(modal(page)).toBeVisible();
    await expect(page.getByTestId('sap-add-question-role-primary')).toBeDisabled();
    await expect(page.getByTestId('sap-add-question-primary-helper')).toHaveText('Primary is already used by Q1 · a plan has one primary question.');
    await expect(page.getByTestId('sap-add-question-role-secondary')).toHaveAttribute('aria-checked', 'true');

    await page.getByTestId('sap-add-question-text').fill('  does the drug   LOWER crp? ');
    await page.getByTestId('sap-add-question-submit').click();
    await expect(page.getByTestId('sap-add-question-issue')).toHaveText('This question is already in the plan (Q1).');
    expect(stub.writesTo('POST', '/draft/question-stubs')).toHaveLength(0);

    await page.getByTestId('sap-add-question-text').fill(QUESTION);
    await page.getByTestId('sap-add-question-define').click();
    const added = stub.questions[1]?.questionId;
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap/questions/${added}$`));
    expect(stub.writesTo('POST', '/draft/question-stubs').map((w) => w.body.question)).toEqual([{ text: QUESTION, role: 'secondary' }]);
  });

  test('AXI-2589.3 FR59 empty-state "Add the primary question" opens the modal; Esc empty closes, Esc with text asks to discard', async ({ page }) => {
    await openSap(page);
    await page.getByTestId('sap-plan-add-primary-question').click();
    await expect(modal(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/add=question/);

    await page.getByTestId('sap-plan-add-primary-question').click();
    await page.getByTestId('sap-add-question-text').fill('Half a question');
    await page.getByTestId('sap-add-question-text').press('Escape');
    await expect(page.getByRole('heading', { name: 'Discard this question?' })).toBeVisible();
    await expect(modal(page)).toBeVisible();
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(modal(page)).toHaveCount(0);
    expect(stub.writesTo('POST', '/draft/question-stubs')).toHaveLength(0);
  });

  test('AXI-2589.4 FR59 no saved protocol — the page entries are disabled; the sidebar opens the protocol page', async ({ page }) => {
    stub.protocolSaved = false;
    await openSap(page, '?add=question');
    await expect(modal(page)).toHaveCount(0);
    await expect(page.getByTestId('sap-plan-add-question')).toBeDisabled();
    await expect(page.getByTestId('sap-plan-add-primary-question')).toBeDisabled();
    await expect(page.getByTestId('sap-plan-add-question').locator('..')).toHaveAttribute('title', 'Save the protocol first: the plan follows it.');
    await page.getByTestId('investigator-add-question').click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/study/protocol$`));
  });

  test('AXI-2589.5 FR61 rows order by role then creation; the Method column reads "method · α"', async ({ page }) => {
    const planned = {
      questionId: '77777777-7777-4777-8777-000000000902', text: 'Does arm matter?', role: 'primary',
      template: { templateId: 'T1', templateVersion: '1.0.0' },
      bindings: [{ slot: 'groupingColumn', field: 'field-arm' }, { slot: 'outcome', field: 'field-crp' }],
      estimand: {}, parameters: { alpha: 0.05, sidedness: 'two_sided' }, decisionCriterion: { kind: 'p_at_or_below_alpha' }, sensitivityAnalyses: [],
    };
    stub.seed([{ questionId: '77777777-7777-4777-8777-000000000903', text: 'Exploring IL-6?', role: 'exploratory' }, planned]);
    await openSap(page);
    await expect(page.getByTestId('sap-plan-questions-row-Q1')).toHaveAttribute('data-question-id', planned.questionId);
    await expect(page.getByTestId('sap-plan-questions-method-Q1')).toHaveText('Mann-Whitney U test · α 0.05');
    await expect(page.getByTestId('sap-plan-questions-row-Q2')).toContainText('Exploring IL-6?');
    await expect(page.getByTestId('sap-plan-questions-status-Q2')).toHaveText('Awaiting analysis');
  });
});
