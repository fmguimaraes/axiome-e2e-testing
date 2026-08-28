import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alreadyStagedRationale, alreadyStagedThreshold, resolveCastDisplayName } from './thresholdStaging';
import { checkThresholdChartsDeclared } from '../fixtures/validateFixture';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import type { ThresholdFixture } from '../fixtures/types';

/**
 * UT-STAGE-050..057 (SI-044) — FR11-adjacent (see `thresholdStaging.ts`'s
 * "NO DEDICATED FR/AC" note), Capture Spec §8's threshold provenance/
 * rationale staging and the idempotency guards each staging loop depends on
 * (NFR1). See `staging/steps/UT.md`.
 */

function threshold(overrides: Partial<ThresholdFixture> = {}): ThresholdFixture {
  return {
    chartTitle: 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1',
    field: 'log2FoldChange',
    operator: '>=',
    value: 1,
    label: '|log2FC| ≥ 1 — published cutoff (external)',
    provenance: 'external',
    rationale: 'irrelevant for this check',
    authorHandle: 'cast-biologist',
    ...overrides,
  };
}

test('UT-STAGE-050 (NFR1): alreadyStagedThreshold matches an active threshold with the same field/operator/value', () => {
  const existing = [{ id: 'th1', field: 'log2FoldChange', operator: '>=', value: 1, status: 'active' }];
  assert.equal(alreadyStagedThreshold(existing, threshold())?.id, 'th1');
});

test('UT-STAGE-051 (NFR1): alreadyStagedThreshold ignores an archived/superseded threshold', () => {
  const existing = [{ id: 'th1', field: 'log2FoldChange', operator: '>=', value: 1, status: 'superseded' }];
  assert.equal(alreadyStagedThreshold(existing, threshold()), undefined);
});

test('UT-STAGE-052 (NFR1): alreadyStagedThreshold is false when the value differs — an edited cutoff re-stages', () => {
  const existing = [{ id: 'th1', field: 'log2FoldChange', operator: '>=', value: 2, status: 'active' }];
  assert.equal(alreadyStagedThreshold(existing, threshold()), undefined);
});

test('UT-STAGE-053 (NFR1): alreadyStagedRationale matches an active threshold-targeted annotation with the same text', () => {
  const existing = [{ id: 'a1', text: 'the rationale', status: 'active', target: { type: 'threshold' as const, thresholdId: 'th1' } }];
  assert.equal(alreadyStagedRationale(existing, 'th1', 'the rationale'), true);
});

test('UT-STAGE-054 (NFR1): alreadyStagedRationale ignores a chart-targeted annotation and a different threshold id', () => {
  const existing = [
    { id: 'a1', text: 'the rationale', status: 'active', target: { type: 'chart' as const } },
    { id: 'a2', text: 'the rationale', status: 'active', target: { type: 'threshold' as const, thresholdId: 'other' } },
  ];
  assert.equal(alreadyStagedRationale(existing, 'th1', 'the rationale'), false);
});

test('UT-STAGE-055: resolveCastDisplayName resolves the fixture cast handle to a real display name (Annotation.author is a label, not an identity claim)', () => {
  assert.equal(resolveCastDisplayName(TENANT_FIXTURE.cast, 'cast-biologist'), 'Marc Ottavi');
});

test('UT-STAGE-056: resolveCastDisplayName throws loudly for an undeclared handle rather than silently defaulting', () => {
  assert.throws(() => resolveCastDisplayName(TENANT_FIXTURE.cast, 'nobody'));
});

test('UT-STAGE-057 (Capture Spec §8): checkThresholdChartsDeclared passes on the live TENANT_FIXTURE — both thresholds target a real chart title', () => {
  assert.deepEqual(checkThresholdChartsDeclared(TENANT_FIXTURE), []);
});

test('UT-STAGE-058: checkThresholdChartsDeclared flags a threshold whose chartTitle matches no declared chart', () => {
  const fixture = {
    ...TENANT_FIXTURE,
    content: { ...TENANT_FIXTURE.content, thresholds: [threshold({ chartTitle: 'No such chart' })] },
  };
  const violations = checkThresholdChartsDeclared(fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'FR6');
});

test('UT-STAGE-059 (Capture Spec §8): TENANT_FIXTURE declares exactly two thresholds, provenance external and prespecified, no third "failed" threshold (OQ2)', () => {
  const declared = TENANT_FIXTURE.content.thresholds;
  assert.equal(declared.length, 2);
  assert.deepEqual(declared.map((t) => t.provenance).sort(), ['external', 'prespecified']);
});
