import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateThresholds, evaluateSnapshots } from './thresholdsSnapshots';

/** UT-STAGE-144..150 (SI-044) — Capture Spec §4/§8/AC10, OQ6, AXI-1380. */

const THRESHOLDS = [
  { id: 't1', label: '|log2FC| >= 1 — published cutoff (external)', status: 'active' },
  { id: 't2', label: 'FDR < 0.05 — prespecified', status: 'active' },
];
const RATIONALE = [{ text: 'rationale text', status: 'active', target: { type: 'threshold' } }];

test('UT-STAGE-144 (Capture Spec §8): evaluateThresholds passes with 2 labeled thresholds and a rationale annotation', () => {
  assert.equal(evaluateThresholds(THRESHOLDS, RATIONALE).ok, true);
});

test('UT-STAGE-145: evaluateThresholds fails closed on fewer than 2 active thresholds', () => {
  const result = evaluateThresholds([THRESHOLDS[0]], RATIONALE);
  assert.equal(result.ok, false);
  assert.match(result.detail, />= 2/);
});

test('UT-STAGE-146: evaluateThresholds fails when a threshold has no provenance label', () => {
  const result = evaluateThresholds([...THRESHOLDS, { id: 't3', label: '', status: 'active' }], RATIONALE);
  assert.equal(result.ok, false);
  assert.match(result.detail, /no provenance label/);
});

test('UT-STAGE-147: evaluateThresholds fails when no threshold rationale annotation exists', () => {
  const result = evaluateThresholds(THRESHOLDS, []);
  assert.equal(result.ok, false);
  assert.match(result.detail, /no threshold rationale/);
});

test('UT-STAGE-148 (AC10): evaluateSnapshots passes when v1/v2 both exist and bind to different datasets', () => {
  const v1 = { id: 's1', version: 1, name: 'Snapshot v1', datasetId: 'de-table' };
  const v2 = { id: 's2', version: 2, name: 'Snapshot v2', datasetId: 'stratified' };
  assert.equal(evaluateSnapshots(v1, v2).ok, true);
});

test('UT-STAGE-149: evaluateSnapshots fails closed when v1 or v2 is missing live', () => {
  const v1 = { id: 's1', version: 1, name: 'Snapshot v1', datasetId: 'de-table' };
  assert.equal(evaluateSnapshots(v1, undefined).ok, false);
  assert.equal(evaluateSnapshots(undefined, v1).ok, false);
});

test('UT-STAGE-150 (OQ6): evaluateSnapshots fails when v2 binds to the SAME dataset as v1 — a same-data label, not a real stratified contrast', () => {
  const v1 = { id: 's1', version: 1, name: 'Snapshot v1', datasetId: 'de-table' };
  const v2 = { id: 's2', version: 2, name: 'Snapshot v2', datasetId: 'de-table' };
  const result = evaluateSnapshots(v1, v2);
  assert.equal(result.ok, false);
  assert.match(result.detail, /OQ6/);
});
