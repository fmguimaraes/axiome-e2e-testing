/**
 * AXI-2648 (epic AXI-2630 — feature BACKLOG-Investigator-On-Shared-Principles §8.14/§20,
 * FR58, FR59, FR60, AC37, AC38; SI-042). PURE: no I/O, no Playwright — the handover preset's
 * shape on the NEW model, re-expressed from the old AXI-2601 one-file preset
 * (`tests/AXI-2598/harness/preset.ts`, reused here for `csvFacts`/`sha256Hex`).
 *
 * The preset is ONE study, TWO data files (T1_LONG, T2) and FOUR v2 field-bound questions
 * (`axiome-back/libs/contracts/src/sap/sap-plan-v2.contract.ts` shape), launched through
 * `QuestionLaunchService` (AXI-2635) — never `SapRun`. No prepared file: a question's data is
 * resolved per question (DD14) to whichever linked file carries its bound fields; this module
 * states which file each field and each question's bindings belong to and checks the two agree.
 *
 * Image 1 compiles to ONE Dunn run over exactly the 3 §20 panels (L11 / AXI-2643, FR59): template
 * T2 with `parameters.stratifyBy` set is a single run with `featureColumn` = the stratum column,
 * never a fan-out of one run per stratum, and `stratifyBy.strata` pinned to the explicit 3-level
 * subset (`opening-template.stratify-by.ts#strataOf` draws every level of the column when no
 * subset is given, which would be 7 panels, not 3) — `isSingleStratifiedDunnRun` is the
 * structural check for both halves (AC37).
 *
 * REVIEW ROUND 2 BOUNCE FIX (2026-11-18) — the round-1 fix made this module internally
 * consistent but NOT launchable on the real back-end path. Three defects, re-verified against
 * the live code (file:line cited below), fixed here:
 *
 * 1. `profilePin` is NOT a fixture literal. `SemanticProfilesService.configVersionOf`
 *    (`semantic-profiles.service.ts:436-439`) computes `<profileId>@<version>+sha256:<hash>`
 *    for a pack-based profile, and CC18 (`cc18-spec-canonical-field.ts:29`) requires
 *    `field.profilePin === profile.configVersion` BYTE-FOR-BYTE. A fixture can never predict
 *    that hash (it depends on what extension packs, if any, are on the project when it is
 *    read), so `PresetField` no longer carries a `profilePin` at all — `specificationBody` now
 *    takes the LIVE `configVersion` (read by the caller off the project's resolved semantic
 *    contract, AFTER any extension below) as an argument and stamps it everywhere, refusing to
 *    build without the `+sha256:` form (`assertLiveConfigVersion`).
 *
 * 2. `question-data.resolver.ts#outcomeOf` (`:98-106`) matches a dataset's `ProjectFieldMapping`
 *    rows on `canonicalField` ALONE, within one dataset. T2 declared 7 coating columns and 2
 *    cell-count columns against the SAME platform canonical field each, so a real mapping would
 *    have produced `matches.length > 1` → `matched_twice` for every one of those 9 columns,
 *    which makes every question touching them `kind: 'none'`. Each of those 9 columns now
 *    declares `canonicalFieldSource: 'extension'` with its own distinct LOCAL key; provisioning
 *    adds them via AXI-2638 `POST semantic-profiles/projects/:projectId/extensions`
 *    (`mapping:confirm_binding`, `semantic-profiles.controller.ts:170-190`) BEFORE reading the
 *    live `configVersion` (an extension changes the registry hash, L3) and namespaces each key
 *    `project.<projectId>.<key>` (`semantic-profile-extension.ts:33` `projectFieldNamespace`) —
 *    `specificationBody` does that namespacing; `extensionFieldsOf`/`provisioningPlan` state the
 *    ordering so a caller cannot read the config version too early. `duplicateCanonicalFieldProblems`
 *    is the static mirror of `matched_twice`.
 *
 * 3. `neededFieldsOf` (`question-data.resolver.ts:89-96`) adds EVERY `required` field to EVERY
 *    question's needed set, regardless of that question's own file. With all 18 fields marked
 *    `required: true` across two disjoint files, no single dataset could ever carry a question's
 *    full needed set, so even image 1 resolved to `none`. No field in this two-file preset is
 *    genuinely needed by every question (each question already names its own fields through its
 *    bindings), so every field is now `required: false`; `questionFileCohesionProblems` is the
 *    static mirror that would catch a future field wrongly marked required across files.
 *
 * Owner flag carried into the story report: a WIDE file whose columns all share one platform
 * canonical field (T2's 9 repeated-measure columns here) needs a per-column PROJECT EXTENSION
 * field to be launchable at all — the platform's own canonical-field vocabulary has no room for
 * "the same measurement, once per reference/cell-type column" without one.
 */
import { csvFacts, sha256Hex, splitCsv, type CsvFacts } from '../../AXI-2598/harness/preset';

export type { CsvFacts };
export { csvFacts, sha256Hex, splitCsv };

export type FileKey = 'T1_LONG' | 'T2';
export type SemanticRole = 'continuous' | 'grouping_two_levels' | 'grouping_three_plus_levels';
export type QuestionRole = 'primary' | 'key_secondary' | 'secondary' | 'exploratory';
export type OpeningTemplateId = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
export type CanonicalFieldSource = 'platform' | 'extension';

export interface PresetField {
  name: string;
  label: string;
  semanticRole: SemanticRole;
  levels?: string[];
  controlLevels?: string[];
  /** Never true across this two-file preset — see the module docstring, defect 3. */
  required: boolean;
  description?: string;
  /** Which of the two preset files carries this column (FR58: data per question, DD14). */
  file: FileKey;
  /**
   * 'platform': an existing canonical field of the project's semantic profile (checked
   * statically against `KNOWN_CANONICAL_FIELDS`, CC18's membership half).
   * 'extension': a LOCAL, unqualified key this project's AXI-2638 extension must declare before
   * provisioning. NEVER the fully namespaced id — `specificationBody` namespaces it
   * `project.<projectId>.<key>` at provisioning time, because the projectId is not known to a
   * preset fixture ahead of time (and must not be baked in as a fake one).
   */
  canonicalField: string;
  canonicalFieldSource: CanonicalFieldSource;
}

/**
 * Known canonical field ids of the `immune_mediated_microbiota` profile (packs `immunology` +
 * `immune_mediated` + `microbiota_coating`) — an audit copy of
 * `axiome-back/apps/organization-service/src/semantic-profiles/config/registries/
 * canonical_fields.{immunology,immune_mediated,microbiota_coating}.v1.json`, read 2026-11-18.
 * Mirrors CC18's "the canonical field exists in the pinned profile" check, statically, for
 * `canonicalFieldSource: 'platform'` fields only — an extension field is never in this set by
 * construction (it does not exist until this project's own extension adds it).
 */
export const KNOWN_CANONICAL_FIELDS: ReadonlySet<string> = new Set([
  'patient_id', 'sample_id', 'cohort_arm', 'response_status', 'timepoint', 'visit_day',
  'baseline_flag', 'cell_type', 'marker', 'pathway_score', 'cytokine_level', 'assay_type',
  'tissue', 'specimen_type', 'treatment', 'dose_level', 'batch_id', 'site_id', 'value',
  'value_unit', 'age', 'sex', 'gene_identifier', 'mean_expression', 'effect_size',
  'effect_size_se', 'pvalue', 'padj', 'test_statistic', 'expression_value',
  'disease_group', 'isotype', 'serum_immunoglobulin', 'disease_activity_index',
  'histology_score', 'tissue_cell_density', 'organ_involvement', 'complement_level',
  'hypocomplementemia', 'relapse', 'phenotype_cluster', 'cell_count', 'cell_frequency_pct',
  'autoantibody', 'inflammation_marker', 'damage_index', 'remission_status',
  'disease_duration', 'glucocorticoid_dose', 'immunosuppressive_therapy',
  'classification_criteria_score', 'reference_microbiota', 'coating_pct',
]);

/** A LOCAL extension key's allowed shape (lowercase snake_case) — never checked against any
 *  real registry here (it does not exist until provisioned); this only catches an unusable key. */
const EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface PresetBinding {
  slot: string;
  /** A preset field NAME (resolved to the server fieldId at provisioning, FR5). */
  field: string;
}

export interface StratifyByParam {
  column: string;
  strata?: string[];
}

export interface RestrictToParam {
  column: string;
  levels: string[];
}

/** AXI-2667 (FR77): the closed list the server reads (`readRecommendedChartDisplay`). */
export interface ChartDisplayParam {
  show_points?: boolean;
  show_box?: boolean;
  show_median?: boolean;
  log_y?: boolean;
  y_range?: [number, number];
  group_order?: string[];
  group_labels?: Record<string, string>;
  facet_order?: string[];
  facet_labels?: Record<string, string>;
  pairwise?: { reference_group: string };
}

export interface QuestionParameters {
  alpha: number;
  sidedness: 'two_sided' | 'greater' | 'less';
  groups?: string[];
  restrictTo?: RestrictToParam;
  stratifyBy?: StratifyByParam;
  /** AXI-2667 (FR77): how this question's recommended chart is drawn. Never reaches the analysis. */
  chartDisplay?: ChartDisplayParam;
}

export interface PresetQuestion {
  key: string;
  image: 1 | 2 | 3 | 4;
  text: string;
  role: QuestionRole;
  /** The file this question's bindings must resolve against (no prepared file — FR59). */
  dataFile: FileKey;
  template: { templateId: OpeningTemplateId; templateVersion: string };
  estimand: {
    population: string;
    variable: string;
    intercurrentEvents: string;
    populationSummary: string;
    treatmentComparison: string;
  };
  bindings: PresetBinding[];
  parameters: QuestionParameters;
  decisionCriterion: { kind: 'p_at_or_below_alpha'; direction?: 'positive' | 'negative' };
  expectedChart: string;
}

export interface NewModelPreset {
  presetId: string;
  presetVersion: string;
  /** The semantic profile the project must already be configured with — no `profilePin` here;
   *  that is a live fact read at provisioning time (see the module docstring, defect 1). */
  profile: { profileId: string; version: string };
  study: { title: string; objective: string; studyPopulation: string };
  plan: { title: string; specificationSource: 'declared'; studyPopulation: string };
  files: PresetFile[];
  dataSpecification: { fields: PresetField[] };
  questions: PresetQuestion[];
}

export interface PresetFile {
  key: FileKey;
  label: string;
  path: string;
  sha256: string;
  rows: number;
  columns: number;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * FR58 — the preset IS one study with two files and four questions. Structural, never counted
 * loosely elsewhere: every other check in this module assumes these three hold.
 */
export function planShapeProblems(preset: NewModelPreset): string[] {
  const problems: string[] = [];
  if (preset.files.length !== 2) problems.push(`preset declares ${preset.files.length} file(s), FR58 requires exactly 2`);
  if (!preset.files.some((f) => f.key === 'T1_LONG')) problems.push('preset has no T1_LONG file');
  if (!preset.files.some((f) => f.key === 'T2')) problems.push('preset has no T2 file');
  if (preset.questions.length !== 4) problems.push(`preset declares ${preset.questions.length} question(s), FR58 requires exactly 4`);
  const images = preset.questions.map((q) => q.image).sort();
  if (JSON.stringify(images) !== JSON.stringify([1, 2, 3, 4])) {
    problems.push(`preset questions carry images [${images.join(', ')}], expected [1, 2, 3, 4]`);
  }
  return problems;
}

/**
 * FR59, AC37 — the image-1 question is Dunn (Holm) on T1_LONG, restricted to HD/IgG4-RD/SD,
 * stratified by reference, as ONE run (L11): `templateId: 'T2'` (Kruskal-Wallis + Dunn) with
 * `parameters.stratifyBy` set and `groups` the exact 3-level restriction — never a separate
 * question per stratum (that would be a fan-out, the thing L11/AXI-2643 removed).
 */
const IMAGE_1_STRATA = ['ENT 059', 'CER 229', 'CER 215 et 234'];

export function isSingleStratifiedDunnRun(question: PresetQuestion): boolean {
  return (
    question.image === 1 &&
    question.dataFile === 'T1_LONG' &&
    question.template.templateId === 'T2' &&
    question.parameters.stratifyBy?.column === 'reference' &&
    sameSet(question.parameters.stratifyBy?.strata ?? [], IMAGE_1_STRATA) &&
    sameSet(question.parameters.groups ?? [], ['HD', 'IgG4-RD', 'SD'])
  );
}

export function image1Question(preset: NewModelPreset): PresetQuestion | undefined {
  return preset.questions.find((q) => q.image === 1);
}

/**
 * FR58/FR59/FR12-equivalent — every problem that makes this preset unfit for the two committed
 * data files, at once. Empty ⇒ the preset may be provisioned. Never "fixes" anything.
 */
export function presetProblems(preset: NewModelPreset, csvByFile: Readonly<Record<FileKey, CsvFacts>>): string[] {
  return [
    ...planShapeProblems(preset),
    ...fileFactProblems(preset, csvByFile),
    ...fieldProblems(preset, csvByFile),
    ...duplicateCanonicalFieldProblems(preset),
    ...questionProblems(preset),
    ...questionFileCohesionProblems(preset),
  ];
}

function fileFactProblems(preset: NewModelPreset, csvByFile: Readonly<Record<FileKey, CsvFacts>>): string[] {
  const problems: string[] = [];
  for (const file of preset.files) {
    const csv = csvByFile[file.key];
    if (!csv) continue;
    if (csv.rows !== file.rows) problems.push(`file ${file.key} has ${csv.rows} rows, preset declares ${file.rows}`);
    if (csv.header.length !== file.columns) {
      problems.push(`file ${file.key} has ${csv.header.length} columns, preset declares ${file.columns}`);
    }
  }
  return problems;
}

function fieldProblems(preset: NewModelPreset, csvByFile: Readonly<Record<FileKey, CsvFacts>>): string[] {
  const problems: string[] = [];
  const names = preset.dataSpecification.fields.map((f) => f.name);
  names.filter((n, i) => names.indexOf(n) !== i).forEach((n) => problems.push(`field "${n}" is declared twice`));
  for (const f of preset.dataSpecification.fields) {
    problems.push(...canonicalFieldProblems(f));
    const csv = csvByFile[f.file];
    if (!csv) {
      problems.push(`field "${f.name}" names an unknown file "${f.file}"`);
      continue;
    }
    problems.push(...oneFieldProblems(f, csv));
  }
  return problems;
}

/**
 * Mirrors CC19 (a declared plan's field must name a `canonicalField`,
 * `cc19-spec-declared-canonical-required.ts:20-23`) and the membership half of CC18
 * (`cc18-spec-canonical-field.ts:32-34`) — structural, static checks over the preset's own
 * declared data. The profilePin-equality half of CC18 (`:29-31`) is deliberately NOT mirrored
 * here any more: that is a live fact, enforced at provisioning time by `assertLiveConfigVersion`
 * inside `specificationBody`, never guessable from a fixture (defect 1).
 */
function canonicalFieldProblems(f: PresetField): string[] {
  if (!f.canonicalField) {
    return [`field "${f.name}" names no canonical field from the project's semantic profile (CC19)`];
  }
  if (f.canonicalFieldSource === 'platform' && !KNOWN_CANONICAL_FIELDS.has(f.canonicalField)) {
    return [`field "${f.name}" names canonical field "${f.canonicalField}", not one of the profile's known platform fields (CC18)`];
  }
  if (f.canonicalFieldSource === 'extension' && !EXTENSION_KEY_PATTERN.test(f.canonicalField)) {
    return [`field "${f.name}" names an unusable extension key "${f.canonicalField}"`];
  }
  return [];
}

/**
 * Mirrors `question-data.resolver.ts#outcomeOf` (`:98-106`): within ONE file (dataset), two
 * fields naming the SAME `canonicalField` would both produce a `matched` `ProjectFieldMapping`
 * row, so `outcomeOf` would see `matches.length > 1` and refuse with `matched_twice` for BOTH —
 * never a pick-one. A platform field repeated across files is fine (each file is its own
 * dataset); the collision is per file (defect 2).
 */
function duplicateCanonicalFieldProblems(preset: NewModelPreset): string[] {
  const problems: string[] = [];
  for (const file of preset.files) {
    const seenBy = new Map<string, string>();
    for (const f of preset.dataSpecification.fields.filter((field) => field.file === file.key)) {
      const prior = seenBy.get(f.canonicalField);
      if (prior) {
        problems.push(
          `fields "${prior}" and "${f.name}" both name canonical field "${f.canonicalField}" in file ${file.key} — ` +
            `question-data.resolver.ts#outcomeOf would see two matched mappings and refuse both as "matched_twice"`,
        );
      } else {
        seenBy.set(f.canonicalField, f.name);
      }
    }
  }
  return problems;
}

function oneFieldProblems(f: PresetField, csv: CsvFacts): string[] {
  if (!csv.header.includes(f.name)) {
    const near = csv.header.find((h) => h.toLowerCase() === f.name.toLowerCase());
    return [`field "${f.name}" is not a column of file ${near ? ` (the file has "${near}")` : 'declared'}`];
  }
  return f.semanticRole === 'continuous' ? continuousFieldProblems(f, csv) : groupingFieldProblems(f, csv);
}

function continuousFieldProblems(f: PresetField, csv: CsvFacts): string[] {
  const problems: string[] = [];
  if (f.levels !== undefined) problems.push(`field "${f.name}" is continuous but declares levels`);
  const nonNumeric = (csv.values[f.name] ?? []).filter((v) => !Number.isFinite(Number(v)));
  if (nonNumeric.length > 0) {
    problems.push(`field "${f.name}" is continuous but the file holds non-numeric [${nonNumeric.slice(0, 3).join(', ')}]`);
  }
  return problems;
}

function groupingFieldProblems(f: PresetField, csv: CsvFacts): string[] {
  const problems: string[] = [];
  const fileLevels = csv.values[f.name] ?? [];
  if (!f.levels || !sameSet(f.levels, fileLevels)) {
    problems.push(`field "${f.name}" declares levels [${(f.levels ?? []).join(', ')}], the file holds [${fileLevels.join(', ')}]`);
  }
  const want = f.semanticRole === 'grouping_two_levels' ? 2 : 3;
  const n = f.levels?.length ?? 0;
  if (f.semanticRole === 'grouping_two_levels' ? n !== 2 : n < want) {
    problems.push(`field "${f.name}" is ${f.semanticRole} but declares ${n} level(s)`);
  }
  for (const c of f.controlLevels ?? []) {
    if (!f.levels?.includes(c)) problems.push(`field "${f.name}" control level "${c}" is not one of its levels`);
  }
  return problems;
}

function questionProblems(preset: NewModelPreset): string[] {
  const problems: string[] = [];
  const keys = preset.questions.map((q) => q.key);
  keys.filter((k, i) => keys.indexOf(k) !== i).forEach((k) => problems.push(`question key "${k}" is used twice`));
  const names = new Set(preset.dataSpecification.fields.map((f) => f.name));
  for (const q of preset.questions) problems.push(...oneQuestionProblems(q, names));
  const image1 = image1Question(preset);
  if (image1 && !isSingleStratifiedDunnRun(image1)) {
    problems.push('image-1 question is not a single stratified Dunn run (FR59, L11)');
  }
  return problems;
}

function oneQuestionProblems(q: PresetQuestion, fieldNames: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const b of q.bindings) {
    if (!fieldNames.has(b.field)) problems.push(`question ${q.key} binds slot ${b.slot} to undeclared field "${b.field}"`);
  }
  return problems;
}

/**
 * Mirrors `question-data.resolver.ts#neededFieldsOf` (`:89-96`): the needed set for ANY
 * question is its bound fields UNION every field marked `required: true`, regardless of that
 * question's own file. If a required field's file differs from a bound field's file, no single
 * dataset can ever carry the needed set and `resolveQuestionData` returns `kind: 'none'` for
 * every candidate — this is defect 3's static mirror.
 */
function questionFileCohesionProblems(preset: NewModelPreset): string[] {
  const fileByName = new Map(preset.dataSpecification.fields.map((f) => [f.name, f.file]));
  const requiredNames = preset.dataSpecification.fields.filter((f) => f.required).map((f) => f.name);
  const problems: string[] = [];
  for (const q of preset.questions) {
    const neededNames = new Set([...q.bindings.map((b) => b.field), ...requiredNames]);
    const files = new Set([...neededNames].map((n) => fileByName.get(n)).filter((f): f is FileKey => f !== undefined));
    if (files.size > 1) {
      problems.push(
        `question ${q.key} needs fields from files [${[...files].join(', ')}] at once — ` +
          `question-data.resolver.ts#neededFieldsOf would make it unresolvable on any single dataset`,
      );
    }
  }
  return problems;
}

/**
 * The local extension keys this preset needs the project to already carry before its
 * specification can be posted — the ordered input to AXI-2638's
 * `POST semantic-profiles/projects/:projectId/extensions` (`mapping:confirm_binding`,
 * `semantic-profiles.controller.ts:170-190`). Grouped per file only for readability; the real
 * call posts one pack naming every key at once (`buildCumulativeExtensionPack`).
 */
export interface ExtensionFieldSpec {
  key: string;
  label: string;
  file: FileKey;
}

export function extensionFieldsOf(preset: NewModelPreset): ExtensionFieldSpec[] {
  return preset.dataSpecification.fields
    .filter((f) => f.canonicalFieldSource === 'extension')
    .map((f) => ({ key: f.canonicalField, label: f.label, file: f.file }));
}

export type ProvisioningStepKind =
  | 'link_project_profile'
  | 'add_extension'
  | 'link_files_confirm_mappings'
  | 'read_live_config_version'
  | 'post_specification'
  | 'post_questions';

export interface ProvisioningStep {
  kind: ProvisioningStepKind;
  detail: string;
}

/**
 * The ordered provisioning sequence this preset requires (data only — no live call is made
 * here). Pins the ONE ordering fact the review named: an extension is added (if any) BEFORE the
 * live `configVersion` is read, because adding it changes the registry hash (L3,
 * `resolveForProject` / `addProfileExtension`, `semantic-profiles.service.ts:79-217`).
 */
export function provisioningPlan(preset: NewModelPreset): ProvisioningStep[] {
  const extensions = extensionFieldsOf(preset);
  const steps: ProvisioningStep[] = [
    { kind: 'link_project_profile', detail: `project must already be linked to semantic profile "${preset.profile.profileId}"` },
  ];
  if (extensions.length > 0) {
    steps.push({
      kind: 'add_extension',
      detail: `POST semantic-profiles/projects/:projectId/extensions with ${extensions.length} field(s): ${extensions
        .map((e) => e.key)
        .join(', ')}`,
    });
  }
  steps.push(
    { kind: 'link_files_confirm_mappings', detail: 'link T1_LONG and T2, confirm one matched mapping row per canonical field per file' },
    { kind: 'read_live_config_version', detail: "read configVersion off the live semantic contract (resolveSemanticContract), AFTER any extension above (L3)" },
    { kind: 'post_specification', detail: 'specificationBody(preset, projectId, liveConfigVersion)' },
    { kind: 'post_questions', detail: 'questionBody per question, bindings resolved to server fieldIds' },
  );
  return steps;
}

/** A live `configVersion` must carry the manifest-profile's registry hash (`configVersionOf`,
 *  `semantic-profiles.service.ts:436-439`) — refuses a stale/bare pin that CC18 would also refuse. */
function assertLiveConfigVersion(configVersion: string): void {
  if (!/\+sha256:[0-9a-f]+$/.test(configVersion)) {
    throw new Error(
      `specificationBody requires a live configVersion with a "+sha256:" suffix (configVersionOf, ` +
        `semantic-profiles.service.ts:436-439); got "${configVersion}"`,
    );
  }
}

/**
 * The v2 draft `dataSpecification` body for this preset, built against a LIVE `configVersion`
 * (read by the caller AFTER provisioning any extension, per `provisioningPlan`) and a `projectId`
 * to namespace extension fields under (`project.<projectId>.<key>`,
 * `semantic-profile-extension.ts#projectFieldNamespace`). Throws on a configVersion with no
 * `+sha256:` suffix — never silently builds a body CC18 would refuse anyway.
 */
export type ProvisionedSpecField = Omit<PresetField, 'file' | 'canonicalFieldSource'> & { profilePin: string };

export function specificationBody(
  preset: NewModelPreset,
  projectId: string,
  liveConfigVersion: string,
): { fields: ProvisionedSpecField[] } {
  assertLiveConfigVersion(liveConfigVersion);
  return {
    fields: preset.dataSpecification.fields.map(({ file: _file, canonicalFieldSource, canonicalField, ...rest }) => ({
      ...rest,
      canonicalField: canonicalFieldSource === 'extension' ? `project.${projectId}.${canonicalField}` : canonicalField,
      profilePin: liveConfigVersion,
    })),
  };
}

/** A v2 question body (FR5): bindings by server fieldId. Throws on an unknown field name. */
export function questionBody(q: PresetQuestion, fieldIdByName: ReadonlyMap<string, string>) {
  return {
    text: q.text,
    role: q.role,
    estimand: { ...q.estimand },
    template: { ...q.template },
    bindings: q.bindings.map((b) => {
      const field = fieldIdByName.get(b.field);
      if (!field) throw new Error(`question ${q.key}: no server fieldId for "${b.field}"`);
      return { slot: b.slot, field };
    }),
    parameters: { ...q.parameters },
    decisionCriterion: { ...q.decisionCriterion },
    sensitivityAnalyses: [],
  };
}
