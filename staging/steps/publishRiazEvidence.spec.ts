import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineDescribeUserCharts, findDescriptiveDecision, findSentenceEvidence, interpretationDecisionLabel, isHandBuiltUserChart, selectRecommended } from './publishRiazEvidence';

/**
 * UT-STAGE-168..172 — the two pure selectors `stage:riaz-publish` uses
 * instead of creating charts (AXI-1553): which candidate specs on a dataset
 * are the platform's recommended chart(s) for a rule-derived snapshot, and
 * which pre-AXI-1553 user specs `--prune-user-charts` deletes. See
 * `staging/steps/UT.md`.
 */

const spec = (origin: 'auto' | 'user' | 'recommended', title: string | null, id = 'x') => ({ id, title, origin, templateId: 't' });

test('UT-STAGE-168: selectRecommended returns the recommended spec when present', () => {
  const specs = [spec('auto', 'Auto card'), spec('recommended', 'Recommended: Wilcoxon signed-rank test', 'rec-1'), spec('user', 'Q11 · Wilcoxon effect size — responders')];
  const recs = selectRecommended(specs);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].id, 'rec-1');
});

test('UT-STAGE-169: selectRecommended returns an empty list when no recommended spec exists (e.g. a passing QC gate)', () => {
  const specs = [spec('auto', 'Auto card'), spec('user', 'some user chart')];
  assert.deepEqual(selectRecommended(specs), []);
});

test('UT-STAGE-170: selectRecommended returns ALL recommended specs when a dataset carries several templates', () => {
  const specs = [spec('recommended', 'Recommended: Wilcoxon', 'rec-1'), spec('recommended', 'qc_fail_reason_counts_v1', 'rec-2'), spec('auto', 'ignored')];
  const recs = selectRecommended(specs);
  assert.deepEqual(recs.map((r) => r.id).sort(), ['rec-1', 'rec-2']);
});

test('UT-STAGE-171: isHandBuiltUserChart matches a pre-AXI-1553 "Qn · …" user spec', () => {
  assert.equal(isHandBuiltUserChart(spec('user', 'Q11 · Wilcoxon Pre→On effect size per gene — responders (n=9)')), true);
  assert.equal(isHandBuiltUserChart(spec('user', 'Q2 · log2 CPM Pre vs On, focus genes — all patients')), true);
});

test('UT-STAGE-172: isHandBuiltUserChart ignores a non-user origin, a user chart with an unrelated title, and a null title', () => {
  assert.equal(isHandBuiltUserChart(spec('recommended', 'Q11 · looks like one but is not')), false);
  assert.equal(isHandBuiltUserChart(spec('user', 'My custom chart')), false);
  assert.equal(isHandBuiltUserChart(spec('user', null)), false);
});

// ── AXI-1565 (FR36): the describe branch selects, never authors ──────────────

test('UT-E2E-DESC-017: the run\'s sentence evidence is found by its citation context, never by title', () => {
  const rows = [
    { id: 'e1', currentVersion: { id: 'v1', title: 'Q12 · Mann–Whitney per gene', citationContext: { snapshot_id: 'other' } } },
    { id: 'e2', currentVersion: { id: 'v2', title: 'Describe result (ranked) — binding covered', citationContext: { snapshot_id: 'snap-1' } } },
  ];
  assert.equal(findSentenceEvidence(rows, 'snap-1')?.id, 'e2');
  assert.equal(findSentenceEvidence(rows, 'snap-missing'), undefined);
  assert.equal(findSentenceEvidence([{ id: 'e3', currentVersion: { id: 'v3', title: 'x' } }], 'snap-1'), undefined);
});

test('UT-E2E-DESC-018: the descriptive decision is the draft whose context names this rule run', () => {
  const decisions = [
    { id: 'd1', label: 'x', status: 'draft', context: { ruleRunId: 'run-9' } },
    { id: 'd2', label: 'y', status: 'draft', context: { ruleRunId: 'run-1' } },
    { id: 'd3', label: 'z', status: 'draft' },
  ] as unknown as Parameters<typeof findDescriptiveDecision>[0];
  assert.equal(findDescriptiveDecision(decisions, 'run-1')?.id, 'd2');
  assert.equal(findDescriptiveDecision(decisions, 'run-absent'), undefined);
});

test('UT-STAGE-193: interpretationDecisionLabel is "<questionId> — <reading> · interpretation" (AXI-1586)', () => {
  assert.equal(interpretationDecisionLabel('Q2', 'pooled induction is a responder effect'), 'Q2 — pooled induction is a responder effect · interpretation');
});

test('UT-STAGE-194: interpretationDecisionLabel differs for two different plans of the same question — the Review Center lists both', () => {
  const a = interpretationDecisionLabel('Q6', 'exhausted transcripts mark the hot tumour');
  const b = interpretationDecisionLabel('Q6', 'CTLA4 is the outlier — checkpoint ≠ exhaustion');
  assert.notEqual(a, b);
});

// ── AXI-1587: a describe question's userCharts[] merge into the same publish ──

const sentenceEvidence = (id: string) => ({ id, versionId: `${id}-v1`, versionNumber: 1, title: 'sentence', text: 'sentence text', snapshotId: 's1', ruleRunId: 'r1', link: 'l', charts: [] });
const userChartEvidence = (id: string) => ({ id, versionId: `${id}-v1`, versionNumber: 1, title: 'chart', text: 'chart reading', snapshotId: 's2', ruleRunId: '', link: 'l', charts: [] });

test('UT-STAGE-198: combineDescribeUserCharts appends the userCharts[] evidences and interpretation decisions to the describe publish', () => {
  const evidences = [sentenceEvidence('e1')];
  const userCharts = { evidences: [userChartEvidence('e2'), userChartEvidence('e3')], interpretationDecisions: [{ id: 'd2', label: 'alt reading', link: 'l' }] };
  const { allEvidences, decisionIds } = combineDescribeUserCharts(evidences, 'd1', userCharts);
  assert.deepEqual(allEvidences.map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.deepEqual(decisionIds, ['d1', 'd2']);
});

test('UT-STAGE-199: combineDescribeUserCharts drops a null descriptive decision id and tolerates no userCharts[] at all', () => {
  const evidences = [sentenceEvidence('e1')];
  const { allEvidences, decisionIds } = combineDescribeUserCharts(evidences, null, { evidences: [], interpretationDecisions: [] });
  assert.deepEqual(allEvidences.map((e) => e.id), ['e1']);
  assert.deepEqual(decisionIds, []);
});
