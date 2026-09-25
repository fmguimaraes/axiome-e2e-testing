import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CYTOTOXIC_FOCUS, cohortName, confidenceBand, configFor, decisionLabel, ruleCode, statisticalTitle, summariseQc, summariseStatistical } from './riazEvidenceText';
import type { Verdict } from './riazQuestionVerdicts';

/**
 * UT-STAGE-160..167 — the wording `stage:riaz-publish` puts on published
 * evidence and decisions (`riazEvidenceText.ts`), pinned on Q11's real
 * Wilcoxon numbers (run GR-95c2062c). See `staging/steps/UT.md`.
 */

const row = (feature: string, medianDifference: number, pValue: number, nPairs = 9) => ({ feature, medianDifference, pValue, nPairs, effectSize: Math.sign(medianDifference) * 0.5 });

// Q11 responders (n=9): the six focus genes + the non-focus genes that trend.
const RESPONDERS = [
  row('PDCD1', 1.254, 0.02), row('CD8A', 0.359, 0.039), row('PRF1', 0.664, 0.055), row('GZMA', 0.632, 0.074), row('CD27', 0.533, 0.098),
  row('LAG3', 1.207, 0.129), row('IFNG', 0.853, 0.359), row('GZMB', 0.699, 0.426), row('CXCL10', -0.345, 1),
];
// Q11 non-responders (n=18): no focus gene moves; CXCL9 / CXCL10 rise.
const NON_RESPONDERS = [
  row('CXCL9', 0.937, 0.009, 18), row('CXCL10', 0.659, 0.048, 18), row('CD274', 0.471, 0.054, 18), row('IDO1', 0.416, 0.099, 18),
  row('CD8A', -0.032, 1, 18), row('PRF1', 0.185, 0.347, 18), row('GZMB', 0.122, 0.58, 18), row('IFNG', 0.132, 0.366, 18), row('PDCD1', 0.235, 0.304, 18), row('LAG3', 0.231, 0.212, 18),
];
const wilcoxon = (rows: typeof RESPONDERS, cohort: string) => summariseStatistical({ rows, cohort, operationId: 'stats.wilcoxon_signed_rank', focusGenes: CYTOTOXIC_FOCUS, levelFrom: 'Pre', levelTo: 'On' });

test('UT-STAGE-160: the responder summary names the significant focus genes with direction and p, the trend, and what did not reach significance', () => {
  const text = wilcoxon(RESPONDERS, 'responders');
  assert.match(text, /^Responders \(n=9 paired patients\), Wilcoxon signed-rank Pre→On per gene/);
  assert.match(text, /PDCD1 \(p=0\.020\) and CD8A \(p=0\.039\) rise on treatment/);
  assert.match(text, /PRF1 \(p=0\.055\) rises as a trend/);
  assert.match(text, /GZMB, IFNG and LAG3 do not reach significance/);
  assert.match(text, /Outside the focus set, GZMA \(p=0\.074\) and CD27 \(p=0\.098\) rise as a trend/);
});

test('UT-STAGE-161: the non-responder summary says no focus gene moves and names the non-focus genes that do', () => {
  const text = wilcoxon(NON_RESPONDERS, 'non-responders');
  assert.match(text, /None of the 6 focus genes \(CD8A, PRF1, GZMB, IFNG, PDCD1 and LAG3\) changes significantly/);
  assert.match(text, /CXCL9 \(p=0\.009\) and CXCL10 \(p=0\.048\) rise; CD274 \(p=0\.054\) and IDO1 \(p=0\.099\) rise as a trend/);
});

test('UT-STAGE-162: the summary is 3–5 plain sentences — no ids, no key=value dumps', () => {
  for (const text of [wilcoxon(RESPONDERS, 'responders'), wilcoxon(NON_RESPONDERS, 'non-responders')]) {
    const sentences = text.split(/(?<=\.)\s+/).filter(Boolean);
    assert.ok(sentences.length >= 3 && sentences.length <= 5, `${sentences.length} sentences: ${text}`);
    assert.doesNotMatch(text, /feature=|pValue=|effectSize=|[0-9a-f]{8}-[0-9a-f]{4}/);
  }
});

test('UT-STAGE-163: a falling significant gene is described as falling', () => {
  const text = summariseStatistical({ rows: [row('CD8A', -0.9, 0.01)], cohort: 'all patients', operationId: 'stats.paired_ttest', focusGenes: ['CD8A'] });
  assert.match(text, /CD8A \(p=0\.010\) falls on treatment/);
  assert.match(text, /paired t-test per gene/);
});

test('UT-STAGE-164: QC text states the gate, referent, rows checked and verdict in one or two sentences', () => {
  const text = summariseQc({ cohort: 'non-responders', ruleCode: 'RIAZ-QC-PAIRED-01', ruleVersion: 3, rowsEvaluated: 864, verdict: 'pass', failReasons: [] });
  assert.equal(text, 'Paired-completeness gate RIAZ-QC-PAIRED-01 v3 on the non-responder referent: 864 rows checked, all included, verdict pass. The per-gene test of this cohort cites this referent.');
  assert.match(summariseQc({ cohort: 'responders', ruleCode: 'RIAZ-QC-PAIRED-01', ruleVersion: 3, rowsEvaluated: 156, verdict: 'block', failReasons: ['min_rows'] }), /verdict block \(min_rows\)\.$/);
});

test('UT-STAGE-165: titles are short and name the test, span, cohort and n; cohorts come from the snapshot filters', () => {
  const cfg = configFor('Q11');
  assert.equal(cohortName([{ column: 'response', operator: 'eq', value: 'R' }], cfg), 'responders');
  assert.equal(cohortName([{ column: 'prior_ipi', operator: 'eq', value: 'other' }], cfg), 'prior_ipi = other');
  assert.equal(statisticalTitle('Q11', 'stats.wilcoxon_signed_rank', 'responders', 9, 'Pre', 'On'), 'Q11 · Wilcoxon Pre→On per gene — responders (n=9)');
});

const q11Verdicts: Verdict[] = [
  { rule: 'RIAZ-INT-CYTO-01 @ responders (stats.wilcoxon_signed_rank)', verdict: 'cytotoxic_program_induced', detail: '', expected: '', match: true },
  { rule: 'RIAZ-INT-CYTO-01 @ non-responders', verdict: 'cytotoxic_program_not_induced', detail: '', expected: '', match: true },
  { rule: 'RIAZ-INT-RESP-01', verdict: 'responder_restricted', detail: 'confidence 0.55', expected: '', match: true, confidence: 0.55 },
  { rule: 'RIAZ-INT-SENS-01 (vs Q1 paired t-test)', verdict: 'robust', detail: '', expected: '', match: true },
];

test('UT-STAGE-166: the Q11 decision label states the claim and the cited rule verdicts, with parentheticals stripped', () => {
  assert.equal(ruleCode('RIAZ-INT-SENS-01 (vs Q1 paired t-test)'), 'RIAZ-INT-SENS-01');
  assert.equal(decisionLabel('Q11', configFor('Q11'), q11Verdicts), 'Q11 — responder-restricted cytotoxic induction holds under Wilcoxon · RIAZ-INT-RESP-01: responder_restricted · RIAZ-INT-SENS-01: robust');
});

test('UT-STAGE-167: confidence band maps the rule confidence — ≥0.75 high, ≥0.5 medium, else low, none → medium', () => {
  assert.equal(confidenceBand(q11Verdicts), 'medium');
  assert.equal(confidenceBand([{ ...q11Verdicts[2], confidence: 0.8 }]), 'high');
  assert.equal(confidenceBand([{ ...q11Verdicts[2], confidence: 0.3 }]), 'low');
  assert.equal(confidenceBand([q11Verdicts[0]]), 'medium');
});

// ── AXI-1588 — Q12–Q21 userCharts[] plans (Chart-Enrichment-Brief §2) ────────
// Structural checks on the plans this story adds: every question hits the
// ≥3-chart AC, every plan's title/key is unique within its question (the
// find-or-create-by-title mechanic in `riazUserCharts.ts` depends on it), and
// every question carries exactly one `userCharts[]` interpretation.

// Q20 was retired (duplicate of Q33); its chart plans live on Q33. Name kept for the UT-STAGE-205..209 rows.
const Q12_TO_Q21 = ['Q12', 'Q13', 'Q14', 'Q15', 'Q16', 'Q17', 'Q18', 'Q19', 'Q21', 'Q33'];

test('UT-STAGE-205: every Q12–Q21 question carries at least 3 userCharts[] plans (AC — recommended + ≥3 shows ≥4 charts total)', () => {
  for (const qId of Q12_TO_Q21) {
    const plans = configFor(qId).userCharts ?? [];
    assert.ok(plans.length >= 3, `${qId} has only ${plans.length} userCharts[] plan(s)`);
  }
});

test('UT-STAGE-206: every Q12–Q21 plan has a unique title within its question (find-or-create-by-title depends on it)', () => {
  for (const qId of Q12_TO_Q21) {
    const plans = configFor(qId).userCharts ?? [];
    const titles = plans.map((p) => p.title);
    assert.equal(new Set(titles).size, titles.length, `${qId} has duplicate userCharts[] titles`);
  }
});

test('UT-STAGE-207: every Q12–Q21 plan has a unique key within its question (the render-cache cohort discriminator depends on it)', () => {
  for (const qId of Q12_TO_Q21) {
    const plans = configFor(qId).userCharts ?? [];
    const keys = plans.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, `${qId} has duplicate userCharts[] keys`);
  }
});

test('UT-STAGE-208: every Q12–Q21 question carries exactly one userCharts[] interpretation, and every title starts with its own question id', () => {
  for (const qId of Q12_TO_Q21) {
    const plans = configFor(qId).userCharts ?? [];
    const interpretations = plans.filter((p) => p.interpretation);
    assert.equal(interpretations.length, 1, `${qId} has ${interpretations.length} interpretation(s), expected 1`);
    for (const p of plans) assert.ok(p.title.startsWith(`${qId} · `), `${qId} plan title "${p.title}" does not start with "${qId} · "`);
  }
});

test('UT-STAGE-209: Q12–Q21 recommended bar_chart_v1 stays untouched — userCharts[] never plans a bar_chart_v1 template (that origin stays "recommended", never "user")', () => {
  for (const qId of Q12_TO_Q21) {
    const plans = configFor(qId).userCharts ?? [];
    for (const p of plans) assert.notEqual(p.templateId, 'bar_chart_v1', `${qId} plan "${p.title}" would collide with the recommended bar_chart_v1`);
  }
});
