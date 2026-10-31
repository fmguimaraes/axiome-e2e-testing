import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { answered, askQuestion, choose, gotoSettled, seedScope, stubWizardRoutes, type WizardStubs } from './harness/new-analysis';

/**
 * AXI-2361 (epic AXI-2308 — FR21, FR47, FR51, FR52, D21, EC28, EC29; AC41, AC42, AC45, AC46):
 * front half of D21 — the Data step is removed, the Template step offers eligible
 * (template, dataset) PAIRS across every project dataset, Ready shows the chosen dataset and
 * lets the investigator change it (FR51), `?datasetId=` on entry restricts the pairs to one
 * dataset (EC28), and `datasetSettledBy` is stamped correctly on the persisted record (FR52).
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2361.3–.8.
 *
 * Stubbed in the browser (`harness/new-analysis.ts`), same discipline as AXI-2328: the
 * suggestion + intent catalog (each test controls its own answer, including `datasetIds`) and
 * the project SAP list. NOT stubbed: the project dataset list and the opening-template `match`
 * route — both real, against two REAL ingested datasets, which is the only way to exercise D21's
 * "every project dataset is a candidate" behaviour honestly.
 *
 * Fixtures: `opening-templates-paul-header.csv` (T1/T2/T3/T4 all eligible — AXI-2339) and
 * `opening-templates-second-dataset.csv` (a disjoint-named, smaller dataset: `biomarker_x`
 * continuous, `group_arm` 2 levels, `visit_age` continuous — eligible for T1 and T3, never T2).
 * T1 is eligible on BOTH datasets, which is what every multi-dataset assertion below relies on.
 *
 * Run: `BASE_URL=<worktree Vite serving the AXI-2361 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2361-*`.
 */

const FIXTURE_1 = 'opening-templates-paul-header.csv';
const FIXTURE_2 = 'opening-templates-second-dataset.csv';
const QUESTION = 'Does the outcome differ between the two groups?';
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';

let api: Api;
let t: Tenant;
let dataset1: string;
let dataset2: string;

/** T1's pair key on a given dataset. */
const pk = (datasetId: string) => `T1::${datasetId}`;

async function openWizard(page: Page, path: string, stubs: WizardStubs = {}) {
  await seedScope(page, t);
  await stubWizardRoutes(page, stubs);
  await gotoSettled(page, path);
  await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 15_000 });
}

/** Question → suggested intent (compare_groups) → the Template step. */
async function reachTemplate(page: Page, datasetIds: string[] = []) {
  await askQuestion(page, QUESTION);
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  return datasetIds;
}

async function latestRecord(runId: string): Promise<Record<string, unknown>> {
  const res = await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}&runId=${runId}`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.records[0];
}

test.describe.serial('AXI-2361 the wizard offers (template, dataset) pairs — no Data step @SI-066 @SI-045', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    api = await adminApi();
    t = await ensureTenant(api);
    dataset1 = await ingestCsvFixture(api, t, FIXTURE_1);
    dataset2 = await ingestCsvFixture(api, t, FIXTURE_2);
    await silenceTours(await adminToken());
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AC41 — AXI-2361.3 no Data step anywhere in the wizard', async ({ page }) => {
    await openWizard(page, '/new-analysis');
    await reachTemplate(page);
    await expect(page.getByTestId('na-rail-data')).toHaveCount(0);
    await expect(page.getByText(/which dataset/i)).toHaveCount(0);
  });

  test('AC15 AC42 — AXI-2361.4 T1 lists once per eligible dataset, dataset named in the subtitle, suggestion dataset ranks first', async ({ page }) => {
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: { ...answered(QUESTION, 'compare_groups'), datasetIds: [dataset2] } } });
    await reachTemplate(page);
    await expect(page.getByTestId(`na-choice-${pk(dataset1)}`)).toBeVisible();
    await expect(page.getByTestId(`na-choice-${pk(dataset2)}`)).toBeVisible();
    // the second dataset's pair is the suggested one (tie-break by the suggestion's own datasetIds)
    await expect(page.getByTestId(`na-choice-${pk(dataset2)}`)).toContainText('suggested');
    await expect(page.getByTestId(`na-choice-${pk(dataset2)}`)).toHaveAttribute('aria-checked', 'true');
  });

  test('AC41 AC42 — AXI-2361.5 ?datasetId= on entry restricts every pair to that one dataset (EC28)', async ({ page }) => {
    await openWizard(page, `/new-analysis?datasetId=${dataset2}`, { suggestion: { kind: 'answer', body: answered(QUESTION, 'compare_groups') } });
    await reachTemplate(page);
    await expect(page.getByTestId(`na-choice-${pk(dataset2)}`)).toBeVisible();
    await expect(page.getByTestId(`na-choice-${pk(dataset1)}`)).toHaveCount(0);
  });

  test('AC45 AC46 — AXI-2361.6/.7 Ready shows the dataset and offers the other eligible one; changing it re-settles', async ({ page }) => {
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: { ...answered(QUESTION, 'compare_groups'), datasetIds: [dataset1] } } });
    await reachTemplate(page);
    await choose(page, `na-choice-${pk(dataset1)}`);
    await expect(page.getByTestId('na-step-ready')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('na-ready-row-dataset')).toBeVisible();
    const changeButton = page.getByTestId(`na-change-dataset-${dataset2}`);
    await expect(changeButton).toBeVisible();
    await changeButton.click();
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    await expect(page.getByTestId('na-ready-row-dataset')).toBeVisible();
    await expect(page.getByTestId(`na-change-dataset-${dataset1}`)).toBeVisible(); // the other way round now
  });

  test('AC45 AC46 — AXI-2361.5b a single-candidate Ready (entry-restricted) offers no "Use … instead" control', async ({ page }) => {
    await openWizard(page, `/new-analysis?datasetId=${dataset2}`, { suggestion: { kind: 'answer', body: answered(QUESTION, 'compare_groups') } });
    await reachTemplate(page);
    await choose(page, `na-choice-${pk(dataset2)}`);
    await expect(page.getByTestId('na-step-ready')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`na-change-dataset-${dataset1}`)).toHaveCount(0);
  });

  test('FR52 — AXI-2361.8 datasetSettledBy: entry, question, decided', async ({ page }) => {
    // entry: opened with ?datasetId=
    await openWizard(page, `/new-analysis?datasetId=${dataset2}`, { suggestion: { kind: 'answer', body: answered(QUESTION, 'compare_groups') } });
    await reachTemplate(page);
    await choose(page, `na-choice-${pk(dataset2)}`);
    await expect(page.getByTestId('na-step-ready')).toBeVisible({ timeout: 10_000 });
    let launched = page.waitForResponse((r) => r.url().includes(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    let answer = await (await launched).json();
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    let record = await latestRecord(answer.runId);
    expect(record).toMatchObject({ datasetId: dataset2, datasetSettledBy: 'entry' });

    // question: confirms the suggestion's own dataset, on a project with both candidates
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: { ...answered(QUESTION, 'compare_groups'), datasetIds: [dataset1] } } });
    await reachTemplate(page);
    await choose(page, `na-choice-${pk(dataset1)}`);
    await expect(page.getByTestId('na-step-ready')).toBeVisible({ timeout: 10_000 });
    launched = page.waitForResponse((r) => r.url().includes(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    answer = await (await launched).json();
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    record = await latestRecord(answer.runId);
    expect(record).toMatchObject({ datasetId: dataset1, datasetSettledBy: 'question' });

    // decided: picks a dataset OTHER than the one the suggestion named
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: { ...answered(QUESTION, 'compare_groups'), datasetIds: [dataset1] } } });
    await reachTemplate(page);
    await choose(page, `na-choice-${pk(dataset2)}`);
    await expect(page.getByTestId('na-step-ready')).toBeVisible({ timeout: 10_000 });
    launched = page.waitForResponse((r) => r.url().includes(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    answer = await (await launched).json();
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    record = await latestRecord(answer.runId);
    expect(record).toMatchObject({ datasetId: dataset2, datasetSettledBy: 'decided' });
  });
});
