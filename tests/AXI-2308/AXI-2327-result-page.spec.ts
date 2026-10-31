import { randomUUID } from 'crypto';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { answered, askQuestion, choose, gotoSettled, seedScope, stubWizardRoutes } from './harness/new-analysis';
import {
  INVESTIGATOR_ROLE_ID,
  REVIEWER_ROLE_ID,
  WIZARD_RUNS,
  addMember,
  expectGroupColours,
  drawnTraces,
  launchAndDrain,
  launchAs,
  person,
  signIn,
  wizardBody,
  type Person,
} from './harness/result-page';

/**
 * AXI-2327 (epic AXI-2308 — FR29, FR30, FR32, FR35, NFR3, AC23, AC25, EC12, EC17, D20 Q10): the
 * result page of one governed run. `GET /projects/:p/runs/:r/result-page` is ONE membership read
 * that serves the answer sentence (deterministic, per template), the operation's declared default
 * chart with the owner's accent/mute defaults, and the collapsed evidence; every result is
 * authorized by the client report's run read, every refusal is the one 404.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2327 (.3–.9).
 * Team = the platform admin (the project's stored storage state); the Investigator (…0105) and the
 * Reviewer (…0101) are throwaway membership-only users signed in through the UI. §.3 drives the
 * wizard's Run in the browser (its suggestion stubbed — no LLM); the other runs use the wizard's
 * own request (`POST /guided-analysis/wizard-runs`), the same server path.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2327-* --project=chromium --no-deps`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const MAG4 = 'microbiote_igg4_mag4_27';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const ACCENT = '#C0392B';
const MUTED = '#B0B0B0';
const SEX_QUESTION = 'Does IgG4 differ by sex?';
const SEX_READ = answered(SEX_QUESTION, 'compare_groups', [
  ['outcome', 'igg4_g_l', 'IgG4'],
  ['groupingColumn', 'sexe', 'by sex'],
]);
const NUM = '-?[0-9.]+(e-?[0-9]+)?';
const NOT_FOUND = 'This result is not available.';

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let investigator: Person;
let reviewer: Person;
let outsider: Person;
let otherProjectId: string;
let t1RunId: string;
let t2RunId: string;
let t3RunId: string;
let t4RunId: string;
let hisRunId: string;

const pagePath = (runId: string, projectId = t.projectId) => `/projects/${projectId}/runs/${runId}`;
const apiPath = (runId: string, projectId = t.projectId) => `/api/v1/projects/${projectId}/runs/${runId}/result-page`;

async function fresh(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

async function openTeamPage(page: Page, runId: string): Promise<void> {
  await seedScope(page, t);
  await gotoSettled(page, pagePath(runId));
  await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
}

test.describe.serial('AXI-2327 result page — answer, charts & navigation, evidence @SI-066 @SI-033 @SI-048 @SI-013 @SI-010 @SI-034', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u', 'stats.kruskal_wallis', 'stats.dunn_posthoc', 'stats.correlation_matrix', 'stats.partial_correlation']);
    await silenceTours(await adminToken());
    investigator = await person('investigator', t.workspaceId);
    reviewer = await person('reviewer', t.workspaceId);
    outsider = await person('outsider', randomUUID());
    await addMember(api, t, investigator, INVESTIGATOR_ROLE_ID);
    await addMember(api, t, reviewer, REVIEWER_ROLE_ID);
    for (const p of [investigator, reviewer]) await silenceTours(p.accessToken);
    const other = await api.post('/api/v1/projects', { name: `E2E AXI-2327 other ${Date.now()}`, workspaceId: t.workspaceId }, t.headers);
    expect(other.status, JSON.stringify(other.body)).toBeLessThan(300);
    otherProjectId = other.body.id;
    t2RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', 'Does igg4_g_l differ across the clusters?', 'compare_groups', [
      { slot: 'groupingColumn', value: CLUSTER }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
    t3RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T3', 'Does igg4_g_l move with MAG4?', 'explore_dataset', [
      { slot: 'x', value: 'igg4_g_l' }, { slot: 'y', value: [MAG4] },
    ]));
    t4RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T4', 'Does MAG4 move with igg4_g_l once age is held fixed?', 'explore_dataset', [
      { slot: 'x', value: MAG4 }, { slot: 'y', value: ['igg4_g_l'] }, { slot: 'adjustFor', value: 'age' },
    ]));
    hisRunId = await launchAs(investigator, api, t, wizardBody(t, dataset, 'T1', `Does ${MAG4} differ between F and M?`, 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'groups', value: ['F', 'M'] }, { slot: 'outcome', value: MAG4 },
    ]));
  });

  test.afterAll(async () => {
    for (const p of [investigator, reviewer]) {
      if (p) await api.ctx.delete(apiUrl(`/api/v1/workspaces/${t.workspaceId}/members/${p.userId}`), { headers: t.headers }).catch(() => undefined);
    }
    for (const p of [investigator, reviewer, outsider]) await p?.api.dispose();
    await api?.ctx.dispose();
  });

  test('AC23 FR29 FR30 NFR3 — AXI-2327.3 Run opens the result page: answer from the persisted row, declared box plot accented, the numbers @SI-066 @SI-033 @SI-048 @SI-002 @SI-016 @SI-017', async ({ page }) => {
    // Arrange — AXI-2352: the suggested intent cites one real (recorded-transport) logged suggestion
    const suggested = await api.post('/api/v1/guided-analysis/intent-prefill/suggest', { projectId: t.projectId, question: SEX_QUESTION, dataset }, t.headers);
    expect(suggested.body, JSON.stringify(suggested.body)).toMatchObject({ status: 'answered', intent: 'compare_groups' });
    await seedScope(page, t);
    await stubWizardRoutes(page, { suggestion: { kind: 'answer', body: { ...SEX_READ, callId: suggested.body.callId } } });
    await gotoSettled(page, `/new-analysis?datasetId=${dataset.datasetId}`);
    await askQuestion(page, SEX_QUESTION);
    await choose(page, 'na-choice-compare_groups');
    // AXI-2361 (D21): the Template step's choice id is the (template, dataset) pair key; this
    // test opens the wizard on exactly one dataset (`?datasetId=`), so T1's pair is that dataset's.
    await choose(page, `na-choice-T1::${dataset.datasetId}`);
    await choose(page, 'na-read-confirm');
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    const launched = page.waitForResponse((r) => r.url().includes(WIZARD_RUNS) && r.request().method() === 'POST');

    // Act
    await choose(page, 'na-run');
    const answer = await (await launched).json();
    t1RunId = answer.runId;

    // Assert
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/projects/${t.projectId}/runs/${t1RunId}$`), { timeout: 30_000 });
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('rp-eyebrow')).toHaveText('Results · exploratory');
    await expect(page.getByTestId('rp-question')).toHaveText(SEX_QUESTION);
    await expect(page.getByTestId('rp-answer')).toHaveText(new RegExp(`^igg4_g_l: F \\(n = 12\\) vs M \\(n = 12\\); Mann–Whitney U = ${NUM}, p = ${NUM}\\.$`));
    const served = await api.get(apiPath(t1RunId), t.headers);
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    const row = served.body.results[0].rows[0];
    await expect(page.getByTestId('rp-answer')).toContainText(`Mann–Whitney U = ${row.uStatistic}`);
    await expect(page.getByTestId('rp-chart-type')).toHaveText('Default chart: box plot');
    await expectGroupColours(page, { F: ACCENT, M: ACCENT });
    await expect(page.getByTestId('chart-type-override-select')).toHaveCount(0);
    await expect(page.getByTestId('rp-numbers')).toContainText('uStatistic');
    await expect(page.getByTestId('rp-numbers')).toContainText('pValue');
    await expect(page.getByTestId('rp-new-analysis')).toBeVisible();
  });

  test('AC25 FR32 — AXI-2327.4 the evidence is collapsed and lists n per group, method, why, parameters, family size, data hash, analysis version, mode @SI-034 @SI-013', async ({ page }) => {
    // Arrange
    await openTeamPage(page, t1RunId);
    const evidence = page.getByTestId('rp-evidence');
    await expect(evidence).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('rp-evidence-method')).toBeHidden();

    // Act
    await evidence.locator('summary').click();

    // Assert
    await expect(page.getByTestId('rp-evidence-n-per-group')).toHaveText('F: 12 · M: 12');
    await expect(page.getByTestId('rp-evidence-method')).toHaveText('Mann-Whitney U test');
    await expect(page.getByTestId('rp-evidence-why-this-method')).toContainText('exactly two of its levels selected');
    await expect(page.getByTestId('rp-evidence-parameters')).toContainText('groupFrom');
    await expect(page.getByTestId('rp-evidence-family-size')).toHaveText('not applicable — this test declares no multiple-testing correction');
    await expect(page.getByTestId('rp-evidence-data-hash')).toHaveText(/^sha256:[0-9a-f]{64} \(version \d+\)$/);
    await expect(page.getByTestId('rp-evidence-analysis-version')).toHaveText(/ v\d+$/);
    await expect(page.getByTestId('rp-evidence-mode')).toHaveText('guided (template T1)');
  });

  test('AC23 AC25 EC17 — AXI-2327.5 T2: two tabs with Previous/Next, its own family size per result, a session-only highlight @SI-066 @SI-033 @SI-048 @SI-013', async ({ page }) => {
    // Arrange
    await openTeamPage(page, t2RunId);
    await expect(page.getByTestId('rp-answer')).toHaveText(new RegExp(`^igg4_g_l across 4 groups \\(n = 24\\): Kruskal–Wallis H = ${NUM}, p = ${NUM}; Dunn pairwise, Holm-adjusted: C1 vs C2: p_adj = ${NUM}; .+\\.$`));
    await expect(page.getByTestId('rp-tab')).toHaveText(['Kruskal-Wallis test', "Dunn's post-hoc test"]);
    await expect(page.getByTestId('rp-prev')).toBeDisabled();
    await page.getByTestId('rp-evidence').locator('summary').click();
    await expect(page.getByTestId('rp-evidence-family-size')).toHaveText('not applicable — this test declares no multiple-testing correction');

    // Act
    await page.getByTestId('rp-next').click();

    // Assert
    await expect(page.getByTestId('rp-tab').nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('rp-next')).toBeDisabled();
    await expect(page.getByTestId('rp-evidence-family-size')).toHaveText(/^\d+ comparisons \(Holm correction within this run\)$/);
    await expectGroupColours(page, { C1: ACCENT, C2: ACCENT, C3: ACCENT, C4: ACCENT });
    await page.getByTestId('rp-highlight-select').selectOption('C3');
    await expectGroupColours(page, { C1: MUTED, C2: MUTED, C3: ACCENT, C4: MUTED });
    await page.getByTestId('rp-highlight-select').selectOption('');
    await expectGroupColours(page, { C1: ACCENT, C2: ACCENT, C3: ACCENT, C4: ACCENT });
    await page.getByTestId('rp-highlight-select').selectOption('C3');
    await page.getByTestId('rp-prev').click();
    await expect(page.getByTestId('rp-tab').nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.reload();
    await expect(page.getByTestId('rp-highlight-select')).toHaveValue('', { timeout: 60_000 });
  });

  test('AC23 FR30 EC12 — AXI-2327.6 T3 renders its annotated heatmap, T4 its chart; neither has a group selector @SI-033 @SI-048', async ({ page }) => {
    // Arrange
    await openTeamPage(page, t3RunId);

    // Act
    const heatmap = await drawnTraces(page);

    // Assert
    await expect(page.getByTestId('rp-answer')).toHaveText(new RegExp(`^igg4_g_l vs ${MAG4} \\(n = 24\\): Spearman ρ = ${NUM}, p = ${NUM}, BH-adjusted p = ${NUM} \\(family of \\d+\\)\\.$`));
    await expect(page.getByTestId('rp-chart-type')).toHaveText('Default chart: heatmap annotated');
    expect(heatmap.map((tr) => tr.type)).toContain('heatmap');
    await expect(page.getByTestId('rp-highlight-select')).toHaveCount(0);
    await openTeamPage(page, t4RunId);
    await expect(page.getByTestId('rp-answer')).toHaveText(new RegExp(`^${MAG4} vs igg4_g_l, adjusted for age \\(n = 24\\): partial Spearman ρ = ${NUM}, p = ${NUM}\\.$`));
    await expect(page.getByTestId('rp-chart')).toBeVisible();
    await expect(page.getByTestId('rp-highlight-select')).toHaveCount(0);
  });

  test('AC23 AC25 Q10 — AXI-2327.7 the Investigator reads the same page on his surface, full width, with no roles or operations call @SI-066 @SI-030 @SI-010 @SI-016 @SI-017', async ({ browser }) => {
    // Arrange
    const page = await fresh(browser);
    const calls: string[] = [];
    page.on('request', (r) => calls.push(new URL(r.url()).pathname));
    await signIn(page, investigator, t, '/investigator');
    const narrow = await page.getByTestId('investigator-main').boundingBox();

    // Act
    await gotoSettled(page, `/investigator${pagePath(hisRunId)}`);

    // Assert
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
    await expect(page.getByTestId('rp-answer')).toHaveText(new RegExp(`^${MAG4}: F \\(n = 12\\) vs M \\(n = 12\\); Mann–Whitney U = ${NUM}, p = ${NUM}\\.$`), { timeout: 120_000 });
    await expectGroupColours(page, { F: ACCENT, M: ACCENT });
    await page.getByTestId('rp-evidence').locator('summary').click();
    await expect(page.getByTestId('rp-evidence-mode')).toHaveText('guided (template T1)');
    const wide = await page.getByTestId('investigator-main').boundingBox();
    expect(wide!.width).toBeGreaterThan(narrow!.width + 100);
    expect(calls.filter((p) => /\/api\/v1\/roles(\/|$)|\/rule-runs\/operations/.test(p))).toEqual([]);
    await page.getByTestId('rp-new-analysis').click();
    await expect(page).toHaveURL(/\/investigator\/new-analysis$/);
    await page.context().close();
  });

  test('AC23 FR35 — AXI-2327.8 the Reviewer opens the page read-only: answer, chart and evidence, no New analysis @SI-010 @SI-066 @SI-016 @SI-017', async ({ browser }) => {
    // Arrange
    const page = await fresh(browser);

    // Act
    await signIn(page, reviewer, t, pagePath(t1RunId));

    // Assert
    await expect(page.getByTestId('rp-answer')).toContainText('Mann–Whitney U =', { timeout: 120_000 });
    await expect(page.getByTestId('rp-chart')).toBeVisible();
    await expect(page.getByTestId('rp-evidence')).toBeVisible();
    await expect(page.getByTestId('rp-new-analysis')).toHaveCount(0);
    const served = await reviewer.api.get(apiUrl(apiPath(t1RunId)));
    expect(served.status()).toBe(200);
    expect((await served.json()).canStartAnalysis).toBe(false);
    await page.context().close();
  });

  test('AC23 NFR1 FR5 — AXI-2327.9 another project, an unknown run and another workspace are the one 404; the browser says not available @SI-010 @SI-013', async ({ page }) => {
    // Arrange
    const reads = [
      await api.get(apiPath(t1RunId, otherProjectId), t.headers),
      await api.get(apiPath(randomUUID()), t.headers),
    ];
    const foreign = await outsider.api.get(apiUrl(apiPath(t1RunId)));

    // Act
    await seedScope(page, t);
    await gotoSettled(page, pagePath(t1RunId, otherProjectId));

    // Assert
    for (const res of reads) {
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.message).toBe('Run not found');
    }
    expect([403, 404]).toContain(foreign.status());
    await expect(page.getByTestId('rp-unavailable')).toHaveText(NOT_FOUND, { timeout: 30_000 });
    await expect(page.getByTestId('rp-chart')).toHaveCount(0);
  });
});
