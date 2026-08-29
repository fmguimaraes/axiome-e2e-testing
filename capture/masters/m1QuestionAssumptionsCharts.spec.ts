import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrecondition } from './m1QuestionAssumptionsCharts';

test('UT-CAP-012 — M1 precondition throws with zero live user charts', () => {
  assert.throws(() => assertPrecondition(0), /precondition failed/);
});

test('UT-CAP-013 — M1 precondition does not throw with >= 1 live user chart', () => {
  assert.doesNotThrow(() => assertPrecondition(1));
  assert.doesNotThrow(() => assertPrecondition(6));
});
