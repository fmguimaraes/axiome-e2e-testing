/**
 * The whole governed statistical surface, grouped by input role-shape into six
 * analyses. Every field here (roleBindings, params, pivot, ordering, the exact
 * executor pin) was verified live against the demo before being written — each
 * of the 17 operations ran SUCCEEDED end-to-end with the pin below.
 *
 * `library` groups operations so a still-stale executor degrades only its group
 * (see libraryProbe). Pins are the registry's exact `==` versions; the descriptor
 * withholds the pin, so it is asserted against these known values (FR10/FR11).
 */

const TAXA = Array.from({ length: 8 }, (_, i) => `taxon_${i}`);
const GENES = Array.from({ length: 12 }, (_, i) => `gene_${i}`);
const SAMPLE_CONDITION_MAP = Object.fromEntries(
  Array.from({ length: 10 }, (_, n) => [`SAMP${String(n).padStart(2, '0')}`, n < 5 ? 'treatment' : 'control']),
);

export interface OpRun {
  operationId: string;
  library: string;
  pin: string;
  roleBindings?: Record<string, string | string[]>;
  operationParams?: Record<string, unknown>;
  pivot?: Record<string, unknown>;
  ordering?: Record<string, string>;
  /**
   * `stats.cutoff_tally` never takes a cut-off from the caller (kernel/cutoff-tally-binding.ts):
   * it reads a captured CutoffChoice by id. The harness captures this expert choice
   * (POST /workspaces/:id/cutoff-choices, no cited run) and stamps its id into operationParams.
   */
  cutoffChoice?: { measurement: string; cutoff: number };
}

export interface AnalysisGroup {
  name: string;
  fixture: string;
  /** Canonical semantic fields that must be mapped for this group's ops. */
  requiredCanonicals: string[];
  ops: OpRun[];
}

export const ANALYSES: AnalysisGroup[] = [
  {
    name: 'Paired & longitudinal',
    fixture: 'paired_longitudinal.csv',
    requiredCanonicals: ['patient_id', 'timepoint'],
    ops: [
      { operationId: 'stats.paired_ttest', library: 'pingouin', pin: '0.5.5', pivot: { valueColumns: ['score'] }, ordering: { levelFrom: 'T0', levelTo: 'T1' } },
      { operationId: 'stats.wilcoxon_signed_rank', library: 'pingouin', pin: '0.5.5', pivot: { valueColumns: ['score'] }, ordering: { levelFrom: 'T0', levelTo: 'T1' } },
      { operationId: 'stats.linear_mixed_model', library: 'statsmodels', pin: '0.14.6', roleBindings: { timeColumn: 'week', valueColumn: 'score', groupColumn: 'arm' } },
    ],
  },
  {
    name: 'Grouped comparisons',
    fixture: 'grouped_comparisons.csv',
    requiredCanonicals: [],
    ops: [
      { operationId: 'stats.unpaired_ttest', library: 'pingouin', pin: '0.5.5', roleBindings: { groupColumn: 'arm' }, pivot: { valueColumns: ['score'] }, operationParams: { groupFrom: 'A', groupTo: 'B', alternative: 'two_sided' } },
      { operationId: 'stats.mann_whitney_u', library: 'pingouin', pin: '0.5.5', roleBindings: { groupColumn: 'arm' }, pivot: { valueColumns: ['score'] }, operationParams: { groupFrom: 'A', groupTo: 'B' } },
      { operationId: 'stats.kruskal_wallis', library: 'pingouin', pin: '0.5.5', roleBindings: { groupColumn: 'arm' }, pivot: { valueColumns: ['score'] } },
      { operationId: 'stats.one_way_anova', library: 'pingouin', pin: '0.5.5', roleBindings: { groupColumn: 'arm' }, pivot: { valueColumns: ['score'] } },
    ],
  },
  {
    name: 'Association',
    fixture: 'association.csv',
    requiredCanonicals: [],
    ops: [
      { operationId: 'stats.correlation', library: 'pingouin', pin: '0.5.5', roleBindings: { xColumn: 'biomarker_x', yColumn: 'biomarker_y' }, operationParams: { method: 'pearson' } },
      { operationId: 'stats.correlation_trimmed', library: 'pingouin', pin: '0.5.5', roleBindings: { xColumn: 'biomarker_x', yColumn: 'biomarker_y' }, operationParams: { method: 'pearson', trimCriterion: 'percentile', trimValue: 5, trimSide: 'both', sensitivityOf: 'axi1400-untrimmed-primary' } },
      { operationId: 'stats.fisher_exact', library: 'axiome-bio-compute/fisher_exact_execution', pin: '1.1.0', roleBindings: { rowColumn: 'arm', columnColumn: 'response' }, operationParams: { rowPositiveLevel: 'A', columnPositiveLevel: 'CR', alternative: 'two_sided' } },
      { operationId: 'stats.chi_square', library: 'pingouin', pin: '0.5.5', roleBindings: { rowColumn: 'arm', columnColumn: 'response' } },
    ],
  },
  {
    name: 'Survival',
    fixture: 'survival.csv',
    requiredCanonicals: [],
    ops: [
      { operationId: 'stats.kaplan_meier', library: 'lifelines', pin: '0.30.3', roleBindings: { timeColumn: 'time', eventColumn: 'event', groupColumn: 'arm' } },
      { operationId: 'stats.cox_proportional_hazards', library: 'lifelines', pin: '0.30.3', roleBindings: { timeColumn: 'time', eventColumn: 'event', covariates: ['covariate_age', 'covariate_score'] } },
      { operationId: 'stats.log_rank', library: 'lifelines', pin: '0.30.3', roleBindings: { timeColumn: 'time', eventColumn: 'event', groupColumn: 'arm' } },
    ],
  },
  {
    name: 'Community',
    fixture: 'microbiome_community.csv',
    requiredCanonicals: [],
    ops: [
      { operationId: 'stats.alpha_diversity', library: 'skbio', pin: '0.6.3', roleBindings: { featureColumns: TAXA, groupColumn: 'arm' }, operationParams: { metric: 'shannon' } },
      { operationId: 'stats.permanova', library: 'skbio', pin: '0.6.3', roleBindings: { featureColumns: TAXA, groupColumn: 'arm' } },
      { operationId: 'stats.anosim', library: 'skbio', pin: '0.6.3', roleBindings: { featureColumns: TAXA, groupColumn: 'arm' } },
      { operationId: 'stats.permdisp', library: 'skbio', pin: '0.6.3', roleBindings: { featureColumns: TAXA, groupColumn: 'arm' } },
      { operationId: 'stats.differential_abundance', library: 'differential_abundance', pin: '1.0.0', roleBindings: { featureColumns: TAXA, groupColumn: 'arm' }, operationParams: { groupFrom: 'A', groupTo: 'B' } },
    ],
  },
  {
    name: 'Differential expression',
    fixture: 'bulk_counts.csv',
    requiredCanonicals: ['patient_id'],
    ops: [
      { operationId: 'stats.deseq2_differential_expression', library: 'pydeseq2', pin: '0.5.4', roleBindings: { countColumns: GENES }, operationParams: { sampleConditionMap: SAMPLE_CONDITION_MAP } },
    ],
  },
  {
    name: 'Biomarker cut-offs & screening',
    fixture: 'biomarker_cohort.csv',
    requiredCanonicals: [],
    ops: [
      { operationId: 'stats.cutoff_roc_youden', library: 'axiome-bio-compute/cutoff_proposal_execution', pin: '1.0.0', roleBindings: { groupColumn: 'outcome', valueColumns: ['marker_a', 'marker_b'] }, pivot: { valueColumns: ['marker_a', 'marker_b'] }, operationParams: { positiveGroup: 'responder' } },
      { operationId: 'stats.cutoff_maxstat', library: 'axiome-bio-compute/cutoff_proposal_execution', pin: '1.0.0', roleBindings: { groupColumn: 'outcome', valueColumns: ['marker_a', 'marker_b'] }, pivot: { valueColumns: ['marker_a', 'marker_b'] }, operationParams: { positiveGroup: 'responder' } },
      { operationId: 'stats.cutoff_distribution', library: 'axiome-bio-compute/cutoff_proposal_execution', pin: '1.0.0', roleBindings: { groupColumn: 'outcome', valueColumns: ['marker_a', 'marker_b'] }, pivot: { valueColumns: ['marker_a', 'marker_b'] }, operationParams: { positiveGroup: 'responder', quantile: 0.5 } },
      { operationId: 'stats.cutoff_reference', library: 'axiome-bio-compute/cutoff_proposal_execution', pin: '1.0.0', roleBindings: { groupColumn: 'outcome', valueColumns: ['marker_a', 'marker_b'] }, pivot: { valueColumns: ['marker_a', 'marker_b'] }, operationParams: { positiveGroup: 'responder', referenceGroup: 'non_responder', quantile: 0.95 } },
      { operationId: 'stats.cutoff_tally', library: 'axiome-bio-compute/cutoff_proposal_execution', pin: '1.0.0', roleBindings: { groupColumn: 'outcome', valueColumns: ['marker_a', 'marker_b'] }, pivot: { valueColumns: ['marker_a', 'marker_b'] }, operationParams: { positiveGroup: 'responder' }, cutoffChoice: { measurement: 'marker_a', cutoff: 6.5 } },
      { operationId: 'stats.screen_shortlist', library: 'axiome-bio-compute/screening_execution', pin: '1.1.0', roleBindings: { groupColumn: 'outcome', valueColumns: ['marker_a', 'marker_b'] }, pivot: { valueColumns: ['marker_a', 'marker_b'] }, operationParams: { comparisons: [{ from: 'non_responder', to: 'responder' }], rankBy: 'pValue' } },
    ],
  },
  {
    name: 'Exploration / holdout split',
    fixture: 'split_cohort.csv',
    requiredCanonicals: [],
    ops: [
      { operationId: 'split.exploration_holdout', library: 'axiome-bio-compute/split_execution', pin: '1.0.0', roleBindings: { patientKey: 'patient_id', outcomeColumn: 'outcome' }, operationParams: { questionKey: 'axi1400-marker-a-response', holdoutRatio: 0.5, splitSeed: 1400 } },
    ],
  },
  {
    name: 'Site & batch variance',
    fixture: 'site_batch.csv',
    requiredCanonicals: [],
    ops: [
      { operationId: 'stats.site_batch_variance_test', library: 'statsmodels', pin: '0.14.6', roleBindings: { measurementColumn: 'measurement', diseaseColumn: 'disease', siteColumn: 'site', batchColumn: 'batch' } },
    ],
  },
];

/** Every operationId this matrix exercises — used to assert parity against the
 *  live descriptor set so a newly-added 18th operation is caught, not skipped. */
export const COVERED_OPERATION_IDS = ANALYSES.flatMap((a) => a.ops.map((o) => o.operationId));

/** The armed-precondition BLOCK negative case (FR8/AC5). */
export const NEGATIVE_CASE = {
  name: 'Survival (no events — negative)',
  fixture: 'survival_no_events.csv',
  operationId: 'stats.kaplan_meier',
  roleBindings: { timeColumn: 'time', eventColumn: 'event', groupColumn: 'arm' },
  expectCondition: 'sufficient_events',
};
