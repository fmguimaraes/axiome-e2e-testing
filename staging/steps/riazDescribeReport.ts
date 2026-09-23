/**
 * AXI-1565 (epic AXI-1555 — FR36) — the "Descriptive questions" section of
 * `Riaz-Guided-Questions-Report.md`: for Q12–Q21, the rendered sentence beside
 * the expected one, the connector that bound, and every expected-vs-actual
 * assertion the runner evaluated. Pure markdown over the trace — no network, no
 * re-derivation (the report never recomputes a number the runner asserted; a
 * second derivation is a second answer, and the two can disagree).
 */
import type { Assertion } from './riazDescribeAssertions';
import { DESCRIBE_EXPECTED, isDescribeQuestion } from './riazDescribeExpectations';
import type { QuestionTrace } from './runRiazQuestions';

const tick = (ok: boolean): string => (ok ? '✓' : '✗');

export const describeQuestions = (questions: readonly QuestionTrace[]): QuestionTrace[] => questions.filter((q) => isDescribeQuestion(q.id));

export const assertionScore = (q: QuestionTrace): { passed: number; total: number } => {
  const a = q.assertions ?? [];
  return { passed: a.filter((x) => x.ok).length, total: a.length };
};

const first = (q: QuestionTrace) => q.describe?.results[0];

const expectedSentenceOf = (q: QuestionTrace): string =>
  DESCRIBE_EXPECTED[q.id]?.results[0]?.sentence ?? '_(shape asserted, not byte-for-byte)_';

/** One row per descriptive question: what bound, what it said, and whether every assertion is green. */
export function describeSummaryRows(questions: readonly QuestionTrace[]): string[] {
  return describeQuestions(questions).map((q) => {
    const r = first(q);
    const { passed, total } = assertionScore(q);
    const connector = r?.binding?.matchedConnectors.join(', ') || 'none';
    const state = r?.binding?.state ?? '—';
    return `| ${q.id} | ${r?.citedConnector ?? '—'} | ${connector} (${state}) | ${r?.nGroups ?? '—'} | ${r?.recommendedChartSpecId ? '✓' : '✗'} | ${passed}/${total} ${tick(total > 0 && passed === total)} |`;
  });
}

export function describeSection(questions: readonly QuestionTrace[]): string[] {
  const rows = describeSummaryRows(questions);
  if (!rows.length) return [];
  return [
    '## Descriptive questions (Q12–Q21)',
    '',
    'Ten chart-first, descriptive questions: one filter level, one aggregation, no p-value. Each one must end with a result table, the platform\'s own recommended chart, a connector-rule `match`, a deterministic sentence and a `descriptive_summary` Decision — every number asserted against a value derived from the source CSVs, never from the platform\'s own output (`staging/steps/riazDescribeExpectations.ts` carries the derivation per question).',
    '',
    '| Q | Connector cited | Connector bound (state) | n_groups | Recommended chart | Assertions |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '### Rendered sentences',
    '',
    '| Q | Rendered sentence | Expected |',
    '|---|---|---|',
    ...describeQuestions(questions).map((q) => `| ${q.id} | ${first(q)?.sentence ?? '_(none)_'} | ${expectedSentenceOf(q)} |`),
    '',
  ];
}

/** The per-question assertion table, appended to that question's own section. */
export function describeAssertionTable(q: QuestionTrace): string[] {
  const assertions: Assertion[] = q.assertions ?? [];
  if (!assertions.length) return [];
  return [
    `**Assertions (expected values derived independently of the platform: ${q.describe?.derivation ?? '—'})**`,
    '',
    '| Assertion | Expected | Actual | |',
    '|---|---|---|---|',
    ...assertions.map((a) => `| ${a.name} | ${a.expected} | ${a.actual} | ${tick(a.ok)} |`),
    '',
  ];
}
