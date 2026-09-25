import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTOR_SHAPES, citedConnectorsInPrompt, connectorBindingProblems } from './connectorShapes';
import { QUESTIONS } from '../steps/runRiazQuestions';
import { DESCRIBE_EXPECTED, isDescribeQuestion } from '../steps/riazDescribeExpectations';
import { RIAZ_CONNECTORS } from './riazConnectorRules';

/**
 * UT-E2E-CONN-1581-001..004 — the offline guard AXI-1581 was bounced for
 * missing: a staged question whose CITED connector cannot bind its OWN declared
 * parameters under the current seeds fails here, at review time, instead of at
 * the end of a live `stage:riaz-questions` run. See `staging/steps/UT.md`.
 */

test('UT-E2E-CONN-1581-001: every expected describe result cites a connector that can bind its own declared parameters', () => {
  const problems = Object.entries(DESCRIBE_EXPECTED).flatMap(([id, expectation]) =>
    expectation.results.flatMap((r) => connectorBindingProblems(r.connector, r.operationId, r.parameters, { declaresEveryParameter: false }).map((p) => `${id}: ${p}`)),
  );
  assert.deepEqual(problems, []);
});

test('UT-E2E-CONN-1581-002: every question prompt cites the same connector its expectation asserts', () => {
  const mismatches = QUESTIONS.filter((q) => isDescribeQuestion(q.id)).flatMap((q) => {
    const cited = [...new Set(citedConnectorsInPrompt(q.text))].sort();
    const expected = [...new Set(DESCRIBE_EXPECTED[q.id].results.map((r) => r.connector))].sort();
    return cited.join(',') === expected.join(',') ? [] : [`${q.id}: prompt cites [${cited.join(', ')}], expectation asserts [${expected.join(', ')}]`];
  });
  assert.deepEqual(mismatches, []);
});

test('UT-E2E-CONN-1581-003: the mirrored shapes cover exactly the connectors stage:rules entitles', () => {
  const entitled = RIAZ_CONNECTORS.map((c) => c.code).sort();
  const mirrored = Object.keys(CONNECTOR_SHAPES).sort();
  assert.deepEqual(mirrored, entitled);
});

test('UT-E2E-CONN-1581-004: the guard names the AXI-1581 narrowings it exists to catch', () => {
  // Arrange — the exact pre-fix Q20 citation: SUM-RANK-01 ranked by std.
  const stdOnRank = connectorBindingProblems('SUM-RANK-01', 'describe.grouped_aggregate', {
    groupColumns: ['gene'], valueColumn: 'log2_cpm', aggregation: 'std', direction: 'desc',
  });
  // Arrange — the pre-fix Q14 citation: SUM-COUNT-01 over two group columns.
  const twoColumnCount = connectorBindingProblems('SUM-COUNT-01', 'describe.count', {
    groupColumns: ['response', 'prior_ipi'], distinctKey: 'patient_id',
  });

  // Assert
  assert.match(stdOnRank.join(' | '), /SUM-RANK-01 accepts aggregation in \{mean, sum\}/);
  assert.match(twoColumnCount.join(' | '), /SUM-COUNT-01 accepts 1 group column\(s\), the question declares 2/);
  assert.deepEqual(connectorBindingProblems('SUM-SPREAD-01', 'describe.grouped_aggregate', {
    groupColumns: ['gene'], valueColumn: 'log2_cpm', aggregation: 'std', direction: 'desc',
  }), []);
});

test('UT-E2E-CONN-1581-005: the guard separates the two top-N connectors by the presence of a filter (AXI-1582)', () => {
  const topN = { sortColumn: 'log2_cpm', direction: 'desc', n: 5 };

  // SUM-TOPN-01 is pinned to an ABSENT filter (`fixed: null`) — declaring one cannot bind it.
  assert.match(
    connectorBindingProblems('SUM-TOPN-01', 'describe.top_n', { ...topN, filter: { column: 'response', op: 'eq', value: 'R' } }).join(' | '),
    /SUM-TOPN-01 is pinned to an absent filter/,
  );
  assert.deepEqual(connectorBindingProblems('SUM-TOPN-01', 'describe.top_n', topN), []);

  // …and the filtered connector requires one.
  assert.match(
    connectorBindingProblems('SUM-TOPN-FILTERED-01', 'describe.top_n', topN).join(' | '),
    /SUM-TOPN-FILTERED-01 requires filter/,
  );
  assert.deepEqual(
    connectorBindingProblems('SUM-TOPN-FILTERED-01', 'describe.top_n', { ...topN, filter: { column: 'response', op: 'eq', value: 'R' } }),
    [],
  );
});
