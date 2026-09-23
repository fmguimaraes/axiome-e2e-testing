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

const expectedSentenceOf = (q: QuestionTrace, index: number): string =>
  DESCRIBE_EXPECTED[q.id]?.results[index]?.sentence ?? '_(shape asserted, not byte-for-byte)_';

/**
 * ONE ROW PER DESCRIBE RESULT, not per question: Q16 answers with two
 * `describe.count` branches, and a summary that showed only the first would
 * hide half of the answer it is reporting on (review-gate advisory A5). The
 * assertion score stays per QUESTION — that is the unit that passes or fails —
 * and is printed on the question's first row only.
 */
export function describeSummaryRows(questions: readonly QuestionTrace[]): string[] {
  return describeQuestions(questions).flatMap((q) => {
    const { passed, total } = assertionScore(q);
    const results = q.describe?.results ?? [];
    if (!results.length) return [`| ${q.id} | — | none (—) | — | ✗ | ${passed}/${total} ${tick(false)} |`];
    return results.map((r, i) => {
      const label = results.length > 1 ? `${q.id} (${r.cohort || `branch ${i + 1}`})` : q.id;
      const connector = r.binding?.matchedConnectors.join(', ') || 'none';
      const score = i === 0 ? `${passed}/${total} ${tick(total > 0 && passed === total)}` : '↑';
      return `| ${label} | ${r.citedConnector ?? '—'} | ${connector} (${r.binding?.state ?? '—'}) | ${r.nGroups ?? '—'} | ${r.recommendedChartSpecId ? '✓' : '✗'} | ${score} |`;
    });
  });
}

export function describeSection(questions: readonly QuestionTrace[]): string[] {
  const rows = describeSummaryRows(questions);
  if (!rows.length) return [];
  return [
    '## Descriptive questions (Q12–Q21)',
    '',
    'Ten chart-first, descriptive questions: one filter level, one aggregation, no p-value. Each one must end with a result table, a connector-rule `match`, a deterministic sentence and a `descriptive_summary` Decision on the analysis surface, plus the platform\'s own recommended chart minted into the result dataset\'s governed gallery where the backend allows one (AXI-1573 removed the client-built chart panel from the result view; a withheld chart is the correct answer, not a gap) — every number asserted against a value derived from the source CSVs, never from the platform\'s own output (`staging/steps/riazDescribeExpectations.ts` carries the derivation per question).',
    '',
    '| Q | Connector cited | Connector bound (state) | n_groups | Recommended chart | Assertions |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '### Rendered sentences',
    '',
    '| Q | Rendered sentence | Expected |',
    '|---|---|---|',
    ...describeQuestions(questions).flatMap((q) =>
      (q.describe?.results ?? [{ sentence: null, cohort: '' }]).map((r, i) => {
        const label = (q.describe?.results?.length ?? 0) > 1 ? `${q.id} (${r.cohort || `branch ${i + 1}`})` : q.id;
        return `| ${label} | ${r.sentence ?? '_(none)_'} | ${expectedSentenceOf(q, i)} |`;
      }),
    ),
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
