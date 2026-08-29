import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrecondition, hasFork } from './m6ProvenanceGraph';

test('UT-CAP-024 — hasFork is true when a node has 2 incoming edges', () => {
  const edges = [{ targetNodeId: 'evidence-1' }, { targetNodeId: 'evidence-1' }, { targetNodeId: 'evidence-2' }];
  assert.equal(hasFork(edges), true);
});

test('UT-CAP-025 — hasFork is false when every node has exactly 1 incoming edge', () => {
  const edges = [{ targetNodeId: 'a' }, { targetNodeId: 'b' }, { targetNodeId: 'c' }];
  assert.equal(hasFork(edges), false);
});

test('UT-CAP-026 — hasFork is false for an empty edge list', () => {
  assert.equal(hasFork([]), false);
});

test('UT-CAP-027 — M6 precondition throws when there is no fork', () => {
  assert.throws(() => assertPrecondition([{ targetNodeId: 'a' }]), /no fork/);
});

test('UT-CAP-028 — M6 precondition does not throw when a fork exists', () => {
  assert.doesNotThrow(() => assertPrecondition([{ targetNodeId: 'a' }, { targetNodeId: 'a' }]));
});
