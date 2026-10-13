import { test, expect, APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-2035 — Individual values on the comparison box plot (epic AXI-2031 —
 * FR11/AC6; manual-e2e `AXI-2031-Non-Parametric-Statistics-Coverage.md`
 * § AXI-2035).
 *
 * Design contract (step c), confirmed against `axiome-front` on
 * `AXI-2035-box-plot-points` (not yet merged to `origin/main`) and
 * `axiome-back` on the same branch:
 *
 *   - `RuleRun.snapshotId` (now served on `GET /rule-runs/:id`) identifies
 *     the run's referent snapshot.
 *   - `GET /view-analyses/snapshots/:id/effective-scope` (new) resolves that
 *     snapshot's `datasetId` + ancestor-composed effective filters.
 *   - `datasetsApi.queryData` (pre-existing, unmodified) reads the raw rows.
 *   - `meltWideRowsToLongSample` (new, pure) turns those wide rows into the
 *     long `{measurement, group, value}` shape the pre-existing
 *     `buildFacetedGroupedBoxplot` renders — one marker per individual
 *     value (`boxpoints: 'all'`), one trace per group, median/IQR computed
 *     by Plotly from the SAME plotted points.
 *   - `RecommendedChart`'s `box_plot` path (`StatisticalTableResult.tsx`'s
 *     mount — the statistical-run result view this story targets) uses this
 *     feed when it resolves, and falls back to today's pre-existing
 *     degenerate (summary-only) rendering whenever it genuinely cannot —
 *     never a fabricated distribution.
 *
 * Scenarios 1/2/4 below need a completed group-comparison run (Kruskal-
 * Wallis / Mann-Whitney / a t-test / ANOVA) with a resolvable referent
 * snapshot and queryable raw dataset rows — the same "real ingested
 * referent with a SUCCEEDED run materialized on it" residue class every
 * other triggered-run scenario in this feature family documents (see
 * `AXI-1416-statistical-table-consumer.spec.ts`'s header) — so they are
 * `test.skip`'d with a concrete reason, against the REAL selectors
 * `RecommendedChart` renders today (`data-testid="recommended-chart"`,
 * confirmed in `src/components/charts/RecommendedChart.tsx`), deferred to
 * the epic's W5 live walk. Scenario 3 (the fallback) is the same shape for
 * the same reason — it needs a run whose raw-sample feed is made to fail.
 *
 * What IS reachable read-only, deterministically, with no dataset or run:
 * the live operation registry's declared `defaultChart` for a `box_plot`
 * operation still carries `roles.facet === 'measurement'`
 * (`COMPARISON_BOX_CHART`, `axiome-back`'s `operation-registry.ts` —
 * untouched by this story) — the contract this story's melt/facet logic is
 * built against. Mirrors the descriptor-liveness pattern
 * `AXI-1416-statistical-table-consumer.spec.ts` already established.
 *
 * AUTHORED, NOT RUN — no stack was started, no browser was used, and no
 * database/bucket was written to for this story (W4 steps c–i only; `npx
 * playwright test` was never invoked). Unit coverage for the melt/data-feed
 * logic this spec exercises end-to-end lives in `axiome-front`'s
 * `src/lib/charts/boxPlotSample.test.ts`,
 * `src/lib/charts/useComparisonBoxPlotRawSample.test.ts`, and the new
 * `UT-FE-GRAPH-1983..1988` cases in `RecommendedChart.test.tsx`.
 *
 * Review gate round 1 (B1, 2026-10-12) added Scenarios 5/6 below:
 *   - Scenario 5: `featureColumn` bound (the shared `UNPAIRED_TTEST.
 *     tableInputScheme`'s optional role) partitions into one panel per
 *     (measurement, feature) pair, sourced from the RESULT rows' own
 *     `feature` values — never the raw dataset's distinct values.
 *   - Scenario 6: a two-group op's `operationParams.groupFrom`/`.groupTo`
 *     restricts the plotted levels to exactly that pair, even when the raw
 *     dataset's group column carries a third level the run never read
 *     (`stats_execution.py#_run_grouped_pairwise`, read-only investigation —
 *     no kernel file touched by this story).
 * Unit coverage for both: `boxPlotSample.test.ts`'s
 * `UT-FE-VIEW-2035-021..032`, `useComparisonBoxPlotRawSample.test.ts`'s
 * `UT-FE-VIEW-2035-033..038`, and `RecommendedChart.test.tsx`'s
 * `UT-FE-GRAPH-1989..1992`.
 *
 * Review gate round 2 (B3/N4, 2026-10-12) added Scenario 7 below:
 *   - Scenario 7: `stats.dunn_posthoc`'s result grain is PAIR (one row per
 *     measurement × feature × pair of groups — `groupA`/`groupB`,
 *     `axiome-back`'s `operation-registry.ts` `DUNN_POSTHOC.outputScheme`,
 *     read-only), sharing the SAME `box_plot`/`roles.facet === 'measurement'`
 *     shape this file's first `describe` block pins. The raw-sample figure's
 *     old `.find()` attached only the first pair's adjusted p-value to the
 *     whole panel; it now renders one labelled caption line per pair beneath
 *     the panel title, in the result rows' own order, with an undefined pair
 *     (all annotation columns null) rendered "not computed" rather than a
 *     number, and NO annotation at all when a multi-row match's pairs cannot
 *     be identified.
 * Unit coverage: `RecommendedChart.test.tsx`'s `UT-FE-GRAPH-1993..1996`
 * (exercising `src/lib/charts/boxPlotRawSampleFigure.ts`'s pair-grain
 * dispatch); N4's float-typed-label guard is `boxPlotSample.test.ts`'s
 * `UT-FE-VIEW-2035-039..041`.
 */

interface OperationDefaultChart {
  type: string;
  roles: Record<string, string>;
  annotation: string[];
}

interface OperationDescriptor {
  operationId: string;
  runKind: string;
  defaultChart: OperationDefaultChart | null;
}

let adminTokens: Promise<{ accessToken: string }> | undefined;

function cachedAdminTokens(): Promise<{ accessToken: string }> {
  if (!adminTokens) {
    adminTokens = (async () => {
      const bootstrap = await apiRequest.newContext();
      const role = ROLES.find((r) => r.name === 'admin');
      if (!role) throw new Error('admin role missing from ROLES registry');
      const tokens = await ensureAuthTokens(bootstrap, role);
      await bootstrap.dispose();
      return { accessToken: tokens.accessToken };
    })().catch((err) => {
      adminTokens = undefined;
      throw err;
    });
  }
  return adminTokens;
}

async function adminApiContext(): Promise<APIRequestContext> {
  const { accessToken } = await cachedAdminTokens();
  return apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

async function fetchOperations(api: APIRequestContext): Promise<OperationDescriptor[]> {
  const res = await api.get(apiUrl('/api/v1/rule-runs/operations'));
  if (!res.ok()) throw new Error(`GET /rule-runs/operations → ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body?.operations ?? body?.data;
  if (!Array.isArray(list)) throw new Error('operations response is not a list');
  return list as OperationDescriptor[];
}

let api: APIRequestContext;
let operations: OperationDescriptor[];

test.beforeAll(async () => {
  api = await adminApiContext();
  operations = await fetchOperations(api);
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('AXI-2035 — comparison box plot declares the facet-by-measurement contract this story builds against', { tag: ['@SI-017'] }, () => {
  test('AC6 — a group-comparison box_plot operation still declares roles.facet === "measurement"', async () => {
    const krusKalWallis = operations.find((op) => op.operationId === 'stats.kruskal_wallis');
    expect(krusKalWallis, 'stats.kruskal_wallis absent from the live operation surface').toBeTruthy();
    expect(krusKalWallis!.defaultChart, 'stats.kruskal_wallis declares no defaultChart').toBeTruthy();
    expect(krusKalWallis!.defaultChart!.type).toBe('box_plot');
    expect(krusKalWallis!.defaultChart!.roles.facet).toBe('measurement');
  });

  // Scoped to the unpaired group-comparison operations the raw-sample feed
  // serves. Other box_plot-charted operations declare their own roles
  // (stats.alpha_diversity uses { group }), and the feed falls back for them.
  const GROUP_COMPARISON_OPERATIONS = [
    'stats.unpaired_ttest',
    'stats.mann_whitney_u',
    'stats.kruskal_wallis',
    'stats.one_way_anova',
    'stats.dunn_posthoc',
  ];

  test('AC6 — every group-comparison operation charts a box_plot faceted by measurement (no per-operation drift)', async () => {
    for (const operationId of GROUP_COMPARISON_OPERATIONS) {
      const op = operations.find((candidate) => candidate.operationId === operationId);
      expect(op, `${operationId} absent from the live operation surface`).toBeTruthy();
      expect(op!.defaultChart?.type, `${operationId} no longer charts a box_plot`).toBe('box_plot');
      expect(op!.defaultChart!.roles.facet, `${operationId} drifted from the shared box_plot roles shape`).toBe('measurement');
    }
  });
});

const NEEDS_LIVE_GROUP_COMPARISON_RUN =
  'needs a completed group-comparison run (Kruskal-Wallis/Mann-Whitney/t-test/ANOVA) with a resolvable snapshot and queryable raw dataset rows — deferred to the epic W5 live walk, same residue class as AXI-1416';

test.describe('AXI-2035 — comparison box plot shows individual values (FR11/AC6)', { tag: ['@SI-033', '@SI-017'] }, () => {
  test('Scenario 1 (AC6) — every individual value renders with the median/IQR box, computed from the same plotted points', async ({ page }) => {
    test.skip(true, NEEDS_LIVE_GROUP_COMPARISON_RUN);
    await page.goto('/'); // placeholder — real statistical-run result view URL, once a live run exists
    const chart = page.getByTestId('recommended-chart');
    await expect(chart).toBeVisible();
    // One <g class="trace boxes"> per group, each with boxpoints 'all' —
    // asserted against the real rendered Plotly SVG once a live run exists.
  });

  test('Scenario 2 (AC6) — group order on the x-axis is stable across repeated opens of the same result', async ({ page }) => {
    test.skip(true, NEEDS_LIVE_GROUP_COMPARISON_RUN);
    await page.goto('/');
    const chart = page.getByTestId('recommended-chart');
    const firstOpen = await chart.textContent();
    await page.reload();
    await expect(chart).toBeVisible();
    expect(await chart.textContent()).toBe(firstOpen);
  });

  test('Scenario 3 (AC6) — raw values unavailable falls back to today\'s summary-only rendering, never a fabricated chart', async ({ page }) => {
    test.skip(true, NEEDS_LIVE_GROUP_COMPARISON_RUN + ' (here: one whose snapshot/dataset deliberately cannot resolve)');
    await page.goto('/');
    const chart = page.getByTestId('recommended-chart');
    await expect(chart).toBeVisible();
    // No error toast/boundary interrupts the rest of the result view.
    await expect(page.getByTestId('recommended-chart-error')).toHaveCount(0);
  });

  test('Scenario 4 (AC6) — multiple measurements facet into separate box-plot panels, each with its own individual values', async ({ page }) => {
    test.skip(true, NEEDS_LIVE_GROUP_COMPARISON_RUN + ' bound to more than one numeric value column');
    await page.goto('/');
    const chart = page.getByTestId('recommended-chart');
    await expect(chart).toBeVisible();
  });

  // Review gate round 1 (B1) — Scenario 5.
  test('Scenario 5 (AC6) — featureColumn bound: one panel per feature, values never pool across features', async ({ page }) => {
    test.skip(true, NEEDS_LIVE_GROUP_COMPARISON_RUN + ' bound with a featureColumn role (long-format: one value column, a measure feature column)');
    await page.goto('/');
    const chart = page.getByTestId('recommended-chart');
    await expect(chart).toBeVisible();
    // Once a live run exists: one panel title per feature value (e.g.
    // CD8A/FOXP3), each panel's boxpoints drawn only from rows whose
    // featureColumn cell matches that panel's feature.
  });

  // Review gate round 1 (B1) — Scenario 6.
  test('Scenario 6 (AC6) — a two-group run on a 3-level group column plots only the compared pair', async ({ page }) => {
    test.skip(true, NEEDS_LIVE_GROUP_COMPARISON_RUN + ' (here: a two-group op whose raw dataset group column carries a third, uncompared level)');
    await page.goto('/');
    const chart = page.getByTestId('recommended-chart');
    await expect(chart).toBeVisible();
    // Once a live run exists: the x-axis/trace names show only groupFrom
    // and groupTo — the third level present in the raw data never renders.
  });

  // Review gate round 2 (B3) — Scenario 7.
  test('Scenario 7 (AC6) — a pair-grain Dunn\'s post-hoc run shows one adjusted-p caption per pair, never only the first pair\'s value', async ({ page }) => {
    test.skip(
      true,
      'needs a completed stats.dunn_posthoc run (three groups, three pairs) with a resolvable snapshot and queryable raw dataset rows — deferred to the epic W5 live walk, same residue class as Scenarios 1-6',
    );
    await page.goto('/');
    const chart = page.getByTestId('recommended-chart');
    await expect(chart).toBeVisible();
    // Once a live run exists: the panel's title annotation is followed by a
    // caption block with one "A vs B: adjustedPValue = …" line per pair, in
    // the result rows' own order — never the first pair's value alone
    // stamped on the whole panel (the pre-round-2 `.find()` defect). A pair
    // whose adjusted p-value could not be computed (an undersized group)
    // reads "not computed", never a number.
  });
});
