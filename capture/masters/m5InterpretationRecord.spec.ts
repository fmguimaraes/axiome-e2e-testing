import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrecondition } from './m5InterpretationRecord';

test('UT-CAP-022 — M5 precondition throws when no approved decision is found', () => {
  assert.throws(() => assertPrecondition(undefined), /status "approved"/);
});

test('UT-CAP-023 — M5 precondition does not throw when an approved decision is found', () => {
  assert.doesNotThrow(() => assertPrecondition({ id: '1', label: 'x', status: 'approved' }));
});
