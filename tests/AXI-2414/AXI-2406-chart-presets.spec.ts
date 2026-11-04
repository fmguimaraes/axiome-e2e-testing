import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { compileTemplate, drainGoverned, ingestCsvFixture, submitGoverned } from '../AXI-2308/harness/opening-templates';
import { gotoSettled, seedScope } from '../AXI-2308/harness/new-analysis';
import { launchAndDrain, wizardBody } from '../AXI-2308/harness/result-page';
import { ruleRunIdsOfWorkspace } from '../AXI-2308/harness/chart-style-sidecar';

/**
 * AXI-2406 (epic AXI-2414 — FR55, NFR14, FR30/FR31 amended, AC52, D31): each opening template
 * writes, at compile, chart-instance presets that CITE the run(s) they draw and compute nothing;
 * the wizard launch records them append-only (`chart_instance_presets`); the result page renders
 * the recorded preset — brackets / test badge turned on by the preset and read from the cited
 * runs' own rows — instead of re-deriving a chart.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2406 (.1–.6;
 * .7 is `manual`). Team = the platform admin. Runs go through the wizard's own request
 * (`POST /guided-analysis/wizard-runs`), the one path that records presets; .6 submits a compiled
 * plan straight to the governed engine (no wizard → no preset) to prove the legacy path.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 *
 * Run: `BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2414/AXI-2406-* --project=chromium --no-deps`.
 * Needs a backend with migration `20261104120000_add_chart_instance_presets` applied.
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const MAG4 = 'microbiote_igg4_mag4_27';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const KW = 'stats.kruskal_wallis';
const DUNN = 'stats.dunn_posthoc';
const MW = 'stats.mann_whitney_u';

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let t1RunId: string;
let t2RunId: string;

const T2_PARAMETERS = { groupingColumn: CLUSTER, outcome: 'igg4_g_l' };
const pagePath = (runId: string) => `/projects/${t.projectId}/runs/${runId}`;
const apiPath = (runId: string) => `/api/v1/projects/${t.projectId}/runs/${runId}/result-page`;

async function readPage(runId: string): Promise<any> {
  const served = await api.get(apiPath(runId), t.headers);
  expect(served.status, JSON.stringify(served.body)).toBe(200);
  return served.body;
}

const resultOf = (page: any, operationId: string) => page.results.find((r: any) => r.operationId === operationId);

/** The drawn figure's layout annotation texts and shape count (what Plotly actually rendered). */
async function drawnLayout(page: Page): Promise<{ texts: string[]; shapes: number }> {
  const plot = page.getByTestId('rp-chart').locator('.js-plotly-plot');
  await expect(plot).toBeVisible({ timeout: 30_000 });
  return plot.evaluate((el) => {
    const layout = (el as unknown as { layout?: { annotations?: Array<{ text?: unknown }>; shapes?: unknown[] } }).layout ?? {};
    return { texts: (layout.annotations ?? []).map((a) => String(a.text)), shapes: (layout.shapes ?? []).length };
  });
}

async function openTeamPage(page: Page, runId: string): Promise<void> {
  await seedScope(page, t);
  await gotoSettled(page, pagePath(runId));
  await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
}

test.describe.serial('AXI-2406 template chart presets — cited chart instances @SI-045 @SI-017 @SI-066 @SI-033', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor([MW, KW, DUNN]);
    await silenceTours(await adminToken());
    t2RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', 'Does igg4_g_l differ across the clusters?', 'compare_groups', [
      { slot: 'groupingColumn', value: CLUSTER }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
    t1RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T1', `Does ${MAG4} differ between F and M?`, 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'groups', value: ['F', 'M'] }, { slot: 'outcome', value: MAG4 },
    ]));
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('FR55 D31 — AXI-2406.1 compile writes the presets beside the plan, bound to its own node ids, byte-identical on recompile @SI-045 @SI-002', async () => {
    // Act
    const first = await compileTemplate(api, t, dataset, 'T2', T2_PARAMETERS);
    const second = await compileTemplate(api, t, dataset, 'T2', T2_PARAMETERS);

    // Assert
    expect(first.body.ok, JSON.stringify(first.body)).toBe(true);
    const nodeOf = (operationId: string) => first.body.plan.nodes.find((n: any) => n.operation?.operationId === operationId).id;
    expect(first.body.chartPresets).toEqual([
      {
        presetKey: 'primary',
        panels: [{ facet: null, chartPlanNodeId: nodeOf(KW), citedPlanNodeIds: [nodeOf(KW), nodeOf(DUNN)] }],
        affordances: { pairwiseBrackets: true, testBadge: true },
      },
      {
        presetKey: 'pairwise',
        panels: [{ facet: null, chartPlanNodeId: nodeOf(DUNN), citedPlanNodeIds: [nodeOf(DUNN)] }],
        affordances: { pairwiseBrackets: true, testBadge: false },
      },
    ]);
    expect(second.body.chartPresets).toEqual(first.body.chartPresets);
  });

  test('AC52 FR55 NFR14 — AXI-2406.2 T2: the chart cites the Kruskal–Wallis and Dunn runs; badge and brackets are those runs\' recorded values @SI-017 @SI-066 @SI-013 @SI-033', async ({ page }) => {
    // Arrange
    const served = await readPage(t2RunId);
    const kw = resultOf(served, KW);
    const dunn = resultOf(served, DUNN);

    // Act
    await openTeamPage(page, t2RunId);
    const drawn = await drawnLayout(page);

    // Assert — the server's record
    expect(kw.preset).toMatchObject({
      presetKey: 'primary',
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      panels: [{ facet: null, chartRuleRunId: kw.ruleRunId, citedRuleRunIds: [kw.ruleRunId, dunn.ruleRunId] }],
    });
    expect(kw.preset.annotations.testAnnotation).toEqual({ operationId: KW, testName: 'Kruskal–Wallis', pValue: kw.rows[0].pValue });
    expect(kw.preset.annotations.pairwise).toEqual(
      dunn.rows.map((r: any) => ({ groupA: r.groupA, groupB: r.groupB, pValue: r.pValue, adjustedPValue: r.adjustedPValue })),
    );
    // Assert — what the page drew is exactly that record
    await expect(page.getByTestId('rp-chart-cited-run')).toHaveText([kw.ruleRunId, dunn.ruleRunId]);
    expect(drawn.texts).toContain(`Kruskal–Wallis P=${Number(kw.rows[0].pValue).toFixed(3)}`);
    expect(drawn.shapes).toBe(3 * dunn.rows.length);
  });

  test('AC52 FR55 — AXI-2406.3 one run, two charts: the Dunn tab draws the pairwise preset over the SAME Dunn run, and reading the page re-runs nothing @SI-017 @SI-066 @SI-034', async ({ page }) => {
    // Arrange
    const before = await ruleRunIdsOfWorkspace(api, t);
    const served = await readPage(t2RunId);
    const kw = resultOf(served, KW);
    const dunn = resultOf(served, DUNN);
    await openTeamPage(page, t2RunId);

    // Act
    await page.getByTestId('rp-next').click();

    // Assert
    expect(dunn.preset).toMatchObject({
      presetKey: 'pairwise',
      panels: [{ facet: null, chartRuleRunId: dunn.ruleRunId, citedRuleRunIds: [dunn.ruleRunId] }],
    });
    expect(kw.preset.panels[0].citedRuleRunIds).toContain(dunn.ruleRunId);
    expect(dunn.preset.annotations.testAnnotation).toBeNull();
    await expect(page.getByTestId('rp-chart-citation')).toHaveAttribute('data-preset-key', 'pairwise');
    await expect(page.getByTestId('rp-chart-cited-run')).toHaveText([dunn.ruleRunId]);
    expect((await drawnLayout(page)).shapes).toBe(3 * dunn.rows.length);
    expect((await ruleRunIdsOfWorkspace(api, t)).sort()).toEqual(before.sort());
  });

  test('FR30 FR55 — AXI-2406.4 T1: the preset turns the badge on and no bracket; it cites the Mann–Whitney run @SI-017 @SI-066', async ({ page }) => {
    // Arrange
    const served = await readPage(t1RunId);
    const mw = resultOf(served, MW);

    // Act
    await openTeamPage(page, t1RunId);
    const drawn = await drawnLayout(page);

    // Assert
    expect(mw.preset).toMatchObject({
      presetKey: 'primary',
      panels: [{ facet: null, chartRuleRunId: mw.ruleRunId, citedRuleRunIds: [mw.ruleRunId] }],
      annotations: { linked: true, mismatch: false, pairwise: [], testAnnotation: { operationId: MW, testName: 'Mann–Whitney', pValue: mw.rows[0].pValue } },
    });
    await expect(page.getByTestId('rp-chart-cited-run')).toHaveText([mw.ruleRunId]);
    expect(drawn.texts).toContain(`Mann–Whitney P=${Number(mw.rows[0].pValue).toFixed(3)}`);
    expect(drawn.shapes).toBe(0);
  });

  test('FR31 D31 — AXI-2406.5 the recorded preset never moves: every read serves the same preset id and content hash @SI-017 @SI-013', async () => {
    // Act
    const first = await readPage(t2RunId);
    const second = await readPage(t2RunId);

    // Assert
    const identity = (page: any) => page.results.map((r: any) => r.preset && { id: r.preset.presetId, hash: r.preset.contentHash });
    expect(identity(first)).toEqual(identity(second));
    expect(identity(first).every((p: unknown) => p !== null)).toBe(true);
  });

  test('FR30 — AXI-2406.6 a run not launched by the wizard records no preset and keeps its declared chart, uncited @SI-013 @SI-066', async ({ page }) => {
    // Arrange
    const compiled = await compileTemplate(api, t, dataset, 'T2', T2_PARAMETERS);
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);
    const runId = await submitGoverned(api, t, compiled.body.plan, dataset.datasetId);
    await drainGoverned(api, t, runId);

    // Act
    const served = await readPage(runId);
    await openTeamPage(page, runId);

    // Assert
    expect(served.results.map((r: any) => r.preset)).toEqual(served.results.map(() => null));
    expect(resultOf(served, KW).chart).toMatchObject({ type: 'box_plot' });
    await expect(page.getByTestId('rp-chart-type')).toHaveText('Default chart: box plot');
    await expect(page.getByTestId('rp-chart-citation')).toHaveCount(0);
  });
});
