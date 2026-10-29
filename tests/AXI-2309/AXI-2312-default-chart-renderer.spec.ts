import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureAnalysis, carrierRuleId, type Tenant, type Analysis } from '../AXI-1400/harness/seed';
import {
  canonicalRunId,
  ingestFixture,
  pollRecommendedCandidate,
  render,
  resolveResultDatasetId,
  runAndWait,
} from './harness/chart-style';

/**
 * AXI-2312 (epic AXI-2309 — FR12, FR13, FR15, AC5).
 *
 * Scenario doc: manual-e2e/AXI-2309-Platform-Opening-Headless.md, "AXI-2312"
 * section (4.1, 4.2, 5.1).
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

  test('AC5/FR13 — an explicit styleOverrides.highlightedGroup wins over the owner default (§4.2)', async () => {
    const run = await runAndWait(api, t, analysis, datasetId, {
      operationId: 'stats.mann_whitney_u',
      roleBindings: { groupColumn: 'group' },
      pivot: { valueColumns: ['value2'] },
      operationParams: { groupFrom: 'A', groupTo: 'B', styleOverrides: { highlightedGroup: 'B' } },
      carrierRuleId: await carrierRuleId('stats.mann_whitney_u'),
    });
    const canonicalId = canonicalRunId(run);
    const resultDatasetId = await resolveResultDatasetId(api, t, analysis.analysisId, canonicalId);
    const recommended = await pollRecommendedCandidate(api, t, resultDatasetId, analysis.analysisId);
    expect(recommended, 'no recommended-origin spec minted for the overridden mann_whitney_u result').toBeTruthy();

    const rendered = await render(api, t, recommended.id);

    expect(rendered.style?.highlightedGroup, 'explicit styleOverrides.highlightedGroup did not survive to the render response').toBe('B');
    expect(rendered.style?.accentColor, 'the owner accent default should still be present alongside the override').toBeTruthy();
  });

  test('AC5 — a non-group-styled chart (scatter) renders successfully with no group-style fields, never blank (§5.1)', async () => {
    const run = await runAndWait(api, t, analysis, datasetId, {
      operationId: 'stats.correlation',
      roleBindings: { xColumn: 'value', yColumn: 'value2' },
      operationParams: { method: 'pearson' },
      carrierRuleId: await carrierRuleId('stats.correlation'),
    });
    const canonicalId = canonicalRunId(run);
    const resultDatasetId = await resolveResultDatasetId(api, t, analysis.analysisId, canonicalId);
    const recommended = await pollRecommendedCandidate(api, t, resultDatasetId, analysis.analysisId);
    expect(recommended, 'no recommended-origin spec minted for the correlation result (FR12)').toBeTruthy();

    const rendered = await render(api, t, recommended.id);

    // FR12: never blank — the render still succeeds and carries a payload.
    expect(rendered.status).not.toBe('error');
    // FR13/FR15 only act on a chart with a group dimension; a scatter has
    // none, so no group-styling field is fabricated.
    expect(rendered.style?.highlightedGroup).toBeUndefined();
  });
});
