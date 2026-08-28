import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFailure } from './externalScoping';
import type { ScopingProbeResult } from '../../steps/externalScopingVerification';

/** UT-STAGE-154..156 (SI-044) — Capture Spec §21/AC12/EC5/EC6, AXI-1380. */

function probeResult(label: string): ScopingProbeResult {
  return { label, path: '/x', expectation: 'hidden', hard: true, status: 200, outcome: 'visible', matchesExpectation: false };
}

test('UT-STAGE-154 (EC5): describeFailure names a leaked internal surface', () => {
  const detail = describeFailure([probeResult('internal discussion thread')], [], []);
  assert.match(detail, /LEAK: internal discussion thread/);
});

test('UT-STAGE-155: describeFailure names a surface blocked from a route the stakeholder should reach', () => {
  const detail = describeFailure([], [probeResult('published-artifacts list')], []);
  assert.match(detail, /blocked-from-published: published-artifacts list/);
});

test('UT-STAGE-156: describeFailure combines leaks, blocked and error probes into one message', () => {
  const detail = describeFailure([probeResult('leak')], [probeResult('blocked')], [probeResult('errored')]);
  assert.match(detail, /LEAK: leak/);
  assert.match(detail, /blocked-from-published: blocked/);
  assert.match(detail, /errors: errored/);
});
