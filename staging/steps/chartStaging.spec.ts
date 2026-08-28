import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  alreadyStagedChart,
  isChartStageable,
  toCreateBody,
  COUNT_MATRIX_INGESTED,
} from './chartStaging';
import { checkChartTitlesUnique } from '../fixtures/validateFixture';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import type { ChartSpecFixture } from '../fixtures/types';

/**
 * UT-STAGE-030..039 (SI-044) — FR8/FR23/AC6's chart-staging truth guard
 * (charts 5-6 stay withheld while the count matrix isn't ingested, same
 * shape as FR9's threshold guard) and the idempotency check the re-stage
 * loop depends on (NFR1). See `staging/steps/UT.md`.
 */

function deTableChart(title = 'irrelevant for this check'): ChartSpecFixture {
  return { title, templateId: 'histogram_v1', templateVersion: '1.0.0', dataRequirement: 'de_table', bindings: { x: 'pvalue' } };
}

function countMatrixChart(title = 'irrelevant for this check'): ChartSpecFixture {
  return { title, templateId: 'boxplot_v1', templateVersion: '1.0.0', dataRequirement: 'count_matrix', bindings: { y: 'expression', group: 'response' } };
}

test('UT-STAGE-030: a de_table chart is always stageable', () => {
  assert.equal(isChartStageable(deTableChart()), true);
});

test('UT-STAGE-031: a count_matrix chart is withheld while COUNT_MATRIX_INGESTED is false (the default)', () => {
  assert.equal(COUNT_MATRIX_INGESTED, false);
  assert.equal(isChartStageable(countMatrixChart()), false);
});

test('UT-STAGE-032 (AC6): TENANT_FIXTURE declares 6 chart titles (Capture Spec §6.2), but exactly 4 pass the AC5 data-feasibility guard', () => {
  const declared = TENANT_FIXTURE.content.chartSpecs;
  assert.equal(declared.length, 6, 'the fixture holds all 6 chart titles (FR6: words, not a feasibility decision)');
  const stageable = declared.filter(isChartStageable);
  assert.equal(stageable.length, 4, 'charts 5-6 need per-sample expression not present in the ingested DE-table dataset');
  assert.deepEqual(
    declared.filter((c) => !isChartStageable(c)).map((c) => c.dataRequirement),
    ['count_matrix', 'count_matrix'],
  );
});

test('UT-STAGE-033 (NFR1): alreadyStagedChart is true for a matching user-origin title — re-run does not duplicate', () => {
  const spec = deTableChart('Volcano — pre-therapy responders vs non-responders (baseMean ≥ 10)');
  const existing = [{ id: 'x1', title: spec.title, origin: 'user' as const }];
  assert.equal(alreadyStagedChart(existing, spec), true);
});

test('UT-STAGE-034 (NFR1): alreadyStagedChart is false when no title matches — an edited fixture title re-stages', () => {
  const spec = deTableChart('New title');
  const existing = [{ id: 'x1', title: 'Old title', origin: 'user' as const }];
  assert.equal(alreadyStagedChart(existing, spec), false);
});

test('UT-STAGE-035 (AC6): alreadyStagedChart ignores an auto-origin spec with the same title — never mistakes an auto candidate for the user chart it is meant to create', () => {
  const spec = deTableChart('Same title');
  const existing = [{ id: 'x1', title: 'Same title', origin: 'auto' as const }];
  assert.equal(alreadyStagedChart(existing, spec), false);
});

test('UT-STAGE-036: toCreateBody maps the fixture spec onto the candidates POST body, scoped to the analysis', () => {
  const spec: ChartSpecFixture = {
    title: 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1',
    templateId: 'table_preview_v1',
    templateVersion: '1.0.0',
    dataRequirement: 'de_table',
    bindings: {},
    filters: [{ column: 'padj', operator: 'lt', value: 0.05 }],
    combinator: 'AND',
    columnCombinators: { log2FoldChange: 'OR' },
  };
  const body = toCreateBody(spec, 'analysis-123');
  assert.deepEqual(body, {
    templateId: 'table_preview_v1',
    templateVersion: '1.0.0',
    bindings: {},
    params: {},
    filters: [{ column: 'padj', operator: 'lt', value: 0.05 }],
    combinator: 'AND',
    columnCombinators: { log2FoldChange: 'OR' },
    title: 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1',
    viewAnalysisId: 'analysis-123',
  });
});

test('UT-STAGE-037: toCreateBody defaults params/filters to empty rather than undefined (backend Prisma column is not nullable)', () => {
  const spec = deTableChart();
  const body = toCreateBody(spec, 'analysis-123');
  assert.deepEqual(body.params, {});
  assert.deepEqual(body.filters, []);
});

test('UT-STAGE-038 (FR8, Capture Spec §6.2 "no duplicates"): checkChartTitlesUnique passes on the live TENANT_FIXTURE (6 distinct titles)', () => {
  assert.deepEqual(checkChartTitlesUnique(TENANT_FIXTURE), []);
});

test('UT-STAGE-039 (FR8): checkChartTitlesUnique flags a duplicated title', () => {
  const fixture = {
    ...TENANT_FIXTURE,
    content: { ...TENANT_FIXTURE.content, chartSpecs: [deTableChart('Same'), deTableChart('Same')] },
  };
  const violations = checkChartTitlesUnique(fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'FR8');
});
