import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCounters } from './nonZeroCounters';

/** UT-STAGE-121..124 (SI-044) — Capture Spec §2.3/AC13, AXI-1380. */

function metrics(overrides: Partial<{ activeProjectsCount: number; ingestionJobsCount: number; qcJobsCount: number; governanceEventsCount: number }> = {}) {
  return { activeProjectsCount: 1, ingestionJobsCount: 3, qcJobsCount: 3, governanceEventsCount: 5, windowDays: 7, ...overrides };
}

test('UT-STAGE-121: evaluateCounters passes when every counter is non-zero', () => {
  assert.equal(evaluateCounters(metrics()).pass, true);
});

test('UT-STAGE-122: evaluateCounters fails closed when governanceEventsCount is zero (AC13 hard gate)', () => {
  const result = evaluateCounters(metrics({ governanceEventsCount: 0 }));
  assert.equal(result.pass, false);
  assert.match(result.detail, /AC13 violation/);
});

test('UT-STAGE-123: evaluateCounters fails when a non-governance counter is zero', () => {
  const result = evaluateCounters(metrics({ activeProjectsCount: 0 }));
  assert.equal(result.pass, false);
  assert.match(result.detail, /activeProjectsCount/);
});

test('UT-STAGE-124: evaluateCounters reports every zero counter, not just the first', () => {
  const result = evaluateCounters(metrics({ activeProjectsCount: 0, qcJobsCount: 0 }));
  assert.match(result.detail, /activeProjectsCount/);
  assert.match(result.detail, /qcJobsCount/);
});
