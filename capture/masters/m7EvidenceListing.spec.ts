import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrecondition } from './m7EvidenceListing';

test('UT-CAP-029 — M7 precondition throws on a count below 6', () => {
  assert.throws(() => assertPrecondition(5), /requires exactly 6/);
});

test('UT-CAP-030 — M7 precondition throws on a count above 6', () => {
  assert.throws(() => assertPrecondition(12), /requires exactly 6/);
});

test('UT-CAP-031 — M7 precondition does not throw on exactly 6', () => {
  assert.doesNotThrow(() => assertPrecondition(6));
});
