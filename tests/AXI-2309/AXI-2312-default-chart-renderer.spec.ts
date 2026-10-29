import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureAnalysis, carrierRuleId, type Tenant, type Analysis } from '../AXI-1400/harness/seed';
import {
  canonicalRunId,
  ingestFixture,
  pollRecommendedCandidate,
  preflightRun,
  render,
  renderUntilReady,
  resolveResultDatasetId,
  runAndWait,
  submitRun,
  type RunArgs,
} from './harness/chart-style';

/**
 * AXI-2312 (epic AXI-2309 — FR12, FR13, FR15, AC5).
 *
 * Scenario doc: manual-e2e/AXI-2309-Platform-Opening-Headless.md, "AXI-2312"
 * section (4.1, 4.2, 5.1; review bounce #2 adds 4.3 dedup visibility and
 * 4.4 refusal + preflight parity).
 *
 * API-level only — this story's surface is the render response, not a UI
 * component, so there is no `page.goto`. Seeding reuses the AXI-1400 harness
 * (`ensureTenant`/`ensureAnalysis`/`carrierRuleId`) read-only; this story owns
 * only its own fixture CSV (`fixtures/chart-style-default.csv`, two numeric
 * columns `value`/`value2` plus a two-level `group` column) and its own
 * ingestion/polling helpers (`./harness/chart-style.ts`), mirroring
 * `AXI-2031/AXI-2034-correlation-q-values.spec.ts`'s established recipe so it
 * never writes into another story's fixtures directory.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

let api: Api;
let t: Tenant;
let analysis: Analysis;
let datasetId: string;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  datasetId = await ingestFixture(api, t);
  analysis = await ensureAnalysis(api, t, 'AXI-2312 chart style defaults', datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2312 — default-chart renderer & chart-spec defaults (FR12/FR13/FR15, AC5)', { tag: ['@SI-017', '@SI-018'] }, () => {
  test('AC5 — a runnable method mints a recommended chart with the owner style defaults (§4.1)', async () => {
    const run = await runAndWait(api, t, analysis, datasetId, {
      operationId: 'stats.mann_whitney_u',
      roleBindings: { groupColumn: 'group' },
      pivot: { valueColumns: ['value'] },
      operationParams: { groupFrom: 'A', groupTo: 'B' },
      carrierRuleId: await carrierRuleId('stats.mann_whitney_u'),
    });
    const canonicalId = canonicalRunId(run);
    const resultDatasetId = await resolveResultDatasetId(api, t, analysis.analysisId, canonicalId);
    const recommended = await pollRecommendedCandidate(api, t, resultDatasetId, analysis.analysisId);
    expect(recommended, 'no recommended-origin spec minted for the mann_whitney_u result (FR12)').toBeTruthy();

    const rendered = await render(api, t, recommended.id);

    expect(rendered.style, 'render response carries no style — FR13/FR15 default not applied').toBeTruthy();
    expect(typeof rendered.style.accentColor).toBe('string');
    expect(typeof rendered.style.mutedColor).toBe('string');
    expect(Array.isArray(rendered.style.controlLabelPatterns)).toBe(true);
    expect(rendered.style.controlLabelPatterns.length).toBeGreaterThan(0);
  });

  test('AC5/FR13 — an explicit chartStyleOverrides.highlightedGroup wins over the owner default (§4.2)', async () => {
    // AXI-2312 (review bounce #1, B1/B3): the override travels on its OWN
    // top-level field, never inside `operationParams` — `operationParams`
    // is validated against the operation's declared parameter scheme, and
    // no operation declares a `styleOverrides` parameter, so the old
    // shape 400'd on every real submission.
    const run = await runAndWait(api, t, analysis, datasetId, await overriddenRun({ highlightedGroup: 'B' }));
    const canonicalId = canonicalRunId(run);
    const resultDatasetId = await resolveResultDatasetId(api, t, analysis.analysisId, canonicalId);
    const recommended = await pollRecommendedCandidate(api, t, resultDatasetId, analysis.analysisId);
    expect(recommended, 'no recommended-origin spec minted for the overridden mann_whitney_u result').toBeTruthy();

    const rendered = await render(api, t, recommended.id);

    expect(rendered.style?.highlightedGroup, 'explicit styleOverrides.highlightedGroup did not survive to the render response').toBe('B');
    expect(rendered.style?.accentColor, 'the owner accent default should still be present alongside the override').toBeTruthy();
  });

  test('AC5 — a non-group-styled chart (bar count) renders successfully with no group-style fields, never blank (§5.1)', async () => {
    // AXI-2312 (review bounce #1, B3): `stats.correlation`'s own chart
    // declaration is `surfaces: ['result']` ONLY — "The gallery has no pair
    // of real columns to plot" (operation-registry.ts) — so it never mints a
    // `recommended`-origin spec at all, and `pollRecommendedCandidate` below
    // would always return `null` regardless of this story's fix.
    // `describe.count` declares `surfaces: ['result', 'gallery']`, resolves
    // to `bar_chart_v1` (NOT in `GROUP_STYLED_TEMPLATE_IDS`), and is the
    // simplest operation this fixture can drive that actually reaches the
    // gallery — the scenario doc's "e.g. a `volcano_v1`-templated result" is
    // illustrative, not a literal operation requirement (§5.1).
    const run = await runAndWait(api, t, analysis, datasetId, {
      operationId: 'describe.count',
      runKind: 'DESCRIBE',
      roleBindings: { groupColumns: 'group' },
      operationParams: {},
      carrierRuleId: await carrierRuleId('describe.count'),
    });
    const canonicalId = canonicalRunId(run);
    const resultDatasetId = await resolveResultDatasetId(api, t, analysis.analysisId, canonicalId);
    const recommended = await pollRecommendedCandidate(api, t, resultDatasetId, analysis.analysisId);
    expect(recommended, 'no recommended-origin spec minted for the describe.count result (FR12)').toBeTruthy();

    // FR12: never blank — a REAL payload, polled past `rendering` (review
    // bounce #2 advisory: `status !== 'error'` alone also passed for `rendering`).
    const rendered = await renderUntilReady(api, t, recommended.id);
    expect(rendered.payload, 'render reached ready with no payload (FR12: never blank)').toBeTruthy();
    // FR13/FR15 only act on a chart with a group dimension declared in
    // `GROUP_STYLED_TEMPLATE_IDS` (boxplot_v1/paired_slope_v1/km_survival_v1);
    // `bar_chart_v1` is not one of those, so `withChartStyle` returns the
    // spec untouched and `style` is absent entirely — asserted directly
    // (review bounce #1, B3: `rendered.style?.highlightedGroup` being
    // `undefined` also passes when `rendered.style` itself is present with
    // unrelated fields, which masks the actual question).
    expect(rendered.style, 'a non-group-styled template must fabricate no style object').toBeUndefined();
  });

  test('FR13 — resubmitting §4.2 with a DIFFERENT override dedups and says the style was NOT applied, never silently (§4.3)', async () => {
    // Same fingerprint as §4.2 (the override is deliberately not run identity),
    // so this dedups onto §4.2's canonical run — whose chart was minted once,
    // with highlightedGroup 'B'. A palette nobody submits makes the differing
    // style unambiguous whatever else the shared demo DB already holds.
    const differing = await submitRun(api, t, analysis, datasetId, await overriddenRun({ highlightedGroup: 'B', palette: ['#0A1B2C'] }));
    expect(differing.status, JSON.stringify(differing.body)).toBeLessThan(300);
    expect(differing.body.deduped, 'resubmission did not dedup — fingerprint moved with the style override').toBe(true);
    expect(differing.body.chartStyleOverridesApplied).toBe(false);
    expect(differing.body.chartStyleOverridesNotApplied?.code).toBe('CHART_STYLE_NOT_APPLIED_ON_DEDUP');

    // The SAME style as the canonical's resolves equal — applied, no reason.
    const same = await submitRun(api, t, analysis, datasetId, await overriddenRun({ highlightedGroup: 'B' }));
    expect(same.body.deduped).toBe(true);
    expect(same.body.chartStyleOverridesApplied).toBe(true);
    expect(same.body.chartStyleOverridesNotApplied).toBeUndefined();
  });

  test('FR13/NFR — a malformed override is refused 400 by execute and BLOCKed by preflight alike (§4.4)', async () => {
    for (const bad of ['red', { highlightedGroup: 'B', evilKey: 'x' }]) {
      const args = await overriddenRun(bad as never);
      const executed = await submitRun(api, t, analysis, datasetId, args);
      expect(executed.status, JSON.stringify(executed.body)).toBe(400);
      expect(JSON.stringify(executed.body)).toContain('CHART_STYLE_OVERRIDES_INVALID');

      const preflight = await preflightRun(api, t, analysis, datasetId, args);
      expect(preflight.status, JSON.stringify(preflight.body)).toBeLessThan(300);
      expect((preflight.body.blocks ?? []).map((b: any) => b.id)).toContain('CHART_STYLE_OVERRIDES_INVALID:chartStyleOverrides');
    }
  });
});

/** §4.2's exact submission (value2, A vs B), carrying the given chart-style override. */
async function overriddenRun(chartStyleOverrides: Record<string, unknown>): Promise<RunArgs> {
  return {
    operationId: 'stats.mann_whitney_u',
    roleBindings: { groupColumn: 'group' },
    pivot: { valueColumns: ['value2'] },
    operationParams: { groupFrom: 'A', groupTo: 'B' },
    chartStyleOverrides,
    carrierRuleId: await carrierRuleId('stats.mann_whitney_u'),
  };
}
