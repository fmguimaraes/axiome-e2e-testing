import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';

/**
 * AXI-2602 (epic AXI-2598 — Investigator Handover): the Study page's state 3 upload (FR13/AC4)
 * and the Run dialog's one-decision path (FR14/AC5).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2598-Investigator-Handover.md` § 6 (6.1, 6.2). §6.3
 * (BLOCK mapping, AC6) is manual — owed after AXI-2612 — and §6.4 (failed-run state, AC7/EC9) is
 * manual — no deterministic failure trigger exists today without backend fault-injection; both
 * are covered deterministically by unit tests in `studyPageState.test.ts` /
 * `ProjectSapRunDialog.test.tsx` on the front repo.
 *
 * E2E CONTRACT — REAL setup throughout, no double. Sign-in, workspace, project, membership, the
 * INVESTIGATOR role's permissions (incl. `dataset:upload`), the v2 declared plan, its data
 * specification, the data-binding propose/confirm endpoints and the SAP run start are all real
 * (demo gateway, `main`). A v2 DECLARED plan is used for both scenarios because it structurally
 * needs no dataset at authoring/finalise (FR6) — exactly the "plan locked before data" shape
 * state 3 and AC4 describe.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2602-e2e-pw!';
const POPULATION = 'Adults with a measured arm and score, 18-75 years';
const READY_WAIT_MS = 120_000;

interface Person extends Actor { email: string; accessToken: string }

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2602-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2602', lastName: label } });
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
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2602 ${label} ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const grant = await access.grant(projectOwner, id, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
  return id;
}

async function signInInvestigator(page: Page, projectId: string): Promise<void> {
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
}

/** A CSV salted per run (never MAG4/duplicate bytes) with two columns named exactly like the
 *  plan's declared fields, so the data-binding propose endpoint's basis is `canonical_field`
 *  by name and the proposal conforms with zero finding. */
function saltedArmScoreCsv(token: string): string {
  const rows = Array.from({ length: 12 }, (_, i) => `S${token}${i + 1},${i % 2 === 0 ? 'A' : 'B'},${(i * 1.7 + 3 + token.length).toFixed(1)}`);
  return `subject_id,arm,score\n${rows.join('\n')}\n`;
}

async function uploadArmScoreDataset(a: Actor, token: string): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await a.api.post(datasets, { data: { organizationId: world.orgId, originalFilename: `axi2602-${token}.csv`, contentType: 'text/csv' } });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: saltedArmScoreCsv(token) });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await a.api.patch(`${datasets}/${created.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return created.id;
}

async function linkDataset(projectId: string, datasetId: string): Promise<void> {
  const res = await projectOwner.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId } });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

async function waitReadyIngestion(datasetId: string): Promise<void> {
  const path = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${datasetId}`);
  await expect.poll(async () => {
    const res = await projectOwner.api.get(path);
    const latest = res.ok() ? (await res.json()).latestIngestion : null;
    return latest?.status ?? 'none';
  }, { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] }).toBe('ready');
}

/**
 * Build, through the real UI, a v2 declared plan — `arm` (grouping, two levels) and `score`
 * (continuous) — with one T1 question bound to both, then finalise it. No dataset is named
 * anywhere in this flow (FR6): the investigator is on `/investigator/projects/:id/sap` when it
 * returns.
 */
async function buildAndFinaliseDeclaredPlan(page: Page, projectId: string, title: string): Promise<void> {
  // AXI-2564 (protocol-first ordering): title, objective and study population come from the
  // saved protocol, never from the create-plan form.
  await gotoSettled(page, `/investigator/projects/${projectId}/study/protocol`);
  await page.getByTestId('protocol-title').fill(title);
  await page.getByTestId('protocol-objective').fill('Does arm change the score?');
  await page.getByTestId('protocol-study-population').fill(POPULATION);
  await page.getByTestId('protocol-save').click();
  await expect(page.getByTestId('protocol-unsaved')).toHaveCount(0, { timeout: 15_000 });

  await gotoSettled(page, `/investigator/projects/${projectId}/sap`);
  await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('sap-header-create-plan').click();
  await page.getByTestId('sap-create-timing-declared').check();
  await page.getByTestId('sap-create-plan-submit').click();
  await expect(page.getByTestId('sap-spec-editor')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('sap-spec-add-field').click();
  await page.getByTestId('sap-spec-field-0-name').fill('arm');
  await page.getByTestId('sap-spec-field-0-label').fill('Treatment arm');
  await page.getByTestId('sap-spec-field-0-role').selectOption('grouping_two_levels');
  await page.getByTestId('sap-spec-field-0-levels').fill('A, B');
  await page.getByTestId('sap-spec-add-field').click();
  await page.getByTestId('sap-spec-field-1-name').fill('score');
  await page.getByTestId('sap-spec-field-1-label').fill('Score');
  await page.getByTestId('sap-spec-save').click();
  await expect(page.getByTestId('sap-spec-field-1-name')).toHaveValue('score');

  // The Plan tab's own "Add question" (`sap-plan-add-question`, same `useAddQuestionToPlan` act
  // as the sidebar pill) reads THIS page's own just-refreshed `useProjectSap` snapshot, so it is
  // enabled the moment the plan exists — no reload/remount needed, unlike the sidebar's own
  // long-lived instance (AXI-2555's `investigator-add-question`, fetched once per session).
  await page.getByTestId('sap-plan-add-question').click();
  await expect(page.getByTestId('sap-question-mode')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sap-question-mode-text').fill('Does arm change the score?');
  await page.getByTestId('sap-question-mode-next').click();
  await expect(page.getByTestId('sap-question-mode-readback')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sap-question-mode-role').selectOption('primary');
  await page.getByTestId('sap-question-mode-add').click();
  await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap`), { timeout: 15_000 });

  // The wizard only stores a stub ("awaiting plan") — its row opens the full spec/estimand form.
  await page.locator('[data-testid^="sap-plan-questions-row-"]').first().click();
  await expect(page.getByTestId('sap-spec-question-form')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('sap-spec-q-template').selectOption('T1');
  await page.getByTestId('sap-spec-q-slot-groupingColumn').selectOption({ label: 'arm — Treatment arm' });
  await page.getByTestId('sap-spec-q-slot-outcome').selectOption({ label: 'score — Score' });
  // ICH E9(R1) estimand, in `ESTIMAND_FIELDS` order (`population` is the one scenario 6.2's
  // original pass missed — it is NOT the protocol's study population field).
  for (const key of ['population', 'variable', 'treatmentComparison', 'intercurrentEvents', 'populationSummary']) {
    await page.getByTestId(`sap-spec-q-estimand-${key}`).fill(`AXI-2602 ${key}`);
  }
  await page.getByTestId('sap-spec-q-alpha').fill('0.05');
  await page.getByTestId('sap-spec-q-save').click();
  await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap`));

  // `sap-finalise` belongs to the old `ProjectSapDraftPanel`, not the Plan tab this route
  // renders for a v2 draft — its own header button is `sap-finalise-open`.
  await expect.poll(async () => page.getByTestId('sap-finalise-open').isEnabled().catch(() => false), { timeout: 30_000 }).toBe(true);
  await page.getByTestId('sap-finalise-open').click();
  await expect(page.getByTestId('sap-finalise-dialog')).toBeVisible();
  await page.getByTestId('sap-finalise-confirm').click();
  // `sap-draft` belongs to the old panel too; this route drops the draft chip/finalise button
  // once there is no open draft left to finalise.
  await expect(page.getByTestId('sap-finalise-open')).toHaveCount(0, { timeout: 15_000 });
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
  await projectOwner?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2602 Study page: upload when locked, one-decision run @SI-066 @SI-032 @SI-065 @SI-010', () => {
  test('AXI-2602.1 AC4 — an Investigator uploads directly from the locked Study page (state 3), no detour to Uploads', async ({ page }) => {
    // Arrange: a finalised declared plan, no dataset ever linked to the project (state 3).
    const projectId = await newProject('upload');
    await signInInvestigator(page, projectId);
    await buildAndFinaliseDeclaredPlan(page, projectId, 'AXI-2602 upload-while-locked plan');

    // Act: open the Study page — state 3, no detour to /investigator/uploads.
    await gotoSettled(page, '/investigator');
    await expect(page.getByTestId('investigator-home')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('study-status-block')).toHaveAttribute('data-study-state', '3', { timeout: 30_000 });
    const primary = page.getByTestId('study-primary-action');
    await expect(primary).toBeVisible();
    await primary.click();

    // Assert: the SAME ingestion path as the Uploads page, inline, never a navigation away. The
    // file input is a real `<input type="file" class="hidden">` behind the visible button (not
    // react-dropzone) — `toBeVisible` does not apply to it; `setInputFiles` works on a hidden one.
    await expect(page.getByTestId('study-upload-input')).toBeAttached();
    await page.getByTestId('study-upload-input').setInputFiles({
      name: `axi2602-locked-${Date.now()}.csv`,
      mimeType: 'text/csv',
      buffer: Buffer.from(saltedArmScoreCsv('upl')),
    });
    await expect(page).toHaveURL(/\/investigator$/);
    await expect.poll(
      async () => page.getByTestId('study-status-block').getAttribute('data-study-state'),
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    ).not.toBe('3');
  });

  test('AXI-2602.2 AC5 — one decision confirms the mapping and starts the run when the proposal already conforms', async ({ page }) => {
    // Arrange: the same declared plan, finalised, with its one dataset linked and ready — field
    // names match the dataset's own columns exactly, so the propose endpoint's basis is
    // `canonical_field` and the proposal conforms with zero finding.
    const projectId = await newProject('one-decision');
    const token = `${Date.now()}`.slice(-6);
    const dataset = await uploadArmScoreDataset(projectOwner, token);
    await linkDataset(projectId, dataset);
    await waitReadyIngestion(dataset);

    await signInInvestigator(page, projectId);
    await buildAndFinaliseDeclaredPlan(page, projectId, 'AXI-2602 one-decision plan');

    // Act: open the Run dialog. AXI-2564 moved the Investigator's single-page surface's Run
    // control into the PageHeader (`sap-run`) — the Runs tab's own `sap-runs-run` button is
    // hidden there (`hideRunButton`) to avoid a duplicate control.
    await gotoSettled(page, `/investigator/projects/${projectId}/sap`);
    const runButton = page.getByTestId('sap-run');
    await expect(runButton).toBeEnabled({ timeout: 30_000 });
    await runButton.click();
    // `sap-run` only sets `?run=new` — the dialog itself mounts inside the Runs tab's content,
    // so this surface needs the explicit tab switch too (the query param alone does not move it).
    await page.getByTestId('sap-tab-runs').click();
    await expect(page.getByTestId('sap-run-dialog')).toBeVisible();
    await expect(page.getByTestId('sap-run-dialog-binding-step')).toBeVisible({ timeout: 30_000 });

    // Assert: the proposal already conforms — no explicit "Confirm mapping" button, one action.
    await expect(page.getByTestId('sap-run-dialog-mapping-conforms')).toBeVisible();
    await expect(page.getByTestId('sap-run-dialog-binding-confirm')).toHaveCount(0);
    const start = page.getByTestId('sap-run-dialog-confirm');
    await expect(start).toBeEnabled();

    await start.click();

    // Assert: the mapping was confirmed (attributed, stored) AND the run started in one click —
    // the dialog closes onto the new run's page, which only happens past a 201 start.
    await expect(page.getByTestId('sap-run-dialog')).toHaveCount(0, { timeout: 30_000 });
    await expect(page).toHaveURL(/\/sap\/runs\//);
  });
});
