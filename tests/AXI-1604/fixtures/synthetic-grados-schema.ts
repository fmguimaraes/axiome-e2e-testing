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

/**
 * AXI-1694 (epic AXI-1687 — FR56, SI-044). The parent chain
 * `generate-synthetic-grados-cohort.ts` derives `absolute_count` through —
 * NOT a flat `pct × total lymphocyte count` for every column. Read as: each
 * entry's `children` are `pct_of_parent`-representation shares of `parent`
 * (a real column, in cells/µL once resolved through ITS OWN row of this
 * table if it also has one — `cd4_pct` is both a child of `lymphocytes` and
 * the parent of `foxp3_pct`/`tfh_compartment`).
 *
 * `tfh_compartment` is virtual — no literal column carries the TFH
 * compartment's own size, only shares of it (`tfh1_pct`, `tfh2_pct`,
 * `tfh17_pct`, `pd1_tfh_pct`, `tfh_residual_pct`). Its absolute size is
 * `tfhFractionOfCd4% of cd4_pct's absolute value`; there is no declared
 * column for the fraction itself.
 *
 * THIS IS SHAPE, NOT A DECISION. It documents what the seed generator already
 * computes; it does not choose containment sets for AXI-1693 (dataset
 * semantic declaration) — that story reads this shape when it decides its own
 * `containmentSets[]` (see `SYNTHETIC_GRADOS_CONTAINMENT_SETS` below for the
 * ONE relationship a bank question actually depends on).
 */
export const SYNTHETIC_GRADOS_VALUE_CHAIN = [
  { parent: 'lymphocytes', children: ['cd4_pct', 'cd8_pct', 'nk_pct', 'b_pct'] },
  { parent: 'cd4_pct', children: ['foxp3_pct', 'tfh_compartment'] },
  { parent: 'tfh_compartment', children: ['tfh1_pct', 'tfh2_pct', 'tfh17_pct', 'pd1_tfh_pct', 'tfh_residual_pct'] },
  { parent: 'b_pct', children: ['plasmablast_pct'] },
] as const;

/**
 * AXI-1694 (epic AXI-1687 — FR56, SI-044). The ONE containment relationship
 * the bank actually tests (Q38, "do any child populations exceed their
 * parent in comparable units?"). `tfh1_pct + tfh2_pct + tfh17_pct` are shares
 * of the SAME 100%-by-construction TFH compartment (`tfh_residual_pct` is
 * literally `100 - Σchildren`, so the check IS `residual < 0`), and it is
 * evaluated in `pct_of_parent` units only — the two readings are declared
 * `comparableAcrossLevels: false`, so a containment check does not mix them.
 *
 * FORMAT FOR THE CONSUMER (AXI-1693, dataset semantic declaration, IMM-QC-10):
 * `parent` is a literal column when `parentKind` is `'column'`, or a fixed
 * constant (never a column) when `'virtual_total'`. `children` are column
 * names whose `pct_of_parent` values are declared shares of `parent`, checked
 * within `comparableUnit` only. `deliberateViolationPredicate` is a plain-
 * English predicate over the generator's OWN row index (not exposed as a CSV
 * column) that a consumer can use to assert the check fires on exactly the
 * rows the seed deliberately violates — AXI-1693 does not need to reproduce
 * the predicate, only to confirm its own count of flagged rows against it.
 */
export const SYNTHETIC_GRADOS_CONTAINMENT_SETS = [
  {
    id: 'tfh-compartment-shares',
    parent: 100,
    parentKind: 'virtual_total' as const,
    children: ['tfh1_pct', 'tfh2_pct', 'tfh17_pct'] as const,
    comparableUnit: 'pct_of_parent' as const,
    deliberateViolationPredicate: 'subject index (1-based, across all 120 subjects) % 17 === 0',
  },
] as const;
