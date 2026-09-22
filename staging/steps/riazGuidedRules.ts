/**
 * The rule library that answers the Riaz 2017 guided question
 * (docs/Riaz-Guided-Rule-Workflow.md):
 *
 *   "Does nivolumab induce an on-treatment cytotoxic / IFN-γ transcriptional
 *    program in melanoma, and is that induction confined to responders?"
 *
 * Four rules, one per protocol layer the platform's rule library declares
 * (`rules/protocol-registry.ts`):
 *
 *   QC        RIAZ-QC-PAIRED-01  — executable. Cited by the plan's `qc_check`
 *                                  node (`params.ruleCode`); the kernel runs it
 *                                  as a real QC rule run and its verdict gates
 *                                  every downstream node (`qc-outcome@1`).
 *   INTERPRET RIAZ-INT-CYTO-01   — the state-label rule: "cytotoxic program
 *                                  induced" when ≥ 4 of 6 effector/T-cell genes
 *                                  rise ≥ 0.5 log2 CPM Pre→On.
 *   INTERPRET RIAZ-INT-RESP-01   — "responder-restricted" when the induction
 *                                  fires in responders and not in non-responders.
 *   DECISION  RIAZ-DEC-01        — the terminal verdict, RUO, human review
 *                                  required.
 *
 * INTERPRET/DECISION rules are authoring-only on the platform today (no
 * executor — AXI-1491 dependency R1): they are published so the demo's
 * DecisionDraft can cite them by code, and `stageRiazGuided.ts` evaluates
 * their predicates deterministically over the paired-test tables the governed
 * run produced, printing which leaf fired. Nothing here drives platform logic
 * except the QC rule.
 */
import type { DecisionDraftConfidence } from './stageRiazGuided';

export const QC_RULE_CODE = 'RIAZ-QC-PAIRED-01';
export const INT_CYTO_CODE = 'RIAZ-INT-CYTO-01';
export const INT_RESP_CODE = 'RIAZ-INT-RESP-01';
export const DEC_CODE = 'RIAZ-DEC-01';

/** The cytotoxic / T-cell effector axis the interpretation rule scores. */
export const CYTO_GENES = ['CD8A', 'PRF1', 'GZMB', 'IFNG', 'PDCD1', 'LAG3'] as const;
export const CYTO_DELTA_THRESHOLD = 0.5; // log2 CPM, Pre→On, paired mean
export const CYTO_K_OF_N = 4;
export const CYTO_P_THRESHOLD = 0.05;

export interface RuleDraft {
  create: Record<string, unknown>;
  body: Record<string, unknown>;
}

const RUO = 'Research Use Only — not for diagnostic or treatment decisions.';

export function qcRule(): RuleDraft {
  return {
    create: {
      code: QC_RULE_CODE,
      title: 'Paired referent completeness guard (Riaz 2017)',
      question: 'Does the referent carry enough paired Pre/On measurements for a per-patient induction estimate?',
      signals: ['meta:sample_size'],
      logicSummary:
        'The referent must carry at least 240 measurement rows — five fully paired patients × 24 panel genes × 2 timepoints. ' +
        'Below that a paired mean delta is not an estimate of anything; the guard caps confidence and requires human review.',
      risksNotes: 'Row count is a proxy for paired completeness; it does not check that each patient has BOTH timepoints (the paired test refuses those subjects itself).',
      category: 'qc_guard',
      protocolType: 'QC_RULE',
      tags: ['riaz-2017', 'demo', 'qc'],
    },
    body: {
      attributeEvaluations: [
        { id: `${QC_RULE_CODE}-eval-1`, attributeKey: 'sample_size', operator: '>=', value: 240, valueType: 'number', context: 'absolute', label: 'At least 5 fully paired patients (240 rows)' },
      ],
      expression: { type: 'LEAF', evaluationId: `${QC_RULE_CODE}-eval-1` },
      outputFields: [
        { key: 'include_mask', type: 'boolean', description: 'Whether the referent passes the paired-completeness guard' },
        { key: 'qc_fail_reasons', type: 'string[]', description: 'Why the referent failed, when it did' },
        { key: 'paired_completeness_adequate', type: 'boolean', description: 'Alias of include_mask for reports' },
      ],
      confidenceHeuristic: null,
      guardOutput: { confidenceCap: 0.5, requireHumanReview: true },
      ruoOnly: true,
    },
  };
}

export function interpretCytoRule(): RuleDraft {
  const evals = CYTO_GENES.map((g, i) => ({
    id: `${INT_CYTO_CODE}-eval-${i + 1}`,
    attributeKey: `paired_mean_delta_log2cpm:${g}`,
    operator: '>=',
    value: CYTO_DELTA_THRESHOLD,
    valueType: 'number',
    context: 'vs_baseline',
    label: `${g} induced ≥ ${CYTO_DELTA_THRESHOLD} log2 CPM Pre→On`,
  }));
  return {
    create: {
      code: INT_CYTO_CODE,
      title: 'On-treatment cytotoxic program induction',
      question: 'Is a cytotoxic / IFN-γ effector program induced on nivolumab, per patient, between the pre-treatment and on-treatment biopsy?',
      signals: ['summary_metric:paired_mean_delta_log2cpm', 'summary_metric:paired_ttest_p', ...CYTO_GENES.map((g) => `feature:${g}`)],
      logicSummary:
        `State label "cytotoxic_program_induced" fires when at least ${CYTO_K_OF_N} of ${CYTO_GENES.length} effector / T-cell genes ` +
        `(${CYTO_GENES.join(', ')}) show a paired mean Pre→On increase ≥ ${CYTO_DELTA_THRESHOLD} log2 CPM. ` +
        `Confidence is read from the paired t-test: high when every fired gene has p < ${CYTO_P_THRESHOLD}, medium when most do, low otherwise.`,
      risksNotes:
        'Bulk RNA-seq: an effector-gene rise can be infiltration, not activation. Panel is 6 genes; a K-of-N on a hand-picked panel is a hypothesis-scoring rule, not a signature. ' +
        'On-treatment biopsies are 2–4 weeks in; timing differs per patient.',
      category: 'microenvironment_state',
      protocolType: 'INTERPRET_RULE',
      tags: ['riaz-2017', 'demo', 'interpretation'],
    },
    body: {
      attributeEvaluations: evals,
      expression: { type: 'K_OF_N', k: CYTO_K_OF_N, children: evals.map((e) => ({ type: 'LEAF', evaluationId: e.id })) },
      outputFields: [
        { key: 'output_type', type: 'string', description: 'state_label' },
        { key: 'state_label', type: 'string', description: 'cytotoxic_program_induced | cytotoxic_program_not_induced' },
        { key: 'confidence', type: 'number', description: 'Confidence 0-1 from the confidence heuristic' },
        { key: 'evidence_refs', type: 'string[]', description: 'Rule-run ids of the paired t-test tables the deltas were read from' },
        {
          key: 'scoring_schema',
          type: 'string',
          description: JSON.stringify({ kind: 'k_of_n', k: CYTO_K_OF_N, n: CYTO_GENES.length, leaf: { metric: 'paired_mean_delta_log2cpm', operator: '>=', value: CYTO_DELTA_THRESHOLD } }),
        },
        { key: 'genes_fired', type: 'string[]', description: 'Which panel genes crossed the induction threshold' },
      ],
      confidenceHeuristic: {
        levels: [
          { level: 'high', condition: `every fired gene has paired p < ${CYTO_P_THRESHOLD}`, value: 0.85 },
          { level: 'medium', condition: `at least ${CYTO_K_OF_N} fired genes have paired p < ${CYTO_P_THRESHOLD}`, value: 0.6 },
          { level: 'low', condition: 'fired on delta alone', value: 0.3 },
        ],
      },
      guardOutput: null,
      ruoOnly: true,
    },
  };
}

export function interpretRespRule(): RuleDraft {
  return {
    create: {
      code: INT_RESP_CODE,
      title: 'Responder-restricted on-treatment induction',
      question: 'Is the on-treatment cytotoxic induction confined to RECIST responders (CR/PR) rather than shared with non-responders (PD)?',
      signals: [`rule_score:${INT_CYTO_CODE}`, 'summary_metric:paired_mean_delta_log2cpm'],
      logicSummary:
        `"responder_restricted" fires when ${INT_CYTO_CODE} fires on the responder cohort AND does NOT fire on the non-responder cohort. ` +
        '"shared_induction" when it fires on both; "no_induction" when on neither. Human review is always required: the cohorts are 9 vs 18 patients.',
      risksNotes: 'Responder cohort is n=9; a single patient flips a K-of-N leaf. Response is best overall response, not durable benefit. Prior ipilimumab is not stratified here.',
      category: 'research_stratification',
      protocolType: 'INTERPRET_RULE',
      tags: ['riaz-2017', 'demo', 'interpretation'],
    },
    body: {
      attributeEvaluations: [
        { id: `${INT_RESP_CODE}-eval-1`, attributeKey: `rule_state:${INT_CYTO_CODE}@responders`, operator: '==', value: 'cytotoxic_program_induced', valueType: 'string', context: 'cohort', label: 'Induction fires in responders' },
        { id: `${INT_RESP_CODE}-eval-2`, attributeKey: `rule_state:${INT_CYTO_CODE}@non_responders`, operator: '!=', value: 'cytotoxic_program_induced', valueType: 'string', context: 'cohort', label: 'Induction does not fire in non-responders' },
      ],
      expression: { type: 'AND', children: [{ type: 'LEAF', evaluationId: `${INT_RESP_CODE}-eval-1` }, { type: 'LEAF', evaluationId: `${INT_RESP_CODE}-eval-2` }] },
      outputFields: [
        { key: 'output_type', type: 'string', description: 'state_label' },
        { key: 'state_label', type: 'string', description: 'responder_restricted | shared_induction | no_induction' },
        { key: 'confidence', type: 'number', description: 'Confidence 0-1 from the confidence heuristic' },
        { key: 'evidence_refs', type: 'string[]', description: 'Rule-run ids of the per-cohort paired t-tests' },
        { key: 'scoring_schema', type: 'string', description: JSON.stringify({ kind: 'and', leaves: ['responders.induced == true', 'non_responders.induced == false'] }) },
      ],
      confidenceHeuristic: {
        levels: [
          { level: 'high', condition: 'responder induction high-confidence AND non-responder fires ≤ 1 gene', value: 0.8 },
          { level: 'medium', condition: 'responder induction fires AND non-responder fires ≤ 3 genes', value: 0.55 },
          { level: 'low', condition: 'anything else', value: 0.25 },
        ],
      },
      guardOutput: { requireHumanReview: true, confidenceCap: 0.8 },
      ruoOnly: true,
    },
  };
}

export function decisionRule(): RuleDraft {
  return {
    create: {
      code: DEC_CODE,
      title: 'Riaz 2017 on-treatment induction — decision',
      question: 'Is this cohort consistent with Riaz et al. 2017: on-treatment (not pre-treatment) immune induction distinguishes nivolumab responders?',
      signals: [`interpretation:${INT_CYTO_CODE}`, `interpretation:${INT_RESP_CODE}`, 'provenance:governed_run'],
      logicSummary:
        `Verdict "consistent_with_riaz_2017" when ${INT_RESP_CODE} = responder_restricted; "partially_consistent" when ${INT_CYTO_CODE} fires in responders but ` +
        'the induction is shared; "inconsistent" otherwise. Always RUO; always requires a named human approver; confidence capped at 0.8.',
      risksNotes: RUO + ' Cohort re-derived from the public BMS038 count matrix (27 fully paired R/NR patients); not the paper’s exact sample set.',
      category: 'research_stratification',
      protocolType: 'DECISION_RULE',
      tags: ['riaz-2017', 'demo', 'decision'],
    },
    body: {
      attributeEvaluations: [
        { id: `${DEC_CODE}-eval-1`, attributeKey: `interpretation:${INT_RESP_CODE}.state_label`, operator: '==', value: 'responder_restricted', valueType: 'string', context: 'terminal', label: 'Responder-restricted induction established' },
      ],
      expression: { type: 'LEAF', evaluationId: `${DEC_CODE}-eval-1` },
      outputFields: [
        { key: 'decision_type', type: 'string', description: 'phenotype_classification' },
        { key: 'verdict', type: 'string', description: 'consistent_with_riaz_2017 | partially_consistent | inconsistent' },
        { key: 'confidence', type: 'number', description: 'Confidence 0-1, capped at 0.8' },
        { key: 'evidence_refs', type: 'string[]', description: 'Governed run id, QC rule-run id, per-cohort paired-test rule-run ids' },
        { key: 'disclaimer_flags', type: 'string[]', description: 'RUO; bulk RNA-seq; n=9 responders' },
      ],
      confidenceHeuristic: null,
      guardOutput: { requireHumanReview: true, confidenceCap: 0.8 },
      ruoOnly: true,
      safetyFlags: ['RUO'],
    },
  };
}

export const ALL_RULES: Array<() => RuleDraft> = [qcRule, interpretCytoRule, interpretRespRule, decisionRule];

/** Offline evaluation of the two INTERPRET rules + the DECISION rule over the
 *  per-gene paired-test rows the governed run produced (no executor exists
 *  for these protocols — see the module comment). Pure; unit-testable. */
export interface PairedGeneStat { gene: string; meanDelta: number; p: number | null }

export interface CytoVerdict { stateLabel: 'cytotoxic_program_induced' | 'cytotoxic_program_not_induced'; genesFired: string[]; genesSignificant: string[]; confidence: number }

export function evaluateCyto(rows: PairedGeneStat[]): CytoVerdict {
  const byGene = new Map(rows.map((r) => [r.gene, r]));
  const genesFired = CYTO_GENES.filter((g) => (byGene.get(g)?.meanDelta ?? -Infinity) >= CYTO_DELTA_THRESHOLD);
  const genesSignificant = genesFired.filter((g) => (byGene.get(g)?.p ?? 1) < CYTO_P_THRESHOLD);
  const fired = genesFired.length >= CYTO_K_OF_N;
  const confidence = !fired ? 0 : genesSignificant.length === genesFired.length ? 0.85 : genesSignificant.length >= CYTO_K_OF_N ? 0.6 : 0.3;
  return { stateLabel: fired ? 'cytotoxic_program_induced' : 'cytotoxic_program_not_induced', genesFired, genesSignificant, confidence };
}

export interface RespVerdict { stateLabel: 'responder_restricted' | 'shared_induction' | 'no_induction'; confidence: number }

export function evaluateResp(responders: CytoVerdict, nonResponders: CytoVerdict): RespVerdict {
  const r = responders.stateLabel === 'cytotoxic_program_induced';
  const nr = nonResponders.stateLabel === 'cytotoxic_program_induced';
  if (r && !nr) {
    const confidence = responders.confidence >= 0.85 && nonResponders.genesFired.length <= 1 ? 0.8 : nonResponders.genesFired.length <= 3 ? 0.55 : 0.25;
    return { stateLabel: 'responder_restricted', confidence };
  }
  return { stateLabel: r && nr ? 'shared_induction' : 'no_induction', confidence: 0.25 };
}

export interface DecisionVerdict { verdict: 'consistent_with_riaz_2017' | 'partially_consistent' | 'inconsistent'; confidence: number; draftConfidence: DecisionDraftConfidence }

export function evaluateDecision(responders: CytoVerdict, resp: RespVerdict): DecisionVerdict {
  const verdict = resp.stateLabel === 'responder_restricted' ? 'consistent_with_riaz_2017' : resp.stateLabel === 'shared_induction' && responders.stateLabel === 'cytotoxic_program_induced' ? 'partially_consistent' : 'inconsistent';
  const confidence = Math.min(0.8, resp.confidence);
  return { verdict, confidence, draftConfidence: confidence >= 0.7 ? 'high' : confidence >= 0.5 ? 'medium' : 'low' };
}
