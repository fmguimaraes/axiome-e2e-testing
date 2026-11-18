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
 * a story agent). The protocol route is NOT part of that double (`owns()` never matches
 * `/study/protocol`) — it is real, so AXI-2569.1's `beforeAll` saves one through the real API,
 * same as AXI-2564.8.
 *
 * AXI-2657 (owner rulings 2026-11-18, touched here only where it broke this spec's own
 * entry point): the plan page's "Create plan" form/testids (`sap-header-create-plan`,
 * `sap-create-*`) are gone — the saved protocol leads straight to the questions, and the first
 * one starts the plan; AXI-2569.1 and .7 are updated below. AXI-2569.2 … .6 were NOT touched —
 * they were already failing against `main` before this story, on testids this spec was never
 * updated for across several intervening stories (AXI-2570's full-page question flow retired
 * by AXI-2589's modal; AXI-2580's `sap-finalise` renamed `sap-finalise-open`, `sap-draft`
 * retired; a later `hidePopulation` on the Investigator surface, which `sap-spec-population`
 * never renders under). That drift predates and is unrelated to AXI-2657 — flagged in the
 * handoff report, not fixed here.
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
    // AXI-2657: a plan cannot exist without a saved protocol — real route, not the double.
    const saved = await investigator.api.put(apiUrl(`/api/v1/projects/${projectId}/study/protocol`), {
      data: { title: 'CRP prospective plan', objective: 'Does CRP differ between arms?', studyPopulation: POPULATION, text: '' },
    });
    expect(saved.status(), await saved.text()).toBeLessThan(300);
  });

  test('AXI-2569.1 (superseded by AXI-2657 owner rulings 2026-11-18) the first question starts a declared plan from the protocol; timing follows it', async ({ page }) => {
    await openSap(page, stub, projectId);
    await expect(page.getByTestId('sap-protocol-summary')).toContainText('CRP prospective plan');

    // The first question starts the plan — no separate "Create plan" step any more.
    await page.getByTestId('sap-plan-add-primary-question').click();
    await page.getByTestId('sap-add-question-text').fill('Does CRP differ between arms?');
    await page.getByTestId('sap-add-question-submit').click();
    await expect(page.getByTestId('sap-add-question-modal')).toHaveCount(0);
    await expect(page.getByTestId('sap-plan-questions-row-Q1')).toBeVisible({ timeout: 15_000 });
    expect(writesTo(stub, 'POST', '/saps/draft')[0].body).toEqual({ planSchemaVersion: 2 });
    expect(writesTo(stub, 'PUT', '/draft')[0].body).toMatchObject({ title: 'CRP prospective plan', studyPopulation: POPULATION });

    // "On data I already have" stays unavailable (AXI-2657: a dataset cannot be picked from
    // this page yet); "declare data first" is the only choice, and it reveals the spec editor.
    await expect(page.getByTestId('sap-plan-timing-existing')).toBeDisabled();
    await page.getByTestId('sap-plan-timing-declared').check();
    await expect(page.getByTestId('sap-spec-editor')).toBeVisible();
    // Already on `main` before this story (commit b1b84f1f, "drop study population from the
    // plan's Data model panel — the protocol holds it"): the Investigator surface hides the
    // spec editor's own population field — the protocol's is now the only one.
    await expect(page.getByTestId('sap-spec-population')).toHaveCount(0);
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

  // AXI-2569.7 AC3 "on existing data" creates today's v1 plan — no schema version, no
  // population. DESCOPED by AXI-2657 (owner rulings 2026-11-18): the "Create plan" form this
  // scenario drove is gone, and its replacement — the first question, through
  // `startPlanFromProtocol` — always starts a v2 (declared) draft (`sapsApi.startDraft(projectId,
  // 2)`, hardcoded, `useProjectSap.ts`); the one remaining timing choice, "On data I already
  // have", is permanently disabled on `ProjectSapPlanTimingField` ("not available yet: a dataset
  // cannot be selected from this page"). A v1/retrospective plan is no longer reachable as a
  // project's FIRST plan from this surface at all — only as an amendment wizard over an EXISTING
  // v1 final (AXI-2564.9's path). This is a real behaviour change this story made, not test
  // drift, and is called out in the handoff report as a question for product/owner sign-off
  // rather than silently dropped or fabricated.
  test.skip('AXI-2569.7 AC3 "on existing data" creates today\'s v1 plan — no schema version, no population', async () => {
    // Intentionally left unimplemented — see the skip reason above.
  });
});
