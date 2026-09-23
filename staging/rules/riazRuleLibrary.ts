/**
 * The Riaz 2017 rule library — every rule the ten guided questions in
 * ../axiome-docs/demo/riaz-2017/Riaz-Guided-Questions.md cite, built with `protocolBuilders.ts` so each
 * protocol's publish contract is satisfied by construction.
 *
 *   Q1  on-treatment cytotoxic induction, responder-restricted   (stage:riaz-guided, done)
 *   Q2  PD-1 (PDCD1) induction on treatment, R vs NR
 *   Q3  IFN-γ / antigen-presentation programme induction in responders
 *   Q4  baseline (Pre) cytotoxic expression, R vs NR
 *   Q5  induction by prior-ipilimumab stratum
 *   Q6  on-treatment exhaustion / checkpoint markers, R vs NR
 *   Q7  negative control — induction in non-responders alone
 *   Q8  pre-treatment DE table: how much signal at padj < 0.05
 *   Q9  pre-treatment DE, ipi-naive vs ipi-progressed strata
 *   Q10 antigen-presentation (HLA-DRA, CD274) induction, responder-restricted
 *   Q11 sensitivity — Q1 under Wilcoxon signed-rank instead of paired t
 *
 * Q1's four rules live in `steps/riazGuidedRules.ts` (already published on the
 * demo stack together with their offline evaluators); they are re-exported
 * here unchanged so `stage:rules` sees ONE library.
 *
 * Panel (24 genes, `riaz2017_immune_paired_log2cpm_long.csv`): CD27 CD274 CD3E
 * CD8A CTLA4 CXCL10 CXCL11 CXCL9 GZMA GZMB HAVCR2 HLA-DRA IDO1 IFNG IL2RA IRF1
 * LAG3 LCK NKG7 PDCD1 PRF1 STAT1 TIGIT TOX. Cohort: 27 fully paired patients,
 * 9 R / 18 NR, 14 ipi-naive / 13 ipi-progressed.
 */
import type { RuleDraft } from './ensureRule';
import { decisionRule, featureRule, interpretRule, qcRule, stratifyRule, summaryRule, type ProtocolType } from './protocolBuilders';
import { DEC_CODE, INT_CYTO_CODE, INT_RESP_CODE, QC_RULE_CODE, decisionRule as q1Decision, interpretCytoRule, interpretRespRule, qcRule as q1Qc } from '../steps/riazGuidedRules';

const TAGS = ['riaz-2017', 'demo'];
const DELTA = 0.5; // log2 CPM Pre→On, paired mean — the induction threshold shared by every INTERPRET rule
const P = 0.05;

export const IFNG_GENES = ['IFNG', 'CXCL9', 'CXCL10', 'CXCL11', 'IDO1', 'STAT1', 'IRF1', 'HLA-DRA'] as const;
export const EXHAUSTION_GENES = ['LAG3', 'HAVCR2', 'TIGIT', 'CTLA4', 'TOX', 'PDCD1'] as const;
export const APM_GENES = ['HLA-DRA', 'CD274'] as const;
export const CYTO_GENES = ['CD8A', 'PRF1', 'GZMB', 'IFNG', 'PDCD1', 'LAG3'] as const; // = riazGuidedRules.CYTO_GENES

const deltaLeaf = (g: string) => ({ attributeKey: `paired_mean_delta_log2cpm:${g}`, operator: '>=' as const, value: DELTA, context: 'vs_baseline', label: `${g} induced ≥ ${DELTA} log2 CPM Pre→On` });
const heuristic = (k: number) => ({
  levels: [
    { level: 'high' as const, condition: `every fired gene has paired p < ${P}`, value: 0.85 },
    { level: 'medium' as const, condition: `at least ${k} fired genes have paired p < ${P}`, value: 0.6 },
    { level: 'low' as const, condition: 'fired on delta alone', value: 0.3 },
  ],
});

// ── QC (executable — cite from a plan's qc_check node) ──────────────────────

export const QC_COHORT_MINN = 'RIAZ-QC-COHORT-MINN-01';
export const QC_DE_TABLE = 'RIAZ-QC-DE-01';

const qcCohortMinN = (): RuleDraft =>
  qcRule({
    code: QC_COHORT_MINN,
    title: 'Cohort minimum size guard (8 paired patients)',
    question: 'Does the cohort referent carry at least 8 fully paired patients (384 rows = 8 × 24 genes × 2 timepoints)?',
    signals: ['meta:sample_size'],
    logicSummary: 'A cohort-restricted paired estimate (non-responders alone, one prior-ipi stratum) needs ≥ 8 patients before a per-gene paired test is worth reading; below that the run is degraded (confidence cap 0.4, human review).',
    risksNotes: 'Row count is a proxy: it assumes the referent is the long paired panel (24 genes × 2 timepoints per patient). Do not cite on the DE tables.',
    category: 'qc_guard',
    tags: [...TAGS, 'qc'],
    evaluations: [{ attributeKey: 'sample_size', operator: '>=', value: 384, label: 'At least 8 fully paired patients (384 rows)' }],
    guardOutput: { confidenceCap: 0.4, requireHumanReview: true },
  });

const qcDeTable = (): RuleDraft =>
  qcRule({
    code: QC_DE_TABLE,
    title: 'DE table completeness guard',
    question: 'Is the differential-expression table complete enough (≥ 10,000 tested genes) to count significant genes on?',
    signals: ['meta:sample_size'],
    logicSummary: 'A gene-count summary over a truncated DE table is meaningless; the guard requires ≥ 10,000 rows (the full Riaz tables carry 22k pooled / 44k stratified rows).',
    risksNotes: 'Counts rows, not distinct genes; the stratified table carries each gene twice (one row per stratum).',
    category: 'qc_guard',
    tags: [...TAGS, 'qc', 'de-table'],
    evaluations: [{ attributeKey: 'sample_size', operator: '>=', value: 10000, label: 'At least 10,000 DE rows' }],
    guardOutput: { confidenceCap: 0.5, requireHumanReview: true },
  });

// ── FEATURE (authoring-only: derived per-row scores the INTERPRET rules cite) ─

export const FEAT_IFNG = 'RIAZ-FEAT-IFNG-SCORE-01';
export const FEAT_EXH = 'RIAZ-FEAT-EXH-SCORE-01';
export const FEAT_APM = 'RIAZ-FEAT-APM-SCORE-01';

const featureScore = (code: string, name: string, genes: readonly string[], title: string, why: string): RuleDraft =>
  featureRule({
    code,
    title,
    question: `What is the per-sample ${name} (mean log2 CPM over ${genes.join(', ')})?`,
    signals: [`marker_set:${name}`, ...genes.map((g) => `marker:${g}`)],
    logicSummary: `${name} = mean(log2_cpm) over ${genes.length} genes per patient × timepoint. ${why}`,
    risksNotes: 'Equal-weight mean of log2 CPM; no gene-wise scaling, so highly expressed genes dominate. A bulk-tissue score, not a cell-type score.',
    category: 'phenotype_detection',
    tags: [...TAGS, 'feature'],
    featureName: name,
    formula: `mean(log2_cpm[${genes.join(', ')}]) per (patient_id, timepoint)`,
    range: 'log2 CPM, typically 0–12',
    evaluations: [{ attributeKey: 'meta:markers_present', operator: '>=', value: genes.length, label: `all ${genes.length} panel genes present` }],
  });

const featIfng = () => featureScore(FEAT_IFNG, 'ifng_program_score', IFNG_GENES, 'IFN-γ programme score (8 genes)', 'Ayers-style IFN-γ-related signature restricted to the genes on the 24-gene panel.');
const featExh = () => featureScore(FEAT_EXH, 'exhaustion_score', EXHAUSTION_GENES, 'Exhaustion / checkpoint score (6 genes)', 'Co-inhibitory receptors plus TOX; rises with chronic antigen exposure and with T-cell infiltration.');
const featApm = () => featureScore(FEAT_APM, 'apm_score', APM_GENES, 'Antigen-presentation / PD-L1 score (2 genes)', 'MHC-II (HLA-DRA) plus PD-L1 (CD274): the IFN-γ-inducible presentation axis.');

// ── SUMMARY (authoring-only: cohort / group aggregations over features) ─────

export const SUM_DE = 'RIAZ-SUM-DE-01';
export const SUM_STRATA = 'RIAZ-SUM-STRATA-01';

const sumDe = (): RuleDraft =>
  summaryRule({
    code: SUM_DE,
    title: 'Significant-gene count, pooled pre-treatment DE',
    question: 'How many genes pass padj < 0.05 in the pooled pre-treatment R vs NR table, and how many of the 24-gene immune panel are among them?',
    signals: ['feature:padj', 'feature:log2FoldChange', 'meta:gene', 'qc_mask'],
    logicSummary: 'COHORT-level: n_sig = count(padj < 0.05); n_panel_sig = count(padj < 0.05 AND gene ∈ panel); direction split by sign(log2FoldChange).',
    risksNotes: 'padj is BH over ~22k genes; the panel count is post-hoc (no extra correction).',
    category: 'research_stratification',
    tags: [...TAGS, 'summary', 'de-table'],
    aggregationLevel: 'COHORT',
    aggregations: [
      { metric: 'padj<0.05', fn: 'count' },
      { metric: 'padj<0.05 & gene in panel', fn: 'count' },
      { metric: 'log2FoldChange | padj<0.05', fn: 'median' },
    ],
    evaluations: [{ attributeKey: 'padj', operator: '<', value: 0.05, label: 'gene significant at BH 5%' }],
  });

const sumStrata = (): RuleDraft =>
  summaryRule({
    code: SUM_STRATA,
    title: 'Significant-gene count per prior-ipilimumab stratum',
    question: 'Per stratum (ipi_naive, ipi_progressed), how many genes pass padj < 0.05 in the pre-treatment R vs NR contrast?',
    signals: ['feature:padj', 'meta:stratum', 'qc_mask'],
    logicSummary: 'GROUP-level by `stratum`: n_sig per stratum and the ratio of the two counts.',
    risksNotes: 'Strata have unequal n (14 vs 13 patients here; the paper’s full cohorts differ), so a count ratio confounds effect size with power.',
    category: 'research_stratification',
    tags: [...TAGS, 'summary', 'de-table'],
    aggregationLevel: 'GROUP',
    aggregations: [
      { metric: 'padj<0.05', fn: 'count' },
      { metric: 'n_tested', fn: 'count' },
    ],
    evaluations: [{ attributeKey: 'padj', operator: '<', value: 0.05, label: 'gene significant at BH 5%' }],
  });

// ── STRATIFY (authoring-only: the explicit groupings the plans filter on) ───

export const STRAT_RESP = 'RIAZ-STRAT-RESP-01';
export const STRAT_IPI = 'RIAZ-STRAT-IPI-01';

const stratResp = (): RuleDraft =>
  stratifyRule({
    code: STRAT_RESP,
    title: 'Response cohorts (RECIST best overall response)',
    question: 'Which patients are responders (CR/PR → R) and which non-responders (PD → NR)?',
    signals: ['meta:response'],
    logicSummary: 'PREDEFINED_GROUPING on `response`: R | NR. SD patients were excluded upstream when the paired panel was derived.',
    risksNotes: 'Best overall response, not durable benefit; 9 vs 18 patients.',
    category: 'research_stratification',
    tags: [...TAGS, 'stratify'],
    mode: 'PREDEFINED_GROUPING',
    groupBy: { column: 'response', levels: ['R', 'NR'] },
    evaluations: [],
  });

const stratIpi = (): RuleDraft =>
  stratifyRule({
    code: STRAT_IPI,
    title: 'Prior ipilimumab strata',
    question: 'Which patients are ipilimumab-naive (NIV3-NAIVE) and which progressed on ipilimumab (NIV3-PROG)?',
    signals: ['meta:prior_ipi'],
    logicSummary: 'PREDEFINED_GROUPING on `prior_ipi`: ipi_naive | ipi_progressed (the two Riaz cohorts).',
    risksNotes: 'Within each stratum responders are 4–5 patients; per-stratum paired estimates are underpowered by design.',
    category: 'research_stratification',
    tags: [...TAGS, 'stratify'],
    mode: 'PREDEFINED_GROUPING',
    groupBy: { column: 'prior_ipi', levels: ['ipi_naive', 'ipi_progressed'] },
    evaluations: [],
  });

// ── INTERPRET (authoring-only; evaluated offline over the run's tables) ──────

export const INT_PD1 = 'RIAZ-INT-PD1-01';
export const INT_IFNG = 'RIAZ-INT-IFNG-01';
export const INT_BASELINE = 'RIAZ-INT-BASELINE-01';
export const INT_IPI = 'RIAZ-INT-IPI-01';
export const INT_EXH = 'RIAZ-INT-EXH-01';
export const INT_DE = 'RIAZ-INT-DE-01';
export const INT_STRATA = 'RIAZ-INT-STRATA-01';
export const INT_APM = 'RIAZ-INT-APM-01';
export const INT_SENS = 'RIAZ-INT-SENS-01';

const intPd1 = (): RuleDraft =>
  interpretRule({
    code: INT_PD1,
    title: 'PD-1 (PDCD1) induction on nivolumab',
    question: 'Does PDCD1 transcript rise between the pre-treatment and on-treatment biopsy?',
    signals: ['summary_metric:paired_mean_delta_log2cpm', 'summary_metric:paired_ttest_p', 'feature:PDCD1'],
    logicSummary: `"pd1_induced" when PDCD1 paired mean Δ ≥ ${DELTA} log2 CPM AND paired p < ${P}; "pd1_trend" when Δ ≥ ${DELTA} only; else "pd1_not_induced".`,
    risksNotes: 'PDCD1 transcript rises with T-cell infiltration; it does not measure receptor occupancy by nivolumab.',
    category: 'microenvironment_state',
    tags: [...TAGS, 'interpretation'],
    outputType: 'state_label',
    labels: ['pd1_induced', 'pd1_trend', 'pd1_not_induced'],
    scoringSchema: { kind: 'and', leaves: [{ metric: 'paired_mean_delta_log2cpm:PDCD1', operator: '>=', value: DELTA }, { metric: 'paired_ttest_p:PDCD1', operator: '<', value: P }] },
    evaluations: [deltaLeaf('PDCD1'), { attributeKey: 'paired_ttest_p:PDCD1', operator: '<', value: P, context: 'vs_baseline', label: `PDCD1 paired p < ${P}` }],
    confidenceHeuristic: { levels: [{ level: 'high', condition: 'both leaves fire and p < 0.01', value: 0.85 }, { level: 'medium', condition: 'both leaves fire', value: 0.6 }, { level: 'low', condition: 'delta only', value: 0.3 }] },
  });

const intKofN = (code: string, title: string, question: string, genes: readonly string[], k: number, feature: string, label: string, risks: string): RuleDraft =>
  interpretRule({
    code,
    title,
    question,
    signals: ['summary_metric:paired_mean_delta_log2cpm', 'summary_metric:paired_ttest_p', `feature:${feature}`, ...genes.map((g) => `feature:${g}`)],
    logicSummary: `"${label}" fires when ≥ ${k} of ${genes.length} genes (${genes.join(', ')}) show a paired mean Pre→On increase ≥ ${DELTA} log2 CPM; confidence from the paired p-values.`,
    risksNotes: risks,
    category: 'microenvironment_state',
    tags: [...TAGS, 'interpretation'],
    outputType: 'state_label',
    labels: [label, `${label.replace(/_induced$/, '')}_not_induced`],
    scoringSchema: { kind: 'k_of_n', k, n: genes.length, leaf: { metric: 'paired_mean_delta_log2cpm', operator: '>=', value: DELTA } },
    evaluations: genes.map(deltaLeaf),
    kOfN: k,
    confidenceHeuristic: heuristic(k),
  });

const intIfng = () => intKofN(INT_IFNG, 'IFN-γ programme induction on treatment', 'Is the IFN-γ-related programme induced Pre→On in responders?', IFNG_GENES, 5, 'ifng_program_score', 'ifng_program_induced', 'Chemokines (CXCL9/10/11) are produced by myeloid cells too; the programme is tissue-level, not T-cell-intrinsic.');
const intApm = () => intKofN(INT_APM, 'Antigen-presentation / PD-L1 induction on treatment', 'Do HLA-DRA and CD274 rise Pre→On?', APM_GENES, 2, 'apm_score', 'apm_induced', 'Two genes only: both must fire. PD-L1 transcript is not PD-L1 IHC.');

const intExh = (): RuleDraft =>
  interpretRule({
    code: INT_EXH,
    title: 'On-treatment exhaustion markers higher in responders',
    question: 'At the on-treatment biopsy, is the exhaustion / checkpoint programme higher in responders than in non-responders?',
    signals: ['summary_metric:mann_whitney_p', 'summary_metric:median_difference', `feature:exhaustion_score`, ...EXHAUSTION_GENES.map((g) => `feature:${g}`)],
    logicSummary: `"exhaustion_higher_in_responders" when ≥ 3 of ${EXHAUSTION_GENES.length} genes have R > NR (median difference > 0) with Mann-Whitney p < ${P} at the On timepoint.`,
    risksNotes: 'Unpaired contrast at one timepoint; higher checkpoint transcripts in responders reflect infiltration (the "hot" tumour), not dysfunction per se.',
    category: 'microenvironment_state',
    tags: [...TAGS, 'interpretation'],
    outputType: 'state_label',
    labels: ['exhaustion_higher_in_responders', 'exhaustion_not_different'],
    scoringSchema: { kind: 'k_of_n', k: 3, n: EXHAUSTION_GENES.length, leaf: { metric: 'mann_whitney_p', operator: '<', value: P, direction: 'R > NR' } },
    evaluations: EXHAUSTION_GENES.map((g) => ({ attributeKey: `mann_whitney_p:${g}`, operator: '<' as const, value: P, context: 'R_vs_NR@On', label: `${g} R > NR at On, p < ${P}` })),
    kOfN: 3,
    confidenceHeuristic: heuristic(3),
  });

const intBaseline = (): RuleDraft =>
  interpretRule({
    code: INT_BASELINE,
    title: 'Baseline cytotoxic expression separates responders',
    question: 'Before treatment, is the cytotoxic panel already higher in responders than in non-responders?',
    signals: ['summary_metric:mann_whitney_p', 'summary_metric:median_difference', ...CYTO_GENES.map((g) => `feature:${g}`)],
    logicSummary: `"baseline_predictive" when ≥ 3 of ${CYTO_GENES.length} cytotoxic genes have R > NR with Mann-Whitney p < ${P} at Pre; else "baseline_not_predictive" (the Riaz 2017 finding).`,
    risksNotes: 'n = 9 vs 18 unpaired; a null here is low power, not proof of no baseline difference.',
    category: 'microenvironment_state',
    tags: [...TAGS, 'interpretation'],
    outputType: 'state_label',
    labels: ['baseline_predictive', 'baseline_not_predictive'],
    scoringSchema: { kind: 'k_of_n', k: 3, n: CYTO_GENES.length, leaf: { metric: 'mann_whitney_p', operator: '<', value: P, direction: 'R > NR' } },
    evaluations: CYTO_GENES.map((g) => ({ attributeKey: `mann_whitney_p:${g}`, operator: '<' as const, value: P, context: 'R_vs_NR@Pre', label: `${g} R > NR at Pre, p < ${P}` })),
    kOfN: 3,
    confidenceHeuristic: heuristic(3),
  });

const intIpi = (): RuleDraft =>
  interpretRule({
    code: INT_IPI,
    title: 'Induction independent of prior ipilimumab',
    question: 'Does the on-treatment cytotoxic induction fire in both prior-ipilimumab strata?',
    signals: [`rule_score:${INT_CYTO_CODE}`, 'assignment:prior_ipi', 'summary_metric:paired_mean_delta_log2cpm'],
    logicSummary: `"ipi_independent" when ${INT_CYTO_CODE} fires in ipi_naive AND ipi_progressed; "ipi_naive_only" / "ipi_progressed_only" when one; "no_induction" when neither.`,
    risksNotes: 'Per-stratum n is 13–14 patients (4–5 responders); the QC guard RIAZ-QC-COHORT-MINN-01 must pass on each stratum snapshot.',
    category: 'research_stratification',
    tags: [...TAGS, 'interpretation'],
    outputType: 'state_label',
    labels: ['ipi_independent', 'ipi_naive_only', 'ipi_progressed_only', 'no_induction'],
    scoringSchema: { kind: 'and', leaves: [`${INT_CYTO_CODE}@ipi_naive == cytotoxic_program_induced`, `${INT_CYTO_CODE}@ipi_progressed == cytotoxic_program_induced`] },
    evaluations: [
      { attributeKey: `rule_state:${INT_CYTO_CODE}@ipi_naive`, operator: '==', value: 'cytotoxic_program_induced', context: 'stratum', label: 'induction fires in ipi-naive' },
      { attributeKey: `rule_state:${INT_CYTO_CODE}@ipi_progressed`, operator: '==', value: 'cytotoxic_program_induced', context: 'stratum', label: 'induction fires in ipi-progressed' },
    ],
    confidenceHeuristic: { levels: [{ level: 'high', condition: 'both strata fire with ≥ 4 significant genes', value: 0.8 }, { level: 'medium', condition: 'both strata fire', value: 0.55 }, { level: 'low', condition: 'one stratum', value: 0.25 }] },
    guardOutput: { requireHumanReview: true, confidenceCap: 0.8 },
  });

const intDe = (): RuleDraft =>
  interpretRule({
    code: INT_DE,
    title: 'Pre-treatment DE signal present',
    question: 'Is there a non-trivial pre-treatment transcriptional difference between responders and non-responders?',
    signals: [`rule_score:${SUM_DE}`, 'summary_metric:n_sig', 'summary_metric:n_panel_sig'],
    logicSummary: '"baseline_signal_present" when n_sig ≥ 100 genes at padj < 0.05; "baseline_immune_signal" additionally when ≥ 6 of the 24 panel genes are significant; else "baseline_signal_absent".',
    risksNotes: 'A large n_sig can come from batch / purity differences between cohorts, not response biology. Compare with Q4 (paired panel) before concluding.',
    category: 'microenvironment_state',
    tags: [...TAGS, 'interpretation', 'de-table'],
    outputType: 'state_label',
    labels: ['baseline_immune_signal', 'baseline_signal_present', 'baseline_signal_absent'],
    scoringSchema: { kind: 'threshold', leaves: [{ metric: 'n_sig', operator: '>=', value: 100 }, { metric: 'n_panel_sig', operator: '>=', value: 6 }] },
    evaluations: [
      { attributeKey: 'n_sig', operator: '>=', value: 100, label: '≥ 100 genes at padj < 0.05' },
      { attributeKey: 'n_panel_sig', operator: '>=', value: 6, label: '≥ 6 panel genes at padj < 0.05' },
    ],
    expression: { type: 'OR', children: [{ type: 'LEAF', evaluationId: `${INT_DE}-eval-1` }, { type: 'LEAF', evaluationId: `${INT_DE}-eval-2` }] },
    confidenceHeuristic: { levels: [{ level: 'high', condition: 'both leaves fire', value: 0.8 }, { level: 'medium', condition: 'n_sig leaf only', value: 0.5 }, { level: 'low', condition: 'neither', value: 0.2 }] },
  });

const intStrata = (): RuleDraft =>
  interpretRule({
    code: INT_STRATA,
    title: 'Pre-treatment DE depends on prior ipilimumab',
    question: 'Is the pre-treatment R vs NR signal concentrated in one prior-ipilimumab stratum?',
    signals: [`rule_score:${SUM_STRATA}`, 'summary_metric:n_sig_ratio', 'assignment:stratum'],
    logicSummary: '"stratum_dependent" when n_sig(larger) / n_sig(smaller) ≥ 2; "stratum_balanced" otherwise.',
    risksNotes: 'Count ratio mixes effect size with per-stratum power; the two strata have different n and different response rates.',
    category: 'research_stratification',
    tags: [...TAGS, 'interpretation', 'de-table'],
    outputType: 'state_label',
    labels: ['stratum_dependent', 'stratum_balanced'],
    scoringSchema: { kind: 'threshold', leaves: [{ metric: 'n_sig_ratio', operator: '>=', value: 2 }] },
    evaluations: [{ attributeKey: 'n_sig_ratio', operator: '>=', value: 2, label: 'significant-gene count ratio ≥ 2 between strata' }],
    confidenceHeuristic: { levels: [{ level: 'high', condition: 'ratio ≥ 3', value: 0.75 }, { level: 'medium', condition: 'ratio ≥ 2', value: 0.5 }, { level: 'low', condition: 'ratio < 2', value: 0.3 }] },
  });

const intSens = (): RuleDraft =>
  interpretRule({
    code: INT_SENS,
    title: 'Paired-test sensitivity (t-test vs Wilcoxon)',
    question: 'Does the responder-restricted induction verdict survive swapping the paired t-test for the Wilcoxon signed-rank test?',
    signals: [`rule_score:${INT_RESP_CODE}`, 'summary_metric:wilcoxon_p', 'summary_metric:paired_ttest_p'],
    logicSummary: `"robust" when ${INT_RESP_CODE} gives the same state label under both tests; "test_dependent" otherwise.`,
    risksNotes: 'The delta threshold is test-independent, so disagreement can only come through the confidence heuristic (significant-gene counts).',
    category: 'knowledge_reuse',
    tags: [...TAGS, 'interpretation', 'sensitivity'],
    outputType: 'flag',
    labels: ['robust', 'test_dependent'],
    scoringSchema: { kind: 'equality', leaves: [`${INT_RESP_CODE}@paired_ttest == ${INT_RESP_CODE}@wilcoxon`] },
    evaluations: [{ attributeKey: `rule_state_agreement:${INT_RESP_CODE}`, operator: '==', value: true, context: 'sensitivity', label: 'same state label under both tests' }],
  });

// ── DECISION (authoring-only; terminal verdicts a DecisionDraft cites) ──────

export const DEC_BASELINE = 'RIAZ-DEC-BASELINE-01';
export const DEC_IPI = 'RIAZ-DEC-IPI-01';

const decBaseline = (): RuleDraft =>
  decisionRule({
    code: DEC_BASELINE,
    title: 'Baseline vs on-treatment — decision',
    question: 'Is this cohort consistent with Riaz 2017’s central claim that ON-treatment, not pre-treatment, immune state distinguishes responders?',
    signals: [`interpretation:${INT_BASELINE}`, `interpretation:${INT_RESP_CODE}`, 'provenance:governed_run'],
    logicSummary: `"on_treatment_not_baseline" when ${INT_BASELINE} = baseline_not_predictive AND ${INT_RESP_CODE} = responder_restricted; "both" when baseline predictive and induction restricted; "neither" otherwise.`,
    risksNotes: 'Two low-power contrasts combined; a null baseline is not evidence of absence.',
    category: 'composite_decision',
    tags: [...TAGS, 'decision'],
    decisionType: 'hypothesis_status',
    verdicts: ['on_treatment_not_baseline', 'both', 'neither'],
    disclaimers: ['RUO', 'bulk RNA-seq', 'n=9 responders'],
    evaluations: [
      { attributeKey: `interpretation:${INT_BASELINE}.state_label`, operator: '==', value: 'baseline_not_predictive', context: 'terminal', label: 'baseline not predictive' },
      { attributeKey: `interpretation:${INT_RESP_CODE}.state_label`, operator: '==', value: 'responder_restricted', context: 'terminal', label: 'induction responder-restricted' },
    ],
  });

const decIpi = (): RuleDraft =>
  decisionRule({
    code: DEC_IPI,
    title: 'Prior ipilimumab — decision',
    question: 'Should prior-ipilimumab exposure be carried as a stratification factor in any follow-up of the induction finding?',
    signals: [`interpretation:${INT_IPI}`, `interpretation:${INT_STRATA}`, 'provenance:governed_run'],
    logicSummary: `"stratify_in_follow_up" when ${INT_IPI} ≠ ipi_independent OR ${INT_STRATA} = stratum_dependent; else "no_stratification_needed".`,
    risksNotes: 'A stratum-restricted induction with 4–5 responders per stratum is a hypothesis, not a finding.',
    category: 'composite_decision',
    tags: [...TAGS, 'decision'],
    decisionType: 'research_stratification',
    verdicts: ['stratify_in_follow_up', 'no_stratification_needed'],
    disclaimers: ['RUO', 'per-stratum n ≤ 14'],
    evaluations: [
      { attributeKey: `interpretation:${INT_IPI}.state_label`, operator: '!=', value: 'ipi_independent', context: 'terminal', label: 'induction not ipi-independent' },
      { attributeKey: `interpretation:${INT_STRATA}.state_label`, operator: '==', value: 'stratum_dependent', context: 'terminal', label: 'baseline DE stratum-dependent' },
    ],
    expression: { type: 'OR', children: [{ type: 'LEAF', evaluationId: `${DEC_IPI}-eval-1` }, { type: 'LEAF', evaluationId: `${DEC_IPI}-eval-2` }] },
  });

// ── the library ─────────────────────────────────────────────────────────────

export interface LibraryEntry {
  code: string;
  protocol: ProtocolType;
  /** Executes on the platform today (QC only); everything else is authoring-only. */
  executable: boolean;
  make: () => RuleDraft;
  questions: string[];
}

const entry = (protocol: ProtocolType, make: () => RuleDraft, questions: string[]): LibraryEntry => ({ code: make().create.code as string, protocol, executable: protocol === 'QC_RULE', make, questions });

export const RIAZ_RULE_LIBRARY: LibraryEntry[] = [
  // Q1 (steps/riazGuidedRules.ts)
  entry('QC_RULE', q1Qc, ['Q1', 'Q2', 'Q3', 'Q10', 'Q11']),
  entry('INTERPRET_RULE', interpretCytoRule, ['Q1', 'Q5', 'Q7', 'Q11']),
  entry('INTERPRET_RULE', interpretRespRule, ['Q1', 'Q11']),
  entry('DECISION_RULE', q1Decision, ['Q1']),
  // QC
  entry('QC_RULE', qcCohortMinN, ['Q5', 'Q7']),
  entry('QC_RULE', qcDeTable, ['Q8', 'Q9']),
  // FEATURE
  entry('FEATURE_RULE', featIfng, ['Q3']),
  entry('FEATURE_RULE', featExh, ['Q6']),
  entry('FEATURE_RULE', featApm, ['Q10']),
  // SUMMARY
  entry('SUMMARY_RULE', sumDe, ['Q8']),
  entry('SUMMARY_RULE', sumStrata, ['Q9']),
  // STRATIFY
  entry('STRATIFY_RULE', stratResp, ['Q4', 'Q6', 'Q7']),
  entry('STRATIFY_RULE', stratIpi, ['Q5', 'Q9']),
  // INTERPRET
  entry('INTERPRET_RULE', intPd1, ['Q2']),
  entry('INTERPRET_RULE', intIfng, ['Q3']),
  entry('INTERPRET_RULE', intBaseline, ['Q4']),
  entry('INTERPRET_RULE', intIpi, ['Q5']),
  entry('INTERPRET_RULE', intExh, ['Q6']),
  entry('INTERPRET_RULE', intDe, ['Q8']),
  entry('INTERPRET_RULE', intStrata, ['Q9']),
  entry('INTERPRET_RULE', intApm, ['Q10']),
  entry('INTERPRET_RULE', intSens, ['Q11']),
  // DECISION
  entry('DECISION_RULE', decBaseline, ['Q4']),
  entry('DECISION_RULE', decIpi, ['Q5', 'Q9']),
];

export const Q1_CODES = [QC_RULE_CODE, INT_CYTO_CODE, INT_RESP_CODE, DEC_CODE];

export function rulesForQuestion(q: string): LibraryEntry[] {
  return RIAZ_RULE_LIBRARY.filter((e) => e.questions.includes(q.toUpperCase()));
}
