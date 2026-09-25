/**
 * AXI-1677 (epic AXI-1604 — FR28/FR30, @SI-042). The column contract the
 * synthetic Grados-shaped CSV must satisfy.
 *
 * THIS IS A COPY, NOT A DESIGN. Every entry below is transcribed verbatim from
 * `GRADOS_DATASET` in
 * `axiome-back/apps/organization-service/src/guided-analysis/plan/compile/
 * __fixtures__/grados-golden-intents.ts` — the `PlannerDatasetSchema` FR29
 * declared and hand-authored all 46 golden `AnalysisIntent`s against. The two
 * repos share no package, so the copy is unavoidable; what is avoidable is the
 * copy DRIFTING, so `harness-unit/AXI-1604/synthetic-grados-cohort.spec.ts`
 * re-reads the declaring fixture from the sibling `axiome-back` checkout and
 * fails if the two disagree on a name, a type or a category domain.
 *
 * WHY THE CATEGORICAL VALUES ARE TEXT TOKENS AND NOT NUMERIC CODES. The
 * profiler (`POST /guided-analysis/profile`) types a numerically-coded column
 * `numeric` and gives it no `categories`, which would put the live envelope in
 * direct contradiction with this declared schema — the planner would be shown
 * `disease_group: numeric` while every golden intent binds it as a grouping
 * column with three named levels. Writing the levels as text is what makes the
 * profiler's answer and the declaration agree. This is a constraint on the
 * FIXTURE, not a workaround in product code.
 */

/** The name of the generated CSV. The `synthetic-` prefix is deliberate and load-bearing. */
export const SYNTHETIC_GRADOS_CSV_FILENAME = 'synthetic-grados-cohort.csv';

/** The declared type of a column, in `PlannerColumnSchema` terms. */
export type SyntheticGradosColumnType = 'string' | 'number';

export interface SyntheticGradosColumnSpec {
  readonly name: string;
  readonly type: SyntheticGradosColumnType;
  /** The declared value domain, for a categorical column. */
  readonly categories?: readonly string[];
}

/** Column order is the declaration order in `GRADOS_DATASET`. */
export const SYNTHETIC_GRADOS_COLUMNS = [
  { name: 'subject_id', type: 'string' },
  { name: 'age', type: 'number' },
  { name: 'disease_group', type: 'string', categories: ['igg4_rd', 'healthy_control', 'pss'] },
  { name: 'treatment_arm', type: 'string', categories: ['rituximab', 'steroids_alone'] },
  { name: 'treated_flag', type: 'string', categories: ['treated', 'untreated'] },
  { name: 'timepoint', type: 'string', categories: ['baseline', 'post_treatment'] },
  { name: 'site', type: 'string', categories: ['site_a', 'site_b', 'site_c'] },
  { name: 'batch', type: 'string', categories: ['batch_1', 'batch_2'] },
  { name: 'flare_status', type: 'string', categories: ['first_flare', 'relapse'] },
  {
    name: 'organ_involvement_group',
    type: 'string',
    categories: ['single_organ', 'multi_organ'],
  },
  { name: 'igg4_threshold_group', type: 'string', categories: ['above_1_35', 'below_1_35'] },
  { name: 'storiform_fibrosis', type: 'string', categories: ['present', 'absent'] },
  {
    name: 'denominator_type',
    type: 'string',
    categories: ['total_igg', 'igg_positive_cells'],
  },
  { name: 'lod_flag', type: 'string', categories: ['below_lod', 'above_lod'] },
  { name: 'unit', type: 'string', categories: ['pct_of_parent', 'absolute_count'] },
  { name: 'tfh1_pct', type: 'number' },
  { name: 'tfh2_pct', type: 'number' },
  { name: 'tfh17_pct', type: 'number' },
  { name: 'pd1_tfh_pct', type: 'number' },
  { name: 'foxp3_pct', type: 'number' },
  { name: 'plasmablast_pct', type: 'number' },
  { name: 'cd4_pct', type: 'number' },
  { name: 'cd8_pct', type: 'number' },
  { name: 'nk_pct', type: 'number' },
  { name: 'b_pct', type: 'number' },
  { name: 'il4', type: 'number' },
  { name: 'il10', type: 'number' },
  { name: 'il17', type: 'number' },
  { name: 'ifng', type: 'number' },
  { name: 'igg4_serum', type: 'number' },
  { name: 'histology_ratio', type: 'number' },
  { name: 'organ_count', type: 'number' },
  { name: 'responder_index', type: 'number' },
  { name: 'tfh_residual_pct', type: 'number' },
] as const satisfies readonly SyntheticGradosColumnSpec[];

export type SyntheticGradosColumn = (typeof SYNTHETIC_GRADOS_COLUMNS)[number]['name'];

/**
 * The `representation` role `GRADOS_DATASET` declares (FR1). The anchored
 * envelope the harness builds does NOT carry this today — `anchorDataset()`
 * resolves identity, columns, types and categories, and nothing in the dataset
 * API exposes a representation role. Recorded here so the gap is visible and
 * citable rather than silently absent; see this story's hand-back.
 */
export const SYNTHETIC_GRADOS_REPRESENTATION = {
  column: 'unit',
  levels: ['pct_of_parent', 'absolute_count'],
  comparableAcrossLevels: false,
} as const;

/** Categorical columns and their declared domains, for assertions. */
export function declaredCategories(): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const c of SYNTHETIC_GRADOS_COLUMNS) {
    if ('categories' in c && c.categories) out.set(c.name, c.categories);
  }
  return out;
}
