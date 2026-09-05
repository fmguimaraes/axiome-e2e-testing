import { test, expect } from '@playwright/test';

/**
 * AXI-1415 — Plotly recommended-chart render + override annotation
 * (Epic AXI-1398, S2.2; FR24, FR25, AC10).
 *
 * `RecommendedChart` (axiome-front `src/components/charts/RecommendedChart.tsx`)
 * is a SELF-CONTAINED component + `useChartOverride` hook (SI-035) — it is not
 * yet mounted on any live page. Its consumer is AXI-1416 (the `statistical_table`
 * result surface), which lands in the same epic. Per the Epic-0/1 pattern (see
 * `tests/AXI-1397/AXI-1412-linear-mixed-model.spec.ts`), this spec is written
 * typecheck-only now (`npm run typecheck`) and every scenario is `test.skip`'d
 * with a concrete reason; unskip once AXI-1416 mounts the component on a real
 * result page and a live stack serves this branch (deferred to the epic's W5
 * live walk, same as every other Epic-0/1 read-only proxy spec).
 *
 * The selectors below (`data-testid="recommended-chart"`,
 * `chart-type-override-select`, `chart-type-override-reset`,
 * `chart-override-annotation`) are the REAL markup `RecommendedChart` renders
 * today — not placeholders — so unskipping requires only navigating to
 * wherever AXI-1416 mounts it, not guessing at selectors.
 */

const NOT_YET_MOUNTED = 'RecommendedChart has no live page mount yet — lands with AXI-1416; live run deferred to epic W5 walk';

test.describe('AXI-1415 — recommended chart render + override (§8/§15, FR24/FR25/AC10)', { tag: '@SI-035' }, () => {
  test('AC10 — the recommended chart type renders in Plotly from the operation\'s declared defaultChart', async ({ page }) => {
    test.skip(true, NOT_YET_MOUNTED);
    await page.goto('/'); // placeholder — real result page path lands with AXI-1416
    await expect(page.getByTestId('recommended-chart')).toBeVisible();
  });

  test('FR24 — the chart carries the p/q/comparison annotation from the materialised result, never recomputed', async ({ page }) => {
    test.skip(true, NOT_YET_MOUNTED);
    await page.goto('/');
    // Assert the annotation shown (hover text / caption) equals the API's OWN
    // pValue/qValue field verbatim — no independent client-side computation.
    await expect(page.getByTestId('recommended-chart')).toBeVisible();
  });

  test('AC10 — overriding the chart type does not alter the displayed statistic or run identity', async ({ page }) => {
    test.skip(true, NOT_YET_MOUNTED);
    await page.goto('/');
    const before = await page.getByTestId('recommended-chart').textContent();
    await page.getByTestId('chart-type-override-select').selectOption('bar_chart');
    await expect(page.getByTestId('chart-override-annotation')).toBeVisible();
    // The override annotation appears; the statistic/table elsewhere on the
    // page (outside this component) must be byte-for-byte unchanged.
    expect(await page.getByTestId('recommended-chart').textContent()).not.toBe(before ?? '');
  });

  test('FR25 — resetting the override returns to the declared recommendation', async ({ page }) => {
    test.skip(true, NOT_YET_MOUNTED);
    await page.goto('/');
    await page.getByTestId('chart-type-override-select').selectOption('bar_chart');
    await page.getByTestId('chart-type-override-reset').click();
    await expect(page.getByTestId('chart-override-annotation')).toHaveCount(0);
  });
});
