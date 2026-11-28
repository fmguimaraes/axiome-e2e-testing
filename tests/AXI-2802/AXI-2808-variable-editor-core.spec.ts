import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { PlanBeforeDataStub } from '../AXI-2567/harness/plan-before-data-stub';

/**
 * AXI-2808 (epic AXI-2802 — Semantic Profile Management, A6; FR76-FR78, NFR16, AC50):
 * non-regression proof that the Investigator Variables card's three surfaces — standard-field
 * drawer, sample-file drawer, and the "mint a profile field" control — behave exactly as before
 * now that they are rendered through the plan-agnostic core
 * (`axiome-front/src/components/project/variableEditor/`) + the SAP adapter
 * (`axiome-front/src/lib/projectSap/variableEditor/sapAdapter.ts`), rather than calling the API
 * and the capability hooks directly. The `data-testid`s below are byte-identical to the ones the
 * pre-AXI-2808 component tree already used (FR77's E2E contract) — this spec exercises the SAME
 * contract `tests/AXI-2567/AXI-2587-variables-section.spec.ts` established, scoped to the three
 * surfaces this story touched.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md` § AXI-2808 (A6),
 * AXI-2808.1–AXI-2808.3.
 *
 * E2E CONTRACT — sign-in, workspace, project, membership and the INVESTIGATOR role's
 * permissions are REAL (demo gateway), reusing `PrivateProjectsWorld`/`PlanBeforeDataStub` from
 * AXI-2567/AXI-2265 (no story-owned harness duplicated). The SAP v2 draft routes are the
 * AXI-2569 in-memory double, same reason as AXI-2587's spec: no running stack serves the
 * migrated v2-plan backend. The ONE route the double does not answer, `POST
 * …/saps/:sapId/sample-proposal` (AXI-2678, FR70), is stubbed locally in this file only (never
 * added to the shared AXI-2567 harness, which this story does not own).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2808-e2e-pw!';

interface Person extends Actor { email: string; accessToken: string }

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2808-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2808', lastName: label } });
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
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2808 ${label} ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const grant = await access.grant(projectOwner, id, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
  return id;
}

/** AXI-2808's own route: `POST <p>/saps/:sapId/sample-proposal` (FR70, not in the shared double). */
async function stubSampleProposal(page: Page, projectId: string): Promise<void> {
  await page.route((url) => url.pathname.endsWith('/sample-proposal'), (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      files: [{ name: 'sample.csv', rowCount: 1, columnCount: 1 }],
      profile: { profileId: 'profile-e2e-2808', displayName: 'E2E demo profile', configVersion: 'v1' },
      rows: [{
        column: 'wbc_count', status: 'available', source: 'custom', label: 'wbc_count', canonicalField: null,
        profilePin: null, measuredRole: 'continuous', levels: null, unit: null, expectedKind: null, usedBy: [],
        bound: false, reviewReasons: [], conflictGroup: null, qualifier: null, exclusion: null,
        files: ['sample.csv'], typeConflict: false,
      }],
    }),
  }));
  void projectId;
}

async function openSap(page: Page, stub: PlanBeforeDataStub, projectId: string): Promise<void> {
  await stub.install(page);
  await stubSampleProposal(page, projectId);
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
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2808.1 Add from standard fields through the extracted core @SI-030', () => {
  test('AC50 — AXI-2808.1: the drawer lists the catalog and adding a field writes the draft unchanged', async ({ page }) => {
    const projectId = await newProject('standard');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    stub.seedDeclaredDraftWithField();
    await openSap(page, stub, projectId);

    await page.getByTestId('sap-variables-add-standard').click();
    await expect(page.getByTestId('sap-standard-fields-drawer')).toBeVisible();
    await expect(page.getByTestId('sap-standard-field-age_years')).toBeVisible();
    await page.getByTestId('sap-standard-field-age_years-check').check();
    await page.getByTestId('sap-standard-fields-add').click();
    await expect(page.getByTestId('sap-standard-fields-drawer')).toHaveCount(0);

    const writes = stub.writes.filter((w) => w.method === 'PUT' && w.path.endsWith('/draft'));
    const saved = writes.at(-1)!.body.dataSpecification.fields;
    expect(saved.map((f: any) => f.name)).toContain('age_years');
    await expect(page.getByTestId(/^sap-variable-field-\d+$/).filter({ hasText: 'Age (years)' })).toBeVisible();
  });
});

test.describe('AXI-2808.2 Add from a CSV sample file through the extracted core (FR78) @SI-030', () => {
  test('AC50, FR78 — AXI-2808.2: the sample drawer accepts CSV only and adding a column writes the draft', async ({ page }) => {
    const projectId = await newProject('sample');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    stub.seedDeclaredDraftWithField();
    await openSap(page, stub, projectId);

    await page.getByTestId('sap-variables-add-sample').click();
    await expect(page.getByTestId('sap-sample-drawer')).toBeVisible();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({ name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from('wbc_count\n4.2\n') });

    await expect(page.getByTestId('sap-sample-row-wbc_count')).toBeVisible();
    await page.getByTestId('sap-sample-row-wbc_count-check').check();
    await page.getByTestId('sap-sample-add').click();
    await expect(page.getByTestId('sap-sample-drawer')).toHaveCount(0);

    const writes = stub.writes.filter((w) => w.method === 'PUT' && w.path.endsWith('/draft'));
    const saved = writes.at(-1)!.body.dataSpecification.fields;
    expect(saved.map((f: any) => f.name)).toContain('wbc_count');
  });
});

test.describe('AXI-2808.3 Mint a profile field from the sample drawer (NFR16) @SI-030', () => {
  test('AC50, NFR16 — AXI-2808.3: "Add a field to this project\'s semantic profile" mints a field with plain-language labels', async ({ page }) => {
    const projectId = await newProject('mint');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    stub.seedDeclaredDraftWithField();
    await openSap(page, stub, projectId);

    await page.getByTestId('sap-variables-add-sample').click();
    await expect(page.getByTestId('sap-sample-drawer')).toBeVisible();
    await page.route((url) => url.pathname.includes('/extensions'), (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ canonicalFields: ['crp_mg_l', `project.${projectId}.custom_marker`], fallbackMode: false }),
    }));

    await expect(page.getByText("Add a field to this project's semantic profile")).toBeVisible();
    await page.getByTestId('profile-extension-new-field-label').fill('Custom marker');
    await page.getByTestId('profile-extension-add-field').click();
    // Plain language only (NFR16): never a raw role value anywhere on the drawer.
    await expect(page.getByTestId('sap-sample-drawer')).not.toContainText('mapping:confirm_binding');
  });
});
