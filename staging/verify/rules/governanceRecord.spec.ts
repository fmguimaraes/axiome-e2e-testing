import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasForkIn, evaluateGovernanceRecord } from './governanceRecord';

/** UT-STAGE-138..143 (SI-044) — Capture Spec §9/AC11, AXI-1380. */

test('UT-STAGE-138: hasForkIn is false for a straight-line graph (every node in-degree <= 1)', () => {
  const graph = { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [{ targetNodeId: 'b' }, { targetNodeId: 'c' }] };
  assert.equal(hasForkIn(graph), false);
});

test('UT-STAGE-139: hasForkIn is true once some node has 2 incoming edges (a shared evidence citation)', () => {
  const graph = { nodes: [{ id: 'evidence' }, { id: 'd1' }, { id: 'd2' }], edges: [{ targetNodeId: 'evidence' }, { targetNodeId: 'evidence' }] };
  assert.equal(hasForkIn(graph), true);
});

test('UT-STAGE-140: hasForkIn is false on an empty graph', () => {
  assert.equal(hasForkIn({ nodes: [], edges: [] }), false);
});

const GOOD = { evidenceCount: 6, decisionCount: 3, publishedCount: 1, hasFork: true };

test('UT-STAGE-141 (AC11): evaluateGovernanceRecord passes on 3/6/1/fork', () => {
  assert.equal(evaluateGovernanceRecord(GOOD).pass, true);
});

test('UT-STAGE-142 (AC11): evaluateGovernanceRecord fails closed when published != 1', () => {
  const result = evaluateGovernanceRecord({ ...GOOD, publishedCount: 2 });
  assert.equal(result.pass, false);
  assert.match(result.detail, /published=2/);
});

test('UT-STAGE-143 (AC11): evaluateGovernanceRecord reports every violated count, not just the first', () => {
  const result = evaluateGovernanceRecord({ evidenceCount: 5, decisionCount: 2, publishedCount: 0, hasFork: false });
  assert.match(result.detail, /interpretations=2/);
  assert.match(result.detail, /evidence=5/);
  assert.match(result.detail, /published=0/);
  assert.match(result.detail, /no fork/);
});
