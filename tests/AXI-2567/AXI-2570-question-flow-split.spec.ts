import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { QuestionFlowStub } from './harness/question-flow-stub';

/**
 * AXI-2570 (epic AXI-2567 — Plan Before Data): the question-flow split — the wizard's question
 * mode stores a question STUB; the stub reads "Awaiting plan"; the plan editor writes its plan.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2567-Plan-Before-Data.md` § AXI-2570 (2.1 … 2.5).
 *
 * E2E CONTRACT — sign-in, workspace, project, membership and the INVESTIGATOR role's
 * permissions are REAL (demo gateway). The SAP routes are an in-memory DOUBLE
 * (`harness/question-flow-stub.ts`, AXI-2570 contracts): no running stack serves the AXI-2570
 * backend (stub routes + `questionStates` exist only on the story branch) and the shared demo
 * DB lacks the AXI-2568 migration a v2 draft needs. Owed at W5: re-run with the double removed.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2570-e2e-pw!';
const QUESTION = 'Does CRP fall by week 12?';

interface Person extends Actor { email: string; accessToken: string }

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;
let projectId: string;
let stub: QuestionFlowStub;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2570-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2570', lastName: label } });
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
  await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  projectOwner = await world.actor('owner');
  await world.addMember(projectOwner, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2570 ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  projectId = (await res.json()).id;
  const grant = await access.grant(projectOwner, projectId, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
  stub = new QuestionFlowStub(projectId, investigator.userId);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2570 question flow: stub, awaiting plan, plan written @SI-030 @SI-066 @SI-065 @SI-071 @SI-031 @SI-010', () => {
  test('AXI-2570.1 FR28 FR27 ask a question walks Question → Ready only and stores a stub (text + role)', async ({ page }) => {
    await openSap(page);
    await page.getByTestId('sap-ask-question').click();
    await expect(page).toHaveURL(/\/sap\/questions\/new\?mode=question$/);
    const flow = page.getByTestId('sap-question-mode');
    await expect(flow).toHaveAttribute('data-step', 'question');
    await expect(page.getByTestId('sap-question-mode-steps').locator('li')).toHaveText(['1. Question', '2. Ready']);
    await expect(page.getByTestId('na-page')).toHaveCount(0);
    await page.getByTestId('sap-question-mode-text').fill(QUESTION);
    await page.getByTestId('sap-question-mode-next').click();
    await expect(flow).toHaveAttribute('data-step', 'ready');
    await expect(page.getByTestId('sap-question-mode-readback')).toHaveText(QUESTION);
    await expect(page.getByTestId('sap-question-mode-role').locator('option')).toHaveText(['Primary', 'Secondary', 'Exploratory']);
    await expect(page.getByTestId('sap-question-mode-role')).toHaveValue('primary');
    await page.getByTestId('sap-question-mode-role').selectOption('secondary');
    await page.getByTestId('sap-question-mode-add').click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap\\?highlight=`));
    expect(stub.writesTo('POST', '/draft/question-stubs').map((w) => w.body)).toEqual([
      { basedOnRevision: 1, question: { text: QUESTION, role: 'secondary' } },
    ]);
    expect(stub.writesTo('POST', '/draft/questions')).toHaveLength(0);
  });

  test('AXI-2570.2 FR29 FR11 the stub reads "Awaiting plan" with a Write plan link; finalise is disabled', async ({ page }) => {
    await openSap(page);
    const row = page.getByTestId('sap-draft-spec-questions-Q1');
    await expect(row).toHaveAttribute('data-state', 'stub');
    await expect(page.getByTestId('sap-draft-spec-questions-Q1-state')).toHaveText('Awaiting plan');
    await expect(row).toContainText('no statistical plan yet');
    await expect(page.getByTestId('sap-draft-spec-questions-Q1-plan')).toBeVisible();
    await expect(page.getByTestId('sap-finalise')).toBeDisabled();
  });

  test('AXI-2570.3 FR27 a blank question cannot be added; no stub request is sent', async ({ page }) => {
    await openSap(page);
    const before = stub.writesTo('POST', '/draft/question-stubs').length;
    await page.getByTestId('sap-ask-question').click();
    await page.getByTestId('sap-question-mode-next').click();
    await expect(page.getByTestId('sap-question-mode-issues')).toContainText('The question needs its text.');
    await expect(page.getByTestId('sap-question-mode-add')).toBeDisabled();
    expect(stub.writesTo('POST', '/draft/question-stubs')).toHaveLength(before);
  });

  test('AXI-2570.4 FR28 FR29 Write plan opens the stub read-only and saves its plan in place (same id) → Complete', async ({ page }) => {
    await openSap(page);
    const stubId = stub.questions[0].questionId;
    await page.getByTestId('sap-draft-spec-questions-Q1-plan').click();
    await expect(page).toHaveURL(new RegExp(`/sap/questions/${stubId}$`));
    const form = page.getByTestId('sap-spec-question-form');
    await expect(form).toHaveAttribute('data-stub', 'true');
    await expect(form.getByRole('heading')).toHaveText('Plan this question');
    await expect(page.getByTestId('sap-spec-q-stub-text')).toHaveText(QUESTION);
    await expect(page.getByTestId('sap-spec-q-text')).toHaveCount(0);
    await expect(page.getByTestId('sap-spec-q-role')).toHaveCount(0);
    await page.getByTestId('sap-spec-q-template').selectOption('T1');
    await page.getByTestId('sap-spec-q-slot-groupingColumn').selectOption({ label: 'arm — Treatment arm' });
    await page.getByTestId('sap-spec-q-slot-outcome').selectOption({ label: 'crp_mg_l — CRP (mg/L)' });
    for (const key of ['variable', 'treatmentComparison', 'intercurrentEvents', 'populationSummary']) {
      await page.getByTestId(`sap-spec-q-estimand-${key}`).fill(`E2E ${key}`);
    }
    await expect(page.getByTestId('sap-spec-q-save')).toHaveText('Save plan');
    await page.getByTestId('sap-spec-q-save').click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap\\?highlight=${stubId}`));
    const put = stub.writesTo('PUT', `/draft/questions/${stubId}`);
    expect(put).toHaveLength(1);
    expect(put[0].body.question).toMatchObject({ text: QUESTION, role: 'secondary', template: { templateId: 'T1' } });
    expect(put[0].body.question.bindings.map((b: { slot: string }) => b.slot)).toEqual(['groupingColumn', 'outcome']);
    expect(stub.writesTo('POST', '/draft/questions')).toHaveLength(0);
    await expect(page.getByTestId('sap-draft-spec-questions-Q1-state')).toHaveText('Complete');
    await expect(page.getByTestId('sap-draft-spec-questions-Q1-plan')).toHaveCount(0);
  });

  test('AXI-2570.5 FR28 "Add question" still opens the AXI-2569 declared question form (ordinary flow untouched)', async ({ page }) => {
    await openSap(page);
    await page.getByTestId('sap-add-question').click();
    await expect(page).toHaveURL(/\/sap\/questions\/new$/);
    const form = page.getByTestId('sap-spec-question-form');
    await expect(form).toBeVisible();
    await expect(form).not.toHaveAttribute('data-stub', 'true');
    await expect(page.getByTestId('sap-spec-q-text')).toBeEditable();
    await expect(page.getByTestId('sap-spec-q-save')).toHaveText('Add to plan');
    await expect(page.getByTestId('sap-question-mode')).toHaveCount(0);
  });
});
