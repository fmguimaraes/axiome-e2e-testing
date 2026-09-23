import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertionScore, describeAssertionTable, describeQuestions, describeSection, describeSummaryRows } from './riazDescribeReport';
import { Q12_SENTENCE } from './riazDescribeExpectations';
import type { QuestionTrace } from './runRiazQuestions';

/**
 * UT-E2E-DESC-019..021 — the "Descriptive questions" report section (AXI-1565,
 * epic AXI-1555 FR36). See `staging/steps/UT.md`.
 */

const q12 = {
  id: 'Q12',
  assertions: [
    { name: 'n_groups', expected: '24', actual: '24', ok: true },
    { name: 'recommended chart', expected: 'present', actual: 'absent', ok: false },
  ],
  describe: {
    derivation: 'pandas: groupby gene mean log2_cpm',
    results: [{ citedConnector: 'SUM-RANK-01', nGroups: 24, recommendedChartSpecId: null, sentence: Q12_SENTENCE, binding: { state: 'covered', matchedConnectors: ['SUM-RANK-01'] } }],
  },
} as unknown as QuestionTrace;

const q4 = { id: 'Q4' } as unknown as QuestionTrace;

test('UT-E2E-DESC-019: only the descriptive questions appear in the section, and the score counts assertions', () => {
  assert.deepEqual(describeQuestions([q4, q12]).map((q) => q.id), ['Q12']);
  assert.deepEqual(assertionScore(q12), { passed: 1, total: 2 });
  assert.deepEqual(assertionScore(q4), { passed: 0, total: 0 });
});

test('UT-E2E-DESC-020: a missing recommended chart is reported as ✗ and fails the question score', () => {
  const row = describeSummaryRows([q12])[0];
  assert.ok(row.includes('SUM-RANK-01'));
  assert.ok(row.includes('covered'));
  assert.ok(row.includes('1/2 ✗'));
});

test('UT-E2E-DESC-021: the section carries the rendered sentence, the expected sentence and the derivation', () => {
  const section = describeSection([q12]).join('\n');
  assert.ok(section.includes('## Descriptive questions (Q12–Q21)'));
  assert.ok(section.includes(Q12_SENTENCE));
  assert.ok(describeAssertionTable(q12).join('\n').includes('pandas: groupby gene mean log2_cpm'));
  assert.deepEqual(describeAssertionTable(q4), []);
});
