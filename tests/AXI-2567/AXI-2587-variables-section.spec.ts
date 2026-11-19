import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { PlanBeforeDataStub } from './harness/plan-before-data-stub';

/**
 * AXI-2587 (epic AXI-2567 — Plan Before Data): the Variables card (declared + extracted modes),
 * "Add from standard fields", removal (including a question-bound field, which is refused), and
 * the completeness sidebar's dedicated spec-checks section.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2567-Plan-Before-Data.md` § AXI-2587 (2.1 … 2.6).
 *
 * E2E CONTRACT — sign-in, workspace, project, membership and the INVESTIGATOR role's
 * permissions are REAL (demo gateway). The SAP routes, now including `GET <p>/sap-standard-fields`,
 * are the AXI-2569 in-memory DOUBLE (`harness/plan-before-data-stub.ts`) extended this story,
 * because no running stack serves the AXI-2568 v2-plan backend over a migrated DB. Owed at W5:
 * re-run against a migrated stack with the double removed.
 *
 * REVIEW BOUNCE #2 (2026-11-18) — every test in this file drives `ProjectSapVariablesCard`
 * against a draft the STUB seeds directly (`seedDeclaredDraftWithField` /
 * `seedDeclaredDraftWithBoundField` / `seedExtractedDraft`), never through a UI "create plan"
 * form: AXI-2657 (merged on this branch's own base) removed that form. The investigator's real
 * order since then is protocol → first added question starts the draft → timing and the data
 * specification are designed from the questions (`firstPlanStartOf`, `planTimingOf`) — none of
 * which this story's Variables-card scope owns or re-implements; seeding the draft reproduces
 * that flow's end state without re-walking UI this spec does not own. This ALSO means the four
 * OTHER merged specs that still call `sap-header-create-plan`/`sap-create-*` (AXI-2569, AXI-2596,
 * AXI-2602, AXI-2618) are themselves stale against the current front end — reported to the
 * coordinator, not fixed here (outside this file's ownership).
 *
 * Because every test below drives the FRONT END only, against this in-memory double, NONE of
 * them is evidence that the front end and the REAL organization-service backend agree on the
 * Variables/completeness contract (the double is written by hand from the contract types, not
 * generated from them) — that agreement is exactly what the AXI-2568 migrated-stack re-run (W5,
 * noted above) is for.
 *
 * AUTHORED, NOT RUN against a live stack this pass: the backend named conditionally in the story
 * brief (`:3001`) resolved to the `axiome-w5val-backend` container — off-limits per the
 * coordinator's instruction and standing policy; `wt-up.sh` (the usual route to an isolated
 * stack) is blocked for story-developer agents. No `e2e-pass` is claimed for this spec from MCP
 * exploration alone; see the story report for the headless run this pass DID execute.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2587-e2e-pw!';

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

/** Signs in and lands on the (already-seeded, via the stub) Statistical plan page. */
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

/**
 * AXI-2587 (B1 fix, review bounce #2): an EMPTY declared spec's manual editor auto-opens
 * (`ProjectSapVariablesCard`'s `manualOpen` default); a non-empty one does not. Open it only
 * when it is not already open, so this helper works at either starting state.
 */
async function openManualEditor(page: Page): Promise<void> {
  const details = page.getByTestId('sap-variables-manual-editor');
  const isOpen = await details.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isOpen) await details.locator('summary').click();
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
    stub.seedDeclaredDraftWithField();
  });

  test('FR52, FR53, FR54 — AXI-2587.1: the declared card shows the table and "+ Add from standard fields"', async ({ page }) => {
    await openSap(page, stub, projectId);
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
    // Non-empty spec by now (crp_mg_l survives test .1/.2) — the manual editor starts closed.
    await openManualEditor(page);
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

test.describe('AXI-2587 Variables card: question-bound removal + extracted modes (manual-e2e 2.2, 2.4) @SI-031 @SI-066', () => {
  test('FR53 — AXI-2587.6: a variable bound to a question cannot be removed from the table', async ({ page }) => {
    const projectId = await newProject('bound');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    const field = stub.seedDeclaredDraftWithBoundField();
    await openSap(page, stub, projectId);
    await expect(page.getByTestId(`sap-variable-${field.fieldId}-status`)).toHaveText('Used');
    await page.getByTestId(`sap-variable-${field.fieldId}-remove`).click();
    await expect(page.getByTestId('sap-variables-remove-error')).toBeVisible();
    await expect(page.getByTestId('sap-variables-remove-error')).toContainText('Q1');
    // Never confirms, never saves: the block is checked BEFORE the confirm dialog (component
    // contract) — a stray `window.confirm` here would hang the test, which is itself a check.
    await expect(page.getByTestId(`sap-variable-${field.fieldId}`)).toBeVisible();
    expect(writesTo(stub, 'PUT', '/draft')).toHaveLength(0);
  });

  test('FR52, FR53 — AXI-2587.7: extracted mode shows only the empty state until variables exist, then the read-only table', async ({ page }) => {
    const emptyProjectId = await newProject('extracted-empty');
    const emptyStub = new PlanBeforeDataStub(emptyProjectId, investigator.userId);
    emptyStub.seedExtractedDraft(false);
    await openSap(page, emptyStub, emptyProjectId);
    await expect(page.getByTestId('sap-variables-chip')).toHaveText('From your data · read only');
    await expect(page.getByTestId('sap-variables-empty')).toBeVisible();
    await expect(page.getByTestId('sap-variables-table')).toHaveCount(0);

    const filledProjectId = await newProject('extracted-filled');
    const filledStub = new PlanBeforeDataStub(filledProjectId, investigator.userId);
    filledStub.seedExtractedDraft(true);
    await openSap(page, filledStub, filledProjectId);
    await expect(page.getByTestId('sap-variables-chip')).toHaveText('From your data · read only');
    await expect(page.getByTestId('sap-variables-table')).toBeVisible();
    await expect(page.getByTestId('sap-variables-extraction-line')).toBeVisible();
    // Read only: no remove button on any row, and no "Add from standard fields"/manual editor.
    await expect(page.getByTestId(/sap-variable-.*-remove/)).toHaveCount(0);
    await expect(page.getByTestId('sap-variables-add-standard')).toHaveCount(0);
    await expect(page.getByTestId('sap-variables-manual-editor')).toHaveCount(0);
  });
});

test.describe('AXI-2587 extraction review: Extract from dataset… → review → Confirm (manual-e2e 2.7, 2.8) @SI-031 @SI-065', () => {
  test('FR52, FR57, FR58 — AXI-2587.8: "On data I already have" → Extract from dataset… → keep exactly one of two columns on one standard field → Confirm writes the variables only', async ({ page }) => {
    const projectId = await newProject('extract');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    stub.seedDeclaredDraftWithQuestionOnly();
    await openSap(page, stub, projectId);
    await page.getByTestId('sap-plan-timing-existing').check();
    await expect(page.getByTestId('sap-variables-empty')).toBeVisible();
    await page.getByTestId('sap-variables-extract').click();
    await expect(page.getByTestId('sap-extraction-drawer')).toBeVisible();

    // Both columns on age_years are To review; Confirm is held.
    await expect(page.getByTestId('sap-extraction-chip-review')).toHaveText('2 to review');
    await expect(page.getByTestId('sap-extraction-confirm')).toBeDisabled();
    await expect(page.getByTestId('sap-extraction-row-age_a-conflict')).toContainText('keep exactly one');

    // Keep age_a (the profile's matched column): its chip now reads Standard field and is counted.
    await page.getByTestId('sap-extraction-tab-all').click();
    await page.getByTestId('sap-extraction-row-age_b-include').uncheck();
    await expect(page.getByTestId('sap-extraction-row-age_a-source')).toHaveText('Standard field');
    await expect(page.getByTestId('sap-extraction-chip-standard')).toHaveText('1 standard fields');
    await expect(page.getByTestId('sap-extraction-row-age_a-label')).toHaveText('Age (years)');
    await expect(page.getByTestId('sap-extraction-row-age_a-unit')).toHaveText('years');
    await page.getByTestId('sap-extraction-confirm').click();

    await expect(page.getByTestId('sap-extraction-drawer')).toHaveCount(0);
    const write = writesTo(stub, 'POST', '/draft/extraction').at(-1)!;
    expect(write.body).toEqual({ basedOnRevision: 1, datasetVersionId: 'ing-e2e-2569', columns: ['age_a'] });
    // The card shows exactly what the panel showed for the kept column.
    await expect(page.getByTestId('sap-variables-chip')).toHaveText('From your data · read only');
    await expect(page.getByTestId('sap-variables-extraction-line')).toContainText('e2e-2587.csv (version 1)');
    const card = page.getByTestId('sap-variables-table');
    await expect(card).toContainText('Age (years)');
    await expect(card).toContainText('years');
    await expect(page.getByTestId('sap-variables-change-version')).toBeVisible();
  });

  test('FR57 — AXI-2587.9: Cancel closes the review panel and writes nothing', async ({ page }) => {
    const projectId = await newProject('extract-refused');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    stub.seedDeclaredDraftWithQuestionOnly();
    await openSap(page, stub, projectId);
    await page.getByTestId('sap-plan-timing-existing').check();
    await page.getByTestId('sap-variables-extract').click();
    await page.getByTestId('sap-extraction-cancel').click();
    await expect(page.getByTestId('sap-extraction-drawer')).toHaveCount(0);
    expect(writesTo(stub, 'POST', '/draft/extraction')).toHaveLength(0);
  });
});

test.describe('AXI-2587 completeness sidebar: dedicated spec-checks section @SI-031', () => {
  test('FR56 — AXI-2587.5: CC15-CC18 render once, separate from the generic rows; CC17 is advisory and never blocks Finalise', async ({ page }) => {
    const projectId = await newProject('checks');
    const stub = new PlanBeforeDataStub(projectId, investigator.userId);
    // A primary question (manual-e2e 2.6's precondition): CC1 passes, so the ONLY thing left to
    // demonstrate is that CC17's warn does not also block Finalise.
    stub.seedDeclaredDraftWithBoundField();
    await openSap(page, stub, projectId);
    await expect(page.getByTestId('sap-spec-checks')).toBeVisible();
    await expect(page.getByTestId('sap-spec-check-CC17')).toContainText('advisory');
    await expect(page.getByTestId('sap-plan-check-CC15')).toHaveCount(0);
    // AXI-2587 (B3 fix, review bounce #2): the real control is `sap-finalise-open`
    // (`ProjectSapInvestigatorPage.tsx`) — `ProjectSapDraftPanel`'s own `sap-finalise` is never
    // rendered on the investigator surface (it is mounted with `canFinalise: false`, see
    // `PlanBody`). The original assertion used the wrong testid AND asserted "enabled" over a
    // seed with no primary question (CC1 would have failed); fixed on both counts here.
    const finalise = page.getByTestId('sap-finalise-open');
    await expect(finalise).toBeEnabled();
    await expect(page.getByTestId('sap-finalise-hint')).toHaveCount(0);
  });
});
