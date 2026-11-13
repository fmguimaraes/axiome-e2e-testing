import { expect, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { silenceTours } from '../AXI-1904/harness/tours';
import { choose, gotoSettled } from '../AXI-2308/harness/new-analysis';
import { SapApiStub, apiCallOf, pinNewestT1, questionInput, type ApiCall, type StubQuestionInput } from '../AXI-2433/harness/sap-api-stub';

/**
 * AXI-2468 (epic AXI-2455 — SAP FR7, FR9, FR67, FR73, FR74, FR75, AC38, AC39, AC40; @SI-066,
 * @SI-030) — wizard plan mode offers one-sided sidedness, the matrix global test and T2's post-hoc
 * choice where the PINNED version's descriptor allows them, and offers the served version that
 * allows what the pin does not ("Use version X"). It never names a version itself: every version
 * is read off `GET …/sap-templates` (`supportsOneSidedAlternative`, `mainResult.cellBound`,
 * `wholeMatrixMainResultVersion`).
 *
 * Every scenario EDITS a question seeded through the real API on the OLDER pin, so the pin under
 * test does not depend on which version the wizard itself opens at (AXI-2469 moves that to the
 * newest) — an edit keeps the stored pin until the author chooses another (AXI-2447.5).
 *
 * E2E CONTRACT — every route REAL on the demo gateway, nothing routed or doubled: sign-in, fixture
 * workspace / project / dataset, the wizard's reads, AXI-2438's draft + question routes, AXI-2439's
 * `GET …/sap-templates`, completeness. No LLM site is reached (an edit starts past the question).
 * Plan mode submits no run; only `PUT …/draft/questions/:id` is written by the page.
 *
 * Fixture: a token dataset `subject_id, arm (A/B), site (s1–s3), score, crp, il6, alb` — T1 (arm),
 * T2 (site), T3 (1 x, 3 y) and T5 (2 references, 2 y) all bind on it. Self-provisioned workspace.
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2468.
 * Run: `npx playwright test tests/AXI-2455/AXI-2468-* --no-deps`.
 * Authored, NOT run against the demo stack — owner override (no e2e runs for epic AXI-2455).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

interface CatalogEntry {
  templateId: string;
  templateVersion: string;
  isNewest: boolean;
  supportsOneSidedAlternative: boolean;
  wholeMatrixMainResultVersion: string | null;
  mainResult: { cellBound: boolean; signedEffectField: string | null };
}

let world: PrivateProjectsWorld;
let editor: UiActor;
let call: ApiCall;
let dataset: string;
let catalog: CatalogEntry[];
let posthocName: string;

const cont = (slot: string, column: string) => ({ slot, column, semanticRole: 'continuous' });

/** `subject_id,arm,site,score,crp,il6,alb` — 24 rows, unique to this spec. */
async function uploadDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const token = Date.now().toString(36);
  const init = await editor.api.post(datasets, { data: { organizationId: world.orgId, originalFilename: `axi2468-${token}.csv`, contentType: 'text/csv' } });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const rows = Array.from({ length: 24 }, (_, i) => {
    const score = 10 + i * 0.9;
    return `s${token}_${i + 1},${i % 2 === 0 ? 'A' : 'B'},s${(i % 3) + 1},${score.toFixed(2)},${(score * 0.5 + (i % 4)).toFixed(2)},${(30 - i * 0.4).toFixed(2)},${(4 + (i % 5) * 0.3).toFixed(2)}`;
  });
  const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: `subject_id,arm,site,score,crp,il6,alb\n${rows.join('\n')}\n` });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await editor.api.patch(`${datasets}/${created.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return created.id;
}

/** The served version of `templateId` matching `pick` — fails loudly when the stack does not serve it. */
function entry(templateId: string, what: string, pick: (e: CatalogEntry) => boolean): CatalogEntry {
  const found = catalog.find((e) => e.templateId === templateId && pick(e));
  if (!found) throw new Error(`the stack serves no ${templateId} version that ${what} — seed the AXI-2455 versions first`);
  return found;
}

const noAlternative = (id: string) => entry(id, 'lacks an alternative', (e) => !e.supportsOneSidedAlternative);
const withAlternative = (id: string) => entry(id, 'has an alternative and is newest', (e) => e.isNewest && e.supportsOneSidedAlternative);
const cellBound = (id: string) => entry(id, 'is cell-bound with a whole-matrix successor', (e) => e.mainResult.cellBound && e.wholeMatrixMainResultVersion !== null);

function question(text: string, role: StubQuestionInput['role'], template: CatalogEntry, over: Partial<StubQuestionInput>): StubQuestionInput {
  return questionInput(1, role, { text, template: { templateId: template.templateId, templateVersion: template.templateVersion }, ...over });
}

/** A project with the fixture dataset linked and no SAP yet. */
async function newProject(label: string): Promise<{ projectId: string; stub: SapApiStub }> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2468 ${label} ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const projectId = (await res.json()).id;
  const link = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId: dataset } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  return { projectId, stub: new SapApiStub(projectId, editor.userId, dataset) };
}

/** A project whose open draft holds `questions`; returns the stored ones. */
async function seeded(label: string, questions: StubQuestionInput[]): Promise<{ projectId: string; stub: SapApiStub; sapId: string; stored: any[] }> {
  const { projectId, stub } = await newProject(label);
  const draft = await stub.seedDraft(call, questions);
  return { projectId, stub, sapId: draft.sapId, stored: draft.plan.questions };
}

async function draftOf(projectId: string): Promise<any> {
  const res = await call('GET', `/projects/${projectId}/sap-draft`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function failures(projectId: string, sapId: string, checkId: string): Promise<string[]> {
  const res = await call('GET', `/projects/${projectId}/saps/${sapId}/draft/completeness`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.results.filter((r: { checkId: string; status: string }) => r.checkId === checkId && r.status === 'fail').map((r: { message: string }) => r.message);
}

async function signIn(page: Page): Promise<void> {
  await page.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(page, editor, world.workspaceId);
}

/** Open the stored question in plan mode; it lands on Ready (every answer still fits). */
async function editQuestion(page: Page, projectId: string, questionId: string): Promise<void> {
  await gotoSettled(page, `/projects/${projectId}/sap/questions/${questionId}`);
  await expect(page.getByTestId('na-step-ready')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('na-plan-save')).toHaveText('Save question');
}

/** Ready → Sensitivity → Parameters. */
async function backToParameters(page: Page): Promise<void> {
  await choose(page, 'na-back');
  await expect(page.getByTestId('na-step-sensitivity')).toBeVisible();
  await choose(page, 'na-back');
  await expect(page.getByTestId('na-step-parameters')).toBeVisible();
}

/** Parameters → Sensitivity → Ready. */
async function forwardToReady(page: Page, from: 'parameters' | 'sensitivity' = 'parameters'): Promise<void> {
  if (from === 'parameters') await choose(page, 'na-plan-next');
  await expect(page.getByTestId('na-step-sensitivity')).toBeVisible();
  await choose(page, 'na-plan-next');
  await expect(page.getByTestId('na-step-ready')).toBeVisible();
}

async function saveAndReturn(page: Page, projectId: string): Promise<void> {
  await choose(page, 'na-plan-save');
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sap$`));
}

test.beforeAll(async () => {
  test.setTimeout(480_000); // hooks are governed by setTimeout, never describe.configure
  world = await PrivateProjectsWorld.create();
  editor = await uiActor('editor', world.workspaceId);
  await world.addMember(editor, 'editor');
  await world.leaveWorkspace();
  await silenceTours(editor.accessToken);
  call = apiCallOf(editor.api);
  dataset = await uploadDataset();
  // A finalised T1 question waits on the dataset's profile (CC4) — every scenario then reads a profiled dataset.
  const warm = await newProject('warm-up');
  await pinNewestT1(call, warm.projectId);
  await warm.stub.seedFinal(call, 'Warm-up plan', [questionInput(1, 'primary')]);
  const templates = await call('GET', `/projects/${warm.projectId}/sap-templates`);
  expect(templates.status, JSON.stringify(templates.body)).toBe(200);
  catalog = templates.body;
  const opening = await editor.api.get(apiUrl('/api/v1/guided-analysis/opening-templates'));
  expect(opening.status(), await opening.text()).toBe(200);
  const body = await opening.json();
  posthocName = (body.templates ?? body).find((t: { templateId: string }) => t.templateId === 'T2').slotWording.posthoc.name;
});

test.afterAll(async () => {
  await editor?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2468 plan mode: one-sided, matrix global test and T2 post-hoc options @SI-066 @SI-030', () => {
  test('AC38 FR75 AXI-2468.1 a T1 question on a version without an alternative is offered the one that has one; one-sided is then recorded as sidedness @SI-066', async ({ page }) => {
    // Arrange — a primary T1 question on a version with no alternative
    const old = noAlternative('T1');
    const target = withAlternative('T1');
    const { projectId, stub, sapId, stored } = await seeded('one-sided', [question('Is the score higher in arm A?', 'primary', old, {})]);
    await stub.install(page);
    await signIn(page);
    await editQuestion(page, projectId, stored[0].questionId);
    await backToParameters(page);
    await expect(page.getByTestId('na-plan-sidedness-greater')).toBeDisabled();
    await expect(page.getByTestId('na-plan-pin-one-sided')).toContainText(`Version ${target.templateVersion}`);

    // Act — use that version, choose one-sided (greater), save
    await choose(page, 'na-plan-pin-one-sided-use');
    await expect(page.getByTestId('na-plan-sidedness-greater')).toBeEnabled();
    await page.getByTestId('na-plan-sidedness-greater').click();
    await forwardToReady(page);
    await expect(page.getByTestId('na-plan-row-analysis')).toContainText(`(T1 v${target.templateVersion})`);
    await expect(page.getByTestId('na-plan-row-parameters')).toContainText('one-sided (greater)');
    await saveAndReturn(page, projectId);

    // Assert — the new pin, `sidedness` only (never `alternative`), and CC5 passes
    const after = (await draftOf(projectId)).plan.questions[0];
    expect(after.template).toEqual({ templateId: 'T1', templateVersion: target.templateVersion });
    expect(after.parameters).toEqual({ alpha: 0.05, sidedness: 'greater' });
    expect(await failures(projectId, sapId, 'CC5')).toEqual([]);
    expect(stub.pageWrites.map((w) => `${w.method} ${w.path}`)).toEqual([`PUT /saps/${sapId}/draft/questions/${stored[0].questionId}`]);
  });

  test('FR7 EC38 AXI-2468.2 a T2 question offers its post-hoc choice under its wording and no one-sided alternative; the choice is recorded @SI-066', async ({ page }) => {
    // Arrange — a T2 question on the newest T2, post-hoc "always"
    const t2 = entry('T2', 'is newest', (e) => e.isNewest);
    const bindings = [{ slot: 'groupingColumn', column: 'site', semanticRole: 'grouping_three_plus_levels' }, cont('outcome', 'score')];
    const { projectId, stub, sapId, stored } = await seeded('posthoc', [question('Does the score differ across sites?', 'primary', t2, { bindings, parameters: { alpha: 0.05, sidedness: 'two_sided', posthoc: 'always' } })]);
    await stub.install(page);
    await signIn(page);
    await editQuestion(page, projectId, stored[0].questionId);
    await backToParameters(page);

    // Act
    await expect(page.getByTestId('na-plan-one-sided-unavailable')).toBeVisible();
    await expect(page.getByTestId('na-plan-pin-one-sided')).toHaveCount(0);
    await expect(page.locator('label[for="na-plan-param-posthoc"]')).toHaveText(posthocName);
    await expect(page.getByTestId('na-plan-param-posthoc')).toHaveValue('always');
    await page.getByTestId('na-plan-param-posthoc').selectOption('never');
    await forwardToReady(page);
    await expect(page.getByTestId('na-plan-row-parameters')).toContainText('posthoc: never');
    await saveAndReturn(page, projectId);

    // Assert
    const after = (await draftOf(projectId)).plan.questions[0];
    expect(after.template).toEqual({ templateId: 'T2', templateVersion: t2.templateVersion });
    expect(after.parameters).toEqual({ alpha: 0.05, sidedness: 'two_sided', posthoc: 'never' });
    expect(await failures(projectId, sapId, 'CC5')).toEqual([]);
  });

  test('AC39 FR73 EC35 AXI-2468.3 a confirmatory T3 question with 3 y is stopped on the one-cell version and recorded on the global-test version @SI-066', async ({ page }) => {
    // Arrange — primary T3, x = score, y = crp/il6/alb, on a cell-bound pin
    const oneCell = cellBound('T3');
    const whole = oneCell.wholeMatrixMainResultVersion as string;
    const bindings = [cont('x', 'score'), cont('y', 'crp'), cont('y', 'il6'), cont('y', 'alb')];
    const { projectId, stub, sapId, stored } = await seeded('t3-global', [question('Is the score associated with any marker?', 'primary', oneCell, { bindings })]);
    await stub.install(page);
    await signIn(page);

    // Act — Ready is blocked by CC9's one-cell rule, naming the whole-matrix version
    await editQuestion(page, projectId, stored[0].questionId);
    await expect(page.getByTestId('na-plan-issues')).toContainText(`binds 3 “y” column(s)`);
    await expect(page.getByTestId('na-plan-issues')).toContainText(`Version ${whole} tests the whole matrix`);
    await expect(page.getByTestId('na-plan-save')).toBeDisabled();
    await backToParameters(page);
    await expect(page.getByTestId('na-plan-main-result-cell')).toBeVisible();
    await choose(page, 'na-plan-pin-whole-matrix-use');
    await expect(page.getByTestId('na-plan-main-result-global')).toBeVisible();
    await expect(page.getByTestId('na-plan-direction')).toHaveCount(0);
    await forwardToReady(page);
    await expect(page.getByTestId('na-plan-issues')).toHaveCount(0);
    await expect(page.getByTestId('na-plan-row-analysis')).toContainText(`(T3 v${whole})`);
    await saveAndReturn(page, projectId);

    // Assert — the whole-matrix pin, every cell kept, no direction; CC9 and CC6 pass
    const after = (await draftOf(projectId)).plan.questions[0];
    expect(after.template).toEqual({ templateId: 'T3', templateVersion: whole });
    expect(after.bindings).toEqual(bindings);
    expect(after.decisionCriterion).toEqual({ kind: 'p_at_or_below_alpha' });
    expect(await failures(projectId, sapId, 'CC9')).toEqual([]);
    expect(await failures(projectId, sapId, 'CC6')).toEqual([]);
  });

  test('AC40 FR74 EC36 AXI-2468.4 a confirmatory T5 question on the one-cell version is stopped on both axes and recorded on the global-test version @SI-066', async ({ page }) => {
    // Arrange — primary T5, references = score/crp, y = il6/alb
    const oneCell = cellBound('T5');
    const whole = oneCell.wholeMatrixMainResultVersion as string;
    const bindings = [cont('references', 'score'), cont('references', 'crp'), cont('y', 'il6'), cont('y', 'alb')];
    const { projectId, stub, sapId, stored } = await seeded('t5-global', [question('Are the scores associated with the markers?', 'primary', oneCell, { bindings })]);
    await stub.install(page);
    await signIn(page);

    // Act
    await editQuestion(page, projectId, stored[0].questionId);
    await expect(page.getByTestId('na-plan-issues')).toContainText(`binds 2 “references” column(s)`);
    await expect(page.getByTestId('na-plan-issues')).toContainText(`binds 2 “y” column(s)`);
    await expect(page.getByTestId('na-plan-save')).toBeDisabled();
    await backToParameters(page);
    await choose(page, 'na-plan-pin-whole-matrix-use');
    await expect(page.getByTestId('na-plan-main-result-global')).toBeVisible();
    await forwardToReady(page);
    await expect(page.getByTestId('na-plan-issues')).toHaveCount(0);
    await saveAndReturn(page, projectId);

    // Assert — CC4 and CC9 pass on the whole-matrix pin (AC40)
    const after = (await draftOf(projectId)).plan.questions[0];
    expect(after.template).toEqual({ templateId: 'T5', templateVersion: whole });
    expect(await failures(projectId, sapId, 'CC9')).toEqual([]);
    expect(await failures(projectId, sapId, 'CC4')).toEqual([]);
  });

  test('FR9 FR75 AXI-2468.5 a sensitivity analysis is judged on its own pin — offered the version with an alternative, then recorded one-sided @SI-066', async ({ page }) => {
    // Arrange — a T1 question on the alternative version, with a T1 sensitivity analysis on the older one
    const old = noAlternative('T1');
    const target = withAlternative('T1');
    const sensitivity = { label: 'Per-protocol', template: { templateId: 'T1', templateVersion: old.templateVersion }, bindings: questionInput(1).bindings, parameters: { alpha: 0.05, sidedness: 'two_sided' } };
    const { projectId, stub, stored } = await seeded('sensitivity', [question('Is the score higher in arm A?', 'primary', target, { sensitivityAnalyses: [sensitivity] })]);
    await stub.install(page);
    await signIn(page);
    await editQuestion(page, projectId, stored[0].questionId);
    await choose(page, 'na-back');
    await expect(page.getByTestId('na-step-sensitivity')).toBeVisible();
    await expect(page.getByTestId('na-plan-sensitivity-0-sidedness-less')).toBeDisabled();

    // Act
    await choose(page, 'na-plan-sensitivity-0-pin-one-sided-use');
    await page.getByTestId('na-plan-sensitivity-0-sidedness-less').click();
    await forwardToReady(page, 'sensitivity');
    await saveAndReturn(page, projectId);

    // Assert
    const after = (await draftOf(projectId)).plan.questions[0].sensitivityAnalyses[0];
    expect(after.template).toEqual({ templateId: 'T1', templateVersion: target.templateVersion });
    expect(after.parameters).toEqual({ alpha: 0.05, sidedness: 'less' });
  });
});
