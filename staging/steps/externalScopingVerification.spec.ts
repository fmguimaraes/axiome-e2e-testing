import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildScopingProbes,
  classifyOutcome,
  evaluateProbe,
  summarizeScoping,
} from './externalScopingVerification';
import type { ScopingProbe, ScopingProbeResult } from './externalScopingVerification';

/**
 * UT-STAGE-090..099 (SI-044) — FR13/AC12/EC5/EC6's external-scoping
 * verification (AXI-1378, Capture Spec §11/§12/§21): the status-code
 * classifier, the probe-vs-expectation evaluator, the probe set shape (2
 * visible + 6 hidden, all hard), and the §21 leak/genuine-scoping
 * determination. See `staging/steps/UT.md`.
 */

test('UT-STAGE-090 (EC6): classifyOutcome treats any 2xx as visible regardless of status within the range', () => {
  assert.equal(classifyOutcome(200), 'visible');
  assert.equal(classifyOutcome(201), 'visible');
  assert.equal(classifyOutcome(204), 'visible');
});

test('UT-STAGE-091: classifyOutcome treats 400/401/403/404 as hidden — the guard denied before data resolution', () => {
  assert.equal(classifyOutcome(400), 'hidden');
  assert.equal(classifyOutcome(401), 'hidden');
  assert.equal(classifyOutcome(403), 'hidden');
  assert.equal(classifyOutcome(404), 'hidden');
});

test('UT-STAGE-092: classifyOutcome treats anything else (5xx) as error, not scoping evidence', () => {
  assert.equal(classifyOutcome(500), 'error');
  assert.equal(classifyOutcome(503), 'error');
});

test('UT-STAGE-093: evaluateProbe marks matchesExpectation true when outcome equals expectation', () => {
  const probe: ScopingProbe = { label: 'x', path: '/y', expectation: 'hidden', hard: true };
  const result = evaluateProbe(probe, 403);
  assert.equal(result.outcome, 'hidden');
  assert.equal(result.matchesExpectation, true);
});

test('UT-STAGE-094 (EC5): evaluateProbe marks matchesExpectation false when an internal surface unexpectedly answers 200', () => {
  const probe: ScopingProbe = { label: 'internal thread', path: '/snapshot-comments', expectation: 'hidden', hard: true };
  const result = evaluateProbe(probe, 200);
  assert.equal(result.outcome, 'visible');
  assert.equal(result.matchesExpectation, false);
});

test('UT-STAGE-095 (FR13): buildScopingProbes returns exactly 2 visible probes (published-artifacts, external thread) and 6 hidden probes, all hard', () => {
  const probes = buildScopingProbes('ws1', 'proj1', 'analysis1');
  const visible = probes.filter((p) => p.expectation === 'visible');
  const hidden = probes.filter((p) => p.expectation === 'hidden');
  assert.equal(visible.length, 2);
  assert.equal(hidden.length, 6);
  assert.ok(probes.every((p) => p.hard));
});

test('UT-STAGE-096: buildScopingProbes targets the real workspace/project/analysis ids, in the path or (for workspace) the X-Workspace-Id header', () => {
  const probes = buildScopingProbes('ws1', 'proj1', 'analysis1');
  const targetsRealId = (p: ScopingProbe) => p.path.includes('proj1') || p.path.includes('analysis1') || p.extraHeaders?.['X-Workspace-Id'] === 'ws1';
  assert.ok(probes.every(targetsRealId));
});

test('UT-STAGE-097: buildScopingProbes attaches an X-Workspace-Id header to every internal (hidden) probe except the deliberate no-header variant', () => {
  const probes = buildScopingProbes('ws1', 'proj1', 'analysis1');
  const hidden = probes.filter((p) => p.expectation === 'hidden');
  const withHeader = hidden.filter((p) => p.extraHeaders?.['X-Workspace-Id'] === 'ws1');
  const withoutHeader = hidden.filter((p) => !p.extraHeaders);
  assert.equal(withHeader.length, 5);
  assert.equal(withoutHeader.length, 1);
});

function ok(probe: ScopingProbe): ScopingProbeResult {
  return evaluateProbe(probe, probe.expectation === 'visible' ? 200 : 403);
}

test('UT-STAGE-098 (§21): summarizeScoping reports genuineScoping=true when every hard probe matches its expectation', () => {
  const probes = buildScopingProbes('ws1', 'proj1', 'analysis1');
  const finding = summarizeScoping(probes.map(ok));
  assert.equal(finding.genuineScoping, true);
  assert.deepEqual(finding.leaks, []);
  assert.deepEqual(finding.blockedFromPublished, []);
});

test('UT-STAGE-099 (EC5): summarizeScoping reports a leak when an internal (hidden) probe comes back visible', () => {
  const probes = buildScopingProbes('ws1', 'proj1', 'analysis1');
  const results = probes.map((p) => (p.label === 'chart-anchored internal comments' ? evaluateProbe(p, 200) : ok(p)));
  const finding = summarizeScoping(results);
  assert.equal(finding.genuineScoping, false);
  assert.equal(finding.leaks.length, 1);
  assert.equal(finding.leaks[0].label, 'chart-anchored internal comments');
});

test('UT-STAGE-100 (FR13): summarizeScoping reports blockedFromPublished when a visible probe comes back hidden', () => {
  const probes = buildScopingProbes('ws1', 'proj1', 'analysis1');
  const results = probes.map((p) => (p.label === 'published-artifacts list' ? evaluateProbe(p, 403) : ok(p)));
  const finding = summarizeScoping(results);
  assert.equal(finding.genuineScoping, false);
  assert.equal(finding.blockedFromPublished.length, 1);
});

test('UT-STAGE-101: summarizeScoping surfaces a 5xx as an error, not silently absorbed into either bucket', () => {
  const probes = buildScopingProbes('ws1', 'proj1', 'analysis1');
  const results = probes.map((p) => (p.label === 'evidence records' ? evaluateProbe(p, 500) : ok(p)));
  const finding = summarizeScoping(results);
  assert.equal(finding.genuineScoping, false);
  assert.equal(finding.errors.length, 1);
  assert.equal(finding.leaks.length, 0);
});
