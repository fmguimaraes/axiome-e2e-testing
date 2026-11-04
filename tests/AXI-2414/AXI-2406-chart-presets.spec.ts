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
import { psql, psqlRows } from '../AXI-1640/harness/seed';

/**
 * AXI-2406 (epic AXI-2414 — FR55, NFR14, FR30/FR31 amended, AC52, D31): each opening template
 * writes, at compile, chart-instance presets that CITE the run(s) they draw and compute nothing;
 * the wizard launch records them append-only (`chart_instance_presets`); the result page renders
 * the recorded preset — brackets / test badge turned on by the preset and read from the cited
 * runs' own rows — instead of re-deriving a chart.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2406 (.1–.8).
 * .5/.7 read and write `chart_instance_presets` through `psql` on the stack's Postgres container
 * (`E2E_PG_CONTAINER`, default `axiome-localhost`). Team = the platform admin. Runs go through the wizard's own request
 * (`POST /guided-analysis/wizard-runs`), the one path that records presets; .6 submits a compiled
 * plan straight to the governed engine (no wizard → no preset) to prove the legacy path.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 *
 * Run: `BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway> E2E_TEST_EMAIL=<platform admin>
 *   npx playwright test tests/AXI-2414/AXI-2406-* --project=chromium` (the `setup` project writes `.auth/`).
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
let directRunId: string;
let directPlan: any;

const t2Parameters = () => ({ datasetId: dataset.datasetId, groupingColumn: CLUSTER, outcome: 'igg4_g_l' });
const T2_QUESTION = 'Does igg4_g_l differ across the clusters?';
const T2_SLOTS = [{ slot: 'groupingColumn', value: CLUSTER }, { slot: 'outcome', value: 'igg4_g_l' }];
const PRESETS = 'organization_svc.chart_instance_presets';
const sqlId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`unsafe id for SQL: ${id}`);
  return `'${id}'`;
};
/** The recorded preset rows of one governed run, as the database holds them (id|key|hash|analysis|declaration). */
const presetRows = (runId: string) =>
  psqlRows(`SELECT id || '|' || preset_key || '|' || content_hash || '|' || view_analysis_id || '|' || declaration::text FROM ${PRESETS} WHERE governed_run_id = ${sqlId(runId)} ORDER BY preset_key`);
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
    t2RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', T2_QUESTION, 'compare_groups', T2_SLOTS));
    t1RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T1', `Does ${MAG4} differ between F and M?`, 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'groups', value: ['F', 'M'] }, { slot: 'outcome', value: MAG4 },
    ]));
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('FR55 D31 — AXI-2406.1 compile writes the presets beside the plan, bound to its own node ids, byte-identical on recompile @SI-045 @SI-002', async () => {
    // Act
    const first = await compileTemplate(api, t, dataset, 'T2', t2Parameters());
    const second = await compileTemplate(api, t, dataset, 'T2', t2Parameters());

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

  test('FR31 D31 — AXI-2406.5 the recorded preset never moves: the database refuses an UPDATE and a DELETE, and the page serves the same id and hash @SI-017 @SI-013', async () => {
    // Arrange
    const before = presetRows(t2RunId);
    const servedBefore = await readPage(t2RunId);
    expect(before).toHaveLength(2);
    const firstId = before[0].split('|')[0];

    // Act
    const updated = psql(`UPDATE ${PRESETS} SET declaration = '{}'::jsonb, content_hash = 'tampered' WHERE id = ${sqlId(firstId)}`);
    const deleted = psql(`DELETE FROM ${PRESETS} WHERE id = ${sqlId(firstId)}`);

    // Assert
    expect(updated).toBe(false);
    expect(deleted).toBe(false);
    expect(presetRows(t2RunId)).toEqual(before);
    const identity = (page: any) => page.results.map((r: any) => r.preset && { id: r.preset.presetId, hash: r.preset.contentHash });
    expect(identity(await readPage(t2RunId))).toEqual(identity(servedBefore));
  });

  test('FR30 — AXI-2406.6 a run not launched by the wizard records no preset and keeps its declared chart, uncited @SI-013 @SI-066', async ({ page }) => {
    // Arrange
    const compiled = await compileTemplate(api, t, dataset, 'T2', t2Parameters());
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);
    directPlan = compiled.body.plan;
    directRunId = await submitGoverned(api, t, directPlan, dataset.datasetId);
    await drainGoverned(api, t, directRunId);

    // Act
    const served = await readPage(directRunId);
    await openTeamPage(page, directRunId);

    // Assert
    expect(presetRows(directRunId)).toEqual([]);
    expect(served.results.map((r: any) => r.preset)).toEqual(served.results.map(() => null));
    expect(resultOf(served, KW).chart).toMatchObject({ type: 'box_plot' });
    await expect(page.getByTestId('rp-chart-type')).toHaveText('Default chart: box plot');
    await expect(page.getByTestId('rp-chart-citation')).toHaveCount(0);
  });

  test('AC52 FR55 — AXI-2406.7 a preset recorded in another analysis than the run it charts is refused: no chart, the reason shown @SI-017 @SI-013', async ({ page }) => {
    // Arrange — no product path writes this row; test setup inserts it (INSERT is all the table admits)
    const foreignAnalysisId = (await readPage(t2RunId)).analysisId as string;
    const ownAnalysisId = (await readPage(directRunId)).analysisId as string;
    expect(foreignAnalysisId && ownAnalysisId && foreignAnalysisId !== ownAnalysisId).toBeTruthy();
    const nodeOf = (operationId: string) => directPlan.nodes.find((n: any) => n.operation?.operationId === operationId).id;
    const declaration = JSON.stringify({
      presetKey: 'primary',
      panels: [{ facet: null, chartPlanNodeId: nodeOf(KW), citedPlanNodeIds: [nodeOf(KW), nodeOf(DUNN)] }],
      affordances: { pairwiseBrackets: true, testBadge: true },
    });
    const inserted = psql(`INSERT INTO ${PRESETS} (id, governed_run_id, view_analysis_id, plan_id, template_id, template_version, preset_key, declaration, content_hash, created_by_user_id)
      VALUES (gen_random_uuid()::text, ${sqlId(directRunId)}, ${sqlId(foreignAnalysisId)}, ${sqlId(directPlan.planId)}, 'T2', 'e2e', 'primary', '${declaration}'::jsonb, 'e2e-foreign', 'e2e-axi-2406')`);
    expect(inserted).toBe(true);

    // Act
    const served = await readPage(directRunId);
    await openTeamPage(page, directRunId);

    // Assert
    const kw = resultOf(served, KW);
    expect(kw).toMatchObject({ chart: null, preset: null });
    expect(kw.chartWithheld).toMatch(/^A chart cites only runs of one analysis; run '.+' belongs to another analysis$/);
    await expect(page.getByTestId('rp-chart-type')).toHaveText(`Chart withheld: ${kw.chartWithheld}`);
    await expect(page.getByTestId('rp-chart')).toHaveCount(0);
  });

  test('AC52 FR55 D31 — AXI-2406.8 re-asking the same question reuses the first launch\'s runs and still draws its cited chart; the first rows never move @SI-017 @SI-013 @SI-066 @SI-045', async ({ page }) => {
    // Arrange
    const firstRows = presetRows(t2RunId);
    const first = await readPage(t2RunId);
    const firstRuleRuns = new Set<string>(first.results.map((r: any) => r.ruleRunId));

    // Act
    const againId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', T2_QUESTION, 'compare_groups', T2_SLOTS));
    const again = await readPage(againId);
    await openTeamPage(page, againId);

    // Assert — D31: new rows for the new run, the first run's rows untouched
    expect(againId).not.toBe(t2RunId);
    expect(presetRows(againId)).toHaveLength(2);
    expect(presetRows(t2RunId)).toEqual(firstRows);
    // Assert — bounce #1: the reused steps cite the FIRST launch's rule runs, and the chart still draws
    const kw = resultOf(again, KW);
    expect(kw.chartWithheld).toBeNull();
    expect(kw.preset).toMatchObject({ presetKey: 'primary' });
    const cited: string[] = kw.preset.panels[0].citedRuleRunIds;
    expect(cited).toHaveLength(2);
    expect(cited.some((id) => firstRuleRuns.has(id)), `cited ${cited} vs first ${[...firstRuleRuns]}`).toBe(true);
    await expect(page.getByTestId('rp-chart-cited-run')).toHaveText(cited);
    await expect(page.getByTestId('rp-chart')).toBeVisible();
  });
});
