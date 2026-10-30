import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureAnalysis, carrierRuleId, type Tenant, type Analysis } from '../AXI-1400/harness/seed';
import {
  canonicalRunId,
  createSapVersion,
  ingestFixture,
  pollRecommendedCandidate,
  render,
  resolveResultDatasetId,
  runAndWait,
} from '../AXI-2309/harness/chart-style';
import { ruleRunIdsOfWorkspace, setChartStyle } from './harness/chart-style-sidecar';

/**
 * AXI-2330 (epic AXI-2308 — FR31; AC24/EC16/NFR8; RO13 vs AXI-2312).
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md
 * § "AXI-2330" (AXI-2330.1 .. AXI-2330.4).
 *
 * API-level by design, same reasoning as AXI-2338's harness header: the result
 * page these three controls will eventually sit on (AXI-2327) is a sibling
 * story not yet merged at the time this spec was written, so there is no
 * `page.goto`. This story's own surface is the sidecar write route and its
 * effect on the NEXT render — reusing AXI-2312's ingestion/run/render harness
 * (`../AXI-2309/harness/chart-style`) read-only, and adding only its own
 * `PATCH .../chart-style` wrapper (`./harness/chart-style-sidecar.ts`).
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

let api: Api;
let t: Tenant;
let analysis: Analysis;
let datasetId: string;
let sapVersionId: string;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  datasetId = await ingestFixture(api, t);
  analysis = await ensureAnalysis(api, t, 'AXI-2330 chart style sidecar', datasetId);
  sapVersionId = await createSapVersion(api, t, ['stats.mann_whitney_u']);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

/** A fresh, scenario-distinct mann_whitney result with its own recommended chart. */
async function mintChart(measurementA: string, measurementB: string): Promise<{ runId: string; specId: string }> {
  const run = await runAndWait(api, t, analysis, datasetId, {
    operationId: 'stats.mann_whitney_u',
    roleBindings: { groupColumn: 'group' },
    pivot: { valueColumns: [measurementA, measurementB] },
    operationParams: { groupFrom: 'A', groupTo: 'B' },
    carrierRuleId: await carrierRuleId('stats.mann_whitney_u'),
    sapVersionId,
  });
  const canonicalId = canonicalRunId(run);
  const resultDatasetId = await resolveResultDatasetId(api, t, analysis.analysisId, canonicalId);
  const recommended = await pollRecommendedCandidate(api, t, resultDatasetId, analysis.analysisId);
  expect(recommended, 'no recommended-origin spec minted for the mann_whitney_u result').toBeTruthy();
  return { runId: canonicalId, specId: recommended.id };
}

test.describe('AXI-2330 — chart style controls as a run sidecar (FR31/AC24/EC16/NFR8)', { tag: ['@SI-033', '@SI-017'] }, () => {
  test('AC24 — AXI-2330.1: Paul changes palette/groupOrder/highlightedGroup; the very next render reflects it (who/when recorded)', async () => {
    const { specId } = await mintChart('value', 'value2');

    const before = await render(api, t, specId);
    const chosenGroup = before.style?.highlightedGroup === 'A' ? 'B' : 'A';

    const set = await setChartStyle(api, t, specId, {
      palette: ['#112233', '#445566'],
      groupOrder: ['B', 'A'],
      highlightedGroup: chosenGroup,
    });
    expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);
    expect(set.body).toMatchObject({
      palette: ['#112233', '#445566'],
      groupOrder: ['B', 'A'],
      highlightedGroup: chosenGroup,
    });
    expect(set.body.updatedByUserId, JSON.stringify(set.body)).toBeTruthy();
    expect(set.body.updatedAt, JSON.stringify(set.body)).toBeTruthy();

    const after = await render(api, t, specId);
    expect(after.style?.palette).toEqual(['#112233', '#445566']);
    expect(after.style?.groupOrder).toEqual(['B', 'A']);
    expect(after.style?.highlightedGroup).toBe(chosenGroup);
  });

  test('EC16 — AXI-2330.2: a style change never re-runs, never creates a run row, and the chart keeps its own spec id', async () => {
    const { runId, specId } = await mintChart('value2', 'value3');
    const runsBefore = await ruleRunIdsOfWorkspace(api, t);
    const runBefore = (await api.get(`/api/v1/rule-runs/${runId}`, t.headers)).body;
    expect(runBefore.status).toBe('SUCCEEDED');

    const set = await setChartStyle(api, t, specId, { highlightedGroup: 'B' });
    expect(set.status, JSON.stringify(set.body)).toBeLessThan(300);

    const runsAfter = await ruleRunIdsOfWorkspace(api, t);
    const runAfter = (await api.get(`/api/v1/rule-runs/${runId}`, t.headers)).body;

    // No new run row — the set of run ids before and after is identical.
    expect(new Set(runsAfter)).toEqual(new Set(runsBefore));
    // The producing run itself never re-executed.
    expect(runAfter.status).toBe('SUCCEEDED');
    expect(runAfter.id).toBe(runBefore.id);
    // The chart is still served from the SAME content-addressed spec — no new
    // record version was minted for a cosmetic change.
    const rendered = await render(api, t, specId);
    expect(rendered).toBeTruthy();
  });

  test('NFR8 — AXI-2330.3: exactly three controls exist; a fourth key is refused and never partially applied', async () => {
    const { specId } = await mintChart('value', 'value3');

    const refused = await setChartStyle(api, t, specId, { highlightedGroup: 'A', evilKey: 'x' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('CHART_STYLE_OVERRIDES_INVALID');

    // Nothing from the refused call was applied — a fresh render carries no
    // sidecar-sourced highlightedGroup for this chart yet.
    const rendered = await render(api, t, specId);
    expect(rendered.style?.highlightedGroup).not.toBe('A');
  });

  test('AC24 — AXI-2330.4: a later write REPLACES the sidecar wholesale — omitting a control clears it, never leaves a stale value', async () => {
    const { specId } = await mintChart('value2', 'value');

    const first = await setChartStyle(api, t, specId, { palette: ['#000000'], highlightedGroup: 'B' });
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const renderedFirst = await render(api, t, specId);
    expect(renderedFirst.style?.palette).toEqual(['#000000']);
    expect(renderedFirst.style?.highlightedGroup).toBe('B');

    // Re-set with ONLY highlightedGroup — palette must be cleared back to the
    // owner default, not left at the stale '#000000'.
    const second = await setChartStyle(api, t, specId, { highlightedGroup: 'A' });
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
    expect(second.body.palette).toBeUndefined();

    const renderedSecond = await render(api, t, specId);
    expect(renderedSecond.style?.highlightedGroup).toBe('A');
    expect(renderedSecond.style?.palette).not.toEqual(['#000000']);
  });
});
