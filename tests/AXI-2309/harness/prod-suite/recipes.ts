import type { ProbeFilter } from './paul-reference';

/**
 * AXI-2319 — how the daily suite RUNS a catalogue (non-Paul) rule: one recipe
 * per kernel operation, on the two provisioned prod-suite fixtures only (FR29:
 * the suite never uploads). A recipe is a column binding the operation's
 * registry declaration accepts on Paul's tables; each was verified live
 * against the demo stack (see the AXI-2319 manual-e2e run notes).
 *
 * An operation with NO recipe here is recorded `not-evaluated` with the reason
 * below — never silently skipped and never `pass`. Those are the operations
 * Paul's two tables cannot feed (no time/event, no paired visits, no count
 * matrix, no subject×timepoint design, no QC gate payload) — a follow-up adds
 * fixtures for them (AXI-1400's matrix fixtures are the obvious source).
 */

/** What a recipe may vary its params on: the rule being run, and a per-executor nonce. */
export interface RecipeContext {
  ruleId: string;
  nonce: string;
}

export interface Recipe {
  fixture: 'tableau1' | 'tableau2';
  filters: ProbeFilter[];
  roleBindings: Record<string, string | string[]>;
  pivot?: Record<string, unknown>;
  /** Static params, or params computed per rule/run (a split's question must be unique). */
  operationParams: Record<string, unknown> | ((c: RecipeContext) => Record<string, unknown>);
}

/** The params a recipe submits for one rule in one executor run. */
export function recipeParams(recipe: Recipe, c: RecipeContext): Record<string, unknown> {
  return typeof recipe.operationParams === 'function' ? recipe.operationParams(c) : recipe.operationParams;
}

const T2 = 'tableau2' as const;
const MARKERS = ['microbiote_igg4_ent_059', 'microbiote_igg4_cer_229'];
const TAXA = [
  'microbiote_igg4_cer_228', 'microbiote_igg4_mag4_27', 'microbiote_igg4_mag4_22', 'microbiote_igg4_mag4_13',
  'microbiote_igg4_cer_215_et_234', 'microbiote_igg4_cer_229', 'microbiote_igg4_ent_059',
];
// Contingency recipes: only `sexe` and `cluster_selon_acr_eular_2019` profile as
// categorical on tableau2 (0/1 outcome columns profile numeric and are refused).
const twoArms = { groupColumn: 'atteinte_pancreatique', valueColumns: MARKERS };

/**
 * `split_is_unique_per_question` (BLOCK) refuses a second split on one question,
 * so every split rule, every day, asks its OWN question: rule id + run nonce.
 * (A fixed key passed once and refused every later rule and every later day.)
 */
const splitParams = (c: RecipeContext) => ({
  questionKey: `axi2319-prod-pass-rule-${c.ruleId}-${c.nonce}`, holdoutRatio: 0.5, splitSeed: 2319,
});

export const CATALOGUE_RECIPES: Readonly<Record<string, Recipe>> = {
  'stats.unpaired_ttest': { fixture: T2, filters: [], roleBindings: { groupColumn: 'atteinte_pancreatique' }, pivot: { valueColumns: MARKERS }, operationParams: { groupFrom: '0', groupTo: '1', alternative: 'two_sided' } },
  'stats.one_way_anova': { fixture: T2, filters: [], roleBindings: { groupColumn: 'cluster_selon_acr_eular_2019' }, pivot: { valueColumns: MARKERS }, operationParams: {} },
  'stats.chi_square': { fixture: T2, filters: [], roleBindings: { rowColumn: 'sexe', columnColumn: 'cluster_selon_acr_eular_2019' }, operationParams: {} },
  'stats.fisher_exact': { fixture: T2, filters: [], roleBindings: { rowColumn: 'sexe', columnColumn: 'cluster_selon_acr_eular_2019' }, operationParams: { rowPositiveLevel: 'F', columnPositiveLevel: 'C1', alternative: 'two_sided' } },
  'stats.correlation_matrix': { fixture: T2, filters: [], roleBindings: { referenceColumns: MARKERS, variableColumns: ['igg4_g_l', 'igg4_rd_ri', 'eosinophils'] }, operationParams: { method: 'spearman' } },
  'stats.alpha_diversity': { fixture: T2, filters: [], roleBindings: { featureColumns: TAXA, groupColumn: 'atteinte_pancreatique' }, operationParams: { metric: 'shannon' } },
  'stats.permanova': { fixture: T2, filters: [], roleBindings: { featureColumns: TAXA, groupColumn: 'atteinte_pancreatique' }, operationParams: {} },
  'stats.anosim': { fixture: T2, filters: [], roleBindings: { featureColumns: TAXA, groupColumn: 'atteinte_pancreatique' }, operationParams: {} },
  'stats.permdisp': { fixture: T2, filters: [], roleBindings: { featureColumns: TAXA, groupColumn: 'atteinte_pancreatique' }, operationParams: {} },
  'stats.differential_abundance': { fixture: T2, filters: [], roleBindings: { featureColumns: TAXA, groupColumn: 'atteinte_pancreatique' }, operationParams: { groupFrom: '0', groupTo: '1' } },
  'stats.cutoff_roc_youden': { fixture: T2, filters: [], roleBindings: twoArms, pivot: { valueColumns: MARKERS }, operationParams: { positiveGroup: '1' } },
  'stats.cutoff_maxstat': { fixture: T2, filters: [], roleBindings: twoArms, pivot: { valueColumns: MARKERS }, operationParams: { positiveGroup: '1' } },
  'stats.cutoff_distribution': { fixture: T2, filters: [], roleBindings: twoArms, pivot: { valueColumns: MARKERS }, operationParams: { positiveGroup: '1', quantile: 0.5 } },
  'stats.cutoff_reference': { fixture: T2, filters: [], roleBindings: twoArms, pivot: { valueColumns: MARKERS }, operationParams: { positiveGroup: '1', referenceGroup: '0', quantile: 0.95 } },
  'stats.screen_shortlist': { fixture: T2, filters: [], roleBindings: twoArms, pivot: { valueColumns: MARKERS }, operationParams: { comparisons: [{ from: '0', to: '1' }], rankBy: 'pValue' } },
  'split.exploration_holdout': { fixture: T2, filters: [], roleBindings: { patientKey: 'patient_id', outcomeColumn: 'atteinte_pancreatique' }, operationParams: splitParams },
  'describe.count': { fixture: T2, filters: [], roleBindings: { groupColumns: ['cluster_selon_acr_eular_2019'] }, operationParams: {} },
  'describe.grouped_aggregate': { fixture: T2, filters: [], roleBindings: { groupColumns: ['cluster_selon_acr_eular_2019'], valueColumn: 'microbiote_igg4_ent_059' }, operationParams: { aggregation: 'mean' } },
  'describe.top_n': { fixture: T2, filters: [], roleBindings: { sortColumn: 'microbiote_igg4_ent_059' }, operationParams: { n: 5, direction: 'desc' } },
  'describe.below_limit_count': { fixture: T2, filters: [], roleBindings: { measureColumn: 'microbiote_igg4_ent_059' }, operationParams: { lod: 0.5, unit: 'pct' } },
};

/** Why an operation has no recipe (recorded as the case's `not-evaluated` reason). */
export function noRecipeReason(operationId: string | null, runKind: string | null): string {
  if (!operationId) return `no recipe: ${runKind ?? 'unknown'} rules carry no kernel operation the suite can run on the prod fixtures`;
  return `no recipe for ${operationId} on the prod-suite fixtures (Paul's two tables cannot feed it) — follow-up: add a fixture`;
}
