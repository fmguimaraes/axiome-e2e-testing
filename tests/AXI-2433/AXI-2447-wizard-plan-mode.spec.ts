import { expect, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { silenceTours } from '../AXI-1904/harness/tours';
import { askQuestion, choose, gotoSettled } from '../AXI-2308/harness/new-analysis';
import { SapApiStub, apiCallOf, pinNewestT1, questionInput, t1Version, uploadArmScoreDataset, type ApiCall } from './harness/sap-api-stub';

/**
 * AXI-2447 (epic AXI-2433 — Structured Statistical Analysis Plan) — the wizard in plan mode:
 * `/projects/:id/sap/questions/new` adds a question to the open draft and
 * `/projects/:id/sap/questions/:questionId` edits one, through the New analysis wizard's own
 * steps plus Role → Estimand (pre-filled, FR68) → Parameters & decision → Sensitivity analyses,
 * and a Ready step that records the question — never a run. AC3: once the draft holds a
 * question, a new one is offered only the draft's dataset. Flow E: the ordinary wizard's Ready,
 * on a project with a SAP, links to the SAP page.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md`
 * § AXI-2447 (AXI-2447.1 … AXI-2447.7).
 *
 * E2E CONTRACT — every route REAL on the demo gateway, nothing routed or doubled: sign-in,
 * fixture workspace / projects / datasets, the wizard's reads (datasets, opening-template
 * catalogue + match, intent catalogue, SAP read), AXI-2438's draft + question routes, AXI-2439's
 * `GET …/sap-templates`, completeness and finalise (seeding only). The wizard's LLM sites
 * (intent suggestion, question reading, restrictTo / stratifyBy offers) run on the stack's
 * RECORDED transport (NFR7); the fixture has no recording, so the intent and the analysis are
 * CHOSEN explicitly — the specs never depend on a suggestion. No paid call is made.
 *
 * Fixture: `subject_id,arm,score` (12 rows, `arm` A/B, `score` numeric). Self-provisioned: a
 * fresh workspace whose platform admin leaves it; a throwaway team editor. Run with `--no-deps`.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const QUESTION = 'Does the score differ between the two arms?';
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';

let world: PrivateProjectsWorld;
let editor: UiActor;
let call: ApiCall;
let datasetD: string;
let datasetE: string;
let t1Subtitle: string;
let t1WizardVersion: string;

interface Fixture {
  projectId: string;
  name: string;
  stub: SapApiStub;
}

/** A project with `datasets` linked (D by default). */
async function newProject(label: string, datasets: string[] = [datasetD]): Promise<Fixture> {
  const name = `E2E AXI-2447 ${label} ${Date.now()}`;
  const res = await editor.api.post(apiUrl('/api/v1/projects'), { data: { name, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const projectId = (await res.json()).id;
  for (const id of datasets) {
    const link = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId: id } });
    expect(link.status(), await link.text()).toBeLessThan(300);
  }
  return { projectId, name, stub: new SapApiStub(projectId, editor.userId, datasets[0]) };
}

async function draftOf(projectId: string): Promise<any> {
  const res = await call('GET', `/projects/${projectId}/sap-draft`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** Signed in as the editor, with the fixture org seeded (the shell would otherwise clear the workspace). */
async function signIn(page: Page, activeProject?: string): Promise<void> {
  await page.addInitScript(([org, p]) => {
    localStorage.setItem('axiome-top-org', org as string);
    if (p) localStorage.setItem('axiome-active-project', p as string);
  }, [world.orgId, activeProject ?? ''] as const);
  await signInAs(page, editor, world.workspaceId);
}

/** Every launch the page attempts — plan mode must never send one. */
function launches(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === WIZARD_RUNS) seen.push(r.url());
  });
  return seen;
}

/** Question → chosen intent → chosen T1 → (what was read) → the first plan step. */
async function throughAnalysis(page: Page, datasetChip?: string): Promise<void> {
  await askQuestion(page, QUESTION);
  await expect(page.getByTestId('na-step-intent')).toBeVisible();
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await expect(page.getByTestId('na-choice-T1')).toBeVisible({ timeout: 60_000 });
  if (datasetChip) await choose(page, `na-chip-${datasetChip}`);
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

test.beforeAll(async () => {
  test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
  world = await PrivateProjectsWorld.create();
  editor = await uiActor('editor', world.workspaceId);
  await world.addMember(editor, 'editor');
  await world.leaveWorkspace();
  await silenceTours(editor.accessToken);
  call = apiCallOf(editor.api);
  datasetD = await uploadArmScoreDataset(world, editor.api, 'axi2447-D');
  datasetE = await uploadArmScoreDataset(world, editor.api, 'axi2447-E');
  // A finalise waits on D's profile (CC4) — after it, every scenario reads a profiled dataset.
  const warm = await newProject('warm-up');
  await pinNewestT1(call, warm.projectId); // the wizard pins the newest — so do the seeds
  await warm.stub.seedFinal(call, 'Warm-up plan', [questionInput(1, 'primary')]);
  const catalog = await editor.api.get(apiUrl('/api/v1/guided-analysis/opening-templates'));
  expect(catalog.status(), await catalog.text()).toBe(200);
  const body = await catalog.json();
  const t1 = (body.templates ?? body).find((t: { templateId: string }) => t.templateId === 'T1');
  t1Subtitle = t1.methodSubtitle;
  t1WizardVersion = t1.version; // a new question pins the version whose guards the wizard ran
});

test.afterAll(async () => {
  await editor?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2447 wizard plan mode: add and edit SAP questions @SI-066 @SI-030', () => {
  test('AC2 FR67 NFR12 AXI-2447.1 "Add to plan" stores the pinned, bound question at the last position and runs nothing @SI-066', async ({ page }) => {
    // Arrange — an empty open draft
    const { projectId, name, stub } = await newProject('add');
    await stub.seedDraft(call, []);
    const launched = launches(page);
    await stub.install(page);
    await signIn(page);

    // Act
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs).toContainText(name);
    await expect(crumbs.getByRole('link', { name: 'Statistical Analysis Plan' })).toHaveAttribute('href', `/projects/${projectId}/sap`);
    await expect(crumbs).toContainText('New question');
    await expect(page.getByTestId('na-page').getByRole('button', { name: /^back$/i })).toHaveCount(0);
    await throughAnalysis(page);
    await expect(page.getByTestId('na-plan-role-primary')).toHaveAttribute('aria-checked', 'true');
    await toReady(page, 'role');
    await expect(page.getByTestId('na-plan-row-analysis')).toContainText(`(T1 v${t1WizardVersion})`);
    await expect(page.getByTestId('na-plan-save')).toHaveText('Add to plan');
    await choose(page, 'na-plan-save');

    // Assert — back on the plan; the question is stored as authored
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap$`));
    const draft = await draftOf(projectId);
    expect(draft.plan.analysisDatasetId).toBe(datasetD);
    expect(draft.plan.questions).toHaveLength(1);
    expect(draft.plan.questions[0]).toMatchObject({
      text: QUESTION,
      role: 'primary',
      position: 1,
      template: { templateId: 'T1', templateVersion: t1WizardVersion },
      parameters: { alpha: 0.05, sidedness: 'two_sided' },
      decisionCriterion: { kind: 'p_at_or_below_alpha' },
      sensitivityAnalyses: [],
    });
    expect(draft.plan.questions[0].bindings).toEqual([
      { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
      { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
    ]);
    expect(stub.pageWrites.map((w) => `${w.method} ${w.path}`)).toEqual([`POST /saps/${draft.sapId}/draft/questions`]);
    expect(launched).toEqual([]);
  });

  test('FR68 AXI-2447.2 the Estimand step pre-fills variable, comparison and summary — editable, marked until edited @SI-066', async ({ page }) => {
    // Arrange
    const { projectId, stub } = await newProject('estimand');
    await stub.seedDraft(call, []);
    await signIn(page);
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    await throughAnalysis(page);

    // Act
    await next(page, 'role', 'estimand');

    // Assert — the three pre-filled fields, each marked; the two with no source are empty
    await expect(page.getByTestId('na-plan-estimand-variable')).toHaveValue('score');
    await expect(page.getByTestId('na-plan-estimand-treatmentComparison')).toHaveValue('arm: A vs B');
    await expect(page.getByTestId('na-plan-estimand-populationSummary')).toHaveValue(t1Subtitle);
    for (const field of ['variable', 'treatmentComparison', 'populationSummary']) {
      await expect(page.getByTestId(`na-plan-prefilled-${field}`), field).toHaveText('pre-filled');
    }
    await expect(page.getByTestId('na-plan-estimand-population')).toHaveValue('');
    await expect(page.getByTestId('na-plan-prefilled-population')).toHaveCount(0);

    // Act — edit one: its mark goes, the others stay
    await page.getByTestId('na-plan-estimand-variable').fill('Score at week 12');
    await page.getByTestId('na-plan-estimand-population').fill('All randomised subjects');
    await expect(page.getByTestId('na-plan-prefilled-variable')).toHaveCount(0);
    await expect(page.getByTestId('na-plan-prefilled-treatmentComparison')).toBeVisible();
    await toReady(page, 'estimand');
    await choose(page, 'na-plan-save');
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap$`));

    // Assert — stored: the edit, the untouched pre-fills, the typed population
    const stored = (await draftOf(projectId)).plan.questions[0].estimand;
    expect(stored).toEqual({
      population: 'All randomised subjects',
      variable: 'Score at week 12',
      treatmentComparison: 'arm: A vs B',
      intercurrentEvents: '',
      populationSummary: t1Subtitle,
    });
  });

  test('AC3 FR11 AXI-2447.3 once the draft holds a question, a second question is offered only that dataset @SI-066', async ({ page }) => {
    // Arrange — a project with two datasets T1 fits, and an empty draft: both are offered
    const { projectId, stub } = await newProject('ac3', [datasetD, datasetE]);
    await stub.seedDraft(call, []);
    await signIn(page);
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    await askQuestion(page, QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await expect(page.getByTestId('na-choice-T1')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId(`na-chip-${datasetD}`)).toBeVisible();
    await expect(page.getByTestId(`na-chip-${datasetE}`)).toBeVisible();

    // Act — the draft now holds a question on D; ask a second one
    const open = await draftOf(projectId);
    await call('POST', `/projects/${projectId}/saps/${open.sapId}/draft/questions`, {
      basedOnRevision: open.revision, analysisDatasetId: datasetD, question: questionInput(1, 'primary'),
    });
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    await askQuestion(page, QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await expect(page.getByTestId('na-choice-T1')).toBeVisible({ timeout: 60_000 });

    // Assert — only D is offered (one dataset: the card carries no dataset choice), and the question is recorded on D
    await expect(page.getByTestId(`na-chip-${datasetE}`)).toHaveCount(0);
    await expect(page.getByTestId(`na-chip-${datasetD}`)).toHaveCount(0);
    await choose(page, 'na-choice-T1');
    await settleAnalysis(page);
    await expect(page.getByTestId('na-plan-role-secondary')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('na-plan-role-secondary').click();
    await toReady(page, 'role');
    await choose(page, 'na-plan-save');
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap$`));
    const draft = await draftOf(projectId);
    expect(draft.plan.questions.map((q: { role: string; position: number }) => [q.role, q.position])).toEqual([['primary', 1], ['secondary', 2]]);
    expect(draft.plan.analysisDatasetId).toBe(datasetD);
  });

  test('FR7 FR9 EC19 AXI-2447.4 α, one-sided unavailable, and at most five sensitivity analyses @SI-066', async ({ page }) => {
    // Arrange
    const { projectId, stub } = await newProject('parameters');
    await stub.seedDraft(call, []);
    await signIn(page);
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    await throughAnalysis(page);
    await toReadyUntil(page, 'parameters');

    // Act — parameters & decision
    await expect(page.getByTestId('na-plan-sidedness-two_sided')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('na-plan-sidedness-greater')).toBeDisabled();
    await expect(page.getByTestId('na-plan-sidedness-less')).toBeDisabled();
    await expect(page.getByTestId('na-plan-one-sided-unavailable')).toBeVisible();
    await page.getByTestId('na-plan-alpha').fill('0.025');
    await page.getByTestId('na-plan-direction').selectOption('positive');
    await next(page, 'parameters', 'sensitivity');

    // Act — five sensitivity analyses is the cap; keep two
    for (let i = 0; i < 5; i += 1) await page.getByTestId('na-plan-sensitivity-add').click();
    await expect(page.getByTestId('na-plan-sensitivity-add')).toBeDisabled();
    await expect(page.getByTestId('na-plan-sensitivity-full')).toBeVisible();
    for (let i = 4; i >= 2; i -= 1) await page.getByTestId(`na-plan-sensitivity-${i}-remove`).click();
    await expect(page.getByTestId('na-plan-sensitivity-add')).toBeEnabled();
    for (const [i, label] of [[0, 'Per-protocol'], [1, 'Complete cases']] as const) {
      await page.getByTestId(`na-plan-sensitivity-${i}-label`).fill(label);
      await page.getByTestId(`na-plan-sensitivity-${i}-template`).selectOption('T1');
      await page.getByTestId(`na-plan-sensitivity-${i}-slot-groupingColumn`).selectOption('arm');
      await page.getByTestId(`na-plan-sensitivity-${i}-slot-outcome`).selectOption('score');
    }
    await page.getByTestId('na-plan-sensitivity-1-alpha').fill('0.01');
    await next(page, 'sensitivity', 'ready');
    await expect(page.getByTestId('na-plan-issues')).toHaveCount(0);
    await choose(page, 'na-plan-save');

    // Assert
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap$`));
    const q = (await draftOf(projectId)).plan.questions[0];
    expect(q.parameters).toEqual({ alpha: 0.025, sidedness: 'two_sided' });
    expect(q.decisionCriterion).toEqual({ kind: 'p_at_or_below_alpha', direction: 'positive' });
    expect(q.sensitivityAnalyses).toEqual([0, 1].map((i) => ({
      label: i === 0 ? 'Per-protocol' : 'Complete cases',
      template: { templateId: 'T1', templateVersion: t1Version },
      bindings: [
        { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
        { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
      ],
      parameters: { alpha: i === 0 ? 0.05 : 0.01, sidedness: 'two_sided' },
    })));
  });

  test('FR67 NFR12 AXI-2447.5 editing a question lands on Ready, "Save question" keeps its id and position @SI-066', async ({ page }) => {
    // Arrange — a draft with two questions; edit the second
    const { projectId, stub } = await newProject('edit');
    const seeded = await stub.seedDraft(call, [questionInput(1, 'primary'), questionInput(2, 'secondary')]);
    const target = seeded.plan.questions.find((q: { position: number }) => q.position === 2);
    await stub.install(page);
    await signIn(page);

    // Act
    await gotoSettled(page, `/projects/${projectId}/sap/questions/${target.questionId}`);

    // Assert — straight to Ready, the stored question restored
    await expect(page.getByTestId('na-step-ready')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('na-plan-save')).toHaveText('Save question');
    await expect(page.getByTestId('na-plan-question')).toHaveText('Does marker 2 differ between arms?');
    await expect(page.getByTestId('na-plan-row-role')).toHaveText(/Secondary/);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(`Question ${target.questionId.slice(0, 8)}`);

    // Act — back to Estimand and Role: change the population and the role
    await choose(page, 'na-back');
    await expect(page.getByTestId('na-step-sensitivity')).toBeVisible();
    await choose(page, 'na-back');
    await choose(page, 'na-back');
    await expect(page.getByTestId('na-step-estimand')).toBeVisible();
    await expect(page.getByTestId('na-plan-estimand-variable')).toHaveValue('marker 2');
    await page.getByTestId('na-plan-estimand-population').fill('Per-protocol set');
    await choose(page, 'na-back');
    await expect(page.getByTestId('na-step-role')).toBeVisible();
    await page.getByTestId('na-plan-role-key_secondary').click();
    await toReady(page, 'role');
    await choose(page, 'na-plan-save');

    // Assert — the same question, edited in place
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap$`));
    const after = (await draftOf(projectId)).plan.questions.find((q: { questionId: string }) => q.questionId === target.questionId);
    expect(after).toMatchObject({ position: 2, role: 'key_secondary', text: 'Does marker 2 differ between arms?' });
    expect(after.estimand).toMatchObject({ population: 'Per-protocol set', variable: 'marker 2' });
    expect(after.template).toEqual(target.template); // an edit never silently re-pins
    expect(stub.pageWrites.map((w) => `${w.method} ${w.path}`)).toEqual([`PUT /saps/${seeded.sapId}/draft/questions/${target.questionId}`]);
  });

  test('FR56 flow E AXI-2447.6 the ordinary wizard\'s Ready, on a project with a SAP, is exploratory and links to the SAP page @SI-066', async ({ page }) => {
    // Arrange — a project with a final SAP, opened as the active project
    const { projectId, stub } = await newProject('flow-e');
    await stub.seedFinal(call, 'Flow E plan', [questionInput(1, 'primary')]);
    const launched = launches(page);
    await signIn(page, projectId);

    // Act
    await gotoSettled(page, '/new-analysis');
    await askQuestion(page, QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await expect(page.getByTestId('na-choice-T1')).toBeVisible({ timeout: 60_000 });
    await choose(page, 'na-choice-T1');
    await settleAnalysis(page);

    // Assert
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    await expect(page.getByTestId('na-step-role')).toHaveCount(0);
    await expect(page.getByTestId('plan-status-exploratory')).toBeVisible();
    await expect(page.getByTestId('na-ready-row-plan')).toContainText('does not use');
    const link = page.getByTestId('na-ready-sap-link');
    await expect(link).toHaveText('Pre-specified analyses run from the project’s SAP');
    await expect(link).toHaveAttribute('href', `/projects/${projectId}/sap`);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap$`));
    await expect(page.getByTestId('sap-final-title')).toHaveText('Flow E plan');
    expect(launched).toEqual([]);
  });

  test('FR67 AXI-2447.7 with no open draft the page says so and links to the plan — no wizard @SI-066', async ({ page }) => {
    // Arrange — a project with no SAP at all
    const { projectId } = await newProject('no-draft');
    await signIn(page);

    // Act
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);

    // Assert
    await expect(page.getByTestId('na-plan-no-draft')).toContainText('This plan has no open draft.');
    await expect(page.getByTestId('na-page')).toHaveCount(0);
    await expect(page.getByTestId('na-plan-open-sap')).toHaveAttribute('href', `/projects/${projectId}/sap`);
    await page.getByTestId('na-plan-open-sap').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap$`));
    await expect(page.getByTestId('sap-empty-state')).toBeVisible();
  });
});

async function toReadyUntil(page: Page, until: 'parameters'): Promise<void> {
  await next(page, 'role', 'estimand');
  await next(page, 'estimand', until);
}
