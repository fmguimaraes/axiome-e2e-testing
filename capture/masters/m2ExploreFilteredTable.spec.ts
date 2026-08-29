import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrecondition } from './m2ExploreFilteredTable';

const FILTERED = 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1';
const SECOND = 'P-value distribution — tested universe';

test('UT-CAP-014 — M2 precondition passes when both chart titles are live', () => {
  assert.doesNotThrow(() => assertPrecondition([FILTERED, SECOND, 'Some other chart']));
});

test('UT-CAP-015 — M2 precondition throws when the filtered-table chart is missing', () => {
  assert.throws(() => assertPrecondition([SECOND]), /filtered-table chart/);
});

test('UT-CAP-016 — M2 precondition throws when the second chart is missing', () => {
  assert.throws(() => assertPrecondition([FILTERED]), /second chart/);
});
