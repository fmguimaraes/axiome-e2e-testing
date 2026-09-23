import type { Verdict } from './riazQuestionVerdicts';
import type { UserChartPlan } from './riazUserCharts';

/**
 * Pure wording + per-question configuration for `stage:riaz-publish`: what a
 * question's evidence says (a short summary built from the kernel rows, never a
 * row dump), how it is titled, which charts back it and what the decision
 * claims. No network. Q11 is tuned; Q2–Q10 fall back to the generic wording
 * until their entry in `QUESTION_CONFIG` / `TEXT_OVERRIDES` is written.
 */

// ── per-question configuration ───────────────────────────────────────────────

export type DecisionType = 'phenotype_classification' | 'qc_assessment' | 'cohort_stratification' | 'biomarker_threshold' | 'assay_qualification';

export interface QuestionConfig {
  /** genes the question is about — named in the text, and the source-slice chart is filtered to them */
  focusGenes: readonly string[];
  /** cohort filter (as `column op value`) → how the text names the cohort */
  cohortNames: Record<string, string>;
  /** the claim the decision states, before the rule verdicts */
  decisionHeadline: (verdicts: Verdict[]) => string;
  /** which rule codes the decision label cites (default: all evaluated) */
  labelRules?: readonly string[];
  decisionType: DecisionType;
  /** AXI-1586 — additional, question-scoped user charts (Chart-Enrichment-Brief §2), each bound to its own evidence + optional extra interpretation. */
  userCharts?: readonly UserChartPlan[];
}

const DEFAULT_COHORT_NAMES: Record<string, string> = {
  'response eq R': 'responders',
  'response eq NR': 'non-responders',
  'prior_ipi eq ipi_naive': 'ipilimumab-naive patients',
  'prior_ipi eq ipi_progressed': 'ipilimumab-progressed patients',
  'timepoint eq Pre': 'pre-treatment samples',
  'timepoint eq On': 'on-treatment samples',
};

export const CYTOTOXIC_FOCUS = ['CD8A', 'PRF1', 'GZMB', 'IFNG', 'PDCD1', 'LAG3'] as const;

const verdictOf = (v: Verdict[], code: string): string | null => v.find((x) => ruleCode(x.rule) === code)?.verdict ?? null;

const IFNG_FOCUS = ['IFNG', 'CXCL9', 'CXCL10', 'CXCL11', 'IDO1', 'STAT1', 'IRF1', 'HLA-DRA'] as const;
const EXHAUSTION_FOCUS = ['LAG3', 'HAVCR2', 'TIGIT', 'CTLA4', 'TOX', 'PDCD1'] as const;
const APM_FOCUS = ['HLA-DRA', 'CD274'] as const;

const verdictHeadline = (v: Verdict[], code: string, prefix = ''): string => {
  const x = verdictOf(v, code);
  return `${prefix}${x ?? 'not evaluable'}`;
};

/** Chart-Enrichment-Brief §2 Q2 — PD-1 induced? (`PDCD1`). Charts 1/3/4/5 on WIDE, chart 2 on PAIRED. */
const Q2_USER_CHARTS: UserChartPlan[] = [
  {
    key: 'slope', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [{ column: 'gene', operator: 'eq', value: 'PDCD1' }],
    bindings: { from: 'pre_expression', to: 'on_expression', group: 'response' },
    title: 'Q2 · PDCD1 pre→on slope by patient (WIDE)',
    reading: '27 patient lines, pre-treatment to on-treatment PDCD1 expression. The responders’ lines mostly rise; the non-responders’ cross each other with no consistent direction.',
    interpretation: {
      label: 'PD-1 transcript is a T-cell infiltration read-out, not receptor occupancy',
      text: 'A rising PDCD1 transcript on treatment more plausibly reflects more PD-1+ T cells infiltrating the tumour than a change in PD-1 receptor occupancy per cell — the assay cannot distinguish the two, and the slope chart alone should not be read as a pharmacodynamic occupancy readout.',
    },
  },
  {
    key: 'facet', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [{ column: 'gene', operator: 'eq', value: 'PDCD1' }],
    bindings: { facet: 'response', x: 'timepoint', y: 'log2_cpm' },
    title: 'Q2 · PDCD1 by timepoint, faceted by response (PAIRED)',
    reading: 'PDCD1 log2 CPM by timepoint, one facet per response group. The Pre→On shift is visible only in the responder facet; the non-responder facet is flat.',
  },
  {
    key: 'scatter', templateId: 'paired_timepoint_scatter_v1', dataset: 'WIDE', filters: [{ column: 'gene', operator: 'eq', value: 'PDCD1' }],
    bindings: { x: 'pre_expression', y: 'on_expression', group: 'response' },
    title: 'Q2 · PDCD1 pre vs on scatter (WIDE)',
    reading: 'Each point is one patient’s pre- vs on-treatment PDCD1 expression. Points above the identity line are induced on treatment; responder points sit highest above the line.',
  },
  {
    key: 'strip', templateId: 'strip_v1', dataset: 'PAIRED', filters: [{ column: 'gene', operator: 'eq', value: 'PDCD1' }],
    bindings: { y: 'log2_cpm', group: 'timepoint', color: 'response' },
    title: 'Q2 · PDCD1 raw points by timepoint (PAIRED)',
    reading: 'Every individual PDCD1 measurement, no aggregation, grouped by timepoint and coloured by response — the honesty chart behind the mean-based tests above.',
  },
  {
    key: 'means', templateId: 'bar_grouped_v1', dataset: 'PAIRED', filters: [{ column: 'gene', operator: 'eq', value: 'PDCD1' }],
    bindings: { x: 'timepoint', y: 'log2_cpm', color: 'response' },
    params: { aggregation: 'mean' },
    title: 'Q2 · PDCD1 mean by timepoint and response (PAIRED)',
    reading: 'Mean PDCD1 log2 CPM per timepoint and response group. The four means show the pooled induction: a larger On−Pre rise in responders than in non-responders.',
    interpretation: {
      label: 'pooled induction is a responder effect, underpowered for non-responders',
      text: 'The pooled PDCD1 induction (RIAZ-INT-PD1-01, all patients) is driven almost entirely by the 9 responders; the non-responder arm alone is underpowered to detect an effect of this size, so its null result should not be read as "PD-1 is not induced in non-responders" — only as "not detected at this n".',
    },
  },
];

const eq = (column: string, value: unknown): UserChartPlan['filters'][number] => ({ column, operator: 'eq', value });
const inList = (column: string, value: readonly string[]): UserChartPlan['filters'][number] => ({ column, operator: 'in', value: [...value] });

/** Chart-Enrichment-Brief §2 Q3 — IFN-γ programme in responders (IFNG8). */
const Q3_USER_CHARTS: UserChartPlan[] = [
  { key: 'facetR', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('response', 'R'), inList('gene', IFNG_FOCUS)], bindings: { facet: 'gene', x: 'timepoint', y: 'log2_cpm' }, title: 'Q3 · IFN-γ panel by timepoint, responders (PAIRED)', reading: 'The 8-gene IFN-γ panel, Pre vs On, responders only, one facet per gene. Only 3 of 8 facets (IFNG, IRF1, HLA-DRA) show a visible Pre→On shift; the rest are flat.' },
  { key: 'slopeR', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [eq('response', 'R'), inList('gene', IFNG_FOCUS)], bindings: { from: 'pre_expression', to: 'on_expression', group: 'gene' }, title: 'Q3 · IFN-γ panel pre→on slope, responders (WIDE)', reading: 'Per-gene slope bundles for the IFN-γ panel in responders. The bundles for IFNG, IRF1 and HLA-DRA lean upward; the chemokine and IDO1/STAT1 bundles are mixed.' },
  { key: 'facetNR', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('response', 'NR'), inList('gene', IFNG_FOCUS)], bindings: { facet: 'gene', x: 'timepoint', y: 'log2_cpm' }, title: 'Q3 · IFN-γ panel by timepoint, non-responders (PAIRED)', reading: 'The same 8-gene panel in non-responders, as a contrast. The chemokine axis (CXCL9, CXCL10) moves here instead of in responders — the programme is not simply absent in non-responders, it moves on a different axis.' },
  { key: 'onRank', templateId: 'dot_plot_v1', dataset: 'PAIRED', filters: [eq('response', 'R'), eq('timepoint', 'On'), inList('gene', IFNG_FOCUS)], bindings: { x: 'log2_cpm', y: 'gene' }, title: 'Q3 · IFN-γ panel on-treatment ranking, responders (PAIRED)', reading: 'Mean on-treatment expression per gene, responders only, ranked. STAT1 and HLA-DRA sit at the top of the panel — already high before any induction is measured.' },
  {
    key: 'means', templateId: 'bar_grouped_v1', dataset: 'PAIRED', filters: [inList('gene', IFNG_FOCUS), eq('response', 'R')], bindings: { x: 'gene', y: 'log2_cpm', color: 'timepoint' }, params: { aggregation: 'mean' }, title: 'Q3 · IFN-γ panel Pre vs On means, responders (PAIRED)',
    reading: 'Pre vs On mean log2 CPM per gene, responders only. The panel-wide picture behind the per-gene test: some genes rise, several are already high at baseline.',
    interpretation: { label: 'the programme is already on at baseline in responders — ceiling, not absence', text: 'STAT1 and HLA-DRA read high already at the pre-treatment biopsy in responders; a gene that starts near its assay ceiling has little room left to rise further on treatment, so the 3-of-8 induction count understates how much of the IFN-γ programme is already active before therapy starts.' },
  },
];

/** Chart-Enrichment-Brief §2 Q4 — baseline separation (CYTO at Pre). */
const Q4_USER_CHARTS: UserChartPlan[] = [
  { key: 'facet', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { facet: 'gene', x: 'response', y: 'log2_cpm' }, title: 'Q4 · Cytotoxic panel at Pre, by response (PAIRED)', reading: 'The 6-gene cytotoxic panel at the pre-treatment biopsy, one facet per gene, responders vs non-responders. Every facet shows overlapping boxes — no gene separates the two groups at baseline.' },
  { key: 'cd8aViolin', templateId: 'violin_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), eq('gene', 'CD8A')], bindings: { y: 'log2_cpm', group: 'response' }, title: 'Q4 · CD8A at Pre, full distribution (PAIRED)', reading: 'CD8A at Pre is the closest call in the panel (p .076) — the violin shows the full shape behind that near-miss, not just the box summary.' },
  { key: 'cd8aEcdf', templateId: 'ecdf_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), eq('gene', 'CD8A')], bindings: { x: 'log2_cpm', color: 'response' }, title: 'Q4 · CD8A at Pre, ECDF (PAIRED)', reading: 'Empirical CDFs of CD8A at Pre by response. The two curves nearly coincide — the rank-based view a Mann-Whitney-style test would see.' },
  { key: 'ridgeR', templateId: 'ridgeline_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), eq('response', 'R'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { y: 'log2_cpm', group: 'gene' }, title: 'Q4 · Cytotoxic panel baseline landscape, responders (PAIRED)', reading: 'Responders’ baseline expression landscape across the cytotoxic panel, one ridge per gene — the density behind the boxplots.' },
  { key: 'strip', templateId: 'strip_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { y: 'log2_cpm', group: 'gene', color: 'response' }, title: 'Q4 · Cytotoxic panel at Pre, every patient (PAIRED)', reading: 'Every individual baseline measurement across the cytotoxic panel, coloured by response — no aggregation.', interpretation: { label: 'a CD8A/PDCD1/LAG3 trend at n=27 — a powered study could turn it', text: 'None of the six baseline comparisons reaches p<0.05, but CD8A, PDCD1 and LAG3 all trend toward higher pre-treatment expression in responders; at n=27 this cohort is underpowered to resolve an effect of that size, so "not predictive here" is a power statement, not a biological one.' } },
];

/** Chart-Enrichment-Brief §2 Q5 — prior ipilimumab exposure (CYTO). PAIRED for the two strata; WIDE v2 (has `prior_ipi` now) for the slope chart the brief adds once that column exists. */
const Q5_USER_CHARTS: UserChartPlan[] = [
  { key: 'naive', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [inList('gene', CYTOTOXIC_FOCUS), eq('prior_ipi', 'ipi_naive')], bindings: { facet: 'gene', x: 'timepoint', y: 'log2_cpm' }, title: 'Q5 · Cytotoxic panel by timepoint, ipi-naive (PAIRED)', reading: 'The cytotoxic panel, Pre vs On, ipilimumab-naive patients only. All 6 facets rise on treatment.' },
  { key: 'progressed', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [inList('gene', CYTOTOXIC_FOCUS), eq('prior_ipi', 'ipi_progressed')], bindings: { facet: 'gene', x: 'timepoint', y: 'log2_cpm' }, title: 'Q5 · Cytotoxic panel by timepoint, ipi-progressed (PAIRED)', reading: 'The same panel in ipilimumab-progressed patients — the twin chart. None of the 6 facets rises.' },
  { key: 'twoPanel', templateId: 'faceted_grouped_line_v1', dataset: 'PAIRED', filters: [inList('gene', CYTOTOXIC_FOCUS)], bindings: { facet: 'prior_ipi', x: 'timepoint', y: 'log2_cpm', color: 'gene' }, title: 'Q5 · Cytotoxic panel by prior ipilimumab exposure (PAIRED)', reading: 'Both strata in one figure, one panel per prior-ipilimumab group, mean±SE per gene — the naive-vs-progressed contrast as a single picture.' },
  { key: 'onLevel', templateId: 'bar_grouped_v1', dataset: 'PAIRED', filters: [inList('gene', CYTOTOXIC_FOCUS), eq('timepoint', 'On')], bindings: { x: 'gene', y: 'log2_cpm', color: 'prior_ipi' }, params: { aggregation: 'mean' }, title: 'Q5 · Cytotoxic panel on-treatment level by stratum (PAIRED)', reading: 'On-treatment mean level per gene, split by prior ipilimumab exposure — the induction difference collapsed to a single timepoint.' },
  {
    key: 'slope', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [inList('gene', CYTOTOXIC_FOCUS)], bindings: { from: 'pre_expression', to: 'on_expression', group: 'prior_ipi' }, title: 'Q5 · Cytotoxic panel pre→on slope by prior ipilimumab exposure (WIDE)',
    reading: 'Per-patient Pre→On slopes for the cytotoxic panel, grouped by prior ipilimumab exposure — the individual-patient view behind the two faceted boxplots above.',
    interpretation: { label: 'power: a 13 vs 14 patient design constraint, not necessarily a mechanism', text: 'The ipi-naive and ipi-progressed arms split roughly 13 vs 14 patients, with a different responder mix in each (5 R in naive vs 4 R in progressed); a cleaner "cold tumour" biological story is possible, but this split alone cannot separate a biological effect of prior ipilimumab from an underpowered, response-imbalanced subgroup comparison.' },
  },
];

/** Chart-Enrichment-Brief §2 Q6 — exhaustion markers at On, R vs NR (EXH). */
const Q6_USER_CHARTS: UserChartPlan[] = [
  { key: 'facet', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On'), inList('gene', EXHAUSTION_FOCUS)], bindings: { facet: 'gene', x: 'response', y: 'log2_cpm' }, title: 'Q6 · Exhaustion panel at On, by response (PAIRED)', reading: 'The 6-gene exhaustion/checkpoint panel at the on-treatment biopsy, one facet per gene. 5 of 6 facets separate responders from non-responders.' },
  { key: 'pdcd1Violin', templateId: 'violin_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On'), eq('gene', 'PDCD1')], bindings: { y: 'log2_cpm', group: 'response' }, title: 'Q6 · PDCD1 at On, full distribution (PAIRED)', reading: 'PDCD1 at On is the strongest separator in the panel (p .002) — the full distribution behind that result.' },
  { key: 'toxEcdf', templateId: 'ecdf_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On'), eq('gene', 'TOX')], bindings: { x: 'log2_cpm', color: 'response' }, title: 'Q6 · TOX at On, ECDF (PAIRED)', reading: 'Empirical CDFs of TOX at On by response — the rank shift a Mann-Whitney-style test reads as significant.' },
  { key: 'onRank', templateId: 'dot_plot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On'), inList('gene', EXHAUSTION_FOCUS)], bindings: { x: 'log2_cpm', y: 'gene' }, title: 'Q6 · Exhaustion panel on-treatment means (PAIRED)', reading: 'Mean on-treatment expression per exhaustion/checkpoint gene, ranked.' },
  { key: 'ctla4Strip', templateId: 'strip_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On'), eq('gene', 'CTLA4')], bindings: { y: 'log2_cpm', group: 'response' }, title: 'Q6 · CTLA4 at On, every patient (PAIRED)', reading: 'CTLA4 at On, every patient, by response — the one exhaustion-panel gene that does NOT separate responders from non-responders.', interpretation: { label: 'CTLA4 is the outlier — checkpoint ≠ exhaustion', text: 'CTLA4 is a checkpoint receptor expressed broadly on activated T cells, not a canonical exhaustion marker the way TOX, HAVCR2 or LAG3 are; its failure to separate responders from non-responders here is consistent with "checkpoint expression" and "exhaustion state" being related but not interchangeable readouts.' } },
];

/** Chart-Enrichment-Brief §2 Q7 — non-responder negative control (CYTO). */
const Q7_USER_CHARTS: UserChartPlan[] = [
  { key: 'facetNR', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('response', 'NR'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { facet: 'gene', x: 'timepoint', y: 'log2_cpm' }, title: 'Q7 · Cytotoxic panel by timepoint, non-responders (PAIRED)', reading: 'The cytotoxic panel, Pre vs On, non-responders only. Every facet is flat — the negative control the responder induction is compared against.' },
  { key: 'slopeNR', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [eq('response', 'NR'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { from: 'pre_expression', to: 'on_expression', group: 'gene' }, title: 'Q7 · Cytotoxic panel pre→on slope, non-responders (WIDE)', reading: 'Per-patient Pre→On slopes for the cytotoxic panel in non-responders — the lines cross with no consistent direction per gene.', interpretation: { label: 'LAG3 is the only NR mover — a partial response signature?', text: 'While the non-responder arm shows no panel-wide induction, LAG3 alone trends upward (+0.32) in this group; whether that single-gene movement marks a partial, sub-RECIST immune response is not testable from this cohort but is worth flagging rather than folding into "the same rule stays silent".' } },
  { key: 'slopeR', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [eq('response', 'R'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { from: 'pre_expression', to: 'on_expression', group: 'gene' }, title: 'Q7 · Cytotoxic panel pre→on slope, responders (WIDE)', reading: 'The same slope chart for responders, side by side with the non-responder version — the mirror image: lines rise consistently.' },
  { key: 'cd8aScatter', templateId: 'paired_timepoint_scatter_v1', dataset: 'WIDE', filters: [eq('gene', 'CD8A')], bindings: { x: 'pre_expression', y: 'on_expression', group: 'response' }, title: 'Q7 · CD8A pre vs on scatter, both groups (WIDE)', reading: 'CD8A pre- vs on-treatment for every patient. Non-responder points sit on the identity line; responder points sit above it.' },
];

/** Chart-Enrichment-Brief §2 Q8 — baseline DE signal, no filter (DE table). */
const RIAZ_24_PANEL = ['CD27', 'CD274', 'CD3E', 'CD8A', 'CTLA4', 'CXCL10', 'CXCL11', 'CXCL9', 'GZMA', 'GZMB', 'HAVCR2', 'HLA-DRA', 'IDO1', 'IFNG', 'IL2RA', 'IRF1', 'LAG3', 'LCK', 'NKG7', 'PDCD1', 'PRF1', 'STAT1', 'TIGIT', 'TOX'];
const Q8_USER_CHARTS: UserChartPlan[] = [
  { key: 'volcano', templateId: 'volcano_v1', dataset: 'DE', filters: [], bindings: { x: 'log2FoldChange', y: 'pvalue' }, title: 'Q8 · Baseline DE volcano, tested universe (DE)', reading: 'log2 fold-change vs p-value for every tested gene in the pre-therapy responder-vs-non-responder contrast. 58 points clear the significance line out of 22,333 genes tested.' },
  { key: 'ma', templateId: 'ma_plot_v1', dataset: 'DE', filters: [], bindings: { x: 'baseMean', y: 'log2FoldChange' }, title: 'Q8 · Baseline DE MA plot (DE)', reading: 'Mean expression vs fold-change for every tested gene. The significant hits cluster at low baseMean — low-expression genes, not the high-expression immune panel.' },
  { key: 'pHist', templateId: 'histogram_v1', dataset: 'DE', filters: [], bindings: { x: 'pvalue' }, title: 'Q8 · Baseline DE p-value distribution (DE)', reading: 'The distribution of raw p-values across the tested universe. A near-uniform histogram is the signature of little true signal — the shape a well-calibrated null test produces when most genes do not differ.' },
  { key: 'padjEcdf', templateId: 'ecdf_v1', dataset: 'DE', filters: [], bindings: { x: 'padj' }, title: 'Q8 · Baseline DE padj ECDF (DE)', reading: 'Empirical CDF of adjusted p-values. How fast padj climbs toward 1 across the tested universe.' },
  {
    key: 'panelVolcano', templateId: 'volcano_v1', dataset: 'DE', filters: [inList('gene', RIAZ_24_PANEL)], bindings: { x: 'log2FoldChange', y: 'pvalue' }, title: 'Q8 · Baseline DE volcano, 24-gene immune panel (DE)',
    reading: 'The same volcano, restricted to the 24-gene immune panel this demo tracks elsewhere. Every panel gene sits above the significance line in this baseline contrast — the panel is not where the 58 significant hits live.',
    interpretation: { label: 'signal present but non-immune — a composition artefact', text: 'The 58 baseline-significant genes are not absent of signal; they include lncRNAs, keratins and tissue-structural genes rather than immune-panel genes, consistent with sample composition (tumour purity, biopsy site) rather than a true baseline immune difference between responders and non-responders.' },
  },
];

/** Chart-Enrichment-Brief §2 Q9 — stratum dependence (DE-STRATA). */
const Q9_USER_CHARTS: UserChartPlan[] = [
  { key: 'volcanoNaive', templateId: 'volcano_v1', dataset: 'DE_STRATA', filters: [eq('stratum', 'ipi_naive')], bindings: { x: 'log2FoldChange', y: 'pvalue' }, title: 'Q9 · DE volcano, ipi-naive stratum (DE-STRATA)', reading: 'The pre-therapy responder-vs-non-responder contrast re-run within the ipilimumab-naive arm alone. 33 genes clear significance.' },
  { key: 'volcanoProgressed', templateId: 'volcano_v1', dataset: 'DE_STRATA', filters: [eq('stratum', 'ipi_progressed')], bindings: { x: 'log2FoldChange', y: 'pvalue' }, title: 'Q9 · DE volcano, ipi-progressed stratum (DE-STRATA)', reading: 'The same contrast within the ipilimumab-progressed arm. 50 genes clear significance — more than the naive arm despite a similar-sized cohort.' },
  { key: 'pHist', templateId: 'histogram_color_v1', dataset: 'DE_STRATA', filters: [], bindings: { x: 'pvalue', color: 'stratum' }, title: 'Q9 · DE p-value distribution by stratum (DE-STRATA)', reading: 'Raw p-value distributions for both strata overlaid. Both are near-uniform — neither arm shows an unusually inflated test.' },
  { key: 'padjEcdf', templateId: 'ecdf_v1', dataset: 'DE_STRATA', filters: [], bindings: { x: 'padj', color: 'stratum' }, title: 'Q9 · DE padj ECDF by stratum (DE-STRATA)', reading: 'Empirical CDFs of adjusted p-value by stratum. The curves overlap closely — a balanced testing picture despite the different hit counts.' },
  {
    key: 'countBar', templateId: 'bar_count_v1', dataset: 'DE_STRATA', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }], bindings: { x: 'stratum' }, title: 'Q9 · Significant genes by stratum, padj<0.05 (DE-STRATA)',
    reading: 'The count of padj<0.05 genes in each stratum, in one bar chart: 33 in ipi-naive vs 50 in ipi-progressed.',
    interpretation: { label: 'prior therapy reshapes the baseline, not just the noise floor', text: 'The progressed stratum returns more significant genes than the naive stratum despite a comparable patient count, which is more consistent with prior ipilimumab exposure genuinely reshaping the baseline transcriptome than with a pure power/variance artefact — though the p-value and padj distributions above show neither arm’s TEST itself is miscalibrated.' },
  },
];

/** Chart-Enrichment-Brief §2 Q10 — antigen presentation / PD-L1 (APM = HLA-DRA, CD274). */
const Q10_USER_CHARTS: UserChartPlan[] = [
  { key: 'facet', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [inList('gene', APM_FOCUS)], bindings: { facet: 'gene', x: 'timepoint', y: 'log2_cpm', group: 'response' }, title: 'Q10 · Antigen-presentation panel by timepoint and response (PAIRED)', reading: 'HLA-DRA and CD274, Pre vs On, split by response. HLA-DRA moves only in responders; CD274 moves in both groups.' },
  { key: 'slopeHla', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [eq('gene', 'HLA-DRA')], bindings: { from: 'pre_expression', to: 'on_expression', group: 'response' }, title: 'Q10 · HLA-DRA pre→on slope by response (WIDE)', reading: 'Per-patient HLA-DRA slopes, grouped by response — the responder-specific rise behind the faceted panel.' },
  { key: 'slopeCd274', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [eq('gene', 'CD274')], bindings: { from: 'pre_expression', to: 'on_expression', group: 'response' }, title: 'Q10 · CD274 pre→on slope by response (WIDE)', reading: 'Per-patient CD274 (PD-L1 transcript) slopes, grouped by response — rising lines in both groups.' },
  { key: 'scatter', templateId: 'paired_timepoint_scatter_v1', dataset: 'WIDE', filters: [inList('gene', APM_FOCUS)], bindings: { x: 'pre_expression', y: 'on_expression', group: 'response' }, title: 'Q10 · Antigen-presentation panel pre vs on scatter (WIDE)', reading: 'HLA-DRA and CD274 pre- vs on-treatment, every patient, by response — both genes sit above the identity line more often in responders.' },
  {
    key: 'means', templateId: 'bar_grouped_v1', dataset: 'PAIRED', filters: [inList('gene', APM_FOCUS)], bindings: { x: 'gene', y: 'log2_cpm', color: 'timepoint' }, params: { aggregation: 'mean' }, title: 'Q10 · Antigen-presentation panel Pre vs On means (PAIRED)',
    reading: 'Pre vs On mean expression for HLA-DRA and CD274 — the panel-wide summary behind the per-gene and per-response charts above.',
    interpretation: { label: 'PD-L1 rises regardless — adaptive resistance in non-responders too', text: 'CD274 (PD-L1) rises on treatment in both responders and non-responders, unlike the responder-restricted HLA-DRA induction; a PD-L1 rise in non-responders is consistent with adaptive immune resistance occurring without a productive antitumour response, not with PD-L1 induction being a response biomarker on its own.' },
  },
];

/** Chart-Enrichment-Brief §2 Q11 — Wilcoxon sensitivity (CYTO), on top of the 2 recommended `boxplot_v1`. */
const Q11_USER_CHARTS: UserChartPlan[] = [
  { key: 'slopeR', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [eq('response', 'R'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { from: 'pre_expression', to: 'on_expression', group: 'gene' }, title: 'Q11 · Cytotoxic panel pre→on slope, responders (WIDE)', reading: 'Per-patient Pre→On slopes for the cytotoxic panel in responders — the individual-patient view behind the Wilcoxon signed-rank result.' },
  { key: 'strip', templateId: 'strip_v1', dataset: 'PAIRED', filters: [eq('response', 'R'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { y: 'log2_cpm', group: 'gene', color: 'timepoint' }, title: 'Q11 · Cytotoxic panel raw points, responders (PAIRED)', reading: 'Every individual cytotoxic-panel measurement in responders, by gene and timepoint, no aggregation — what a rank-based test sees instead of a mean.' },
  {
    key: 'cd8aEcdf', templateId: 'ecdf_v1', dataset: 'PAIRED', filters: [eq('gene', 'CD8A'), eq('response', 'R')], bindings: { x: 'log2_cpm', color: 'timepoint' }, title: 'Q11 · CD8A ECDF, responders (PAIRED)',
    reading: 'Empirical CDFs of CD8A by timepoint, responders only — the rank shift a Wilcoxon signed-rank test detects even where a paired t-test on the mean does not.',
    interpretation: { label: 'CD8A becomes significant under Wilcoxon — the t-test was the conservative one', text: 'CD8A does not clear p<0.05 under the paired t-test but does under the Wilcoxon signed-rank test in this cohort; a rank-based test is less sensitive to the handful of large/skewed measurements that inflate the t-test’s variance estimate, so the t-test result here is the conservative read, not the more trustworthy one.' },
  },
];

// ── AXI-1588 — Q12–Q21 (Chart-Enrichment-Brief §2, describe questions) ──────
// Q12–Q21 publish through `publishDescribeOne` (AXI-1565/AXI-1587), same as
// Q22–Q31 below: the sentence evidence + `descriptive_summary` decision are
// the platform's own; `userCharts` is the only field this config contributes.
const RIAZ_24_PANEL_Q = ['CD27', 'CD274', 'CD3E', 'CD8A', 'CTLA4', 'CXCL10', 'CXCL11', 'CXCL9', 'GZMA', 'GZMB', 'HAVCR2', 'HLA-DRA', 'IDO1', 'IFNG', 'IL2RA', 'IRF1', 'LAG3', 'LCK', 'NKG7', 'PDCD1', 'PRF1', 'STAT1', 'TIGIT', 'TOX'];

/** Chart-Enrichment-Brief §2 Q12 — baseline composition (all-panel ranking at Pre). */
const Q12_USER_CHARTS: UserChartPlan[] = [
  { key: 'dot', templateId: 'dot_plot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), inList('gene', RIAZ_24_PANEL_Q)], bindings: { x: 'log2_cpm', y: 'gene' }, title: 'Q12 · Baseline mean log2 CPM per gene, ranked (PAIRED, dot plot)', reading: 'Mean pre-treatment log2 CPM per gene across all 27 patients, ranked. HLA-DRA (9.76) and STAT1 (8.50) lead the panel; IFNG (1.14) sits lowest — the ranking this question reports as a chart.' },
  { key: 'ridge', templateId: 'ridgeline_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), inList('gene', RIAZ_24_PANEL_Q)], bindings: { y: 'log2_cpm', group: 'gene' }, title: 'Q12 · Baseline expression landscape, all genes (PAIRED, ridgeline)', reading: 'The full baseline distribution per gene, not just its mean — one ridge per gene. HLA-DRA\'s ridge sits well clear of the low end where IFNG\'s sits.' },
  {
    key: 'strip', templateId: 'strip_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), inList('gene', RIAZ_24_PANEL_Q)], bindings: { y: 'log2_cpm', group: 'gene' }, title: 'Q12 · Baseline, every patient by gene (PAIRED, strip)',
    reading: 'Every individual pre-treatment measurement across the 24-gene panel, no aggregation — the raw points the mean ranking is built from.',
    interpretation: { label: 'a ranked mean can hide within-gene spread', text: 'HLA-DRA\'s rank-1 mean (9.76) sits on a wide spread of individual points in the strip chart, while several mid-panel genes show tighter distributions; ranking by mean alone treats a wide-spread gene and a tight-spread gene with the same central value as equivalent, which they are not for individual-patient interpretation.' },
  },
];

/** Chart-Enrichment-Brief §2 Q13 — does the panel move Pre→On, full 48-cell cross-tab. */
const Q13_USER_CHARTS: UserChartPlan[] = [
  { key: 'facetLine', templateId: 'faceted_grouped_line_v1', dataset: 'PAIRED', filters: [], bindings: { facet: 'gene', x: 'timepoint', y: 'log2_cpm', color: 'response' }, title: 'Q13 · Full panel by timepoint, faceted by gene, coloured by response (PAIRED)', reading: 'Mean ± SE per gene, Pre vs On, one facet per gene, coloured by response — the 48-cell cross-tab as small multiples. Most facets rise Pre→On; a handful stay flat.' },
  { key: 'slope', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [], bindings: { from: 'pre_expression', to: 'on_expression', group: 'gene' }, title: 'Q13 · Full panel pre→on slope by gene (WIDE)', reading: 'Per-patient, per-gene Pre→On slopes across the full 24-gene panel — the individual lines behind the 48 cell means the cross-tab reports.' },
  {
    key: 'means', templateId: 'bar_grouped_v1', dataset: 'PAIRED', filters: [], bindings: { x: 'gene', y: 'log2_cpm', color: 'timepoint' }, params: { aggregation: 'mean' }, title: 'Q13 · Full panel Pre vs On means, all genes (PAIRED)',
    reading: 'Pre and On means side by side for all 24 genes — the panel-wide summary the cross-tab table lists cell by cell.',
    interpretation: { label: 'the cross-tab reports magnitude, not consistency across patients', text: 'A gene can show a rising mean while its per-patient slopes are mixed — several genes here have a positive mean Pre→On move but a wide slope spread in the WIDE chart above, so a rising cell mean should not be read as "every patient rose".' },
  },
];

/** Chart-Enrichment-Brief §2 Q14 — cohort composition (CD8A@Pre slice, response × prior_ipi). */
const Q14_USER_CHARTS: UserChartPlan[] = [
  { key: 'byResponse', templateId: 'bar_count_v1', dataset: 'PAIRED', filters: [eq('gene', 'CD8A'), eq('timepoint', 'Pre')], bindings: { x: 'response' }, title: 'Q14 · Patient count by response, CD8A@Pre slice (PAIRED)', reading: '18 non-responders vs 9 responders in the slice this question\'s four-cell breakdown is built from.' },
  { key: 'sunburst', templateId: 'sunburst_v1', dataset: 'PAIRED', filters: [eq('gene', 'CD8A'), eq('timepoint', 'Pre')], bindings: { labels: 'prior_ipi', parents: 'response' }, title: 'Q14 · Response × prior ipilimumab exposure composition (PAIRED, sunburst)', reading: 'The same four cells as a hierarchy — response as the inner ring, prior ipilimumab exposure as the outer ring. Non-responders split evenly (9/9); responders skew slightly toward ipi-naive (5 vs 4).' },
  {
    key: 'byIpi', templateId: 'bar_count_v1', dataset: 'PAIRED', filters: [eq('gene', 'CD8A'), eq('timepoint', 'Pre')], bindings: { x: 'prior_ipi' }, title: 'Q14 · Patient count by prior ipilimumab exposure, CD8A@Pre slice (PAIRED)',
    reading: 'The same slice counted the other way — 14 ipilimumab-naive vs 13 ipilimumab-progressed patients, a near-even split independent of response.',
    interpretation: { label: 'the four-cell split is balanced enough not to confound Q5\'s stratified test', text: 'Q5\'s ipi-naive vs ipi-progressed induction comparison rests on a 14 vs 13 split with a similar response mix in each (5R/9NR vs 4R/9NR); this count composition confirms neither arm is response-enriched enough on its own to explain the induction difference Q5 reports.' },
  },
];

/** Chart-Enrichment-Brief §2 Q15 — top-10 baseline DE genes by fold change, padj<0.05. */
const Q15_USER_CHARTS: UserChartPlan[] = [
  {
    key: 'lollipop', templateId: 'lollipop_v1', dataset: 'DE', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }], bindings: { x: 'gene', y: 'log2FoldChange' }, title: 'Q15 · Baseline DE genes ranked by fold change, padj<0.05 (DE, lollipop)',
    reading: 'The padj<0.05 pool (58 genes), ranked by fold change — C20orf166-AS1 (13.92), LINC00890 (9.25), FCAMR (5.70) and VGF (5.24) lead; PRG4 (3.30) closes the top 10 this question names.',
    interpretation: { label: 'the top fold-change ranking is dominated by low-expression genes — a candidate list, not a validated biomarker panel', text: 'C20orf166-AS1 and LINC00890, the two largest fold changes in this ranking, are lncRNAs at low baseline expression (the same low-baseMean pattern Q8\'s MA plot shows for the wider significant set); a large fold change on a low-expression gene is more sensitive to counting noise than the same fold change on a well-expressed gene, so this top-10 list should be read as a candidate list for follow-up, not a validated baseline biomarker panel.' },
  },
  { key: 'volcano', templateId: 'volcano_v1', dataset: 'DE', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }], bindings: { x: 'log2FoldChange', y: 'pvalue' }, title: 'Q15 · Baseline DE volcano, padj<0.05 (DE)', reading: 'The 58 significant genes alone. The top-10 by fold change this question ranks sit at the far-right tail of this volcano.' },
  { key: 'ma', templateId: 'ma_plot_v1', dataset: 'DE', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }], bindings: { x: 'baseMean', y: 'log2FoldChange' }, title: 'Q15 · Baseline DE MA plot, padj<0.05 (DE)', reading: 'Mean expression vs fold-change for the 58 significant genes — the top-ranked genes (C20orf166-AS1, LINC00890) sit at low baseMean, the same low-expression pattern Q8 flags for the wider significant set.' },
];

/** Chart-Enrichment-Brief §2 Q16 — up vs down at padj<0.05 (25 up, 33 down of 58). */
const Q16_USER_CHARTS: UserChartPlan[] = [
  { key: 'hist', templateId: 'histogram_v1', dataset: 'DE', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }], bindings: { x: 'log2FoldChange' }, title: 'Q16 · log2FC distribution, padj<0.05 (DE, histogram)', reading: 'The fold-change distribution of the 58 significant genes — visibly bimodal, one lobe positive (25 genes) and one negative (33 genes), the two counts this question reports as a single picture.' },
  { key: 'upBar', templateId: 'bar_count_v1', dataset: 'DE', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }, { column: 'log2FoldChange', operator: 'gt', value: 0 }], bindings: { x: 'gene' }, title: 'Q16 · Up-regulated genes, padj<0.05 (DE, bar count)', reading: 'Each of the 25 up-regulated genes (log2FC>0, padj<0.05) as its own bar — the "up" branch this question counts, enumerated one gene per bar.' },
  {
    key: 'downBar', templateId: 'bar_count_v1', dataset: 'DE', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }, { column: 'log2FoldChange', operator: 'lt', value: 0 }], bindings: { x: 'gene' }, title: 'Q16 · Down-regulated genes, padj<0.05 (DE, bar count)',
    reading: 'Each of the 33 down-regulated genes as its own bar — the "down" branch, the larger of the two this question counts.',
    interpretation: { label: 'more genes fall than rise — but gene count is not the same as fold-change magnitude', text: 'The down branch (33 genes) outnumbers the up branch (25) at padj<0.05; that gene-count split says nothing about which direction carries the larger average fold change — a stratum-level fold-change mean (as Q30 reports for DE-STRATA) should be read alongside this count, not substituted for it.' },
  },
  { key: 'ecdf', templateId: 'ecdf_v1', dataset: 'DE', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }], bindings: { x: 'log2FoldChange' }, title: 'Q16 · log2FC ECDF, padj<0.05 (DE)', reading: 'Empirical CDF of fold-change across the 58 significant genes — the step where the curve crosses zero marks the 25/33 up/down split this question counts directly.' },
];

/** Chart-Enrichment-Brief §2 Q17 — responder induction, full panel Pre→On in R only. */
const Q17_USER_CHARTS: UserChartPlan[] = [
  { key: 'slope', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [eq('response', 'R')], bindings: { from: 'pre_expression', to: 'on_expression', group: 'gene' }, title: 'Q17 · Full panel pre→on slope, responders (WIDE)', reading: 'Per-patient, per-gene Pre→On slopes in responders only — the individual lines behind this question\'s per-gene means (e.g. PDCD1 2.00→3.38, PRF1 3.53→4.91).' },
  { key: 'facet', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('response', 'R')], bindings: { facet: 'gene', x: 'timepoint', y: 'log2_cpm' }, title: 'Q17 · Full panel by timepoint, faceted by gene, responders (PAIRED)', reading: 'Pre vs On boxplots, one facet per gene, responders only. Most facets shift upward; CXCL11 is already high at On (mean 3.41, n=9).' },
  {
    key: 'onRank', templateId: 'bar_horizontal_v1', dataset: 'PAIRED', filters: [eq('response', 'R'), eq('timepoint', 'On')], bindings: { y: 'gene', x: 'log2_cpm' }, params: { aggregation: 'mean' }, title: 'Q17 · Full panel on-treatment mean, ranked, responders (PAIRED, bar horizontal)',
    reading: 'On-treatment mean per gene in responders, ranked — the fallback ranking chart for the Pre→On magnitude this question\'s cross-tab lists cell by cell (a result-table waterfall is not available on the userCharts source datasets).',
    interpretation: { label: 'on-treatment ranking mixes genes that rose with genes that started high', text: 'A gene can rank near the top of the on-treatment ranking either because it rose the most (like PDCD1) or because it started high and barely moved (like HLA-DRA, Q12); this ranked bar should be read together with the slope chart above, not as a standalone induction ranking.' },
  },
];

/** Chart-Enrichment-Brief §2 Q18 — CXCL9 four groups (response × timepoint). */
const Q18_USER_CHARTS: UserChartPlan[] = [
  { key: 'facet', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('gene', 'CXCL9')], bindings: { facet: 'response', x: 'timepoint', y: 'log2_cpm' }, title: 'Q18 · CXCL9 by timepoint, faceted by response (PAIRED)', reading: 'CXCL9 Pre vs On, one facet per response group. Responders start higher (7.24) and end higher (7.73); non-responders start lower (5.39) and rise to 6.23 without closing the gap.' },
  { key: 'slope', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [eq('gene', 'CXCL9')], bindings: { from: 'pre_expression', to: 'on_expression', group: 'response' }, title: 'Q18 · CXCL9 pre→on slope by response (WIDE)', reading: 'Per-patient CXCL9 slopes, grouped by response — the individual lines behind the four group means.' },
  { key: 'violin', templateId: 'violin_v1', dataset: 'PAIRED', filters: [eq('gene', 'CXCL9')], bindings: { y: 'log2_cpm', group: 'timepoint' }, title: 'Q18 · CXCL9 full distribution by timepoint (PAIRED, violin)', reading: 'The full CXCL9 distribution at each timepoint, both response groups pooled — the shape behind the four cell means.' },
  {
    key: 'ecdf', templateId: 'ecdf_v1', dataset: 'PAIRED', filters: [eq('gene', 'CXCL9')], bindings: { x: 'log2_cpm', color: 'response' }, title: 'Q18 · CXCL9 ECDF by response (PAIRED)',
    reading: 'Empirical CDFs of CXCL9 by response, both timepoints pooled — the responder curve sits consistently to the right of the non-responder curve.',
    interpretation: { label: 'CXCL9 separates responders from non-responders at both timepoints, not just after treatment', text: 'The ECDF curves are already separated before the Pre→On rise either group shows; CXCL9 reads as at least as much a baseline separator as a treatment-induced marker.' },
  },
];

/** Chart-Enrichment-Brief §2 Q19 — on-treatment gap, full panel by response. */
const Q19_USER_CHARTS: UserChartPlan[] = [
  { key: 'facet', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On')], bindings: { facet: 'gene', x: 'response', y: 'log2_cpm' }, title: 'Q19 · Full panel at On, faceted by gene, by response (PAIRED)', reading: 'On-treatment expression, one facet per gene, responders vs non-responders. CD8A, LCK and CD3E show the widest separation (e.g. CD8A 6.10 vs 3.55).' },
  { key: 'rank', templateId: 'dot_plot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On')], bindings: { x: 'log2_cpm', y: 'gene' }, title: 'Q19 · Full panel on-treatment mean, ranked (PAIRED, dot plot)', reading: 'Mean on-treatment expression per gene, pooled across response, ranked — the reference ranking the per-gene response gap sits against.' },
  {
    key: 'heatmap', templateId: 'heatmap_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On')], bindings: { x: 'response', y: 'gene', z: 'log2_cpm' }, params: { aggregation: 'mean' }, title: 'Q19 · Full panel on-treatment, response × gene heatmap (PAIRED)',
    reading: 'Mean on-treatment expression, response × gene, as one heatmap — the same cross-tab breakdown this question lists cell by cell, read by colour instead of by row.',
    interpretation: { label: 'the gap concentrates in T-cell lineage genes, not the whole panel', text: 'The widest R-vs-NR gaps at On sit on T-cell lineage genes (CD8A, LCK, CD3E) rather than being spread evenly across the 24-gene panel; a lineage-composition explanation (more T cells infiltrating in responders) is at least as consistent with this heatmap as a per-gene transcriptional-induction story.' },
  },
];

/** Chart-Enrichment-Brief §2 Q20 — baseline variability (population sd, ranked). */
const Q20_USER_CHARTS: UserChartPlan[] = [
  { key: 'ridge', templateId: 'ridgeline_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre')], bindings: { y: 'log2_cpm', group: 'gene' }, title: 'Q20 · Baseline expression landscape, all genes (PAIRED, ridgeline)', reading: 'The full baseline distribution per gene — CXCL9\'s ridge is visibly wider than IFNG\'s, matching the population-sd ranking (CXCL9 2.76 highest, IFNG 0.96 lowest).' },
  { key: 'strip', templateId: 'strip_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre')], bindings: { y: 'log2_cpm', group: 'gene' }, title: 'Q20 · Baseline, every patient by gene (PAIRED, strip)', reading: 'Every individual baseline measurement, one gene column per position — the raw spread the sd ranking summarises into one number per gene.' },
  {
    key: 'violin', templateId: 'violin_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), inList('gene', ['CXCL9', 'CXCL10', 'IFNG', 'PDCD1'])], bindings: { y: 'log2_cpm', group: 'gene' }, title: 'Q20 · Highest/lowest-variability genes, full distribution (PAIRED, violin)',
    reading: 'CXCL9 and CXCL10 (widest baseline spread) against IFNG and PDCD1 (narrowest) — the two ends of the sd ranking as full distributions.',
    interpretation: { label: 'a wide baseline spread is not the same signal as Q4\'s non-separating baseline', text: 'CXCL9\'s wide baseline spread (this question) and its lack of response-predictive power at baseline are two different properties — high patient-to-patient variability does not by itself mean a gene separates responders from non-responders; it just means individual baseline values vary a lot.' },
  },
];

/** Chart-Enrichment-Brief §2 Q21 — the 24-gene immune panel within the baseline DE table. */
const Q21_USER_CHARTS: UserChartPlan[] = [
  { key: 'volcano', templateId: 'volcano_v1', dataset: 'DE', filters: [inList('gene', RIAZ_24_PANEL_Q)], bindings: { x: 'log2FoldChange', y: 'pvalue' }, title: 'Q21 · 24-gene immune panel in the baseline DE table (DE, volcano)', reading: 'The same volcano as Q8, restricted to the 24-gene immune panel. Every panel gene sits below the significance line — none of the 24 clears padj<0.05 in this baseline contrast (min padj 0.21, at IDO1).' },
  { key: 'lollipop', templateId: 'lollipop_v1', dataset: 'DE', filters: [inList('gene', RIAZ_24_PANEL_Q)], bindings: { x: 'gene', y: 'log2FoldChange' }, title: 'Q21 · 24-gene immune panel ranked by baseline fold change (DE, lollipop)', reading: 'The panel ranked by fold change — IDO1 leads (2.21), HAVCR2 trails (0.067); every panel gene has a positive fold change at baseline, none reaching significance.' },
  {
    key: 'scatter', templateId: 'scatter_v1', dataset: 'DE', filters: [inList('gene', RIAZ_24_PANEL_Q)], bindings: { x: 'log2FoldChange', y: 'padj' }, title: 'Q21 · 24-gene immune panel, fold change vs adjusted p-value (DE, scatter)',
    reading: 'Fold change against adjusted p-value for the panel alone — even IDO1, the largest mover, sits far from the padj<0.05 line the wider DE table\'s significant genes clear.',
    interpretation: { label: 'all-positive baseline fold change without significance is consistent with, not contradictory to, Q8\'s composition-artefact reading', text: 'That every one of the 24 immune-panel genes trends positive at baseline (none negative) while none reaches significance is consistent with a small, correlated baseline shift across the whole panel rather than a real per-gene difference — the same non-immune, composition-driven explanation Q8 gives for the significant hits elsewhere in the table applies here in reverse: the panel moves together but not enough to individually clear the bar.' },
  },
];

// ── AXI-1587 — Q22–Q31 (Chart-Enrichment-Brief §5, describe questions) ──────
// Describe questions publish through `publishDescribeOne` (AXI-1565/AXI-1587):
// the sentence evidence + `descriptive_summary` decision are the platform's
// own, selected never authored; `userCharts` is the only field this config
// contributes for these questions (`focusGenes`/`cohortNames`/`decisionHeadline`
// are dead code on that path, kept only so `QuestionConfig` stays one shape).
const CXCL_TRIO = ['CXCL9', 'CXCL10', 'CXCL11'] as const;
const noHeadline = (): string => '';

const Q22_USER_CHARTS: UserChartPlan[] = [
  {
    key: 'slope', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [inList('gene', CYTOTOXIC_FOCUS)], bindings: { from: 'pre_expression', to: 'on_expression', group: 'response' },
    title: 'Q22 · Cytotoxic panel pre→on slope by patient and gene (WIDE)',
    reading: 'Per-patient, per-gene slopes across the six cytotoxic panel genes, pre-treatment to on-treatment, grouped by response — the individual lines behind the patient×timepoint means above.',
    interpretation: { label: 'cohort means can mask individual heterogeneity', text: 'The patient×timepoint mean table answers "what is the panel doing on average"; this slope view answers a different question — which individual patients rise, fall or barely move — and the two readings should be quoted together, not one in place of the other.' },
  },
  { key: 'facetLine', templateId: 'faceted_grouped_line_v1', dataset: 'PAIRED', filters: [inList('gene', CYTOTOXIC_FOCUS)], bindings: { facet: 'response', x: 'timepoint', y: 'log2_cpm', color: 'gene' }, title: 'Q22 · Cytotoxic panel by timepoint, faceted by response, coloured by gene (PAIRED)', reading: 'Mean ± SE per gene, Pre vs On, one facet per response group — which of the six genes drive each patient\'s mean.' },
];

const Q23_USER_CHARTS: UserChartPlan[] = [
  { key: 'waterfall', templateId: 'waterfall_v1', dataset: 'WIDE', filters: [eq('gene', 'CD8A')], bindings: { x: 'patient_id', y: 'delta' }, title: 'Q23 · CD8A pre→on delta waterfall (WIDE)', reading: 'The 27-patient CD8A Pre→On change as a waterfall, largest increase to largest decrease — the classic oncology waterfall shape.' },
  {
    key: 'strip', templateId: 'strip_v1', dataset: 'WIDE', filters: [eq('gene', 'CD8A')], bindings: { y: 'delta', group: 'response' }, title: 'Q23 · CD8A delta distribution by response (WIDE, strip)',
    reading: 'Every patient\'s CD8A delta, grouped by response — the raw points behind the ranked waterfall.',
    interpretation: { label: 'a handful of large non-responder increases blur the waterfall\'s visual story', text: 'The waterfall\'s rising end is not exclusively responders — Pt78 and Pt28 (both NR) post some of the largest CD8A increases in the cohort; a ranking chart alone can read as "responders rise" when the real picture is a mixed top tier.' },
  },
];

const Q24_USER_CHARTS: UserChartPlan[] = [
  {
    key: 'facet', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On')], bindings: { facet: 'gene', x: 'prior_ipi', y: 'log2_cpm' }, title: 'Q24 · Panel by prior ipilimumab exposure, on-treatment (PAIRED)',
    reading: 'On-treatment expression, one facet per gene, split by prior ipilimumab exposure — Q5\'s picture without a paired test.',
    interpretation: { label: 'on-treatment level differences by prior exposure are small next to the induction differences Q5 tests', text: 'Most facets here show overlapping on-treatment boxes between ipi-naive and ipi-progressed; the meaningful contrast Q5 finds is in the SIZE of the Pre→On move, not the on-treatment level alone, so this chart should not be read as contradicting Q5\'s induction result.' },
  },
  { key: 'dotNaive', templateId: 'dot_plot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On'), eq('prior_ipi', 'ipi_naive')], bindings: { x: 'log2_cpm', y: 'gene' }, title: 'Q24 · Panel on-treatment ranking, ipi-naive (PAIRED)', reading: 'Mean on-treatment level per gene, ipilimumab-naive patients only, ranked.' },
  { key: 'dotProgressed', templateId: 'dot_plot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On'), eq('prior_ipi', 'ipi_progressed')], bindings: { x: 'log2_cpm', y: 'gene' }, title: 'Q24 · Panel on-treatment ranking, ipi-progressed (PAIRED)', reading: 'The same ranking in ipilimumab-progressed patients, side by side with the naive version.' },
];

const Q25_USER_CHARTS: UserChartPlan[] = [
  { key: 'pHist', templateId: 'histogram_v1', dataset: 'DE', filters: [], bindings: { x: 'pvalue' }, title: 'Q25 · Baseline DE p-value distribution (DE)', reading: 'The raw p-value histogram across the tested universe — near-uniform, the signature of a well-calibrated null test with little true signal.' },
  { key: 'padjEcdf', templateId: 'ecdf_v1', dataset: 'DE', filters: [], bindings: { x: 'padj' }, title: 'Q25 · Baseline DE padj ECDF (DE)', reading: 'Empirical CDF of adjusted p-values — how fast padj climbs through the 0.01/0.05/0.10 bands this question counts.' },
  {
    key: 'lfcHist', templateId: 'histogram_v1', dataset: 'DE', filters: [{ column: 'padj', operator: 'lt', value: 0.1 }], bindings: { x: 'log2FoldChange' }, title: 'Q25 · log2 fold-change distribution, padj<0.10 (DE)',
    reading: 'The fold-change distribution of every gene that clears the loosest band (padj<0.10) — the 149-gene pool the three counted bins are carved from.',
    interpretation: { label: 'the padj<0.10 pool is not evenly split between up and down', text: 'This distribution is not symmetric around zero; more genes in the padj<0.10 pool trend in one direction than the other, a pattern Q16\'s up/down split (25 vs 33 at padj<0.05) already hints at and this wider band confirms rather than contradicts.' },
  },
];

const Q26_USER_CHARTS: UserChartPlan[] = [
  { key: 'facet', templateId: 'faceted_grouped_boxplot_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre')], bindings: { facet: 'gene', x: 'response', y: 'log2_cpm' }, title: 'Q26 · Panel at Pre by response, faceted (PAIRED)', reading: 'Boxes overlap on every gene at baseline — the medians restate Q4\'s baseline non-separation instead of the mean.' },
  {
    key: 'ridgeR', templateId: 'ridgeline_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'Pre'), eq('response', 'R')], bindings: { y: 'log2_cpm', group: 'gene' }, title: 'Q26 · Panel baseline landscape, responders (PAIRED, ridgeline)',
    reading: 'Responders\' baseline expression landscape across the panel, one ridge per gene — the density behind the per-gene medians.',
    interpretation: { label: 'medians and means tell the same baseline story here', text: 'The median-based cross-tab and the mean-based Q4/Q12 baseline readings rank genes the same way; the choice of central tendency is not driving the "baseline does not separate response" conclusion.' },
  },
];

const Q27_USER_CHARTS: UserChartPlan[] = [
  { key: 'volcano', templateId: 'volcano_v1', dataset: 'DE', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }], bindings: { x: 'log2FoldChange', y: 'pvalue' }, title: 'Q27 · Baseline DE volcano, padj<0.05 (DE)', reading: 'The 58 significant genes alone — the ten most negative fold changes this question ranks sit at the far-left tail.' },
  {
    key: 'lollipop', templateId: 'lollipop_v1', dataset: 'DE', filters: [inList('gene', ['MYL1', 'KRT14', 'CASP14', 'SPRR2D', 'GSTA3', 'KRT6B', 'COL2A1', 'KLK6', 'PLA2G4F', 'KRTDAP'])], bindings: { x: 'gene', y: 'log2FoldChange' }, title: 'Q27 · Ten most down-regulated genes (DE, lollipop)',
    reading: 'The ten genes this question ranks, as a lollipop — MYL1, KRT14 and CASP14 lead the fall.',
    interpretation: { label: 'muscle and keratin genes, not immunity, dominate the negative tail', text: 'MYL1 (myosin light chain), KRT14/KRT6B/KRTDAP (keratins) and COL2A1 (collagen) are structural/tissue genes, not immune genes; their extreme negative fold changes are more consistent with sample composition (biopsy tissue content) than with an immune-suppressive baseline signature in non-responders, echoing Q8\'s composition-artefact reading.' },
  },
];

const Q28_USER_CHARTS: UserChartPlan[] = [
  { key: 'facetLine', templateId: 'faceted_grouped_line_v1', dataset: 'PAIRED', filters: [inList('gene', CXCL_TRIO)], bindings: { facet: 'gene', x: 'timepoint', y: 'log2_cpm', color: 'response' }, title: 'Q28 · Chemokine trio by timepoint, both cohorts (PAIRED)', reading: 'CXCL9 rises while CXCL11 falls on treatment, in both responders and non-responders — the chemokine-axis shift the governed table (responders only) does not show by itself.' },
  {
    key: 'slopeR', templateId: 'paired_slope_v1', dataset: 'WIDE', filters: [inList('gene', CXCL_TRIO), eq('response', 'R')], bindings: { from: 'pre_expression', to: 'on_expression', group: 'gene' }, title: 'Q28 · Chemokine trio pre→on slope, responders (WIDE)',
    reading: 'Per-patient slopes for the three chemokines in responders — CXCL9 lines lean up, CXCL11 lines lean down.',
    interpretation: { label: 'CXCL9 up / CXCL11 down is a within-axis trade, not a general chemokine induction', text: 'The three chemokines do not move together: CXCL9 rises, CXCL11 falls, and CXCL10 barely moves; "the chemokine axis is induced" overstates a shift that is really CXCL9 specifically rising relative to CXCL11, not the CXCR3-ligand axis as a whole.' },
  },
];

const Q29_USER_CHARTS: UserChartPlan[] = [
  {
    key: 'strip', templateId: 'strip_v1', dataset: 'PAIRED', filters: [eq('gene', 'HLA-DRA'), eq('timepoint', 'Pre')], bindings: { y: 'log2_cpm', group: 'response' }, title: 'Q29 · HLA-DRA at Pre, every patient by response (PAIRED, strip)',
    reading: 'Every patient\'s baseline HLA-DRA, grouped by response — high and low readings appear in both groups.',
    interpretation: { label: 'baseline HLA-DRA spans both response groups — not a response biomarker on its own', text: 'The patients with the highest baseline HLA-DRA (Pt34 R, Pt103 NR, Pt46 NR) are a response-mixed set; antigen presentation level at baseline separates patients from each other far more than it separates responders from non-responders.' },
  },
  { key: 'dot', templateId: 'dot_plot_v1', dataset: 'PAIRED', filters: [eq('gene', 'HLA-DRA'), eq('timepoint', 'Pre')], bindings: { x: 'log2_cpm', y: 'patient_id' }, title: 'Q29 · HLA-DRA at Pre, ranked by patient (PAIRED, dot plot)', reading: 'Every patient ranked by baseline HLA-DRA — the same ten patients the governed table names, in the context of the full 27.' },
];

const Q30_USER_CHARTS: UserChartPlan[] = [
  { key: 'lfcHist', templateId: 'histogram_color_v1', dataset: 'DE_STRATA', filters: [{ column: 'padj', operator: 'lt', value: 0.05 }], bindings: { x: 'log2FoldChange', color: 'stratum' }, title: 'Q30 · log2FC distribution by stratum, padj<0.05 (DE-STRATA)', reading: 'The significant genes\' fold-change distributions by stratum — ipi-progressed skews positive, ipi-naive centres near zero, restating this question\'s two means as full distributions.' },
  {
    key: 'volcanoProgressed', templateId: 'volcano_v1', dataset: 'DE_STRATA', filters: [eq('stratum', 'ipi_progressed')], bindings: { x: 'log2FoldChange', y: 'pvalue' }, title: 'Q30 · DE volcano, ipi-progressed stratum (DE-STRATA)',
    reading: 'The ipi-progressed stratum\'s volcano — more hits than the naive stratum (Q9), and this question shows they lean positive on average.',
    interpretation: { label: 'Q9\'s count and this question\'s direction tell one story: prior ipilimumab reshapes the baseline upward', text: 'Q9 found more significant genes in the ipi-progressed stratum (50 vs 33); this question adds that those genes skew toward a POSITIVE fold change on average, where the naive stratum\'s mean is near zero — consistent with prior ipilimumab exposure shifting the baseline transcriptome, not just adding noise.' },
  },
];

const Q31_USER_CHARTS: UserChartPlan[] = [
  {
    key: 'heatmap', templateId: 'heatmap_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { x: 'patient_id', y: 'gene', z: 'log2_cpm' }, title: 'Q31 · Cytotoxic panel heatmap, on-treatment (PAIRED)',
    reading: 'The classic hot/cold expression heatmap — patients as columns, the six cytotoxic genes as rows, on-treatment. Hot and cold read together across genes, not from any single gene alone.',
    interpretation: { label: '"hot vs cold" on one screen — 8 of the 9 responders sit in the hotter half of the ranking', text: 'Ranking the 27 patients by mean cytotoxic-panel expression and splitting at the median, 8 of the 9 responders fall in the hotter half; the ninth responder and several non-responders in the hotter half show the rule is strong but not absolute — a useful screening signal, not a perfect classifier.' },
  },
  { key: 'strip', templateId: 'strip_v1', dataset: 'PAIRED', filters: [eq('timepoint', 'On'), inList('gene', CYTOTOXIC_FOCUS)], bindings: { y: 'log2_cpm', group: 'response' }, title: 'Q31 · Cytotoxic panel on-treatment, every point by response (PAIRED, strip)', reading: 'Every individual on-treatment cytotoxic-panel measurement, coloured by response — the raw points behind the per-patient ranking and the heatmap above.' },
];

export const QUESTION_CONFIG: Record<string, QuestionConfig> = {
  Q2: {
    focusGenes: ['PDCD1'],
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `PDCD1 (PD-1) reads ${verdictHeadline(v, 'RIAZ-INT-PD1-01 @ all')} pooled, ${verdictHeadline(v, 'RIAZ-INT-PD1-01 @ response=NR')} in non-responders`,
    labelRules: ['RIAZ-INT-PD1-01 @ all', 'RIAZ-INT-PD1-01 @ response=R', 'RIAZ-INT-PD1-01 @ response=NR'],
    decisionType: 'phenotype_classification',
    userCharts: Q2_USER_CHARTS,
  },
  Q3: {
    focusGenes: IFNG_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `the IFN-γ programme in responders reads ${verdictHeadline(v, 'RIAZ-INT-IFNG-01 @ responders')}`,
    labelRules: ['RIAZ-INT-IFNG-01 @ responders'],
    decisionType: 'phenotype_classification',
      userCharts: Q3_USER_CHARTS,
  },
  Q4: {
    focusGenes: CYTOTOXIC_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `baseline (Pre) cytotoxic expression reads ${verdictHeadline(v, 'RIAZ-INT-BASELINE-01 @ Pre')}; response prediction is ${verdictHeadline(v, 'RIAZ-DEC-BASELINE-01 (with Q1 responder_restricted)')}`,
    labelRules: ['RIAZ-INT-BASELINE-01 @ Pre', 'RIAZ-DEC-BASELINE-01 (with Q1 responder_restricted)'],
    decisionType: 'biomarker_threshold',
      userCharts: Q4_USER_CHARTS,
  },
  Q5: {
    focusGenes: CYTOTOXIC_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `cytotoxic induction by prior ipilimumab exposure reads ${verdictHeadline(v, 'RIAZ-INT-IPI-01')} — ${verdictHeadline(v, 'RIAZ-DEC-IPI-01')}`,
    labelRules: ['RIAZ-INT-IPI-01', 'RIAZ-DEC-IPI-01'],
    decisionType: 'cohort_stratification',
      userCharts: Q5_USER_CHARTS,
  },
  Q6: {
    focusGenes: EXHAUSTION_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `on-treatment exhaustion/checkpoint markers read ${verdictHeadline(v, 'RIAZ-INT-EXH-01 @ On')} in responders vs non-responders`,
    labelRules: ['RIAZ-INT-EXH-01 @ On'],
    decisionType: 'phenotype_classification',
      userCharts: Q6_USER_CHARTS,
  },
  Q7: {
    focusGenes: CYTOTOXIC_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `non-responder cytotoxic induction reads ${verdictHeadline(v, 'RIAZ-INT-CYTO-01 @ non-responders')}`,
    labelRules: ['RIAZ-INT-CYTO-01 @ non-responders'],
    decisionType: 'phenotype_classification',
      userCharts: Q7_USER_CHARTS,
  },
  Q8: {
    focusGenes: [],
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `baseline differential-expression signal reads ${verdictHeadline(v, 'RIAZ-INT-DE-01')}`,
    labelRules: ['RIAZ-SUM-DE-01', 'RIAZ-INT-DE-01'],
    decisionType: 'phenotype_classification',
      userCharts: Q8_USER_CHARTS,
  },
  Q9: {
    focusGenes: [],
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `the ipi_naive vs ipi_progressed differential-expression strata read ${verdictHeadline(v, 'RIAZ-INT-STRATA-01')}`,
    labelRules: ['RIAZ-SUM-STRATA-01', 'RIAZ-INT-STRATA-01'],
    decisionType: 'cohort_stratification',
      userCharts: Q9_USER_CHARTS,
  },
  Q10: {
    focusGenes: APM_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `antigen-presentation induction (HLA-DRA, CD274) reads ${verdictHeadline(v, 'RIAZ-INT-APM-01 @ all')} pooled, ${verdictHeadline(v, 'RIAZ-INT-APM-01 @ response=R')} in responders`,
    labelRules: ['RIAZ-INT-APM-01 @ all', 'RIAZ-INT-APM-01 @ response=R', 'RIAZ-INT-APM-01 @ response=NR'],
    decisionType: 'phenotype_classification',
      userCharts: Q10_USER_CHARTS,
  },
  Q11: {
    focusGenes: CYTOTOXIC_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => {
      const resp = verdictOf(v, 'RIAZ-INT-RESP-01');
      const sens = verdictOf(v, 'RIAZ-INT-SENS-01');
      if (resp === 'responder_restricted' && sens === 'robust') return 'responder-restricted cytotoxic induction holds under Wilcoxon';
      if (resp === 'responder_restricted') return `responder-restricted cytotoxic induction under Wilcoxon (sensitivity: ${sens ?? 'not evaluable'})`;
      return `Wilcoxon reads the cytotoxic induction as ${resp ?? 'not evaluable'}`;
    },
    labelRules: ['RIAZ-INT-RESP-01', 'RIAZ-INT-SENS-01'],
    decisionType: 'phenotype_classification',
    userCharts: Q11_USER_CHARTS,
  },
  // AXI-1588 — Q12–Q21 describe questions: only `userCharts` and `decisionType`
  // (for the userCharts[] interpretation decisions) are live on this path.
  Q12: { focusGenes: RIAZ_24_PANEL_Q, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q12_USER_CHARTS },
  Q13: { focusGenes: RIAZ_24_PANEL_Q, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q13_USER_CHARTS },
  Q14: { focusGenes: ['CD8A'], cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'cohort_stratification', userCharts: Q14_USER_CHARTS },
  Q15: { focusGenes: [], cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q15_USER_CHARTS },
  Q16: { focusGenes: [], cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q16_USER_CHARTS },
  Q17: { focusGenes: CYTOTOXIC_FOCUS, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q17_USER_CHARTS },
  Q18: { focusGenes: ['CXCL9'], cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q18_USER_CHARTS },
  Q19: { focusGenes: RIAZ_24_PANEL_Q, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q19_USER_CHARTS },
  Q20: { focusGenes: RIAZ_24_PANEL_Q, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'biomarker_threshold', userCharts: Q20_USER_CHARTS },
  Q21: { focusGenes: RIAZ_24_PANEL_Q, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q21_USER_CHARTS },
  // AXI-1587 — Q22–Q31 describe questions: only `userCharts` and `decisionType`
  // (for the userCharts[] interpretation decisions) are live on this path.
  Q22: { focusGenes: CYTOTOXIC_FOCUS, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q22_USER_CHARTS },
  Q23: { focusGenes: ['CD8A'], cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'biomarker_threshold', userCharts: Q23_USER_CHARTS },
  Q24: { focusGenes: CYTOTOXIC_FOCUS, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'cohort_stratification', userCharts: Q24_USER_CHARTS },
  Q25: { focusGenes: [], cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q25_USER_CHARTS },
  Q26: { focusGenes: CYTOTOXIC_FOCUS, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'biomarker_threshold', userCharts: Q26_USER_CHARTS },
  Q27: { focusGenes: [], cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q27_USER_CHARTS },
  Q28: { focusGenes: CXCL_TRIO, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'phenotype_classification', userCharts: Q28_USER_CHARTS },
  Q29: { focusGenes: ['HLA-DRA'], cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'biomarker_threshold', userCharts: Q29_USER_CHARTS },
  Q30: { focusGenes: [], cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'cohort_stratification', userCharts: Q30_USER_CHARTS },
  Q31: { focusGenes: CYTOTOXIC_FOCUS, cohortNames: DEFAULT_COHORT_NAMES, decisionHeadline: noHeadline, decisionType: 'biomarker_threshold', userCharts: Q31_USER_CHARTS },
};

const GENERIC_CONFIG: QuestionConfig = {
  focusGenes: CYTOTOXIC_FOCUS,
  cohortNames: DEFAULT_COHORT_NAMES,
  decisionHeadline: (v) => (v[0] ? `${ruleCode(v[0].rule)} reads ${v[0].verdict}` : 'no rule verdict'),
  decisionType: 'phenotype_classification',
};

export const configFor = (questionId: string): QuestionConfig => QUESTION_CONFIG[questionId] ?? GENERIC_CONFIG;

/** Hand-written text per evidence, keyed `${questionId}:${ruleRunId}` — wins over the summariser. */
export const TEXT_OVERRIDES: Record<string, string> = {};

// ── wording helpers ──────────────────────────────────────────────────────────

/** `RIAZ-INT-SENS-01 (vs Q1 paired t-test)` → `RIAZ-INT-SENS-01`; `RIAZ-INT-CYTO-01 @ responders (…)` → `RIAZ-INT-CYTO-01 @ responders`. */
export const ruleCode = (rule: string): string => rule.replace(/\s*\(.*\)\s*$/, '').trim();

const TEST_NAMES: Record<string, string> = {
  'stats.wilcoxon_signed_rank': 'Wilcoxon signed-rank',
  'stats.paired_ttest': 'paired t-test',
  'stats.mann_whitney_u': 'Mann–Whitney U',
  'stats.welch_ttest': "Welch's t-test",
  'stats.students_ttest': "Student's t-test",
};
export const testName = (operationId: string | null): string => (operationId ? TEST_NAMES[operationId] ?? operationId.replace(/^stats\./, '').replace(/_/g, ' ') : 'test');
/** Short form for titles: `Wilcoxon signed-rank` → `Wilcoxon`. */
export const testShortName = (operationId: string | null): string => testName(operationId).split(' ')[0];

export interface CohortFilter { column: string; operator: string; value: unknown }
export const filterKey = (f: CohortFilter): string => `${f.column} ${f.operator} ${Array.isArray(f.value) ? f.value.join('/') : String(f.value)}`;

export function cohortName(filters: CohortFilter[], cfg: QuestionConfig): string {
  if (!filters.length) return 'all patients';
  return filters.map((f) => cfg.cohortNames[filterKey(f)] ?? `${f.column} = ${Array.isArray(f.value) ? f.value.join('/') : String(f.value)}`).join(', ');
}

/** Kernel row, whatever the test — the summariser reads what is there. */
export interface ResultRow { feature?: unknown; pValue?: unknown; medianDifference?: unknown; meanDifference?: unknown; effectSize?: unknown; nPairs?: unknown; [k: string]: unknown }

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const fmtP = (p: number): string => (p < 0.001 ? 'p<0.001' : `p=${p.toFixed(3)}`);

interface GeneStat { gene: string; p: number | null; direction: 1 | -1 | 0 }

function geneStats(rows: ResultRow[]): GeneStat[] {
  return rows
    .map((r) => {
      const delta = num(r.medianDifference) ?? num(r.meanDifference) ?? num(r.effectSize);
      return { gene: String(r.feature ?? ''), p: num(r.pValue), direction: delta === null ? 0 : delta > 0 ? 1 : delta < 0 ? -1 : 0 } as GeneStat;
    })
    .filter((g) => g.gene && g.gene !== '__all__');
}

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const withP = (g: GeneStat): string => `${g.gene} (${g.p === null ? 'p n/a' : fmtP(g.p)})`;
const dirWord = (d: 1 | -1, plural: boolean): string => (d < 0 ? (plural ? 'fall' : 'falls') : plural ? 'rise' : 'rises');
const flatWord = (plural: boolean): string => (plural ? 'show' : 'shows') + ' no directional change';

/** A zero delta is neither a rise nor a fall — a gene with `direction === 0`
 *  (e.g. a null/zero effect estimate that still cleared the p-value filter)
 *  used to be bucketed into "up" and worded "rises", overstating it. */
function describeSet(gs: GeneStat[], plural: boolean): string {
  const up = gs.filter((g) => g.direction > 0), down = gs.filter((g) => g.direction < 0), flat = gs.filter((g) => g.direction === 0);
  const parts: string[] = [];
  if (up.length) parts.push(`${list(up.map(withP))} ${dirWord(1, plural || up.length > 1)}`);
  if (down.length) parts.push(`${list(down.map(withP))} ${dirWord(-1, plural || down.length > 1)}`);
  if (flat.length) parts.push(`${list(flat.map(withP))} ${flatWord(plural || flat.length > 1)}`);
  return parts.join(' and ');
}

export interface StatisticalSummaryInput {
  rows: ResultRow[];
  cohort: string; // "responders"
  operationId: string | null;
  focusGenes: readonly string[];
  levelFrom?: string | null; // "Pre"
  levelTo?: string | null; // "On"
}

/**
 * 3–5 sentences from the rows: cohort and pairs, which focus genes move at
 * p<0.05 and in which direction, which trend (p<0.10), what did not move, and
 * where the full table is. No ids, no `key=value` syntax.
 */
export function summariseStatistical(input: StatisticalSummaryInput): string {
  const gs = geneStats(input.rows);
  const n = num(input.rows[0]?.nPairs);
  const focus = new Set(input.focusGenes);
  const span = input.levelFrom && input.levelTo ? `${input.levelFrom}→${input.levelTo}` : null;
  const byP = (a: GeneStat, b: GeneStat) => (a.p ?? 1) - (b.p ?? 1);
  const sig = gs.filter((g) => g.p !== null && g.p < 0.05).sort(byP);
  const trend = gs.filter((g) => g.p !== null && g.p >= 0.05 && g.p < 0.1).sort(byP);
  const focusSig = sig.filter((g) => focus.has(g.gene)), otherSig = sig.filter((g) => !focus.has(g.gene));
  const focusTrend = trend.filter((g) => focus.has(g.gene)), otherTrend = trend.filter((g) => !focus.has(g.gene));
  const focusQuiet = input.focusGenes.filter((g) => !focusSig.some((x) => x.gene === g) && !focusTrend.some((x) => x.gene === g));

  const s: string[] = [];
  s.push(`${cap(input.cohort)}${n !== null ? ` (n=${n} paired patients)` : ''}, ${testName(input.operationId)}${span ? ` ${span}` : ''} per gene over ${gs.length} genes.`);
  if (focusSig.length) s.push(`Among the ${input.focusGenes.length} focus genes, ${describeSet(focusSig, false)} on treatment.`);
  else s.push(`None of the ${input.focusGenes.length} focus genes (${list([...input.focusGenes])}) changes significantly.`);
  if (focusTrend.length) s.push(`${cap(describeSet(focusTrend, false))} as a trend (p<0.10)${focusQuiet.length ? `, while ${list(focusQuiet)} ${focusQuiet.length > 1 ? 'do' : 'does'} not reach significance` : ''}.`);
  else if (focusSig.length && focusQuiet.length) s.push(`${list(focusQuiet)} ${focusQuiet.length > 1 ? 'do' : 'does'} not reach significance.`);
  if (otherSig.length || otherTrend.length) {
    const bits = [otherSig.length ? describeSet(otherSig, false) : '', otherTrend.length ? `${describeSet(otherTrend, false)} as a trend` : ''].filter(Boolean);
    s.push(`Outside the focus set, ${bits.join('; ')}.`);
  }
  s.push(`The recommended chart and the cited table carry every gene's statistics.`);
  return s.join(' ');
}

export interface QcSummaryInput {
  cohort: string;
  ruleCode: string;
  ruleVersion: number | null;
  rowsEvaluated: number | null;
  verdict: string | null;
  failReasons: string[];
}

/** `non-responders` → `non-responder` (the cohort as a modifier: "the non-responder referent"). */
const asModifier = (cohort: string): string => cohort.replace(/responders$/, 'responder');

export function summariseQc(input: QcSummaryInput): string {
  const rule = `${input.ruleCode}${input.ruleVersion ? ` v${input.ruleVersion}` : ''}`;
  const rows = input.rowsEvaluated !== null ? `${input.rowsEvaluated} rows checked` : 'rows checked';
  if (input.verdict === 'pass') return `Paired-completeness gate ${rule} on the ${asModifier(input.cohort)} referent: ${rows}, all included, verdict pass. The per-gene test of this cohort cites this referent.`;
  return `Paired-completeness gate ${rule} on the ${asModifier(input.cohort)} referent: ${rows}, verdict ${input.verdict ?? 'unknown'}${input.failReasons.length ? ` (${input.failReasons.join(', ')})` : ''}.`;
}

// ── titles ───────────────────────────────────────────────────────────────────

export const statisticalTitle = (qId: string, operationId: string | null, cohort: string, n: number | null, levelFrom?: string | null, levelTo?: string | null): string =>
  `${qId} · ${testShortName(operationId)}${levelFrom && levelTo ? ` ${levelFrom}→${levelTo}` : ''} per gene — ${cohort}${n !== null ? ` (n=${n})` : ''}`;
export const qcTitle = (qId: string, cohort: string, verdict: string | null): string => `${qId} · Paired QC — ${cohort}${verdict ? ` (${verdict})` : ''}`;

// ── decision ─────────────────────────────────────────────────────────────────

export type ConfidenceBand = 'high' | 'medium' | 'low';
/** ≥0.75 high, ≥0.5 medium, else low; no numeric confidence → medium. */
export function confidenceBand(verdicts: Verdict[]): ConfidenceBand {
  const nums = verdicts.map((v) => v.confidence).filter((c): c is number => typeof c === 'number');
  if (!nums.length) return 'medium';
  const c = Math.min(...nums);
  return c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : 'low';
}

export function decisionLabel(qId: string, cfg: QuestionConfig, verdicts: Verdict[]): string {
  const cited = cfg.labelRules ? verdicts.filter((v) => cfg.labelRules!.includes(ruleCode(v.rule))) : verdicts;
  const tail = cited.map((v) => `${ruleCode(v.rule)}: ${v.verdict}`).join(' · ');
  return `${qId} — ${cfg.decisionHeadline(verdicts)}${tail ? ` · ${tail}` : ''}`;
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
