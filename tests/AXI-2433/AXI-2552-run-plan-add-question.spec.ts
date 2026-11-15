import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { askQuestion, choose, gotoSettled } from '../AXI-2308/harness/new-analysis';
import { apiCallOf, pinNewestT1, questionInput, uploadArmScoreDataset, type ApiCall, SapApiStub } from './harness/sap-api-stub';

const PLAN_QUESTION = 'Does the score differ between the two arms, question 2?';

/**
 * Question → chosen intent → chosen T1 → (what was read) → the Role step, same sequence as
 * AXI-2447's own `throughAnalysis` (local to that spec file, not imported — spec files here
 * share code only through `harness/`, never a sibling spec's private helpers).
 */
async function throughAnalysis(page: Page): Promise<void> {
  await askQuestion(page, PLAN_QUESTION);
  await expect(page.getByTestId('na-step-intent')).toBeVisible();
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await expect(page.getByTestId('na-choice-T1')).toBeVisible({ timeout: 60_000 });
  await choose(page, 'na-choice-T1');
  await settleAnalysis(page);
  await expect(page.getByTestId('na-step-role')).toBeVisible();
}

/** Confirm what the wizard read and answer what it still asks, with the fixture's only fits. */
async function settleAnalysis(page: Page): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    const step = await page.locator('[data-testid^="na-step-"]').first().getAttribute('data-testid');
    if (step === 'na-step-read') await choose(page, 'na-read-confirm');
    else if (step === 'na-step-decide') await choose(page, 'na-decide-next');
    else return;
    await page.waitForTimeout(300);
  }
}

async function next(page: Page, from: string, to: string): Promise<void> {
  await expect(page.getByTestId(`na-step-${from}`)).toBeVisible();
  await choose(page, 'na-plan-next');
  await expect(page.getByTestId(`na-step-${to}`)).toBeVisible();
}

async function toReady(page: Page, from: 'role' | 'estimand' | 'parameters' | 'sensitivity'): Promise<void> {
  const order = ['role', 'estimand', 'parameters', 'sensitivity', 'ready'];
  for (let i = order.indexOf(from); i < order.length - 1; i += 1) await next(page, order[i], order[i + 1]);
}

/**
 * AXI-2552 (epic AXI-2433 — Structured Statistical Analysis Plan) — the Investigator surface's
 * merged Plan/Runs page header: primary "Run plan" (enabled only once the plan is finalised AND
 * the analysis dataset has a Ready ingestion; disabled tooltips name the unmet gate) and
 * secondary "Add question" (opens plan mode, starting the next version as a draft first on a
 * finalised plan). Also covers the server-side exploration-mode gate (FR86,
 * `WizardSapExplorationGate`) by way of a real Run plan not being refused once the project
 * carries a finalised version.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md`
 * § AXI-2552 (AXI-2552.1 … AXI-2552.5).
 *
 * E2E CONTRACT — every route REAL on the demo gateway, same shape as AXI-2445/AXI-2446's specs
 * (sign-in, fixture workspace, project, dataset, caller permissions, the real SAP draft/finalise/
 * completeness/run API — nothing doubled). `SapApiStub` here is used ONLY as the thin API-call
 * helper + write-observer (`apiCallOf`, `questionInput`, `pinNewestT1`, `uploadArmScoreDataset`,
 * `SapApiStub.seedFinal`/`seedDraft`) that AXI-2445/2446 already established — every request it
 * issues goes through the real gateway/organization-service, never a routed double.
 *
 * AXI-2552.2 (no Ready dataset on a FINALISED plan) is the one state this harness cannot reach by
 * finalising for real: completeness's CC4 requires the analysis dataset's profile, which in
 * practice requires a Ready ingestion to exist, so "finalised AND never-ready" cannot be produced
 * by going through a real finalise. That one scenario therefore intercepts ONLY the front end's
 * ingestions read (`GET …/datasets/:id/ingestions`) to answer an empty list, on an otherwise real
 * stack with a real finalised version — scoped exactly to the front end's OWN dataset-readiness
 * read (`useDatasetReady`/`hasReadyIngestion`), never the gate itself (AXI-2552.4 exercises the
 * real gate, unmocked).
 *
 * STATUS AT HAND-OFF: authored, NOT RUN. No isolated stack (backend/front on their own ports, own
 * vhost) was brought up in this pass — `wt-up.sh` isolated-stack provisioning is flagged
 * elsewhere as blocked for a story-developer subagent pending an owner decision, and the shared
 * demo stack does not yet serve this story's un-merged branch. Run with `--no-deps` against a
 * stack serving this story's `axiome-front`/`axiome-back` branches before trusting it green.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2552-e2e-pw!';

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let datasetId: string;
let call: ApiCall;

interface Fixture {
  project: { id: string; name: string };
  stub: SapApiStub;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2552-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2552', lastName: label },
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

/** A fresh project, linked to the shared arm/score dataset, with its own SAP write-observer. */
async function newProject(label: string): Promise<Fixture> {
  const name = `E2E AXI-2552 ${label} ${Date.now()}`;
  const res = await investigator.api.post(apiUrl('/api/v1/projects'), { data: { name, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const link = await investigator.api.post(apiUrl(`/api/v1/projects/${id}/datasets`), { data: { datasetId } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  return { project: { id, name }, stub: new SapApiStub(id, investigator.userId, datasetId) };
}

/**
 * Session + scope, same precedent as AXI-2445.10/AXI-2446's investigator sign-in: sign in
 * through the UI login form (not localStorage impersonation), so the server's own membership
 * resolution (`isInvestigatorMembership`) is real. `axiome-active-workspace`/`-project` are
 * seeded the same way AXI-2445.10 seeds them — `useTopMenuStore`'s `activeWorkspaceId` is what
 * `useDatasetReady` reads, so without it the dataset-readiness gate (AXI-2552.2/.3) would read
 * `null` and never fetch, which would make EVERY plan look "no Ready dataset" rather than
 * exercising the real gate.
 */
async function openInvestigatorSap(page: Page, stub: SapApiStub, projectId: string): Promise<void> {
  await stub.install(page);
  await page.addInitScript(
    ([org, ws, p]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', p);
    },
    [world.orgId, world.workspaceId, projectId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
  await gotoSettled(page, `/investigator/projects/${projectId}/sap`);
  await expect(page.getByTestId('project-sap-page')).toBeVisible();
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  // AXI-2552 (epic AXI-2433) relies on the seeded Investigator role already holding every SAP
  // right (ruling 8, AXI-2532's UT-COMMON-8531) — adding by roleId grants write/finalise too, so
  // this one caller can both author the plan and be gated by the Investigator-surface check.
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  datasetId = await uploadArmScoreDataset(world, investigator.api, 'axi2552');
  call = apiCallOf(investigator.api);
  await pinNewestT1(call, (await newProject('catalogue')).project.id); // seeds pin the registry's newest T1
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2552 Investigator Plan tab: Run plan / Add question header @SI-031 @SI-045 @SI-066', () => {
  test('AXI-2552.1 no plan at all: Run plan is disabled with "Finalise the plan first"; Add question is offered', async ({ page }) => {
    // Arrange
    const { project, stub } = await newProject('no-plan');

    // Act
    await openInvestigatorSap(page, stub, project.id);

    // Assert
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
    await expect(page.getByTestId('sap-empty-state')).toBeVisible();
    const run = page.getByTestId('sap-run');
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute('title', 'Finalise the plan first');
    await expect(page.getByTestId('sap-header-add-question')).toBeVisible();
    await expect(page.getByTestId('sap-add-question-note')).toHaveCount(0);
  });

  test('AXI-2552.2 a finalised plan with no Ready dataset disables Run plan with "Upload a dataset first"', async ({ page }) => {
    // Arrange: a REAL finalised version (so completeness/CC4 is genuinely satisfied), then scope
    // the ingestions read the front end itself makes to answer "no ready ingestion" — see the
    // file header comment for why this one read, and only this one, is intercepted.
    const { project, stub } = await newProject('no-dataset');
    await stub.seedFinal(call, 'Plan no-dataset', [questionInput(1, 'primary')]);
    await page.route(`**/api/v1/workspaces/${world.workspaceId}/datasets/*/ingestions`, (route) => route.fulfill({ json: [] }));

    // Act
    await openInvestigatorSap(page, stub, project.id);

    // Assert
    const run = page.getByTestId('sap-run');
    await expect(run).toBeDisabled();
    await expect(run).toHaveAttribute('title', 'Upload a dataset first');
  });

  test('AXI-2552.3 finalise v1 (neutral checklist all green), then Run plan is enabled', async ({ page }) => {
    // Arrange
    const { project, stub } = await newProject('finalise');
    await stub.seedDraft(call, [questionInput(1, 'primary')], 'Plan finalise');
    // Act: open the Plan tab BEFORE finalising, so the neutral checklist is observed turning
    // green for a REAL report (no rule id, no red row) ahead of the finalise call.
    await openInvestigatorSap(page, stub, project.id);
    const checklist = page.getByTestId('sap-completeness-checklist');
    await expect(checklist).toBeVisible();
    await expect(checklist).not.toContainText(/RULE-SAP/);
    await expect.poll(async () => page.getByTestId('sap-finalise').isEnabled(), { timeout: 120_000, intervals: [2_000, 5_000] }).toBe(true);
    await page.getByTestId('sap-finalise').click();
    await page.getByTestId('sap-finalise-confirm').click();

    // Assert
    await expect(page.getByTestId('sap-final-title')).toBeVisible();
    const run = page.getByTestId('sap-run');
    await expect(run).toBeEnabled();
  });

  test('AXI-2552.4 Run plan opens the confirm dialog and a run row for v1 appears in Runs — never SAP_EXPLORATION_DISABLED', async ({ page }) => {
    // Arrange: a real finalised plan with a real Ready dataset — this is also the exploration
    // gate's (FR86) happy path: the project now carries a finalised SapVersion, so
    // WizardSapExplorationGate.allowsRun resolves true even with exploration mode OFF (the
    // default) for this workspace.
    const { project, stub } = await newProject('run');
    await stub.seedFinal(call, 'Plan run', [questionInput(1, 'primary')]);

    // Act
    await openInvestigatorSap(page, stub, project.id);
    await page.getByTestId('sap-run').click();
    await expect(page).toHaveURL(/\/sap\?tab=runs&run=new$/);
    await page.getByTestId('sap-run-dialog-confirm').click();

    // Assert
    await expect(page.getByTestId('sap-runs-count')).toContainText(/1 SAP run/, { timeout: 30_000 });
    const row = page.getByTestId('sap-run-row').first();
    await expect(row.getByTestId('sap-run-version')).toHaveText('Version 1');
  });

  test('AXI-2552.5 Add question on a finalised plan starts v2 as a draft; v1 stays readable', async ({ page }) => {
    // Arrange
    const { project, stub } = await newProject('add-question');
    await stub.seedFinal(call, 'Plan v1', [questionInput(1, 'primary')]);

    // Act
    await openInvestigatorSap(page, stub, project.id);
    await expect(page.getByTestId('sap-add-question-note')).toContainText('Adding a question starts v2');
    await page.getByTestId('sap-header-add-question').click();

    // Assert: a v2 draft now exists server-side (the click's own startDraft call) and lands in
    // plan mode's question wizard — the wizard's own content is AXI-2447's spec, not this one's.
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${project.id}/sap/questions/new$`));
    const draftRes = await investigator.api.get(apiUrl(`/api/v1/projects/${project.id}/sap-draft`));
    expect(draftRes.status(), await draftRes.text()).toBe(200);
    const draft = await draftRes.json();
    expect(draft.basedOnVersion).toBe(1);
    // v1 is still readable, unmodified, through the version list.
    const versionsRes = await investigator.api.get(apiUrl(`/api/v1/projects/${project.id}/saps`));
    const versions = (await versionsRes.json()) as Array<{ version: number; title: string }>;
    expect(versions.find((v) => v.version === 1)?.title).toBe('Plan v1');
  });

  test('AXI-2552.6 (AXI-2553 §3/§4) Ready returns to the plan with the new question highlighted and "Add another question" beside it', async ({ page }) => {
    // Arrange — the same v2-draft-via-"Add question" flow as AXI-2552.5
    const { project, stub } = await newProject('highlight');
    await stub.seedFinal(call, 'Plan v1 highlight', [questionInput(1, 'primary')]);
    await openInvestigatorSap(page, stub, project.id);
    await page.getByTestId('sap-header-add-question').click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${project.id}/sap/questions/new$`));

    // Act — through the wizard to Ready, then save
    await throughAnalysis(page);
    await toReady(page, 'role');
    await choose(page, 'na-plan-save');

    // Assert — straight at the merged project-scoped page, never the retired landing route, with
    // the just-recorded question highlighted and "Add another question" beside it
    const draft = await draftOf(project.id);
    const savedQuestionId = draft.plan.questions.find((q: { text: string }) => q.text === PLAN_QUESTION)?.questionId;
    expect(savedQuestionId, JSON.stringify(draft.plan.questions)).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${project.id}/sap\\?highlight=${savedQuestionId}$`));
    const row = page.getByTestId(`sap-draft-questions-row-${rowKeyFor(draft, savedQuestionId)}`);
    await expect(row).toBeVisible();
    await expect(row).toHaveClass(/ring-\[var\(--color-accent\)\]/);
    await expect(page.getByTestId('sap-add-another-question')).toBeVisible();
  });
});

/** The draft's own live state, read the same way `openInvestigatorSap`/other scenarios already do. */
async function draftOf(projectId: string): Promise<any> {
  const res = await call('GET', `/projects/${projectId}/sap-draft`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** `Qn` is derived from list position (never stored) — same derivation `questionRows` uses. */
function rowKeyFor(draft: { plan: { questions: Array<{ questionId: string; position: number }> } }, questionId: string): string {
  const ordered = [...draft.plan.questions].sort((a, b) => a.position - b.position);
  const idx = ordered.findIndex((q) => q.questionId === questionId);
  return `Q${idx + 1}`;
}
