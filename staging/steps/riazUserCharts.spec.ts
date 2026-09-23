import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CohortFilter } from './riazEvidenceText';
import { USER_CHART_DATASET_FILES, filterKey, sameFilterSet, toBindings, type UserChartPlan } from './riazUserCharts';

test('UT-STAGE-183: toBindings prefixes every column with col_, one binding per role', () => {
  const out = toBindings({ x: 'timepoint', y: 'log2_cpm', color: 'response' });
  assert.deepEqual(out, { x: { column_id: 'col_timepoint' }, y: { column_id: 'col_log2_cpm' }, color: { column_id: 'col_response' } });
});

test('UT-STAGE-184: toBindings on an empty binding map returns an empty object', () => {
  assert.deepEqual(toBindings({}), {});
});

test('UT-STAGE-185: filterKey renders an "in" filter’s list value joined, so two identical lists produce the same key', () => {
  const a = filterKey({ column: 'gene', operator: 'in', value: ['CD8A', 'PRF1'] });
  const b = filterKey({ column: 'gene', operator: 'in', value: ['CD8A', 'PRF1'] });
  assert.equal(a, b);
  assert.equal(a, 'gene in CD8A/PRF1');
});

test('UT-STAGE-186: sameFilterSet is true for the same filters in a different order', () => {
  const a: CohortFilter[] = [{ column: 'gene', operator: 'eq', value: 'PDCD1' }, { column: 'response', operator: 'eq', value: 'R' }];
  const b: CohortFilter[] = [{ column: 'response', operator: 'eq', value: 'R' }, { column: 'gene', operator: 'eq', value: 'PDCD1' }];
  assert.equal(sameFilterSet(a, b), true);
});

test('UT-STAGE-187: sameFilterSet is false when a filter value differs', () => {
  const a: CohortFilter[] = [{ column: 'gene', operator: 'eq', value: 'PDCD1' }];
  const b: CohortFilter[] = [{ column: 'gene', operator: 'eq', value: 'CD8A' }];
  assert.equal(sameFilterSet(a, b), false);
});

test('UT-STAGE-188: sameFilterSet is false when the filter counts differ', () => {
  const a: CohortFilter[] = [{ column: 'gene', operator: 'eq', value: 'PDCD1' }];
  const b: CohortFilter[] = [];
  assert.equal(sameFilterSet(a, b), false);
});

test('UT-STAGE-189: sameFilterSet is true for two equal "in" filters regardless of declaration order elsewhere', () => {
  const a: CohortFilter[] = [{ column: 'gene', operator: 'in', value: ['CD8A', 'PRF1'] }];
  const b: CohortFilter[] = [{ column: 'gene', operator: 'in', value: ['CD8A', 'PRF1'] }];
  assert.equal(sameFilterSet(a, b), true);
});

test('UT-STAGE-190: USER_CHART_DATASET_FILES declares exactly the 4 handles the brief names', () => {
  assert.deepEqual(Object.keys(USER_CHART_DATASET_FILES).sort(), ['DE', 'DE_STRATA', 'PAIRED', 'WIDE']);
});

test('UT-STAGE-191: USER_CHART_DATASET_FILES.WIDE points at the v2 (panel-gene) file, not the AXI-1374 count-matrix', () => {
  assert.equal(USER_CHART_DATASET_FILES.WIDE, 'riaz2017_expression_by_response_timepoint_v2.csv');
});

test('UT-STAGE-192: a UserChartPlan with no `interpretation` is valid — interpretations are optional, not every chart forks a reading', () => {
  const plan: UserChartPlan = { key: 'x', templateId: 'strip_v1', dataset: 'PAIRED', filters: [], bindings: { y: 'log2_cpm' }, title: 'T', reading: 'R' };
  assert.equal(plan.interpretation, undefined);
});
