import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { PlanBeforeDataStub } from './harness/plan-before-data-stub';

/**
 * AXI-2587 (epic AXI-2567 — Plan Before Data): the Variables card (declared + extracted modes),
 * "Add from standard fields", removal, the deferred-FR55 manual-editor fallback, and the
 * completeness sidebar's dedicated spec-checks section.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2567-Plan-Before-Data.md` § AXI-2587 (2.1 … 2.6).
 *
 * E2E CONTRACT — sign-in, workspace, project, membership and the INVESTIGATOR role's
 * permissions are REAL (demo gateway). The SAP routes, now including `GET <p>/sap-standard-fields`,
 * are the AXI-2569 in-memory DOUBLE (`harness/plan-before-data-stub.ts`) extended this story,
 * because no running stack serves the AXI-2568 v2-plan backend over a migrated DB. Owed at W5:
 * re-run against a migrated stack with the double removed.
 *
 * AUTHORED, NOT RUN this pass: the backend named conditionally in the story brief (`:3001`)
 * resolved to the `axiome-w5val-backend` container — off-limits per the coordinator's
 * instruction and standing policy; `wt-up.sh` (the usual route to an isolated stack) is blocked
 * for story-developer agents. No `e2e-pass` is claimed for this spec.
 *
 * CROSS-STORY RISK (reported, not fixed here — not this spec's file ownership): AXI-2569's own
 * spec asserts `sap-spec-editor` is VISIBLE immediately after creating a declared plan. This
 * story nests that same editor inside a closed `<details data-testid="sap-variables-manual-editor">`
 * disclosure (FR55 deferred), so once both stories' front-end changes are combined, that
 * AXI-2569 assertion will fail until it is updated to open the disclosure first.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2587-e2e-pw!';
const POPULATION = 'Adults with rheumatoid arthritis, 18-75 years';

interface Person extends Actor { email: string; accessToken: string }

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2587-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2587', lastName: label } });
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
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2587 ${label} ${Date.now()}`, workspaceId: world.workspaceId } });
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

/** Creates a declared (v2) plan with one continuous field `crp_mg_l`, through the UI. */
async function createDeclaredPlanWithField(page: Page, stub: PlanBeforeDataStub, projectId: string): Promise<void> {
  await openSap(page, stub, projectId);
  await page.getByTestId('sap-header-create-plan').click();
  await page.getByTestId('sap-create-title').fill('AXI-2587 variables plan');
  await page.getByTestId('sap-create-objective').fill('Does CRP differ between arms?');
  await page.getByTestId('sap-create-timing-declared').check();
  await page.getByTestId('sap-create-study-population').fill(POPULATION);
  await page.getByTestId('sap-create-plan-submit').click();
  await expect(page.getByTestId('sap-variables-card')).toBeVisible();
  // FR55 deferred: the only way left to add a wholly custom field is the manual editor,
  // behind the "Add a custom variable, or edit a field by hand" disclosure.
  await page.getByTestId('sap-variables-manual-editor').locator('summary').click();
  await page.getByTestId('sap-spec-add-field').click();
  await page.getByTestId('sap-spec-field-0-name').fill('crp_mg_l');
  await page.getByTestId('sap-spec-field-0-label').fill('CRP (mg/L)');
  await page.getByTestId('sap-spec-field-0-required').check();
  await page.getByTestId('sap-spec-save').click();
  await expect.poll(() => writesTo(stub, 'PUT', '/draft').length).toBeGreaterThan(0);
}

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

test.describe('AXI-2587 Variables card: table, standard fields, removal @SI-031 @SI-066', () => {
  let projectId: string;
  let stub: PlanBeforeDataStub;

  test.beforeAll(async () => {
    projectId = await newProject('variables');
    stub = new PlanBeforeDataStub(projectId, investigator.userId);
  });

  test('FR52, FR53, FR54 — AXI-2587.1: the declared card shows the table and "+ Add from standard fields"', async ({ page }) => {
    await createDeclaredPlanWithField(page, stub, projectId);
    await expect(page.getByTestId('sap-variables-chip')).toHaveText('Declared before data');
    await expect(page.getByTestId('sap-variables-table')).toBeVisible();
    await expect(page.getByTestId(/sap-variable-.*-status/).first()).toHaveText('Not used by a question');

    await page.getByTestId('sap-variables-add-standard').click();
    await expect(page.getByTestId('sap-standard-fields-drawer')).toBeVisible();
    await expect(page.getByTestId('sap-standard-field-sex')).toBeVisible();
    await page.getByTestId('sap-standard-field-age_years-check').check();
    await page.getByTestId('sap-standard-fields-add').click();
    await expect(page.getByTestId('sap-standard-fields-drawer')).toHaveCount(0);
    const saved = writesTo(stub, 'PUT', '/draft').at(-1)!.body.dataSpecification.fields;
    expect(saved.map((f: any) => f.name)).toContain('age_years');
    await expect(page.getByTestId(/sap-variable-.*/).filter({ hasText: 'Age (years)' })).toBeVisible();
  });

  test('FR53 — AXI-2587.2: removing an unused variable asks to confirm, then saves without it', async ({ page }) => {
    await openSap(page, stub, projectId);
    const row = page.getByTestId(/sap-variable-.*/).filter({ hasText: 'Age (years)' });
    const removeButton = row.getByRole('button', { name: /Remove variable/ });
    page.once('dialog', (d) => d.accept());
    await removeButton.click();
    const before = writesTo(stub, 'PUT', '/draft').length;
    await expect.poll(() => writesTo(stub, 'PUT', '/draft').length).toBeGreaterThan(before);
    const saved = writesTo(stub, 'PUT', '/draft').at(-1)!.body.dataSpecification.fields;
    expect(saved.map((f: any) => f.name)).not.toContain('age_years');
    await expect(page.getByTestId(/sap-variable-.*/).filter({ hasText: 'Age (years)' })).toHaveCount(0);
  });

  test('FR52 — AXI-2587.3: the manual editor still adds a wholly custom field (FR55 deferred)', async ({ page }) => {
    await openSap(page, stub, projectId);
    await page.getByTestId('sap-variables-manual-editor').locator('summary').click();
    await page.getByTestId('sap-spec-add-field').click();
    const index = (await page.getByTestId(/^sap-spec-field-\d+$/).count()) - 1;
    await page.getByTestId(`sap-spec-field-${index}-name`).fill('custom_marker');
    await page.getByTestId(`sap-spec-field-${index}-label`).fill('Custom marker');
    await page.getByTestId(`sap-spec-field-${index}-required`).check();
    await page.getByTestId('sap-spec-save').click();
    await expect(page.getByTestId(/sap-variable-.*-custom/)).toHaveCount(1);
  });

  test('FR52 — AXI-2587.4: v1 plans show no Variables card', async ({ page }) => {
    const v1Project = await newProject('v1');
    const v1Stub = new PlanBeforeDataStub(v1Project, investigator.userId);
    v1Stub.seedFinalV1();
    await openSap(page, v1Stub, v1Project);
    await expect(page.getByTestId('sap-variables-card')).toHaveCount(0);
  });
});

test.describe('AXI-2587 completeness sidebar: dedicated spec-checks section @SI-031', () => {
  test('FR56 — AXI-2587.5: CC15-CC18 render once, separate from the generic rows; CC17 is advisory', async ({ page }) => {
    const projectId = await newProject('checks');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    await createDeclaredPlanWithField(page, stub, projectId);
    await expect(page.getByTestId('sap-spec-checks')).toBeVisible();
    await expect(page.getByTestId('sap-spec-check-CC17')).toContainText('advisory');
    await expect(page.getByTestId('sap-plan-check-CC15')).toHaveCount(0);
    const finalise = page.getByTestId('sap-finalise');
    await expect(finalise).toBeEnabled();
  });
});
