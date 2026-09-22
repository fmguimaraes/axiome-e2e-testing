/**
 * Builders for every rule protocol the platform's library declares
 * (`apps/organization-service/src/rules/protocol-registry.ts`):
 *
 *   QC_RULE · FEATURE_RULE · SUMMARY_RULE · STRATIFY_RULE · INTERPRET_RULE · DECISION_RULE
 *
 * Each builder takes the scientific content (question, evaluations, logic) and
 * fills in what `validateProtocolCompliance` demands on publish — the required
 * `outputFields` per protocol, `guardOutput` for QC, the signal-prefix
 * conventions — so a library author writes the biology, not the contract.
 *
 * `checkProtocol()` mirrors the server-side validator offline (required output
 * keys, guard presence, signal prefixes, the SUMMARY/INTERPRET "must declare an
 * input" rules) so `stage:rules --check` catches a bad draft before any HTTP.
 * `PROTOCOL_CONTRACT` is a hand-maintained mirror of the registry: when the
 * registry changes, change it here (the publish call is the source of truth).
 *
 * Execution reality (AXI-1491 R1): today only QC rules execute on the platform
 * (a governed `qc_check` node cites them by code). FEATURE / SUMMARY / STRATIFY
 * / INTERPRET / DECISION rules are authoring-only — published so plans,
 * DecisionDrafts and humans can cite them, and evaluated offline by scripts.
 */
import type { RuleDraft } from './ensureRule';

export type ProtocolType = 'QC_RULE' | 'FEATURE_RULE' | 'SUMMARY_RULE' | 'STRATIFY_RULE' | 'INTERPRET_RULE' | 'DECISION_RULE';

export type RuleCategory =
  | 'phenotype_detection'
  | 'microenvironment_state'
  | 'research_stratification'
  | 'qc_guard'
  | 'knowledge_reuse'
  | 'safety'
  | 'composite_decision'
  | 'relationship_rule';

export type Operator = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not_in';

export interface Evaluation {
  /** Defaults to `<code>-eval-<n>`. */
  id?: string;
  attributeKey: string;
  operator: Operator;
  value: unknown;
  valueType?: 'number' | 'string' | 'boolean';
  context?: string;
  label?: string;
}

export type Expression =
  | { type: 'LEAF'; evaluationId: string }
  | { type: 'AND' | 'OR'; children: Expression[] }
  | { type: 'NOT'; child: Expression }
  | { type: 'K_OF_N'; k: number; children: Expression[] };

export interface OutputField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'string[]' | 'number[]';
  description: string;
}

export interface ConfidenceLevel {
  level: 'high' | 'medium' | 'low';
  condition: string;
  value: number;
}

export interface GuardOutput {
  confidenceCap?: number;
  requireHumanReview?: boolean;
}

/** What every protocol shares. */
export interface RuleSpec {
  code: string;
  title: string;
  question: string;
  /** Input references; prefixes are checked against `PROTOCOL_CONTRACT`. */
  signals: string[];
  logicSummary: string;
  risksNotes: string;
  category: RuleCategory;
  tags?: string[];
  evaluations: Evaluation[];
  /**
   * Defaults to the single LEAF when one evaluation is given, else an AND of
   * all leaves. `kOfN` builds a K_OF_N over all leaves instead.
   */
  expression?: Expression;
  kOfN?: number;
  /** Protocol-specific fields are added by the builder; these are appended. */
  extraOutputFields?: OutputField[];
  confidenceHeuristic?: { levels: ConfidenceLevel[] } | null;
  guardOutput?: GuardOutput | null;
  ruoOnly?: boolean;
  safetyFlags?: string[];
}

export const RUO_NOTE = 'Research Use Only — not for diagnostic or treatment decisions.';

/** Mirror of the registry's contract, kept small on purpose. */
export const PROTOCOL_CONTRACT: Record<ProtocolType, { requiredOutputKeys: string[]; allowedSignalPrefixes: string[]; requiresGuardOutput: boolean; requiredInputPrefixes: string[] | null }> = {
  QC_RULE: { requiredOutputKeys: ['include_mask', 'qc_fail_reasons'], allowedSignalPrefixes: ['meta:', 'marker:', 'score:', 'rule_score:'], requiresGuardOutput: true, requiredInputPrefixes: null },
  FEATURE_RULE: { requiredOutputKeys: ['feature_name', 'value'], allowedSignalPrefixes: ['marker:', 'marker_set:', 'score:', 'meta:', 'ratio(', 'delta('], requiresGuardOutput: false, requiredInputPrefixes: null },
  SUMMARY_RULE: { requiredOutputKeys: ['group_id', 'n_total', 'n_included', 'aggregation_level', 'aggregation_functions'], allowedSignalPrefixes: ['feature:', 'rule_score:', 'meta:', 'qc_mask'], requiresGuardOutput: false, requiredInputPrefixes: ['feature:', 'qc_mask'] },
  STRATIFY_RULE: { requiredOutputKeys: ['stratify_mode', 'group_id', 'n_included'], allowedSignalPrefixes: ['feature:', 'meta:', 'qc_mask'], requiresGuardOutput: false, requiredInputPrefixes: null },
  INTERPRET_RULE: { requiredOutputKeys: ['output_type', 'confidence', 'evidence_refs', 'scoring_schema'], allowedSignalPrefixes: ['summary_metric:', 'feature:', 'rule_score:', 'meta:', 'qc_mask', 'assignment:', 'enrichment:'], requiresGuardOutput: false, requiredInputPrefixes: ['summary_metric:', 'feature:', 'rule_score:'] },
  DECISION_RULE: { requiredOutputKeys: ['decision_type', 'verdict', 'confidence', 'evidence_refs', 'disclaimer_flags'], allowedSignalPrefixes: ['interpretation:', 'rule_score:', 'summary_metric:', 'meta:', 'provenance:'], requiresGuardOutput: false, requiredInputPrefixes: null },
};

// ── shared assembly ─────────────────────────────────────────────────────────

function withIds(code: string, evals: Evaluation[]): Array<Required<Pick<Evaluation, 'id' | 'attributeKey' | 'operator' | 'value' | 'valueType'>> & Pick<Evaluation, 'context' | 'label'>> {
  return evals.map((e, i) => ({
    id: e.id ?? `${code}-eval-${i + 1}`,
    attributeKey: e.attributeKey,
    operator: e.operator,
    value: e.value,
    valueType: e.valueType ?? (typeof e.value === 'number' ? 'number' : typeof e.value === 'boolean' ? 'boolean' : 'string'),
    context: e.context ?? 'absolute',
    label: e.label ?? `${e.attributeKey} ${e.operator} ${JSON.stringify(e.value)}`,
  }));
}

function defaultExpression(spec: RuleSpec, ids: string[]): Expression {
  if (spec.expression) return spec.expression;
  const leaves: Expression[] = ids.map((evaluationId) => ({ type: 'LEAF', evaluationId }));
  if (spec.kOfN) return { type: 'K_OF_N', k: spec.kOfN, children: leaves };
  return leaves.length === 1 ? leaves[0] : { type: 'AND', children: leaves };
}

function assemble(protocolType: ProtocolType, spec: RuleSpec, protocolFields: OutputField[], defaults: { guardOutput?: GuardOutput | null; category?: RuleCategory }): RuleDraft {
  const evals = withIds(spec.code, spec.evaluations);
  const outputFields = dedupeByKey([...protocolFields, ...(spec.extraOutputFields ?? [])]);
  return {
    create: {
      code: spec.code,
      title: spec.title,
      question: spec.question,
      signals: spec.signals,
      logicSummary: spec.logicSummary,
      risksNotes: spec.risksNotes,
      category: spec.category ?? defaults.category ?? 'research_stratification',
      protocolType,
      tags: spec.tags ?? [],
    },
    body: {
      attributeEvaluations: evals,
      expression: defaultExpression(spec, evals.map((e) => e.id)),
      outputFields,
      confidenceHeuristic: spec.confidenceHeuristic ?? null,
      guardOutput: spec.guardOutput === undefined ? defaults.guardOutput ?? null : spec.guardOutput,
      ruoOnly: spec.ruoOnly ?? true,
      ...(spec.safetyFlags ? { safetyFlags: spec.safetyFlags } : {}),
    },
  };
}

function dedupeByKey(fields: OutputField[]): OutputField[] {
  const seen = new Set<string>();
  return fields.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true)));
}

// ── QC ──────────────────────────────────────────────────────────────────────

export interface QcSpec extends RuleSpec {
  /** Required by the registry; defaults to cap 0.5 + human review. */
  guardOutput?: GuardOutput;
}

/** Executable: cite by `params.ruleCode` from a plan's `qc_check` node. */
export function qcRule(spec: QcSpec): RuleDraft {
  return assemble(
    'QC_RULE',
    spec,
    [
      { key: 'include_mask', type: 'boolean', description: 'Whether the referent passes the guard' },
      { key: 'qc_fail_reasons', type: 'string[]', description: 'Why it failed, when it did' },
    ],
    { guardOutput: { confidenceCap: 0.5, requireHumanReview: true }, category: 'qc_guard' },
  );
}

// ── FEATURE ─────────────────────────────────────────────────────────────────

export interface FeatureSpec extends Omit<RuleSpec, 'evaluations'> {
  /** The emitted `feature_name` — what downstream `feature:<name>` signals cite. */
  featureName: string;
  /** Human-readable formula, stored as the `formula` output field description. */
  formula: string;
  /** Optional evaluations (e.g. a validity range); a feature rule may have none. */
  evaluations?: Evaluation[];
  range?: string;
}

/** Derives one numeric feature per row (score, ratio, delta) for later layers. */
export function featureRule(spec: FeatureSpec): RuleDraft {
  const evaluations = spec.evaluations ?? [{ attributeKey: `feature:${spec.featureName}`, operator: '!=', value: 'NA', valueType: 'string', context: 'derived', label: `${spec.featureName} is computable (every input marker present)` }];
  return assemble(
    'FEATURE_RULE',
    { ...spec, evaluations },
    [
      { key: 'feature_name', type: 'string', description: spec.featureName },
      { key: 'value', type: 'number', description: 'Numeric feature value per row' },
      { key: 'formula', type: 'string', description: spec.formula },
      ...(spec.range ? [{ key: 'range', type: 'string' as const, description: spec.range }] : []),
    ],
    { category: 'phenotype_detection' },
  );
}

// ── SUMMARY ─────────────────────────────────────────────────────────────────

export interface SummarySpec extends RuleSpec {
  aggregationLevel: 'GROUP' | 'COHORT' | 'GROUP,COHORT';
  /** Serialised into `aggregation_functions` (JSON array). */
  aggregations: Array<{ metric: string; fn: 'mean' | 'median' | 'std' | 'count' | 'sum' | 'min' | 'max' | 'fraction' }>;
}

/** Aggregates features per group / cohort; must cite a `feature:` or `qc_mask` input. */
export function summaryRule(spec: SummarySpec): RuleDraft {
  return assemble(
    'SUMMARY_RULE',
    spec,
    [
      { key: 'group_id', type: 'string', description: 'Group identifier the aggregation is reported for' },
      { key: 'n_total', type: 'number', description: 'Rows in the group before the QC mask' },
      { key: 'n_included', type: 'number', description: 'Rows in the group after the QC mask' },
      { key: 'aggregation_level', type: 'string', description: spec.aggregationLevel },
      { key: 'aggregation_functions', type: 'string', description: JSON.stringify(spec.aggregations) },
    ],
    { category: 'research_stratification' },
  );
}

// ── STRATIFY ────────────────────────────────────────────────────────────────

export interface StratifySpec extends RuleSpec {
  mode: 'PREDEFINED_GROUPING' | 'CLUSTERING';
  /** For PREDEFINED_GROUPING: the column and its levels. */
  groupBy?: { column: string; levels: string[] };
  algorithm?: string;
  seed?: number;
}

/** Assigns rows to groups (explicit column levels or a clustering). */
export function stratifyRule(spec: StratifySpec): RuleDraft {
  const evaluations = spec.evaluations.length > 0 || !spec.groupBy
    ? spec.evaluations
    : spec.groupBy.levels.map((level) => ({ attributeKey: `meta:${spec.groupBy!.column}`, operator: '==' as const, value: level, valueType: 'string' as const, context: 'group', label: `${spec.groupBy!.column} = ${level}` }));
  return assemble(
    'STRATIFY_RULE',
    { ...spec, evaluations, expression: spec.expression ?? (evaluations.length > 1 ? { type: 'OR', children: evaluations.map((_, i) => ({ type: 'LEAF', evaluationId: `${spec.code}-eval-${i + 1}` })) } : undefined) },
    [
      { key: 'stratify_mode', type: 'string', description: spec.mode },
      { key: 'group_id', type: 'string', description: spec.groupBy ? `${spec.groupBy.column} ∈ {${spec.groupBy.levels.join(', ')}}` : 'Assigned group' },
      { key: 'n_included', type: 'number', description: 'Rows assigned to the group' },
      ...(spec.algorithm ? [{ key: 'algorithm', type: 'string' as const, description: spec.algorithm }] : []),
      ...(spec.seed !== undefined ? [{ key: 'seed', type: 'number' as const, description: String(spec.seed) }] : []),
    ],
    { category: 'research_stratification' },
  );
}

// ── INTERPRET ───────────────────────────────────────────────────────────────

export interface InterpretSpec extends RuleSpec {
  outputType: 'state_label' | 'flag' | 'severity';
  /** The labels the rule can emit, first = "fired". Stored on the `state_label` field. */
  labels: string[];
  /** Serialised into `scoring_schema`. */
  scoringSchema: Record<string, unknown>;
}

/** Turns summary metrics / features / other rule scores into a state label. */
export function interpretRule(spec: InterpretSpec): RuleDraft {
  return assemble(
    'INTERPRET_RULE',
    spec,
    [
      { key: 'output_type', type: 'string', description: spec.outputType },
      { key: spec.outputType, type: 'string', description: spec.labels.join(' | ') },
      { key: 'confidence', type: 'number', description: 'Confidence 0-1 from the confidence heuristic' },
      { key: 'evidence_refs', type: 'string[]', description: 'Rule-run / snapshot ids the inputs were read from' },
      { key: 'scoring_schema', type: 'string', description: JSON.stringify(spec.scoringSchema) },
    ],
    { category: 'microenvironment_state' },
  );
}

// ── DECISION ────────────────────────────────────────────────────────────────

export interface DecisionSpec extends RuleSpec {
  decisionType: 'phenotype_classification' | 'research_stratification' | 'go_no_go' | 'hypothesis_status';
  verdicts: string[];
  disclaimers?: string[];
}

/** Terminal verdict over interpretations; always RUO, always human-reviewed. */
export function decisionRule(spec: DecisionSpec): RuleDraft {
  return assemble(
    'DECISION_RULE',
    { ...spec, safetyFlags: spec.safetyFlags ?? ['RUO'] },
    [
      { key: 'decision_type', type: 'string', description: spec.decisionType },
      { key: 'verdict', type: 'string', description: spec.verdicts.join(' | ') },
      { key: 'confidence', type: 'number', description: 'Confidence 0-1 (capped by guardOutput)' },
      { key: 'evidence_refs', type: 'string[]', description: 'Governed run id, rule-run ids, snapshot ids' },
      { key: 'disclaimer_flags', type: 'string[]', description: (spec.disclaimers ?? ['RUO']).join('; ') },
    ],
    { guardOutput: { requireHumanReview: true, confidenceCap: 0.8 }, category: 'composite_decision' },
  );
}

// ── offline validation ──────────────────────────────────────────────────────

/** Returns the problems the server-side publish validator would raise; empty = clean. */
export function checkProtocol(draft: RuleDraft): string[] {
  const problems: string[] = [];
  const protocol = draft.create.protocolType as ProtocolType;
  const contract = PROTOCOL_CONTRACT[protocol];
  const code = String(draft.create.code);
  if (!contract) return [`${code}: unknown protocolType ${protocol}`];
  const outputKeys = new Set(((draft.body.outputFields as OutputField[] | undefined) ?? []).map((f) => f.key));
  for (const key of contract.requiredOutputKeys) if (!outputKeys.has(key)) problems.push(`${code}: missing required output field "${key}" for ${protocol}`);
  if (contract.requiresGuardOutput && !draft.body.guardOutput) problems.push(`${code}: ${protocol} requires guardOutput`);
  const signals = (draft.create.signals as string[] | undefined) ?? [];
  for (const s of signals) {
    const prefixed = /^[a-z_]+[:(]/.test(s);
    if (prefixed && !contract.allowedSignalPrefixes.some((p) => s.startsWith(p))) problems.push(`${code}: signal "${s}" uses a prefix ${protocol} does not accept (${contract.allowedSignalPrefixes.join(' ')})`);
  }
  if (contract.requiredInputPrefixes && signals.length > 0 && !signals.some((s) => contract.requiredInputPrefixes!.some((p) => s.startsWith(p)))) {
    problems.push(`${code}: ${protocol} must declare at least one ${contract.requiredInputPrefixes.join(' / ')} input`);
  }
  const evals = (draft.body.attributeEvaluations as Array<{ id: string }> | undefined) ?? [];
  const ids = new Set(evals.map((e) => e.id));
  const walk = (x: Expression | undefined): void => {
    if (!x) return;
    if (x.type === 'LEAF') {
      if (!ids.has(x.evaluationId)) problems.push(`${code}: expression cites unknown evaluation ${x.evaluationId}`);
    } else if (x.type === 'NOT') walk(x.child);
    else x.children.forEach(walk);
  };
  walk(draft.body.expression as Expression | undefined);
  return problems;
}
