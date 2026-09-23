import type { Verdict } from './riazQuestionVerdicts';

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

export const QUESTION_CONFIG: Record<string, QuestionConfig> = {
  Q2: {
    focusGenes: ['PDCD1'],
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `PDCD1 (PD-1) reads ${verdictHeadline(v, 'RIAZ-INT-PD1-01 @ all')} pooled, ${verdictHeadline(v, 'RIAZ-INT-PD1-01 @ response=NR')} in non-responders`,
    labelRules: ['RIAZ-INT-PD1-01 @ all', 'RIAZ-INT-PD1-01 @ response=R', 'RIAZ-INT-PD1-01 @ response=NR'],
    decisionType: 'phenotype_classification',
  },
  Q3: {
    focusGenes: IFNG_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `the IFN-γ programme in responders reads ${verdictHeadline(v, 'RIAZ-INT-IFNG-01 @ responders')}`,
    labelRules: ['RIAZ-INT-IFNG-01 @ responders'],
    decisionType: 'phenotype_classification',
  },
  Q4: {
    focusGenes: CYTOTOXIC_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `baseline (Pre) cytotoxic expression reads ${verdictHeadline(v, 'RIAZ-INT-BASELINE-01 @ Pre')}; response prediction is ${verdictHeadline(v, 'RIAZ-DEC-BASELINE-01 (with Q1 responder_restricted)')}`,
    labelRules: ['RIAZ-INT-BASELINE-01 @ Pre', 'RIAZ-DEC-BASELINE-01 (with Q1 responder_restricted)'],
    decisionType: 'biomarker_threshold',
  },
  Q5: {
    focusGenes: CYTOTOXIC_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `cytotoxic induction by prior ipilimumab exposure reads ${verdictHeadline(v, 'RIAZ-INT-IPI-01')} — ${verdictHeadline(v, 'RIAZ-DEC-IPI-01')}`,
    labelRules: ['RIAZ-INT-IPI-01', 'RIAZ-DEC-IPI-01'],
    decisionType: 'cohort_stratification',
  },
  Q6: {
    focusGenes: EXHAUSTION_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `on-treatment exhaustion/checkpoint markers read ${verdictHeadline(v, 'RIAZ-INT-EXH-01 @ On')} in responders vs non-responders`,
    labelRules: ['RIAZ-INT-EXH-01 @ On'],
    decisionType: 'phenotype_classification',
  },
  Q7: {
    focusGenes: CYTOTOXIC_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `non-responder cytotoxic induction reads ${verdictHeadline(v, 'RIAZ-INT-CYTO-01 @ non-responders')}`,
    labelRules: ['RIAZ-INT-CYTO-01 @ non-responders'],
    decisionType: 'phenotype_classification',
  },
  Q8: {
    focusGenes: [],
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `baseline differential-expression signal reads ${verdictHeadline(v, 'RIAZ-INT-DE-01')}`,
    labelRules: ['RIAZ-SUM-DE-01', 'RIAZ-INT-DE-01'],
    decisionType: 'phenotype_classification',
  },
  Q9: {
    focusGenes: [],
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `the ipi_naive vs ipi_progressed differential-expression strata read ${verdictHeadline(v, 'RIAZ-INT-STRATA-01')}`,
    labelRules: ['RIAZ-SUM-STRATA-01', 'RIAZ-INT-STRATA-01'],
    decisionType: 'cohort_stratification',
  },
  Q10: {
    focusGenes: APM_FOCUS,
    cohortNames: DEFAULT_COHORT_NAMES,
    decisionHeadline: (v) => `antigen-presentation induction (HLA-DRA, CD274) reads ${verdictHeadline(v, 'RIAZ-INT-APM-01 @ all')} pooled, ${verdictHeadline(v, 'RIAZ-INT-APM-01 @ response=R')} in responders`,
    labelRules: ['RIAZ-INT-APM-01 @ all', 'RIAZ-INT-APM-01 @ response=R', 'RIAZ-INT-APM-01 @ response=NR'],
    decisionType: 'phenotype_classification',
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
  },
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
