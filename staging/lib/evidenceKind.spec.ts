import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveEvidenceKind } from './evidenceKind';

/**
 * UT-STAGE-176..182 — `deriveEvidenceKind`, the structural (never title-regexed)
 * evidence-kind classification `stage:riaz-publish` sends explicitly, mirroring
 * backend `EVIDENCE_KIND_BY_RUN_KIND`/`deriveEvidenceKind`. See `staging/steps/UT.md`.
 */

test('UT-STAGE-176: a QC run kind classifies as qc_check', () => {
  assert.equal(deriveEvidenceKind({ runKinds: ['QC'], hasChartEntries: false, hasCitationContext: true }), 'qc_check');
});

test('UT-STAGE-177: DELTA/STRATIFY/STATISTICAL/JOIN run kinds all classify as statistical_result', () => {
  for (const runKind of ['DELTA', 'STRATIFY', 'STATISTICAL', 'JOIN']) {
    assert.equal(deriveEvidenceKind({ runKinds: [runKind], hasChartEntries: false, hasCitationContext: true }), 'statistical_result');
  }
});

test('UT-STAGE-178: statistical_result outranks qc_check when both run kinds are cited', () => {
  assert.equal(deriveEvidenceKind({ runKinds: ['QC', 'STATISTICAL'], hasChartEntries: false, hasCitationContext: true }), 'statistical_result');
});

test('UT-STAGE-179: DESCRIBE/LEGACY_AD_HOC contribute no classification of their own — falls through to shape', () => {
  assert.equal(deriveEvidenceKind({ runKinds: ['DESCRIBE'], hasChartEntries: true, hasCitationContext: true }), 'chart');
  assert.equal(deriveEvidenceKind({ runKinds: ['LEGACY_AD_HOC'], hasChartEntries: false, hasCitationContext: true }), 'table');
});

test('UT-STAGE-180: no known run kind, chart entries present — classifies as chart', () => {
  assert.equal(deriveEvidenceKind({ runKinds: [], hasChartEntries: true, hasCitationContext: false }), 'chart');
});

test('UT-STAGE-181: no known run kind, no chart, a citation context — classifies as table', () => {
  assert.equal(deriveEvidenceKind({ runKinds: [], hasChartEntries: false, hasCitationContext: true }), 'table');
});

test('UT-STAGE-182: nothing structural to go on — undefined, never a guessed "note" (server derives)', () => {
  assert.equal(deriveEvidenceKind({ runKinds: [], hasChartEntries: false, hasCitationContext: false }), undefined);
  assert.equal(deriveEvidenceKind({ runKinds: ['SOME_FUTURE_RUN_KIND'], hasChartEntries: false, hasCitationContext: false }), undefined);
});
