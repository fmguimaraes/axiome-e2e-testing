import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrecondition } from './m8StakeholderView';

test('UT-CAP-032 — M8 precondition throws with zero published artifacts', () => {
  assert.throws(() => assertPrecondition(0), /no published artifact/);
});

test('UT-CAP-033 — M8 precondition does not throw with >= 1 published artifact', () => {
  assert.doesNotThrow(() => assertPrecondition(1));
});
