import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrecondition } from './m10SubjectDelta';

test('UT-CAP-050 — M10 precondition throws with zero live subject rows', () => {
  assert.throws(() => assertPrecondition(0), /precondition failed/);
});

test('UT-CAP-051 — M10 precondition does not throw with >= 1 live subject row', () => {
  assert.doesNotThrow(() => assertPrecondition(1));
  assert.doesNotThrow(() => assertPrecondition(18));
});
