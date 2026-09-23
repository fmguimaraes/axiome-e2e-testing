import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateColumnName,
  boundColumns,
  COLUMN_ROLE_PARAMETERS,
  allPassed,
  evaluateDescribeQuestion,
  evaluateDescribeResult,
  nearly,
  pairResults,
  readColumn,
  rowLabel,
  topNLabel,
  type ObservedDescribeResult,
} from './riazDescribeAssertions';
import { DESCRIBE_EXPECTED, Q12_SENTENCE, isDescribeQuestion, type ExpectedDescribeResult } from './riazDescribeExpectations';
import { canonicalFieldsOf, citedConnectorOf, decisionOf, filterText, nGroupsOf, sentenceEvidenceText } from './riazDescribeObserve';

/**
 * UT-E2E-DESC-001..016 — the pure comparison engine behind `stage:riaz-questions`'s
 * Q12–Q21 assertions (AXI-1565, epic AXI-1555 FR35) and the pure readers behind the
 * observations it compares. See `staging/steps/UT.md`.
 */

const Q12 = DESCRIBE_EXPECTED.Q12.results[0];

/** A Q12 observation that satisfies every assertion — each test mutates one thing. */
function observedQ12(overrides: Partial<ObservedDescribeResult> = {}): ObservedDescribeResult {
  const rows = [
    { gene: 'HLA-DRA', n: 27, mean_log2_cpm: 9.7626 },
    { gene: 'STAT1', n: 27, mean_log2_cpm: 8.5016 },
    { gene: 'CXCL9', n: 27, mean_log2_cpm: 6.0093 },
    ...Array.from({ length: 20 }, (_, i) => ({ gene: `G${i}`, n: 27, mean_log2_cpm: 5 - i * 0.1 })),
    { gene: 'IFNG', n: 27, mean_log2_cpm: 1.1382 },
  ];
  return {
    ruleRunId: 'run-1',
    snapshotId: 'snap-1',
    cohort: 'timepoint eq Pre',
    operationId: 'describe.grouped_aggregate',
    citedConnector: 'SUM-RANK-01',
    // The REAL shape: `boundParameters` carries SCALARS only (the backend's
    // `copyConnectorScalars` keeps `enum`/`number` kinds), the column roles
    // arrive as `canonicalFields` (review-gate blocker 1).
    boundParameters: { aggregation: 'mean', direction: 'desc' },
    canonicalFields: [
      { parameter: 'groupColumns', column: 'gene', canonicalField: 'feature_id' },
      { parameter: 'valueColumn', column: 'log2_cpm', canonicalField: 'expression_value' },
    ],
    columns: ['gene', 'n', 'mean_log2_cpm'],
    rows,
    nGroups: 24,
    binding: { state: 'covered', ambiguous: false, matchedConnectors: ['SUM-RANK-01'], unmappedColumns: [], citationStatus: 'confirmed' },
    recommendedChartSpecId: 'spec-1',
    sentence: Q12_SENTENCE,
    decision: { id: 'dec-1', type: 'descriptive_summary', ruleRunId: 'run-1', sentenceText: Q12_SENTENCE, status: 'draft' },
    ...overrides,
  };
}

const namesOfFailures = (rs: ReturnType<typeof evaluateDescribeResult>): string[] => rs.filter((a) => !a.ok).map((a) => a.name);

test('UT-E2E-DESC-001: a fully correct Q12 result passes every assertion', () => {
  const assertions = evaluateDescribeResult(Q12, observedQ12());
  assert.deepEqual(namesOfFailures(assertions), []);
  assert.equal(allPassed(assertions), true);
});

test('UT-E2E-DESC-002: a top value off by more than 0.01 fails, off by less passes', () => {
  const off = observedQ12({ rows: observedQ12().rows.map((r, i) => (i === 0 ? { ...r, mean_log2_cpm: 9.78 } : r)) });
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, off)).includes('top "HLA-DRA" mean_log2_cpm'));
  const within = observedQ12({ rows: observedQ12().rows.map((r, i) => (i === 0 ? { ...r, mean_log2_cpm: 9.7686 } : r)) });
  assert.deepEqual(namesOfFailures(evaluateDescribeResult(Q12, within)), []);
});

test('UT-E2E-DESC-003: a rank whose label moved fails, exactly (no tolerance on ranks)', () => {
  const swapped = observedQ12();
  const rows = [...swapped.rows];
  [rows[1], rows[2]] = [rows[2], rows[1]];
  const failures = namesOfFailures(evaluateDescribeResult(Q12, { ...swapped, rows }));
  assert.ok(failures.includes('rank 2 label'));
  assert.ok(failures.includes('rank 3 label'));
});

test('UT-E2E-DESC-004: a wrong n_groups fails even when every asserted row is right', () => {
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, observedQ12({ nGroups: 23 }))).includes('n_groups'));
});

test('UT-E2E-DESC-005: an indeterminate or ambiguous binding fails — only a narrow match passes', () => {
  const indeterminate = observedQ12({ binding: { state: 'no_match', ambiguous: false, matchedConnectors: [], unmappedColumns: ['prior_ipi'], citationStatus: 'absent' } });
  const failures = namesOfFailures(evaluateDescribeResult(Q12, indeterminate));
  assert.ok(failures.includes('binding state'));
  assert.ok(failures.includes('binding matched connector'));
  assert.ok(failures.includes('binding unmapped columns'));
  const ambiguous = observedQ12({ binding: { state: 'covered', ambiguous: true, matchedConnectors: ['SUM-RANK-01', 'SUM-CROSS-01'], unmappedColumns: [], citationStatus: 'confirmed' } });
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, ambiguous)).includes('binding ambiguous'));
});

test('UT-E2E-DESC-006: a missing recommended chart fails the question — it is never worked around', () => {
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, observedQ12({ recommendedChartSpecId: null }))).includes('recommended chart'));
});

test('UT-E2E-DESC-007: the Q12 sentence is compared byte-for-byte, on the evidence AND on the decision', () => {
  const almost = Q12_SENTENCE.replace('; IFNG the lowest', ', IFNG the lowest');
  const drifted = observedQ12({ sentence: almost, decision: { id: 'd', type: 'descriptive_summary', ruleRunId: 'run-1', sentenceText: almost, status: 'draft' } });
  const failures = namesOfFailures(evaluateDescribeResult(Q12, drifted));
  assert.ok(failures.includes('evidence sentence (exact)'));
  assert.ok(failures.includes('decision sentence (exact)'));
});

test('UT-E2E-DESC-008: a decision of another type, an absent draft, or a sentence that drifted from the evidence fails', () => {
  const wrongType = observedQ12({ decision: { id: 'd', type: 'phenotype_classification', ruleRunId: 'run-1', sentenceText: Q12_SENTENCE, status: 'draft' } });
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, wrongType)).includes('decision type'));
  const missing = observedQ12({ decision: null });
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, missing)).includes('descriptive_summary decision for run run-1'));
  // The draft's sentence against the EVIDENCE's sentence — two records the
  // platform writes independently, so this can actually fail (advisory A1).
  const drifted = observedQ12({ decision: { id: 'd', type: 'descriptive_summary', ruleRunId: 'run-1', sentenceText: 'something else', status: 'draft' } });
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, drifted)).includes('decision sentence === evidence sentence'));
});

test('UT-E2E-DESC-009: an unbound or overridden connector parameter fails, naming the parameter', () => {
  const unbound = observedQ12({ boundParameters: { direction: 'desc' } });
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, unbound)).includes('bound aggregation'));
  const wrongDirection = observedQ12({ boundParameters: { ...observedQ12().boundParameters, direction: 'asc' } });
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, wrongDirection)).includes('bound direction'));
});

test('UT-E2E-DESC-010: EC6 — a Q14 count sentence that says "rows" instead of "patients" fails', () => {
  const q14 = DESCRIBE_EXPECTED.Q14.results[0];
  const rows = [
    { response: 'NR', prior_ipi: 'ipi_naive', n: 9 },
    { response: 'NR', prior_ipi: 'ipi_progressed', n: 9 },
    { response: 'R', prior_ipi: 'ipi_naive', n: 5 },
    { response: 'R', prior_ipi: 'ipi_progressed', n: 4 },
  ];
  const base: ObservedDescribeResult = {
    ...observedQ12(),
    operationId: 'describe.count',
    citedConnector: 'SUM-COUNT-01',
    boundParameters: {},
    canonicalFields: [
      { parameter: 'groupColumns', column: 'response', canonicalField: 'response_status' },
      { parameter: 'groupColumns', column: 'prior_ipi', canonicalField: null },
      { parameter: 'distinctKey', column: 'patient_id', canonicalField: 'subject_id' },
    ],
    rows,
    nGroups: 4,
    binding: { state: 'covered', ambiguous: false, matchedConnectors: ['SUM-COUNT-01'], unmappedColumns: [], citationStatus: 'confirmed' },
    sentence: 'NR/ipi_naive has the most patients (9); R/ipi_progressed the fewest (4). 4 groups counted.',
  };
  const ok = { ...base, decision: { id: 'd', type: 'descriptive_summary', ruleRunId: base.ruleRunId, sentenceText: base.sentence, status: 'draft' } };
  assert.deepEqual(namesOfFailures(evaluateDescribeResult(q14, ok)), []);
  const rowsWord = 'NR/ipi_naive has the most rows (9); R/ipi_progressed the fewest (4). 4 groups counted.';
  const bad = { ...ok, sentence: rowsWord, decision: { ...ok.decision, sentenceText: rowsWord } };
  assert.ok(namesOfFailures(evaluateDescribeResult(q14, bad)).includes('sentence omits "rows"'));
});

test('UT-E2E-DESC-011: a two-branch question pairs each expectation with the branch carrying its filter', () => {
  const up = { ...observedQ12(), cohort: 'padj lt 0.05 & log2FoldChange gt 0', nGroups: 25 };
  const down = { ...observedQ12(), cohort: 'padj lt 0.05 & log2FoldChange lt 0', nGroups: 33 };
  const pairs = pairResults(DESCRIBE_EXPECTED.Q16.results, [down, up]);
  assert.equal(pairs[0].observed?.nGroups, 25);
  assert.equal(pairs[1].observed?.nGroups, 33);
});

test('UT-E2E-DESC-012: a question whose describe run never happened fails with a named assertion', () => {
  const assertions = evaluateDescribeQuestion(DESCRIBE_EXPECTED.Q12, []);
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].ok, false);
  assert.equal(assertions[0].actual, 'no matching describe run');
});

test('UT-E2E-DESC-013: the aggregate column name is derived from the bound parameters, `n` for a count', () => {
  assert.equal(aggregateColumnName({ valueColumn: 'log2_cpm', aggregation: 'mean' }), 'mean_log2_cpm');
  assert.equal(aggregateColumnName({ valueColumn: 'log2_cpm', aggregation: 'std' }), 'std_log2_cpm');
  assert.equal(aggregateColumnName({ groupColumns: ['response'] }), 'n');
});

test('UT-E2E-DESC-014: labels join the bound group columns in order; top_n reads its label column', () => {
  assert.equal(rowLabel({ gene: 'CXCL9', timepoint: 'Pre' }, ['gene', 'timepoint']), 'CXCL9|Pre');
  assert.equal(rowLabel({ gene: 'CXCL9', timepoint: 'Pre' }, ['timepoint', 'gene']), 'Pre|CXCL9');
  assert.equal(topNLabel({ rank: 1, gene: 'VGF', log2FoldChange: 5.24 }, 'log2FoldChange'), 'VGF');
  assert.equal(readColumn({ MEAN_LOG2_CPM: 3 }, 'mean_log2_cpm'), 3);
  assert.equal(nearly(1.14, '1.145'), true);
  assert.equal(nearly(1.14, null), false);
});

test('UT-E2E-DESC-015: the observation readers read the cited code, n_groups and the run-linked draft', () => {
  assert.equal(citedConnectorOf({ id: 'n2', nodeType: 'describe', params: {}, operation: { ruleCode: 'SUM-RANK-01' }, stepLabel: '' }), 'SUM-RANK-01');
  assert.equal(citedConnectorOf({ id: 'n2', nodeType: 'describe', params: { ruleCode: 'SUM-COUNT-01' }, operation: null, stepLabel: '' }), 'SUM-COUNT-01');
  assert.equal(citedConnectorOf(undefined), null);
  assert.equal(nGroupsOf({ nGroups: 24 }, { metrics: { n_groups: 99 } }), 24);
  assert.equal(nGroupsOf(null, { metrics: { n_groups: 48 } }), 48);
  assert.equal(nGroupsOf(null, {}), null);
  assert.equal(filterText([{ column: 'timepoint', operator: 'eq', value: 'Pre' }]), 'timepoint eq Pre');
  assert.equal(decisionOf([{ id: 'd', type: 'descriptive_summary', context: { ruleRunId: 'r1', resultSentence: { text: 'S' } } }], 'r1')?.sentenceText, 'S');
  assert.equal(decisionOf([{ id: 'd', context: { ruleRunId: 'other' } }], 'r1'), null);
});

test('UT-E2E-DESC-016: every descriptive question declares a derivation and four distinct connectors are covered', () => {
  const ids = Object.keys(DESCRIBE_EXPECTED);
  assert.equal(ids.length, 10);
  ids.forEach((id) => assert.ok(isDescribeQuestion(id) && DESCRIBE_EXPECTED[id].derivation.length > 20, id));
  const connectors = new Set(ids.flatMap((id) => DESCRIBE_EXPECTED[id].results.map((r: ExpectedDescribeResult) => r.connector)));
  assert.deepEqual([...connectors].sort(), ['SUM-COUNT-01', 'SUM-CROSS-01', 'SUM-RANK-01', 'SUM-TOPN-01']);
});

test('UT-E2E-DESC-030: column roles are asserted from canonicalFields, in bound order — never from boundParameters', () => {
  // The misconception this test exists to prevent: a run that bound `gene` and
  // `log2_cpm` perfectly reports NEITHER in `boundParameters` (scalars only),
  // so reading them there would fail a correct platform on all ten questions.
  assert.deepEqual([...COLUMN_ROLE_PARAMETERS].sort(), ['distinctKey', 'groupColumns', 'sortColumn', 'valueColumn']);
  const correct = observedQ12({ boundParameters: { aggregation: 'mean', direction: 'desc' } });
  assert.deepEqual(namesOfFailures(evaluateDescribeResult(Q12, correct)), []);

  const roleMissing = observedQ12({ canonicalFields: [{ parameter: 'valueColumn', column: 'log2_cpm', canonicalField: null }] });
  assert.ok(namesOfFailures(evaluateDescribeResult(Q12, roleMissing)).includes('bound groupColumns'));

  const q13 = DESCRIBE_EXPECTED.Q13.results[0];
  const swapped = [
    { parameter: 'groupColumns', column: 'timepoint', canonicalField: null },
    { parameter: 'groupColumns', column: 'gene', canonicalField: null },
    { parameter: 'valueColumn', column: 'log2_cpm', canonicalField: null },
  ];
  assert.deepEqual(boundColumns(swapped, 'groupColumns'), ['timepoint', 'gene'], 'order is preserved as bound');
  const crossed = observedQ12({ operationId: q13.operationId, canonicalFields: swapped });
  assert.ok(namesOfFailures(evaluateDescribeResult(q13, crossed)).includes('bound groupColumns'), 'group columns bound in the wrong order fail');
});

test('UT-E2E-DESC-031: Q15 asserts one group and ten rows — describe.top_n reports n_groups 1 — and reads its label column by name', () => {
  const q15 = DESCRIBE_EXPECTED.Q15.results[0];
  assert.equal(q15.nGroups, 1);
  assert.equal(q15.rowCount, 10);
  assert.equal(q15.labelColumn, 'gene');
  const rows = [
    { gene: 'C20orf166-AS1', log2FoldChange: 13.9224, padj: 0.0000001, rank: 1 },
    { gene: 'LINC00890', log2FoldChange: 9.2489, padj: 0.0000002, rank: 2 },
    { gene: 'FCAMR', log2FoldChange: 5.6966, padj: 0.0137, rank: 3 },
    { gene: 'VGF', log2FoldChange: 5.2405, padj: 0.0001, rank: 4 },
    ...Array.from({ length: 5 }, (_, i) => ({ gene: `G${i}`, log2FoldChange: 4 - i * 0.1, padj: 0.01, rank: 5 + i })),
    { gene: 'PRG4', log2FoldChange: 3.2953, padj: 0.0499, rank: 10 },
  ];
  const obs = observedQ12({
    operationId: 'describe.top_n',
    citedConnector: 'SUM-TOPN-01',
    cohort: 'padj lt 0.05',
    nGroups: 1,
    rows,
    boundParameters: { direction: 'desc', n: 10 },
    canonicalFields: [{ parameter: 'sortColumn', column: 'log2FoldChange', canonicalField: null }],
    binding: { state: 'covered', ambiguous: false, matchedConnectors: ['SUM-TOPN-01'], unmappedColumns: [], citationStatus: 'confirmed' },
    sentence: 'Top 10 rows by log2FoldChange.',
    decision: { id: 'd', type: 'descriptive_summary', ruleRunId: 'run-1', sentenceText: 'Top 10 rows by log2FoldChange.', status: 'draft' },
  });
  assert.deepEqual(namesOfFailures(evaluateDescribeResult(q15, obs)), []);
  // A ten-group expectation would have failed a correct platform.
  assert.ok(namesOfFailures(evaluateDescribeResult({ ...q15, nGroups: 10 }, obs)).includes('n_groups'));
});

test('UT-E2E-DESC-032: the observers read the column roles and the evidence sentence off the shapes the API returns', () => {
  assert.deepEqual(
    canonicalFieldsOf({ canonicalFields: [{ parameter: 'groupColumns', column: 'gene' }, { column: 'orphan' }, { parameter: 'valueColumn', column: 'log2_cpm', canonicalField: 'expression_value' }] }),
    [
      { parameter: 'groupColumns', column: 'gene', canonicalField: null },
      { parameter: 'valueColumn', column: 'log2_cpm', canonicalField: 'expression_value' },
    ],
  );
  assert.deepEqual(canonicalFieldsOf(null), []);
  const evidences = [
    { id: 'e0', currentVersion: { text: 'another result', citationContext: { snapshot_id: 'snap-9' } } },
    { id: 'e1', currentVersion: { text: Q12_SENTENCE, citationContext: { snapshot_id: 'snap-1' } } },
  ];
  assert.equal(sentenceEvidenceText(evidences, 'snap-1'), Q12_SENTENCE);
  assert.equal(sentenceEvidenceText(evidences, 'snap-unknown'), null, 'never falls back to another snapshot\'s evidence');
});
