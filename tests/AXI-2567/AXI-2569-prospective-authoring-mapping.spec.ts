import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { PlanBeforeDataStub, STUB_INGESTION_ID } from './harness/plan-before-data-stub';

/**
 * AXI-2569 (epic AXI-2567 — Plan Before Data): prospective authoring and data mapping UI.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2567-Plan-Before-Data.md` § AXI-2569 (2.1 … 2.7).
 *
 * E2E CONTRACT — sign-in, workspace, project, membership and the INVESTIGATOR role's
 * permissions are REAL (demo gateway). The SAP / data-binding / run routes, the project's
 * dataset links and the dataset's ingestions are an in-memory DOUBLE
 * (`harness/plan-before-data-stub.ts`, AXI-2568 contracts) because no running stack serves the
 * AXI-2568 backend over a migrated DB (shared demo DB unmigrated; migrating it is forbidden for
 * a story agent). Owed at W5: re-run against a migrated stack with the double removed.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2569-e2e-pw!';
const POPULATION = 'Adults with rheumatoid arthritis, 18-75 years';

interface Person extends Actor { email: string; accessToken: string }

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2569-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2569', lastName: label } });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

async function newProject(label: string): Promise<string> {
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2569 ${label} ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const grant = await access.grant(projectOwner, id, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
  return id;
}

async function openSap(page: Page, stub: PlanBeforeDataStub, projectId: string): Promise<void> {
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

const writesTo = (stub: PlanBeforeDataStub, method: string, suffix: string) =>
  stub.writes.filter((w) => w.method === method && w.path.endsWith(suffix));

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  projectOwner = await world.actor('owner');
  await world.addMember(projectOwner, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2569 declared plan: author, finalise, map, run @SI-031 @SI-066', () => {
  let projectId: string;
  let stub: PlanBeforeDataStub;

  test.beforeAll(async () => {
    projectId = await newProject('declared');
    stub = new PlanBeforeDataStub(projectId, investigator.userId);
  });

  test('AXI-2569.1 AC1 create plan offers "declare data first"; a declared plan needs its study population', async ({ page }) => {
    await openSap(page, stub, projectId);
    await page.getByTestId('sap-header-create-plan').click();
    await page.getByTestId('sap-create-title').fill('CRP prospective plan');
    await page.getByTestId('sap-create-objective').fill('Does CRP differ between arms?');
    await page.getByTestId('sap-create-timing-declared').check();
    const submit = page.getByTestId('sap-create-plan-submit');
    await expect(submit).toBeDisabled();
    await page.getByTestId('sap-create-study-population').fill(POPULATION);
    await submit.click();
    await expect(page.getByTestId('sap-spec-editor')).toBeVisible();
    expect(writesTo(stub, 'POST', '/saps/draft')[0].body).toEqual({ planSchemaVersion: 2 });
    expect(writesTo(stub, 'PUT', '/draft')[0].body).toMatchObject({ title: 'CRP prospective plan', studyPopulation: POPULATION });
    await expect(page.getByTestId('sap-spec-population')).toHaveValue(POPULATION);
  });

  test('AXI-2569.2 AC2 add and remove spec fields; the save sends the whole spec', async ({ page }) => {
    await openSap(page, stub, projectId);
    const add = page.getByTestId('sap-spec-add-field');
    await add.click();
    await page.getByTestId('sap-spec-field-0-name').fill('crp_mg_l');
    await page.getByTestId('sap-spec-field-0-label').fill('CRP (mg/L)');
    await page.getByTestId('sap-spec-field-0-required').check();
    await add.click();
    await page.getByTestId('sap-spec-field-1-name').fill('arm');
    await page.getByTestId('sap-spec-field-1-label').fill('Treatment arm');
    await page.getByTestId('sap-spec-field-1-role').selectOption('grouping_two_levels');
    await page.getByTestId('sap-spec-field-1-levels').fill('A, B');
    await page.getByTestId('sap-spec-field-1-required').check();
    await add.click();
    await page.getByTestId('sap-spec-field-2-name').fill('to_remove');
    await page.getByTestId('sap-spec-field-2-remove').click();
    await expect(page.getByTestId('sap-spec-field-2')).toHaveCount(0);
    await page.getByTestId('sap-spec-save').click();
    await expect.poll(() => writesTo(stub, 'PUT', '/draft').length).toBe(2);
    const fields = writesTo(stub, 'PUT', '/draft')[1].body.dataSpecification.fields;
    expect(fields.map((f: any) => f.name)).toEqual(['crp_mg_l', 'arm']);
    expect(fields.every((f: any) => f.fieldId === undefined)).toBe(true);
    expect(fields[1]).toMatchObject({ semanticRole: 'grouping_two_levels', levels: ['A', 'B'], required: true });
    await expect(page.getByTestId('sap-spec-field-1-name')).toHaveValue('arm');
  });

  test('AXI-2569.3 AC2 a declared question binds spec fields; Population comes from the study population', async ({ page }) => {
    await openSap(page, stub, projectId);
    await page.getByTestId('sap-add-question').click();
    await expect(page.getByTestId('sap-spec-question-form')).toBeVisible();
    await expect(page.getByTestId('na-page')).toHaveCount(0);
    await page.getByTestId('sap-spec-q-text').fill('Does CRP differ between arms?');
    await page.getByTestId('sap-spec-q-template').selectOption('T1');
    await expect(page.getByTestId('sap-spec-q-estimand-population')).toHaveValue(POPULATION);
    const grouping = page.getByTestId('sap-spec-q-slot-groupingColumn');
    await expect(grouping.locator('option')).toHaveText(['Choose a field…', 'arm — Treatment arm']);
    await grouping.selectOption({ label: 'arm — Treatment arm' });
    await page.getByTestId('sap-spec-q-slot-outcome').selectOption({ label: 'crp_mg_l — CRP (mg/L)' });
    for (const key of ['variable', 'treatmentComparison', 'intercurrentEvents', 'populationSummary']) {
      await page.getByTestId(`sap-spec-q-estimand-${key}`).fill(`E2E ${key}`);
    }
    await page.getByTestId('sap-spec-q-save').click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap`));
    const posted = writesTo(stub, 'POST', '/draft/questions')[0].body;
    expect(posted).not.toHaveProperty('analysisDatasetId');
    expect(posted.question.bindings.map((b: any) => b.slot)).toEqual(['groupingColumn', 'outcome']);
    expect(posted.question.estimand.population).toBe(POPULATION);
    await expect(page.getByTestId('sap-draft-spec-questions-Q1')).toContainText('groupingColumn: arm, outcome: crp_mg_l');
  });

  test('AXI-2569.4 AC2 a CC17 warning shows but never blocks finalise; v1 reads back read-only', async ({ page }) => {
    await openSap(page, stub, projectId);
    await expect(page.getByTestId('sap-checklist-warn-CC17')).toBeVisible();
    const finalise = page.getByTestId('sap-finalise');
    await expect(finalise).toBeEnabled();
    await finalise.click();
    await page.getByTestId('sap-finalise-confirm').click();
    await expect(page.getByTestId('sap-draft')).toHaveCount(0);
    await expect(page.getByTestId('sap-final-spec-population')).toHaveText(POPULATION);
    await expect(page.getByTestId('sap-final-spec-fields')).toContainText('crp_mg_l');
    await expect(page.getByTestId('sap-final-spec-questions-Q1')).toBeVisible();
  });

  test('AXI-2569.5 AC4 AC5 Run plan opens at the mapping step; BLOCK stops Start; an edit drops the binding; Start carries dataBindingId', async ({ page }) => {
    await openSap(page, stub, projectId);
    const run = page.getByTestId('sap-run');
    await expect(run).toBeEnabled();
    await expect(run).toHaveAttribute('title', /Map your data to the plan first/);
    await run.click();
    await expect(page.getByTestId('sap-run-dialog-dataset-choice')).toHaveValue(/ds-e2e-2569/);
    await expect(page.getByTestId('sap-run-dialog-binding-step')).toBeVisible();
    const start = page.getByTestId('sap-run-dialog-confirm');
    await expect(start).toBeDisabled();
    const selects = page.locator('select[data-testid^="sap-run-dialog-mapping-"]');
    await expect(selects).toHaveCount(2);
    const crp = selects.nth(0);
    await expect(crp).toHaveValue('crp_mg_l');
    await crp.selectOption('subject_id');
    await page.getByTestId('sap-run-dialog-binding-confirm').click();
    await expect(page.getByTestId('sap-run-dialog-conformance-block')).toContainText('subject_id');
    await expect(start).toBeDisabled();
    await crp.selectOption('crp_mg_l');
    await page.getByTestId('sap-run-dialog-binding-confirm').click();
    await expect(page.getByTestId('sap-run-dialog-conformance-pass')).toBeVisible();
    await expect(start).toBeEnabled();
    await selects.nth(1).selectOption('subject_id');
    await expect(start).toBeDisabled();
    await selects.nth(1).selectOption('arm');
    await page.getByTestId('sap-run-dialog-binding-confirm').click();
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page).toHaveURL(/run-e2e-2569/);
    const started = writesTo(stub, 'POST', '/runs')[0].body;
    expect(writesTo(stub, 'POST', '/data-bindings')).toHaveLength(3);
    expect(started).toMatchObject({ version: 1, datasetVersionId: STUB_INGESTION_ID });
    expect(started.dataBindingId).toMatch(/^binding-/);
  });
});

test.describe('AXI-2569 regressions: amend after finalise, retrospective create @SI-031', () => {
  test('AXI-2569.6 AC1 a finalised plan keeps Add question enabled; the click starts the next version', async ({ page }) => {
    const projectId = await newProject('amend');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    stub.seedFinalV1();
    await openSap(page, stub, projectId);
    const add = page.getByTestId('sap-header-add-question');
    await expect(add).toBeEnabled();
    await expect(page.getByTestId('sap-add-question-note')).toHaveText('Adding a question starts v2');
    await add.click();
    await expect(page).toHaveURL(/\/sap\/questions\/new/);
    expect(writesTo(stub, 'POST', '/saps/draft')).toHaveLength(1);
  });

  test('AXI-2569.7 AC3 "on existing data" creates today\'s v1 plan — no schema version, no population', async ({ page }) => {
    const projectId = await newProject('retro');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    await openSap(page, stub, projectId);
    await page.getByTestId('sap-header-create-plan').click();
    await expect(page.getByTestId('sap-create-timing-existing')).toBeChecked();
    await expect(page.getByTestId('sap-create-study-population')).toHaveCount(0);
    await page.getByTestId('sap-create-title').fill('Retrospective');
    await page.getByTestId('sap-create-objective').fill('Does score differ?');
    await page.getByTestId('sap-create-plan-submit').click();
    await expect.poll(() => writesTo(stub, 'PUT', '/draft').length).toBe(1);
    expect(writesTo(stub, 'POST', '/saps/draft')[0].body).toEqual({});
    expect(writesTo(stub, 'PUT', '/draft')[0].body).not.toHaveProperty('studyPopulation');
    await expect(page.getByTestId('sap-spec-editor')).toHaveCount(0);
  });
});
