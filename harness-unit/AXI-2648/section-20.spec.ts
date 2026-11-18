import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSection20, type Image1Result, type Image2Result, type Image3Result, type Image4Result } from '../../tests/AXI-2630/harness/section-20';

/**
 * UT-PRESET-2648-016 .. UT-PRESET-2648-025 (epic AXI-2630 — AXI-2648, FR60, AC38; SI-042). Pure
 * coverage of the §20 value/element assertion AXI-2647 calls against each launched question's
 * result. One behaviour per test (AAA). No network.
 */

const IMAGE_1_PASS: Image1Result = {
  byReference: [
    { reference: 'ENT 059', significant: true, adjustedPValue: 0.0217 },
    { reference: 'CER 229', significant: true, adjustedPValue: 0.0378 },
    { reference: 'CER 215 et 234', significant: false, vsHD: 0.437, vsSD: 0.325 },
  ],
  elements: { panelCount: 3, sharedYAxis: true, groupOrder: ['HD', 'IgG4-RD', 'SD'], medianBarPerGroup: true, bracketsAgainstGroup: 'IgG4-RD' },
};

const IMAGE_2_PASS: Image2Result = {
  h: 4.871,
  p: 0.1815,
  elements: { logYAxis: true, pointsOverBoxes: true, groupOrder: ['Cluster 1', 'Cluster 2', 'Cluster 3', 'Cluster 4'], testBadge: true },
};

const IMAGE_3_PASS: Image3Result = {
  u: 77.5,
  p: 0.3705,
  nAbsent: 9,
  nPresent: 14,
  elements: { logYAxis: true, pointsOverBoxes: true, groupOrder: ['Absent', 'Present'], testBadge: true },
};

const IMAGE_4_PASS: Image4Result = {
  totalCells: 42,
  significantCells: 15,
  elements: { annotatedHeatmap: true, starOnSignificantCells: true },
};

test('UT-PRESET-2648-016 image 1 reproducing every §20 reference value and element passes with no problem', () => {
  assert.deepEqual(assertSection20({ image: 1, result: IMAGE_1_PASS }), []);
});

test('UT-PRESET-2648-017 image 1 with a wrong ENT-059 adjusted p is refused by name', () => {
  const result: Image1Result = { ...IMAGE_1_PASS, byReference: [{ reference: 'ENT 059', significant: true, adjustedPValue: 0.05 }] };
  const problems = assertSection20({ image: 1, result });
  assert.ok(problems.some((p) => p.includes('ENT 059') && p.includes('adjusted p')));
});

test('UT-PRESET-2648-018 image 1 missing a reference entirely is refused by name', () => {
  const result: Image1Result = { ...IMAGE_1_PASS, byReference: IMAGE_1_PASS.byReference.filter((r) => r.reference !== 'CER 229') };
  assert.ok(assertSection20({ image: 1, result }).some((p) => p === 'image 1: no result for reference "CER 229"'));
});

test('UT-PRESET-2648-019 image 1 with the wrong panel count is refused on the element', () => {
  const result: Image1Result = { ...IMAGE_1_PASS, elements: { ...IMAGE_1_PASS.elements, panelCount: 7 } };
  assert.ok(assertSection20({ image: 1, result }).some((p) => p.includes('"panelCount"')));
});

test('UT-PRESET-2648-020 image 2 reproducing H, p and every element passes with no problem', () => {
  assert.deepEqual(assertSection20({ image: 2, result: IMAGE_2_PASS }), []);
});

test('UT-PRESET-2648-021 image 2 with a wrong H statistic is refused', () => {
  const result: Image2Result = { ...IMAGE_2_PASS, h: 1 };
  assert.ok(assertSection20({ image: 2, result }).some((p) => p.startsWith('image 2: H')));
});

test('UT-PRESET-2648-022 image 3 reproducing U, p, n and every element passes with no problem', () => {
  assert.deepEqual(assertSection20({ image: 3, result: IMAGE_3_PASS }), []);
});

test('UT-PRESET-2648-023 image 3 with a mismatched group order is refused on the element', () => {
  const result: Image3Result = { ...IMAGE_3_PASS, elements: { ...IMAGE_3_PASS.elements, groupOrder: ['Present', 'Absent'] } };
  assert.ok(assertSection20({ image: 3, result }).some((p) => p.includes('"groupOrder"')));
});

test('UT-PRESET-2648-024 image 4 reproducing the cell counts and elements passes with no problem', () => {
  assert.deepEqual(assertSection20({ image: 4, result: IMAGE_4_PASS }), []);
});

test('UT-PRESET-2648-025 image 4 with the wrong significant-cell count is refused', () => {
  const result: Image4Result = { ...IMAGE_4_PASS, significantCells: 1 };
  assert.ok(assertSection20({ image: 4, result }).some((p) => p.includes('significant cells')));
});
