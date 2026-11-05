import { test, expect, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { gotoSettled, seedScope } from '../AXI-2308/harness/new-analysis';
import { addMember, launchAndDrain, person, REVIEWER_ROLE_ID, signIn, wizardBody, type Person, type Slot } from '../AXI-2308/harness/result-page';
import { psql, psqlRows } from '../AXI-1640/harness/seed';

/**
 * AXI-2412 (epic AXI-2414 — FR56, FR57, AC53, AC54, EC34, EC35, D32): a template preset's chart is
 * one of a CLOSED, ordered list of variants, chosen deterministically over the preset's own
 * measured facts (no LLM); a variant named in the question is honoured only through its span, and
 * one the data rule out is stated as a mismatch. Saving a chart as evidence appends ONE
 * `chart_evidences` row pinning the cited rule runs and the SHA-256 of the drawn-chart document;
 * a later run of the same analysis is FLAGGED, never applied.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2412 (.1–.7; .8 is
 * `manual` — the slide-3 golden needs the real study data, absent from the E2E tenant).
 *
 * The expected choices are derived BY HAND from the fixtures, never by re-running the ranking:
 * - `opening-templates-paul-header.csv` (AXI-2339): 4 clusters × 6; `igg4_g_l` 0.72–3.53 (all
 *   positive, 0.69 orders); `microbiote_igg4_mag4_13` has a negative value.
 * - `axi2412-small-wide-range.csv` (this story): `arm` A/B × 4; `titre` 0.4–420 (3.0 orders).
 *
 * Run: `BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway> E2E_TEST_EMAIL=<platform admin>
 *   npx playwright test tests/AXI-2414/AXI-2412-* --project=chromium`. Needs migration
 * `20261105150000_add_chart_evidences`; .5 reads `chart_evidences` through `psql`
 * (`E2E_PG_CONTAINER`). Never against the shared demo gateway (:3000): saves are append-only.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const SMALL_FIXTURE = 'axi2412-small-wide-range.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const IGG4 = 'igg4_g_l';
const NEGATIVE_OUTCOME = 'microbiote_igg4_mag4_13';
const KW = 'stats.kruskal_wallis';
const DUNN = 'stats.dunn_posthoc';
const MW = 'stats.mann_whitney_u';
const EVIDENCES = 'organization_svc.chart_evidences';

const OMNIBUS_KEYS = [
  'strip_log_brackets', 'strip_linear_brackets', 'strip_log', 'strip_linear',
  'box_log_brackets', 'box_linear_brackets', 'box_log', 'box_linear',
];
const LOG_QUESTION = `Does ${IGG4} differ across the clusters on a log scale?`;
const PLAIN_QUESTION = `Does ${IGG4} differ across the clusters?`;

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let small: AnchoredDataset;
let reviewer: Person;
let plainRunId: string;
let logRunId: string;
let negativeRunId: string;
let neverRunId: string;
let stripRunId: string;
let savedDeterministic: any;

const t2Slots = (outcome: string, posthoc?: string): Slot[] => [
  { slot: 'groupingColumn', value: CLUSTER },
  { slot: 'outcome', value: outcome },
  ...(posthoc ? [{ slot: 'posthoc', value: posthoc }] : []),
];
const pagePath = (runId: string) => `/projects/${t.projectId}/runs/${runId}`;
const apiPath = (runId: string) => `/api/v1/projects/${t.projectId}/runs/${runId}/result-page`;
const evidencePath = (runId: string) => `${apiPath(runId)}/chart-evidence`;
const sqlId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`unsafe id for SQL: ${id}`);
  return `'${id}'`;
};
const evidenceRow = (id: string) =>
  psqlRows(`SELECT id || '|' || artifact_hash || '|' || variant_key || '|' || array_to_string(cited_rule_run_ids, ',') FROM ${EVIDENCES} WHERE id = ${sqlId(id)}`);

async function readPage(runId: string): Promise<any> {
  const served = await api.get(apiPath(runId), t.headers);
  expect(served.status, JSON.stringify(served.body)).toBe(200);
  return served.body;
}

const resultOf = (page: any, operationId: string) => page.results.find((r: any) => r.operationId === operationId);

async function variantsOf(runId: string, operationId: string): Promise<{ result: any; variants: any }> {
  const result = resultOf(await readPage(runId), operationId);
  expect(result?.preset?.variants, JSON.stringify(result?.preset)).toBeTruthy();
  return { result, variants: result.preset.variants };
}

async function save(runId: string, presetId: string, variantKey: string): Promise<{ status: number; body: any }> {
  return api.post(evidencePath(runId), { presetId, variantKey }, t.headers);
}

/** The drawn figure as Plotly holds it: trace shape fields, the y-axis type and the shape count. */
async function drawnFigure(page: Page): Promise<{ traces: Array<Record<string, unknown>>; yType: unknown; shapes: number }> {
  const plot = page.getByTestId('rp-chart').locator('.js-plotly-plot');
  await expect(plot).toBeVisible({ timeout: 30_000 });
  return plot.evaluate((el) => {
    const fig = el as unknown as { data?: Array<Record<string, unknown>>; layout?: { yaxis?: { type?: unknown }; shapes?: unknown[] } };
    const traces = (fig.data ?? []).map((d) => ({ type: d.type, boxpoints: d.boxpoints, fillcolor: d.fillcolor }));
    return { traces, yType: fig.layout?.yaxis?.type, shapes: (fig.layout?.shapes ?? []).length };
  });
}

async function openTeamPage(page: Page, runId: string): Promise<void> {
  await seedScope(page, t);
  await gotoSettled(page, pagePath(runId));
  await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
}

test.describe.serial('AXI-2412 deterministic chart variant + save chart as evidence @SI-045 @SI-068 @SI-017 @SI-015 @SI-010 @SI-066', () => {
  test.beforeAll(async () => {
    test.setTimeout(900_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const anchor = async (filename: string) => {
      const datasetId = await ingestCsvFixture(api, t, filename);
      const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
      if (!anchored) throw new Error(`${filename} could not be anchored`);
      return anchored;
    };
    dataset = await anchor(FIXTURE);
    small = await anchor(SMALL_FIXTURE);
    await approveCarriersFor([MW, KW, DUNN]);
    await silenceTours(await adminToken());
    // The log-question launch compiles the SAME plan as the plain one, so it goes FIRST: the plain
    // run must have no newer run of its plan until AXI-2412.6 launches one (EC35).
    logRunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', LOG_QUESTION, 'compare_groups', t2Slots(IGG4)));
    plainRunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', PLAIN_QUESTION, 'compare_groups', t2Slots(IGG4)));
    negativeRunId = await launchAndDrain(api, t, wizardBody(
      t, dataset, 'T2', `Does ${NEGATIVE_OUTCOME} differ across the clusters on a log scale?`, 'compare_groups', t2Slots(NEGATIVE_OUTCOME),
    ));
    neverRunId = await launchAndDrain(api, t, wizardBody(
      t, dataset, 'T2', `Does ${IGG4} differ across the clusters, shown with brackets?`, 'compare_groups', t2Slots(IGG4, 'never'),
    ));
    stripRunId = await launchAndDrain(api, t, wizardBody(t, small, 'T1', 'Does titre differ between A and B?', 'compare_groups', [
      { slot: 'groupingColumn', value: 'arm' }, { slot: 'groups', value: ['A', 'B'] }, { slot: 'outcome', value: 'titre' },
    ]));
    reviewer = await person('reviewer2412', t.workspaceId);
    await addMember(api, t, reviewer, REVIEWER_ROLE_ID);
  });

  test.afterAll(async () => {
    await reviewer?.api.dispose();
    await api?.ctx.dispose();
  });

  test('AC53 FR56 — AXI-2412.1 the variant is chosen deterministically from the measured facts: box + linear + brackets on the clusters, strip + log on the small wide fixture @SI-045 @SI-017 @SI-066', async ({ page }) => {
    // Arrange
    const first = await variantsOf(plainRunId, KW);
    const again = await variantsOf(plainRunId, KW);
    const strip = await variantsOf(stripRunId, MW);

    // Act
    await openTeamPage(page, stripRunId);
    const drawn = await drawnFigure(page);

    // Assert — T2 clusters: n 6, positive, < 2 orders, Dunn ran
    expect(first.variants.facts).toMatchObject({ minGroupN: 6, outcomeAllPositive: true, postHocPresent: true });
    expect(first.variants.facts.outcomeOrdersOfMagnitude).toBeCloseTo(Math.log10(3.53 / 0.72), 2);
    expect(first.variants.offered.map((v: any) => v.variantKey)).toEqual(OMNIBUS_KEYS);
    expect(first.variants).toMatchObject({ selectedKey: 'box_linear_brackets', provenance: { kind: 'deterministic', rank: 6 }, mismatch: null });
    expect(again.variants).toEqual(first.variants);
    // Assert — T1 small fixture: n 4 (< 5), positive, ~3 orders (>= 2)
    expect(strip.variants.facts).toMatchObject({ minGroupN: 4, outcomeAllPositive: true, postHocPresent: false });
    expect(strip.variants).toMatchObject({ selectedKey: 'strip_log', provenance: { kind: 'deterministic', rank: 1 } });
    // Assert — what the page drew is that variant
    await expect(page.getByTestId('rp-chart')).toHaveAttribute('data-variant-key', 'strip_log');
    await expect(page.getByTestId('rp-variant-provenance')).toHaveText("Chosen from the measured data (variant 1 of the template's list)");
    expect(drawn.yType).toBe('log');
    const boxes = drawn.traces.filter((tr) => tr.type === 'box');
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) expect(box).toMatchObject({ boxpoints: 'all', fillcolor: 'rgba(0,0,0,0)' });
  });

  test('AC53 FR56 — AXI-2412.2 a variant named in the question is selected with its source span; only the named aspect moves @SI-068 @SI-045 @SI-066', async ({ page }) => {
    // Arrange
    const { variants } = await variantsOf(logRunId, KW);
    const start = LOG_QUESTION.indexOf('log scale');

    // Act
    await openTeamPage(page, logRunId);
    const drawn = await drawnFigure(page);

    // Assert
    expect(variants.selectedKey).toBe('box_log_brackets');
    expect(variants.provenance).toEqual({ kind: 'question', rank: 5, spans: [{ start, end: start + 'log scale'.length, text: 'log scale' }] });
    expect(variants.mismatch).toBeNull();
    await expect(page.getByTestId('rp-variant-provenance')).toHaveText('Named in your question: "log scale"');
    expect(drawn.yType).toBe('log');
  });

  test('EC34 FR56 — AXI-2412.3 a named variant the data rule out is not offered: the mismatch is stated and the deterministic variant shown @SI-045 @SI-068 @SI-066', async ({ page }) => {
    // Arrange
    const negative = await variantsOf(negativeRunId, KW);
    const never = await variantsOf(neverRunId, KW);

    // Act
    await openTeamPage(page, negativeRunId);

    // Assert — log over a non-positive outcome
    const offeredKeys: string[] = negative.variants.offered.map((v: any) => v.variantKey);
    expect(offeredKeys.filter((k) => k.includes('_log'))).toEqual([]);
    expect(negative.variants.selectedKey).toBe('box_linear_brackets');
    const statement = 'Your question asks for "log scale", but the outcome has values at or below zero, which a log axis cannot show; '
      + 'showing Box + all points, linear y, pairwise brackets instead.';
    expect(negative.variants.mismatch.statement).toBe(statement);
    await expect(page.getByTestId('rp-variant-mismatch')).toHaveText(statement);
    // Assert — brackets with no post-hoc (posthoc: never)
    expect(never.variants.offered.filter((v: any) => v.pairwiseBrackets)).toEqual([]);
    expect(never.variants.selectedKey).toBe('box_linear');
    expect(never.variants.mismatch.statement).toBe(
      'Your question asks for "brackets", but no pairwise post-hoc comparison was run, so there are no brackets to draw; showing Box + all points, linear y instead.',
    );
  });

  test('FR56 — AXI-2412.4 the variant is preselected and changeable among the offered variants only @SI-066', async ({ page }) => {
    // Arrange
    const { variants } = await variantsOf(plainRunId, KW);
    await openTeamPage(page, plainRunId);
    const select = page.getByTestId('rp-variant-select');
    await expect(select).toHaveValue('box_linear_brackets');
    await expect(select.locator('option')).toHaveText(variants.offered.map((v: any) => v.label));

    // Act
    await select.selectOption('box_linear');

    // Assert
    await expect(page.getByTestId('rp-chart')).toHaveAttribute('data-variant-key', 'box_linear');
    await expect(page.getByTestId('rp-variant-provenance')).toHaveText('Chosen by you from the offered variants');
    const drawn = await drawnFigure(page);
    expect(drawn.shapes).toBe(0);
    expect(drawn.yType).not.toBe('log');
  });

  test('AC54 FR57 NFR8 — AXI-2412.5 saving pins the cited runs and the artifact hash; re-saving reproduces it; the row is append-only @SI-015 @SI-010 @SI-066', async ({ page }) => {
    // Arrange
    const { result } = await variantsOf(plainRunId, KW);
    const dunn = resultOf(await readPage(plainRunId), DUNN);
    const presetId = result.preset.presetId;
    const negative = await variantsOf(negativeRunId, KW);

    // Act
    const first = await save(plainRunId, presetId, 'box_linear_brackets');
    const again = await save(plainRunId, presetId, 'box_linear_brackets');
    const picked = await save(plainRunId, presetId, 'box_linear');
    const unoffered = await save(negativeRunId, negative.result.preset.presetId, 'box_log_brackets');

    // Assert — the saved record
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    savedDeterministic = first.body;
    expect(first.body).toMatchObject({
      runId: plainRunId, presetId, variantKey: 'box_linear_brackets',
      citedRuleRunIds: [result.ruleRunId, dunn.ruleRunId],
      variantProvenance: { kind: 'deterministic', rank: 6 },
      artifactHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      newerRun: null,
    });
    expect(again.status).toBe(201);
    expect({ id: again.body.id, hash: again.body.artifactHash }).toEqual({ id: first.body.id, hash: first.body.artifactHash });
    expect(picked.status).toBe(201);
    expect(picked.body.artifactHash).not.toBe(first.body.artifactHash);
    expect(picked.body.variantProvenance).toEqual({ kind: 'investigator', rank: 8 });
    expect(unoffered.status, JSON.stringify(unoffered.body)).toBe(400);
    // Assert — append-only in the database
    const before = evidenceRow(first.body.id);
    expect(before).toHaveLength(1);
    expect(psql(`UPDATE ${EVIDENCES} SET artifact_hash = 'tampered' WHERE id = ${sqlId(first.body.id)}`)).toBe(false);
    expect(psql(`DELETE FROM ${EVIDENCES} WHERE id = ${sqlId(first.body.id)}`)).toBe(false);
    expect(evidenceRow(first.body.id)).toEqual(before);
    // Assert — the UI save lands in the list with the same hash the server stored
    await openTeamPage(page, plainRunId);
    await page.getByTestId('rp-save-evidence').click();
    const item = page.locator(`[data-testid="rp-saved-evidence-item"][data-evidence-id="${first.body.id}"]`);
    await expect(item).toHaveAttribute('data-artifact-hash', first.body.artifactHash);
    await expect(item.getByTestId('rp-saved-evidence-run')).toHaveText([result.ruleRunId, dunn.ruleRunId]);
    await expect(item.getByTestId('rp-saved-evidence-hash')).toHaveText(`sha256:${first.body.artifactHash.slice(0, 12)}`);
  });

  test('EC35 AC54 NFR8 — AXI-2412.6 a newer run of the same analysis is flagged; the saved evidence never moves @SI-015 @SI-066', async ({ page }) => {
    // Arrange
    expect(savedDeterministic, 'AXI-2412.5 saved the chart').toBeTruthy();

    // Act
    const newerRunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', PLAIN_QUESTION, 'compare_groups', t2Slots(IGG4)));
    const listed = await api.get(evidencePath(plainRunId), t.headers);
    const onNewer = await api.get(evidencePath(newerRunId), t.headers);
    await openTeamPage(page, plainRunId);

    // Assert
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const same = listed.body.find((e: any) => e.id === savedDeterministic.id);
    const { newerRun, ...pinned } = same;
    const { newerRun: _was, ...pinnedBefore } = savedDeterministic;
    expect(pinned).toEqual(pinnedBefore);
    expect(newerRun?.runId).toBe(newerRunId);
    expect(onNewer.body.map((e: any) => e.id)).not.toContain(savedDeterministic.id);
    const item = page.locator(`[data-testid="rp-saved-evidence-item"][data-evidence-id="${savedDeterministic.id}"]`);
    await expect(item.getByTestId('rp-saved-evidence-newer-run')).toHaveText(
      `A newer run of this analysis exists (${newerRunId}). This saved chart still pins its original runs and is unchanged.`,
    );
  });

  test('FR57 FR35 — AXI-2412.7 a Reviewer sees the chart and the saved evidence but cannot save @SI-010 @SI-066', async ({ page }) => {
    // Arrange
    const { result } = await variantsOf(plainRunId, KW);

    // Act
    const refused = await reviewer.api.post(apiUrl(evidencePath(plainRunId)), { data: { presetId: result.preset.presetId, variantKey: 'box_linear' } });
    const listed = await reviewer.api.get(apiUrl(evidencePath(plainRunId)));
    await signIn(page, reviewer, t, pagePath(plainRunId));

    // Assert
    expect(refused.status()).toBe(403);
    expect(listed.status()).toBe(200);
    expect((await listed.json()).map((e: any) => e.id)).toContain(savedDeterministic.id);
    await expect(page.getByTestId('rp-chart')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('rp-variant')).toBeVisible();
    await expect(page.getByTestId('rp-saved-evidence')).toBeVisible();
    await expect(page.getByTestId('rp-save-evidence')).toHaveCount(0);
  });
});
