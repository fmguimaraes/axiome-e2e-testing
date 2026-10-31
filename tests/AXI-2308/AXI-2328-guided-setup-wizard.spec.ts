import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import {
  answered,
  askQuestion,
  choose,
  chooseRadio,
  focusedTestId,
  gotoSettled,
  horizontalOverflow,
  measureControls,
  press,
  seedScope,
  stubWizardRoutes,
  type WizardStubs,
} from './harness/new-analysis';

/**
 * AXI-2328 (epic AXI-2308 — FR18, FR21, FR22, FR24, FR47, FR48, FR50, FR51, FR53, NFR12, NFR13):
 * the New analysis page — the guided setup wizard (question → [plan] → intent → analysis →
 * [read] → [decide] → ready), driven in the browser on a real dataset, against the real
 * opening-template routes (AXI-2339 `catalog` + `match`) and the real dataset/profile routes.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2328.3–.14.
 *
 * Stubbed in the browser (`harness/new-analysis.ts`), on purpose:
 *  - AXI-2345's `POST /guided-analysis/intent-prefill/suggest` + `GET …/catalog` — not on `main`
 *    yet, and every case here needs a controlled answer (delayed, failed, contradicting). The
 *    stub answers the final `QuestionSuggestionResult` contract (spans with UTF-16 offsets).
 *  - the project SAP list — so "project has a SAP" is a per-test fact, never another spec's state.
 *  - `…/semantic-declaration/ensure-recognized-fill` — an idempotent WRITE (AXI-2326); answered
 *    `null` so this spec writes nothing; the call itself is asserted.
 * AXI-2352: a Run that relies on a suggestion cites its FR27 call-log row (`suggestionCallId`) and
 * the server stores the model READ FROM THAT ROW; an uncited `suggested` intent is refused. So
 * §.11's launch first makes ONE real (recorded-transport) suggestion call for SEX_QUESTION on this
 * project and hands its `callId` to the stubbed answer — the UI stays deterministic, the row the
 * server reads is real.
 * NOT stubbed: Run. AXI-2349's `POST /guided-analysis/wizard-runs` is the real route — §.11 runs
 * the analysis for real (the server re-checks the answers, compiles T1, writes the wizard record,
 * starts the governed run) and lands on the run's analysis page; its refusal case alters the
 * launch body IN FLIGHT to an outcome the dataset lacks (the UI only offers valid choices), so
 * the refusal shown is the SERVER's, routed back to the parameter it names (EC26).
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339's synthetic
 * Paul-header file: `igg4_g_l`, `age`, MAG4 columns continuous; `sexe` F/M; the ACR/EULAR cluster
 * C1–C4) — every template is eligible on it.
 *
 * Run: `BASE_URL=<worktree Vite serving the AXI-2328 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2328-*`.
 * Run analysis needs the T1 carrier approved on that stack (`approveCarriersFor`, refused on the
 * shared demo :3000 by design) — so this spec runs on an isolated stack only.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const SEX_QUESTION = 'Does IgG4 differ by sex?';
const SEX_READ = answered(SEX_QUESTION, 'compare_groups', [
  ['outcome', 'igg4_g_l', 'IgG4'],
  ['groupingColumn', 'sexe', 'by sex'],
]);

let api: Api;
let t: Tenant;
let datasetId: string;

/** AXI-2361 (D21): the Template step's choice id is the (template, dataset) PAIR key — this
 * spec's project links exactly one dataset, so every pair key is `<templateId>::${datasetId}`. */
function pk(templateId: string): string {
  return `${templateId}::${datasetId}`;
}

async function openWizard(page: Page, stubs: WizardStubs = {}) {
  await seedScope(page, t);
  const log = await stubWizardRoutes(page, stubs);
  await gotoSettled(page, `/new-analysis?datasetId=${datasetId}`);
  await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 15_000 }); // first paint waits on the project + dataset reads
  return log;
}

/** The step's choices, in order, as their data-testid suffix. */
async function choiceKeys(page: Page, group: string): Promise<string[]> {
  const ids = await page.getByRole('radiogroup', { name: group }).getByRole('radio').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.replace('na-choice-', ''));
}

async function checkedKeys(page: Page, group: string): Promise<string[]> {
  const ids = await page.getByRole('radiogroup', { name: group }).locator('[aria-checked="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.replace('na-choice-', ''));
}

const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';

/** The launch body with `outcome` swapped — the in-flight edit that makes the server refuse. */
function withOutcome(body: any, value: string) {
  return { ...body, slots: body.slots.map((s: any) => (s.slot === 'outcome' ? { ...s, value } : s)) };
}

/** The one wizard record the UI's Run stored: the UI's answers, provenance and span, the caller's run. */
async function expectRecordOf(runId: string, viewAnalysisId: string, callId: string) {
  const res = await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}&runId=${runId}`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.records).toHaveLength(1);
  const record = res.body.records[0];
  expect(record).toMatchObject({ runId, viewAnalysisId, question: SEX_QUESTION, intent: 'compare_groups', intentSource: 'suggested', templateId: 'T1', suggestionCallId: callId, suggestionModel: 'claude-haiku-5-5', sapChoice: null });
  const bySlot = Object.fromEntries(record.slots.map((s: any) => [s.slot, s]));
  expect(bySlot.outcome).toMatchObject({ value: 'age', provenance: 'decided' });
  expect(bySlot.groupingColumn).toMatchObject({ value: 'sexe', provenance: 'question', sourceSpan: { text: 'by sex' } });
  expect(SEX_QUESTION.slice(bySlot.groupingColumn.sourceSpan.start, bySlot.groupingColumn.sourceSpan.end)).toBe('by sex');
  for (const s of record.slots) expect(Date.parse(s.answeredAt), JSON.stringify(s)).not.toBeNaN();
}

/** AXI-2352: one real recorded-transport suggestion for SEX_QUESTION on this project — its logged call handle. */
async function loggedSuggestionCallId(): Promise<string> {
  const dataset = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
  const res = await api.post('/api/v1/guided-analysis/intent-prefill/suggest', { projectId: t.projectId, question: SEX_QUESTION, dataset }, t.headers);
  expect(res.body, JSON.stringify(res.body)).toMatchObject({ status: 'answered', intent: 'compare_groups' });
  return res.body.callId;
}

/** Question → suggested intent → suggested T1 → Read → Ready, by the SEX_READ suggestion. */
async function reachReadyBySex(page: Page) {
  await askQuestion(page, SEX_QUESTION);
  await expect(page.getByTestId('na-choice-compare_groups')).toHaveAttribute('aria-checked', 'true');
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await choose(page, `na-choice-${pk('T1')}`);
  await expect(page.getByTestId('na-step-read')).toBeVisible();
  await choose(page, 'na-read-confirm');
  await expect(page.getByTestId('na-step-ready')).toBeVisible();
}

test.describe.serial('AXI-2328 guided setup wizard — the New analysis page @SI-066 @SI-030', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    await approveCarriersFor(['stats.mann_whitney_u']); // T1's carrier — Run executes for real
    await silenceTours(await adminToken()); // a fresh stack's admin gets the first-visit tour, which navigate()s away
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AC41 — AXI-2328.3 New analysis opens from Dataset Tables: question focused, no breadcrumb, a full-width bar of only the rendering steps @SI-066 @SI-030', async ({ page }) => {
    await seedScope(page, t);
    await stubWizardRoutes(page);
    await gotoSettled(page, '/project-datasets');
    await page.getByRole('button', { name: 'New analysis' }).click();
    await expect(page).toHaveURL(/\/new-analysis/);
    await expect(page.getByLabel('What do you want to find out?')).toBeFocused();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
    const bar = await page.getByTestId('na-step-bar').boundingBox();
    const shell = await page.getByTestId('na-page').boundingBox();
    expect(Math.abs((bar?.width ?? 0) - (shell?.width ?? -1))).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('na-bar-question')).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('na-bar-plan')).toHaveCount(0); // no SAP on this project
    await gotoSettled(page, '/guided-analysis');
    await expect(page.getByTestId('na-step-bar')).toHaveCount(0);
  });

  test('AC44 NFR12 — AXI-2328.4 the question advances at once while the suggestion is still pending @SI-066', async ({ page }) => {
    const log = await openWizard(page, { suggestion: { kind: 'answer', delayMs: 5_000, body: SEX_READ } });
    await page.getByLabel('What do you want to find out?').fill(SEX_QUESTION);
    await page.evaluate(() => {
      const w = window as unknown as { __naAt?: number; __naShown?: number };
      document.addEventListener('keydown', () => (w.__naAt ??= performance.now()), { capture: true, once: true });
      new MutationObserver((_m, o) => {
        if (document.querySelector('[data-testid="na-step-intent"]')) {
          w.__naShown = performance.now();
          o.disconnect();
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('na-step-intent')).toBeVisible();
    const ms = await page.evaluate(() => {
      const w = window as unknown as { __naAt: number; __naShown: number };
      return w.__naShown - w.__naAt;
    });
    expect(ms, `question → intent took ${ms} ms`).toBeLessThan(300);
    await expect.poll(() => log.suggestionBodies.length).toBe(1);
    expect(log.suggestionBodies[0]).toMatchObject({ projectId: t.projectId, question: SEX_QUESTION });
    expect(log.fillCalls, 'the recognised-format fill is ensured before the schema is read').toBeGreaterThan(0);
    await expect(page.getByTestId('na-intent-heading')).toHaveText('Reading your question…');
    expect(await checkedKeys(page, 'Intent')).toEqual([]);
    await choose(page, 'na-choice-explore_dataset');
    await expect(page.getByTestId('na-step-template')).toBeVisible();
  });

  test('AC44 EC20 — AXI-2328.4 a failed suggestion leaves five usable intents, nothing preselected, no error @SI-066', async ({ page }) => {
    const log = await openWizard(page, { suggestion: { kind: 'fail' } });
    await askQuestion(page, SEX_QUESTION);
    await expect.poll(() => log.suggestionBodies.length).toBe(1);
    await expect(page.getByTestId('na-intent-heading')).toHaveText('Pick the closest one.');
    expect(await choiceKeys(page, 'Intent')).toEqual(['explore_dataset', 'compare_groups', 'find_validate_biomarkers', 'follow_patients_over_time', 'reproduce_published_analysis']);
    expect(await checkedKeys(page, 'Intent')).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('AC41 — AXI-2328.5 with a project SAP the plan step is asked, No preselected, N answers it exploratory @SI-066', async ({ page }) => {
    await openWizard(page, { saps: [{ sapVersionId: 'sap-v1', version: 1, title: 'Primary SAP', supersededBy: null }] });
    await expect(page.getByTestId('na-bar-plan')).toBeVisible();
    await askQuestion(page, SEX_QUESTION);
    await expect(page.getByTestId('na-step-plan')).toBeVisible();
    expect(await checkedKeys(page, 'Use a statistical analysis plan')).toEqual(['no']);
    await press(page, 'n');
    await expect(page.getByTestId('na-step-intent')).toBeVisible();
    await expect(page.getByTestId('na-rail-plan')).toContainText('Exploratory');
    await expect(page.getByTestId('na-back')).toHaveText('← Back to the plan question');
  });

  test('AC42 — AXI-2328.6 the suggested intent is preselected and labelled; a late suggestion never overrides a pick @SI-066', async ({ page }) => {
    await openWizard(page, { suggestion: { kind: 'answer', body: SEX_READ } });
    await askQuestion(page, SEX_QUESTION);
    await expect(page.getByTestId('na-choice-compare_groups')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('na-choice-compare_groups')).toContainText('suggested');
    await expect(page.getByTestId('na-intent-heading')).toHaveText('Reads as Compare groups. Change it if that is wrong.');

    const late = await openWizard(page, { suggestion: { kind: 'answer', delayMs: 2_500, body: SEX_READ } });
    await askQuestion(page, SEX_QUESTION);
    await expect.poll(() => late.suggestionBodies.length).toBe(1);
    await press(page, '1'); // move onto "Explore a dataset" — a pick, not a confirm
    await expect(page.getByTestId('na-choice-explore_dataset')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('na-choice-compare_groups')).toContainText('suggested');
    expect(await checkedKeys(page, 'Intent')).toEqual(['explore_dataset']);
    await expect(page.getByTestId('na-intent-heading')).toHaveText('Your pick:');
  });

  test('AC15 EC24 — AXI-2328.7 only guard-matching analyses, ranked by intent, the top one suggested and preselected @SI-066 @SI-030', async ({ page }) => {
    await openWizard(page, { suggestion: { kind: 'answer', body: SEX_READ } });
    await askQuestion(page, SEX_QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await expect(page.getByTestId('na-step-template')).toBeVisible();
    expect(await choiceKeys(page, 'Analysis')).toEqual(['T1', 'T2', 'T4', 'T3'].map(pk));
    expect(await checkedKeys(page, 'Analysis')).toEqual([pk('T1')]);
    await expect(page.getByTestId(`na-choice-${pk('T1')}`)).toContainText('Compare groups');
    await expect(page.getByTestId(`na-choice-${pk('T1')}`)).toContainText('Mann-Whitney U test');
    await expect(page.getByTestId(`na-choice-${pk('T1')}`)).toContainText('suggested');
    await expect(page.getByTestId('na-back')).toHaveText('← Back to intent');
    await press(page, 'Escape');
    await expect(page.getByTestId('na-step-intent')).toBeVisible();
    await choose(page, 'na-choice-explore_dataset');
    await expect(page.getByTestId('na-step-template')).toBeVisible();
    expect(await choiceKeys(page, 'Analysis')).toEqual(['T3', 'T1', 'T2', 'T4'].map(pk));
    expect(await checkedKeys(page, 'Analysis')).toEqual([pk('T3')]);
  });

  test('AC15 — AXI-2328.8 when no analysis fits the data the step says so and offers nothing to run @SI-066', async ({ page }) => {
    await openWizard(page, { noTemplateFits: true });
    await askQuestion(page, SEX_QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await expect(page.getByTestId('na-template-none')).toHaveText('No analysis fits this data yet — contact Axiome.');
    await expect(page.getByRole('radiogroup', { name: 'Analysis' })).toHaveCount(0);
    await expect(page.getByTestId('na-run')).toHaveCount(0);
  });

  test('AC45 EC21 — AXI-2328.9 Read lists only values whose words are in the question, with those words; absent when nothing was read @SI-066', async ({ page }) => {
    const withNoise = { ...SEX_READ, slots: [...SEX_READ.slots, { slot: 'groups', value: 'F', sourceSpan: { text: 'women', start: 0, end: 5 } }] };
    await openWizard(page, { suggestion: { kind: 'answer', body: withNoise } });
    await askQuestion(page, SEX_QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await choose(page, `na-choice-${pk('T1')}`);
    await expect(page.getByTestId('na-step-read')).toBeVisible();
    await expect(page.getByTestId('na-read-outcome')).toContainText('igg4_g_l');
    await expect(page.getByTestId('na-read-outcome')).toContainText('from IgG4');
    await expect(page.getByTestId('na-read-groupingColumn')).toContainText('from by sex');
    await expect(page.getByTestId('na-read-groups')).toHaveCount(0);
    await expect(page.getByTestId('na-read-confirm')).toBeFocused();

    await openWizard(page, { suggestion: { kind: 'answer', body: answered(SEX_QUESTION, 'compare_groups') } });
    await askQuestion(page, SEX_QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await choose(page, `na-choice-${pk('T1')}`);
    await expect(page.getByTestId('na-step-decide-groupingColumn')).toBeVisible();
    await expect(page.getByTestId('na-bar-read')).toHaveCount(0);
  });

  test('AC45 EC22 — AXI-2328.10 Must be decided asks one parameter at a time, names what it blocks, quotes contradicted words @SI-066', async ({ page }) => {
    const question = 'Does CCL19 differ across clusters?';
    await openWizard(page, { suggestion: { kind: 'answer', body: answered(question, 'compare_groups', [], [['outcome', 'CCL19']]) } });
    await askQuestion(page, question);
    await choose(page, 'na-choice-compare_groups');
    await choose(page, `na-choice-${pk('T2')}`);
    // The fixture's profile offers two grouping columns with three or more levels (the cluster,
    // and the first MAG4 column the profiler types as a timepoint — AXI-2339's noted defect).
    const grouping = page.getByTestId('na-step-decide-groupingColumn');
    await expect(grouping).toBeVisible();
    await expect(grouping.getByRole('heading', { level: 1 })).toHaveText('Which column splits your subjects into groups?');
    await expect(page.getByTestId('na-decide-blocks')).toHaveText("Blocking · Compare groups (Kruskal-Wallis test, then Dunn's pairwise test (Holm)) cannot run without it");
    await expect(page.getByTestId('na-decide-contradiction')).toHaveCount(0);
    expect(await checkedKeys(page, 'Which column splits your subjects into groups?')).toEqual([]);
    await chooseRadio(page, /cluster_selon_acr_eular_2019/);
    const outcome = page.getByTestId('na-step-decide-outcome');
    await expect(outcome).toBeVisible();
    await expect(outcome.getByRole('heading', { level: 1 })).toHaveText('Which measurement do you compare?');
    await expect(page.getByTestId('na-decide-contradiction')).toHaveText('Your question says “CCL19”, which matches nothing in this dataset, so this is asked here.');
    await expect(page.getByTestId('na-back')).toHaveText('← Previous question');
    expect(await checkedKeys(page, 'Which measurement do you compare?')).toEqual([]);
    await chooseRadio(page, /igg4_g_l/);
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    await expect(page.getByTestId('na-ready-decided')).toContainText('cluster_selon_acr_eular_2019');
    await expect(page.getByTestId('na-ready-decided')).toContainText('igg4_g_l');
    await expect(page.getByTestId('na-ready-handled')).toContainText('Holm correction across the pairs of groups');
  });

  test('AC45 AC13 AC16 AC46 — AXI-2328.11 Ready shows the design by origin, Change re-asks a read value, Run launches and opens the run @SI-066 @SI-010', async ({ page }) => {
    const callId = await loggedSuggestionCallId();
    await openWizard(page, { suggestion: { kind: 'answer', body: { ...SEX_READ, callId } } });
    await reachReadyBySex(page);
    await expect(page.getByTestId('na-run')).toBeFocused();
    await expect(page.getByTestId('na-step-ready').getByRole('heading', { level: 1 })).toHaveText('Here is the exploratory analysis you have set up.');
    await expect(page.getByTestId('na-ready-analysis')).toContainText('Compare groups');
    await expect(page.getByTestId('na-ready-analysis')).toContainText('Exploratory — this project has no analysis plan');
    await expect(page.getByTestId('na-ready-question')).toContainText('from IgG4');
    await expect(page.getByTestId('na-ready-handled')).toContainText('F vs M');
    await expect(page.getByTestId('na-ready-settled')).toBeVisible(); // EC23: nothing had to be asked
    await expect(page.getByTestId('na-ready-decided')).toHaveCount(0);
    await expect(page.getByTestId('na-rail-question')).toContainText(SEX_QUESTION);

    await choose(page, 'na-change-outcome');
    await expect(page.getByTestId('na-step-decide-outcome')).toBeVisible();
    await chooseRadio(page, /(^|\s)age$/);
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    await expect(page.getByTestId('na-ready-decided')).toContainText('age');
    await expect(page.getByTestId('na-ready-question')).not.toContainText('from IgG4');

    const launched = page.waitForResponse((r) => r.url().includes(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    const answer = await (await launched).json();
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/projects/${t.projectId}/runs/${answer.runId}$`), { timeout: 30_000 });
    await expectRecordOf(answer.runId, answer.viewAnalysisId, callId);
  });

  test('AC50 EC26 — AXI-2328.11 a refusal from the server is shown on Ready and routes back to the parameter it names; nothing is opened @SI-066 @SI-010', async ({ page }) => {
    await openWizard(page, { suggestion: { kind: 'answer', body: SEX_READ } });
    await reachReadyBySex(page);
    await page.route(`**${WIZARD_RUNS}`, (route) => route.continue({ postData: JSON.stringify(withOutcome(route.request().postDataJSON(), 'not_a_column')) }));
    const refused = page.waitForResponse((r) => r.url().includes(WIZARD_RUNS) && r.request().method() === 'POST');

    await choose(page, 'na-run');

    const answer = await (await refused).json();
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: false, code: 'ANSWERS_REFUSED', slots: ['outcome'] });
    const panel = page.getByTestId('na-run-refused');
    await expect(panel).toContainText(answer.messages[0]);
    await expect(page).toHaveURL(/\/new-analysis/);
    await expect(page.getByTestId('na-refused-back-groupingColumn')).toHaveCount(0); // only what the server named
    await expect(page.getByTestId('na-refused-back-outcome')).toHaveText('Answer “Measurement compared” again');
    await choose(page, 'na-refused-back-outcome');
    await expect(page.getByTestId('na-step-decide-outcome')).toBeVisible();
  });

  test('AC47 EC27 EC24 — AXI-2328.12 keyboard only: focus on every transition, held Enter advances once, back named, a new question invalidates @SI-066', async ({ page }) => {
    await openWizard(page, { suggestion: { kind: 'answer', body: answered(SEX_QUESTION, null) } });
    await askQuestion(page, SEX_QUESTION);
    await expect(page.getByTestId('na-step-intent')).toBeVisible();
    expect(await focusedTestId(page)).toBe('na-choice-explore_dataset');
    await press(page, '2');
    expect(await focusedTestId(page)).toBe('na-choice-compare_groups');
    await page.keyboard.down('Enter'); // held: the auto-repeat must not also answer the next step
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(page.getByTestId('na-step-template')).toBeVisible();
    expect(await focusedTestId(page)).toBe(pk('T1'));
    await expect(page.getByTestId('na-back')).toHaveText('← Back to intent');
    await press(page, 'Escape');
    await expect(page.getByTestId('na-step-intent')).toBeVisible();
    expect(await focusedTestId(page)).toBe('na-choice-compare_groups');
    await press(page, 'Enter');
    await expect(page.getByTestId('na-step-template')).toBeVisible();
    await press(page, 'Enter');
    for (let i = 0; i < 4 && !(await page.getByTestId('na-step-ready').isVisible()); i += 1) {
      expect(await focusedTestId(page)).toMatch(/^na-choice-/);
      await press(page, 'Enter');
    }
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    expect(await focusedTestId(page)).toBe('na-run');

    for (let i = 0; i < 8 && !(await page.getByTestId('na-step-question').isVisible()); i += 1) {
      expect(await focusedTestId(page), `focus after back #${i}`).not.toBe('');
      await choose(page, 'na-back');
    }
    const input = page.getByLabel('What do you want to find out?');
    await expect(input).toBeFocused();
    await input.fill('Does age differ across clusters?');
    await press(page, 'Enter');
    await expect(page.getByTestId('na-step-intent')).toBeVisible();
    expect(await checkedKeys(page, 'Intent')).toEqual([]);
    await expect(page.getByTestId('na-rail-question')).toContainText('Does age differ across clusters?');
    await expect(page.getByTestId('na-rail-analysis')).toContainText('—');
  });

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`AC49 NFR13 AC18 — AXI-2328.13/.14 at ${viewport.width} px: no horizontal scroll, visible focus, AA contrast, no rule or filter controls @SI-066`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openWizard(page, { suggestion: { kind: 'answer', body: SEX_READ } });
      const check = async (step: string) => {
        await expect(page.getByTestId(step)).toBeVisible();
        expect(await horizontalOverflow(page), `${step} overflows`).toBeLessThanOrEqual(0);
        for (const m of await measureControls(page)) {
          expect(m.focusVisible, `${step} ${m.theme} ${m.testId} focus outline`).toBe(true);
          expect(m.text, `${step} ${m.theme} ${m.testId} text contrast`).toBeGreaterThanOrEqual(4.5);
          expect(m.focusRing, `${step} ${m.theme} ${m.testId} focus ring contrast`).toBeGreaterThanOrEqual(3);
          if (m.border !== null) expect(m.border, `${step} ${m.theme} ${m.testId} border contrast`).toBeGreaterThanOrEqual(3);
        }
        const path = page.getByTestId('na-page'); // AC18 is about the wizard path, not the app shell (whose role chip reads "Rule approver" for an approver)
        await expect(path.getByRole('button', { name: /\brule\b/i })).toHaveCount(0);
        await expect(path.getByRole('table')).toHaveCount(0);
        await expect(path.getByRole('combobox')).toHaveCount(0);
      };
      await page.getByLabel('What do you want to find out?').fill(SEX_QUESTION);
      await check('na-step-question');
      await page.keyboard.press('Enter');
      await check('na-step-intent');
      await expect(page.getByTestId('na-choice-compare_groups')).toHaveAttribute('aria-checked', 'true');
      await choose(page, 'na-choice-compare_groups');
      await check('na-step-template');
      await choose(page, `na-choice-${pk('T1')}`);
      await check('na-step-read');
      await choose(page, 'na-read-confirm');
      await check('na-step-ready');
    });
  }
});
