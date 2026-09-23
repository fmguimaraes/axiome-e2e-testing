import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHandBuiltUserChart, selectRecommended } from './publishRiazEvidence';

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
