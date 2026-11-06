import { test, expect, type Page, type Route } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { gotoSettled, seedScope } from './harness/new-analysis';
import { launchAndDrain, wizardBody } from './harness/result-page';

/**
 * AXI-2380 (epic AXI-2308 — slice of AXI-2377): the result page header and the numbers' "In words"
 * line. The headline is the SIGNED decision object's question (the wizard record), the tag line is
 * PRE-SPECIFIED / EXPLORATORY plus "Template Tn · analysis version …", a run whose analysed
 * measurement is not among the signed values states the mismatch instead of an answer, and the
 * numbers table carries one server-authored plain-language line (no LLM).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2380 (.2–.5).
 * .2/.3 read real wizard runs end to end. .4/.5 cannot be produced organically through the wizard
 * (it always analyses what it signed, and always signs a record) — they take the REAL served page
 * and change only the one field under test (`questionMismatch` / `signedQuestion`), the same
 * response-routing precedent as AXI-2343/AXI-2376; the server's derivation of both is unit-covered
 * (`UT-RP-2380-01..12`).
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2380-* --project=chromium --no-deps`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const T1_QUESTION = 'Does igg4_g_l differ between F and M?';
const T2_QUESTION = 'Does igg4_g_l differ across the clusters?';
const NUM = '-?[0-9.]+(e-?[0-9]+)?';
const RESULT_PAGE = /\/api\/v1\/projects\/[^/]+\/runs\/[^/]+\/result-page(\?|$)/;
const MISMATCH_STATEMENT =
  'This result analysed age, which is not among the values signed with the question (igg4_g_l, sexe, F, M). It is shown for the record; it does not answer the question as signed.';

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let t1RunId: string;
let t2RunId: string;

const pagePath = (runId: string) => `/projects/${t.projectId}/runs/${runId}`;
const apiPath = (runId: string) => `/api/v1/projects/${t.projectId}/runs/${runId}/result-page`;

async function openPage(page: Page, runId: string): Promise<void> {
  await seedScope(page, t);
  await gotoSettled(page, pagePath(runId));
  await expect(page.getByTestId('rp-header')).toBeVisible({ timeout: 120_000 });
}

/** Serve the run's REAL result page with only `patch` applied (never a hand-built body). */
async function routeServedPage(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.route(RESULT_PAGE, async (route: Route) => {
    const served = await route.fetch();
    const body = await served.json();
    await route.fulfill({ response: served, json: { ...body, ...patch } });
  });
}

test.describe.serial('AXI-2380 result page header — signed question, mismatch guard, numbers in words @SI-066 @SI-017 @SI-048 @SI-002', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u', 'stats.kruskal_wallis', 'stats.dunn_posthoc']);
    await silenceTours(await adminToken());
    t1RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T1', T1_QUESTION, 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'groups', value: ['F', 'M'] }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
    t2RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', T2_QUESTION, 'compare_groups', [
      { slot: 'groupingColumn', value: CLUSTER }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2380 AC-headline AC-tagline — AXI-2380.2 the headline is the signed question; the tag line names the analysis kind, template and analysis version @SI-066 @SI-017 @SI-002', async ({ page }) => {
    // Arrange
    const served = await api.get(apiPath(t1RunId), t.headers);
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    expect(served.body.signedQuestion).toMatchObject({ question: T1_QUESTION, templateId: 'T1' });
    expect(served.body.questionMismatch).toBeNull();
    const ruleVersion = served.body.results[0].evidence.ruleVersion;

    // Act
    await openPage(page, t1RunId);

    // Assert
    await expect(page.getByTestId('rp-question')).toHaveText(T1_QUESTION);
    await expect(page.getByTestId('rp-analysis-kind')).toHaveText('EXPLORATORY');
    await expect(page.getByTestId('rp-tagline-detail')).toHaveText(`Template T1 · analysis version ${ruleVersion}`);
    await expect(page.getByTestId('rp-header')).toHaveAttribute('data-question-mismatch', 'false');
    await expect(page.getByTestId('rp-question-mismatch')).toHaveCount(0);
    await expect(page.getByTestId('rp-no-signed-question')).toHaveCount(0);
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
  });

  test('AXI-2380 AC-in-words — AXI-2380.3 the numbers carry one "In words" line: statistic, degrees of freedom, empty columns @SI-066 @SI-017 @SI-048', async ({ page }) => {
    // Arrange
    const mwu = await api.get(apiPath(t1RunId), t.headers);
    const kw = await api.get(apiPath(t2RunId), t.headers);
    expect(mwu.body.results[0].numbersInWords, JSON.stringify(mwu.body.results[0])).toEqual(expect.any(String));

    // Act
    await openPage(page, t1RunId);

    // Assert — MWU: the statistic, and that a rank test has no degrees of freedom
    const line = page.getByTestId('rp-numbers-in-words');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveText(`In words: ${mwu.body.results[0].numbersInWords}`);
    await expect(line).toContainText(new RegExp(`U = ${NUM} \\(uStatistic, the Mann–Whitney statistic\\) gives p = ${NUM}`));
    await expect(line).toContainText('a rank test like this one has no degrees of freedom');

    // Assert — KW: H on its degrees of freedom
    await openPage(page, t2RunId);
    await expect(page.getByTestId('rp-question')).toHaveText(T2_QUESTION);
    await expect(page.getByTestId('rp-numbers-in-words')).toHaveText(`In words: ${kw.body.results[0].numbersInWords}`);
    await expect(page.getByTestId('rp-numbers-in-words')).toContainText(new RegExp(`H = ${NUM} \\(hStatistic, the Kruskal–Wallis statistic\\) on ${NUM} degrees of freedom`));
  });

  test('AXI-2380 AC-mismatch — AXI-2380.4 an analysed measurement absent from the signed question is stated, and no answer is rendered @SI-066', async ({ page }) => {
    // Arrange
    await routeServedPage(page, { questionMismatch: { analysed: ['age'], statement: MISMATCH_STATEMENT } });

    // Act
    await openPage(page, t1RunId);

    // Assert
    await expect(page.getByTestId('rp-header')).toHaveAttribute('data-question-mismatch', 'true');
    await expect(page.getByTestId('rp-question-mismatch')).toHaveText(MISMATCH_STATEMENT);
    await expect(page.getByTestId('rp-question-mismatch')).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('rp-question')).toHaveText(T1_QUESTION);
    await expect(page.getByTestId('rp-numbers')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('rp-answer')).toHaveCount(0);
  });

  test('AXI-2380 AC-headline — AXI-2380.5 a run with no signed decision object says so, never borrowing the plan question @SI-066', async ({ page }) => {
    // Arrange
    await routeServedPage(page, { signedQuestion: null, questionMismatch: null });

    // Act
    await openPage(page, t1RunId);

    // Assert
    await expect(page.getByTestId('rp-question')).toHaveText('Result');
    await expect(page.getByTestId('rp-no-signed-question')).toHaveText('No signed question is recorded for this run.');
    await expect(page.getByTestId('rp-tagline-detail')).toHaveText(/^Template T1 · analysis version .+$/);
  });
});
