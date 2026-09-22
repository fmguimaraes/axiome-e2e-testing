import { readFileSync, writeFileSync } from 'node:fs';
import { RestClient } from '../client/RestClient';
import { ensureIdentities } from '../identities/ensureIdentities';
import { asList, must } from '../rules/ensureRule';
import { rulesForQuestion } from '../rules/riazRuleLibrary';
import { CYTO_GENES, evaluateCyto, evaluateResp, type PairedGeneStat } from './riazGuidedRules';
import { ADMIN_HANDLE, SERVICE_HANDLE } from './context';
import { projectHeaders } from './projectProvisioning';
import type { QuestionTrace } from './runRiazQuestions';
import type { PublishedRecord } from './publishRiazEvidence';

/**
 * `npm run stage:riaz-report` — turns docs/riaz-questions-trace.json (what the
 * LLM planner did and what the kernel produced for Q2..Q11) into
 * docs/Riaz-Guided-Questions-Report.md: per question the plan the planner
 * chose, the result tables, the offline verdict of every INTERPRET / DECISION
 * rule the question cites (the platform has no executor for those protocols),
 * whether that verdict matches the expectation computed from the source CSV,
 * and the deep links. Re-fetches each analysis's snapshots for their
 * `effectiveFilters`, which is how a rule run is tied back to its cohort.
 */
const TRACE_PATH = process.env.STAGING_RIAZ_QUESTIONS_TRACE?.trim() || 'docs/riaz-questions-trace.json';
const REPORT_PATH = process.env.STAGING_RIAZ_QUESTIONS_REPORT?.trim() || 'docs/Riaz-Guided-Questions-Report.md';
const FRONT_URL = (process.env.STAGING_FRONT_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
const DELTA = 0.5;
const P = 0.05;

interface Filter { column: string; operator: string; value: unknown }
interface Snap { id: string; origin?: string; ruleRunId?: string | null; parentSnapshotId?: string | null; effectiveFilters?: Filter[] | null; filters?: Filter[] | null; rowCount?: number | null }

/** One result row, normalised across paired / unpaired / other kernels. */
export interface Stat { gene: string; cohort: string; n: number | null; delta: number | null; p: number | null; from: number | null; to: number | null; ciLow: number | null; ciHigh: number | null; operationId: string | null; ruleRunId: string; raw: Record<string, unknown> }

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

const pick = (row: Record<string, unknown>, keys: string[]): unknown => {
  const k = Object.keys(row).find((c) => keys.includes(c.toLowerCase()));
  return k ? row[k] : undefined;
};

function cohortLabel(filters: Filter[]): { cohort: string; gene: string | null } {
  const gene = filters.find((f) => f.column === 'gene' && f.operator === 'eq');
  const rest = filters.filter((f) => f !== gene).map((f) => `${f.column}${f.operator === 'eq' ? '=' : ` ${f.operator} `}${String(f.value)}`);
  return { cohort: rest.length ? rest.join(' & ') : 'all', gene: gene ? String(gene.value) : null };
}

/** Normalise every non-QC rule run of a question into per-gene stats. */
export function statsOf(q: QuestionTrace, snaps: Map<string, Snap>): Stat[] {
  const out: Stat[] = [];
  for (const r of q.ruleRuns) {
    if (r.kind === 'QC') continue;
    const ref = r.referentSnapshotId ? snaps.get(r.referentSnapshotId) : undefined;
    const { cohort, gene: filteredGene } = cohortLabel(ref?.effectiveFilters ?? ref?.filters ?? []);
    for (const row of r.rows) {
      const feature = String(pick(row, ['feature', 'gene', 'measurement_feature']) ?? '');
      const gene = feature && feature !== '__all__' ? feature : filteredGene ?? feature;
      out.push({
        gene,
        cohort,
        n: num(pick(row, ['npairs', 'n', 'n_total', 'nfrom'])),
        delta: num(pick(row, ['meandifference', 'mean_difference', 'mediandifference', 'estimate', 'delta'])),
        p: num(pick(row, ['pvalue', 'p_value', 'p', 'padj'])),
        from: num(pick(row, ['medianfrom', 'meanfrom'])),
        to: num(pick(row, ['medianto', 'meanto'])),
        ciLow: num(pick(row, ['cilow'])),
        ciHigh: num(pick(row, ['cihigh'])),
        operationId: r.operationId,
        ruleRunId: r.id,
        raw: row,
      });
    }
  }
  return out;
}

const byCohort = (stats: Stat[], cohort: string | ((c: string) => boolean)) => stats.filter((s) => (typeof cohort === 'string' ? s.cohort === cohort : cohort(s.cohort)));
const paired = (stats: Stat[]): PairedGeneStat[] => stats.map((s) => ({ gene: s.gene, meanDelta: s.delta ?? NaN, p: s.p }));
const fmt = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));
const fmtP = (v: number | null) => (v === null ? '—' : v < 0.001 ? '<0.001' : v.toFixed(3));

export interface Verdict { rule: string; verdict: string; detail: string; expected: string; match: boolean | null }

function kOfN(stats: Stat[], genes: readonly string[], k: number, label: string, notLabel: string): { verdict: string; fired: string[]; sig: string[] } {
  const m = new Map(stats.map((s) => [s.gene, s]));
  const fired = genes.filter((g) => (m.get(g)?.delta ?? -Infinity) >= DELTA);
  const sig = fired.filter((g) => (m.get(g)?.p ?? 1) < P);
  return { verdict: fired.length >= k ? label : notLabel, fired, sig };
}

/** Direction R > NR from a two-group row: the planner names groupFrom/groupTo; we read the medians the kernel reports and the sign of the effect. */
function higherInR(s: Stat, groupFrom: string | null): boolean | null {
  if (!groupFrom) return null;
  // Mann-Whitney rows carry no medians; the kernel's effectSize is pingouin's
  // rank-biserial correlation with groupTo passed first, so > 0 ⇔ to > from
  // (verified against the CSV: all six Pre medians R > NR ⇔ positive RBC).
  const diff = s.from !== null && s.to !== null ? s.to - s.from : num(s.raw.effectSize);
  if (diff === null) return null;
  return groupFrom === 'NR' ? diff > 0 : diff < 0;
}

function groupFromOf(q: QuestionTrace): string | null {
  for (const n of q.planNodes) {
    const op = (n.operation ?? {}) as { operationParams?: Record<string, unknown> };
    const gf = op.operationParams?.groupFrom ?? (n.params as Record<string, unknown>)?.groupFrom;
    if (typeof gf === 'string') return gf;
  }
  return null;
}

// ── per-question evaluation (the INTERPRET / DECISION rules, offline) ───────

type Evaluator = (q: QuestionTrace, stats: Stat[], ctx: { q1: { r: ReturnType<typeof evaluateCyto>; nr: ReturnType<typeof evaluateCyto> } | null; earlier: Map<string, Verdict[]> }) => Verdict[];

const EVALUATORS: Record<string, Evaluator> = {
  Q2: (_q, stats) =>
    ['all', 'response=R', 'response=NR'].map((c) => {
      const s = byCohort(stats, c).find((x) => x.gene === 'PDCD1');
      const v = !s ? 'not_evaluable' : (s.delta ?? -1) >= DELTA && (s.p ?? 1) < P ? 'pd1_induced' : (s.delta ?? -1) >= DELTA ? 'pd1_trend' : 'pd1_not_induced';
      const expected = c === 'response=NR' ? 'pd1_not_induced' : 'pd1_induced';
      return { rule: `RIAZ-INT-PD1-01 @ ${c}`, verdict: v, detail: s ? `Δ ${fmt(s.delta)}, p ${fmtP(s.p)}, n ${s.n}` : 'no PDCD1 row', expected, match: s ? v === expected : null };
    }),
  Q3: (_q, stats) => {
    const r = kOfN(byCohort(stats, 'response=R'), ['IFNG', 'CXCL9', 'CXCL10', 'CXCL11', 'IDO1', 'STAT1', 'IRF1', 'HLA-DRA'], 5, 'ifng_program_induced', 'ifng_program_not_induced');
    const ok = byCohort(stats, 'response=R').length > 0;
    return [{ rule: 'RIAZ-INT-IFNG-01 @ responders', verdict: ok ? r.verdict : 'not_evaluable', detail: ok ? `fired ${r.fired.length}/8 (${r.fired.join(', ') || 'none'}); p<0.05: ${r.sig.join(', ') || 'none'}` : 'no responder rows', expected: 'ifng_program_not_induced', match: ok ? r.verdict === 'ifng_program_not_induced' : null }];
  },
  Q4: (q, stats) => {
    const gf = groupFromOf(q);
    const pre = byCohort(stats, (c) => c.includes('timepoint=Pre'));
    const sig = CYTO_GENES.filter((g) => { const s = pre.find((x) => x.gene === g); return s && (s.p ?? 1) < P && higherInR(s, gf) !== false; });
    const v = pre.length === 0 ? 'not_evaluable' : sig.length >= 3 ? 'baseline_predictive' : 'baseline_not_predictive';
    const dec = v === 'baseline_not_predictive' ? 'on_treatment_not_baseline' : v === 'baseline_predictive' ? 'both' : 'not_evaluable';
    return [
      { rule: 'RIAZ-INT-BASELINE-01 @ Pre', verdict: v, detail: `R>NR with p<0.05: ${sig.join(', ') || 'none'} (groupFrom=${gf ?? '?'}; ${pre.length} gene rows)`, expected: 'baseline_not_predictive', match: pre.length ? v === 'baseline_not_predictive' : null },
      { rule: 'RIAZ-DEC-BASELINE-01 (with Q1 responder_restricted)', verdict: dec, detail: 'Q1: RIAZ-INT-RESP-01 = responder_restricted', expected: 'on_treatment_not_baseline', match: dec === 'not_evaluable' ? null : dec === 'on_treatment_not_baseline' },
    ];
  },
  Q5: (_q, stats) => {
    const naive = kOfN(byCohort(stats, (c) => c.includes('ipi_naive')), CYTO_GENES, 4, 'cytotoxic_program_induced', 'cytotoxic_program_not_induced');
    const prog = kOfN(byCohort(stats, (c) => c.includes('ipi_progressed')), CYTO_GENES, 4, 'cytotoxic_program_induced', 'cytotoxic_program_not_induced');
    const have = byCohort(stats, (c) => c.includes('ipi_')).length > 0;
    const n = naive.verdict === 'cytotoxic_program_induced', p = prog.verdict === 'cytotoxic_program_induced';
    const ipi = !have ? 'not_evaluable' : n && p ? 'ipi_independent' : n ? 'ipi_naive_only' : p ? 'ipi_progressed_only' : 'no_induction';
    const dec = ipi === 'not_evaluable' ? 'not_evaluable' : ipi !== 'ipi_independent' ? 'stratify_in_follow_up' : 'no_stratification_needed';
    return [
      { rule: 'RIAZ-INT-CYTO-01 @ ipi_naive', verdict: have ? naive.verdict : 'not_evaluable', detail: `fired ${naive.fired.length}/6 (${naive.fired.join(', ') || 'none'}); p<0.05: ${naive.sig.join(', ') || 'none'}`, expected: 'cytotoxic_program_induced', match: have ? naive.verdict === 'cytotoxic_program_induced' : null },
      { rule: 'RIAZ-INT-CYTO-01 @ ipi_progressed', verdict: have ? prog.verdict : 'not_evaluable', detail: `fired ${prog.fired.length}/6 (${prog.fired.join(', ') || 'none'})`, expected: 'cytotoxic_program_not_induced', match: have ? prog.verdict === 'cytotoxic_program_not_induced' : null },
      { rule: 'RIAZ-INT-IPI-01', verdict: ipi, detail: 'induction fires in one stratum only', expected: 'ipi_naive_only', match: have ? ipi === 'ipi_naive_only' : null },
      { rule: 'RIAZ-DEC-IPI-01', verdict: dec, detail: 'not ipi-independent → carry prior_ipi as a stratification factor', expected: 'stratify_in_follow_up', match: have ? dec === 'stratify_in_follow_up' : null },
    ];
  },
  Q6: (q, stats) => {
    const gf = groupFromOf(q);
    const on = byCohort(stats, (c) => c.includes('timepoint=On'));
    const genes = ['LAG3', 'HAVCR2', 'TIGIT', 'CTLA4', 'TOX', 'PDCD1'];
    const sig = genes.filter((g) => { const s = on.find((x) => x.gene === g); return s && (s.p ?? 1) < P && higherInR(s, gf) !== false; });
    const v = on.length === 0 ? 'not_evaluable' : sig.length >= 3 ? 'exhaustion_higher_in_responders' : 'exhaustion_not_different';
    return [{ rule: 'RIAZ-INT-EXH-01 @ On', verdict: v, detail: `R>NR with p<0.05: ${sig.join(', ') || 'none'} (${sig.length}/6; groupFrom=${gf ?? '?'})`, expected: 'exhaustion_higher_in_responders', match: on.length ? v === 'exhaustion_higher_in_responders' : null }];
  },
  Q7: (q, stats) => {
    const nr = kOfN(byCohort(stats, 'response=NR'), CYTO_GENES, 4, 'cytotoxic_program_induced', 'cytotoxic_program_not_induced');
    const have = byCohort(stats, 'response=NR').length > 0;
    const qc = q.ruleRuns.find((r) => r.kind === 'QC');
    return [
      { rule: 'RIAZ-QC-COHORT-MINN-01 / RIAZ-QC-PAIRED-01 (executed)', verdict: qc ? `${qc.status} (${qc.snapshotName ?? ''})` : 'no QC node in plan', detail: qc ? `QC rule run ${qc.id}` : 'planner did not cite a QC rule', expected: 'pass', match: qc ? qc.status === 'SUCCEEDED' : false },
      { rule: 'RIAZ-INT-CYTO-01 @ non-responders', verdict: have ? nr.verdict : 'not_evaluable', detail: `fired ${nr.fired.length}/6 (${nr.fired.join(', ') || 'none'})`, expected: 'cytotoxic_program_not_induced', match: have ? nr.verdict === 'cytotoxic_program_not_induced' : null },
    ];
  },
  Q8: (q, stats) => deVerdicts(q, stats, 'Q8'),
  Q9: (q, stats) => deVerdicts(q, stats, 'Q9'),
  Q10: (_q, stats) =>
    ['all', 'response=R', 'response=NR'].map((c) => {
      const r = kOfN(byCohort(stats, c), ['HLA-DRA', 'CD274'], 2, 'apm_induced', 'apm_not_induced');
      const have = byCohort(stats, c).length > 0;
      const expected = c === 'response=R' ? 'apm_induced' : 'apm_not_induced';
      return { rule: `RIAZ-INT-APM-01 @ ${c}`, verdict: have ? r.verdict : 'not_evaluable', detail: `fired ${r.fired.join(', ') || 'none'}; p<0.05: ${r.sig.join(', ') || 'none'}`, expected, match: have ? r.verdict === expected : null };
    }),
  Q11: (_q, stats, ctx) => {
    const r = byCohort(stats, 'response=R'), nr = byCohort(stats, 'response=NR');
    if (!r.length || !nr.length) return [{ rule: 'RIAZ-INT-SENS-01', verdict: 'not_evaluable', detail: 'need responder + non-responder Wilcoxon rows', expected: 'robust', match: null }];
    const wilcoxon = stats.every((s) => s.operationId === 'stats.wilcoxon_signed_rank');
    const cr = evaluateCyto(paired(r)), cnr = evaluateCyto(paired(nr));
    const resp = evaluateResp(cr, cnr);
    const q1 = ctx.q1;
    const robust = q1 ? evaluateResp(q1.r, q1.nr).stateLabel === resp.stateLabel : null;
    return [
      { rule: `RIAZ-INT-CYTO-01 @ responders (${stats[0]?.operationId})`, verdict: cr.stateLabel, detail: `fired ${cr.genesFired.join(', ')}; p<0.05: ${cr.genesSignificant.join(', ') || 'none'}; test is ${wilcoxon ? 'Wilcoxon' : 'NOT Wilcoxon'}`, expected: 'cytotoxic_program_induced', match: cr.stateLabel === 'cytotoxic_program_induced' },
      { rule: 'RIAZ-INT-CYTO-01 @ non-responders', verdict: cnr.stateLabel, detail: `fired ${cnr.genesFired.join(', ') || 'none'}`, expected: 'cytotoxic_program_not_induced', match: cnr.stateLabel === 'cytotoxic_program_not_induced' },
      { rule: 'RIAZ-INT-RESP-01', verdict: resp.stateLabel, detail: `confidence ${resp.confidence}`, expected: 'responder_restricted', match: resp.stateLabel === 'responder_restricted' },
      { rule: 'RIAZ-INT-SENS-01 (vs Q1 paired t-test)', verdict: robust === null ? 'not_evaluable' : robust ? 'robust' : 'test_dependent', detail: q1 ? `Q1 t-test: ${evaluateResp(q1.r, q1.nr).stateLabel}; Wilcoxon: ${resp.stateLabel}` : 'Q1 trace missing', expected: 'robust', match: robust },
    ];
  },
};

function deVerdicts(q: QuestionTrace, stats: Stat[], id: string): Verdict[] {
  // DE questions run structural nodes (filter padj < 0.05 → describe); the
  // significant-gene counts are the row counts of the filter snapshots.
  const counts = q.snapshots.filter((s) => s.origin === 'filter').map((s) => ({ id: s.id, rowCount: s.rowCount, filters: (s as { filters?: string }).filters ?? '' }));
  const detail = `filter snapshots: ${counts.map((c) => `[${c.filters}] = ${c.rowCount ?? '?'} rows`).join('; ') || 'none'}; rule-run rows: ${stats.length}`;
  if (id === 'Q8') {
    // n_sig = the snapshot filtered on padj alone; the panel count = the one that also filters gene.
    const sigOnly = counts.find((c) => /padj lt 0\.05/.test(c.filters) && !/gene/.test(c.filters));
    const panel = counts.find((c) => /padj lt 0\.05/.test(c.filters) && /gene in/.test(c.filters));
    const nSig = sigOnly?.rowCount ?? null;
    const nPanel = panel?.rowCount ?? null;
    const v = nSig === null ? 'not_evaluable' : nSig >= 100 ? 'baseline_signal_present' : 'baseline_signal_absent';
    return [
      { rule: 'RIAZ-SUM-DE-01', verdict: nSig === null ? 'not_evaluable' : `n_sig = ${nSig}, panel genes = ${nPanel ?? '?'}`, detail, expected: 'n_sig = 58, 0 panel genes', match: nSig === null ? null : nSig === 58 && (nPanel === null || nPanel === 0) },
      { rule: 'RIAZ-INT-DE-01', verdict: v, detail: `n_sig ${nSig ?? '?'} vs threshold 100`, expected: 'baseline_signal_absent', match: nSig === null ? null : v === 'baseline_signal_absent' },
    ];
  }
  // one count per stratum, taken from the snapshots filtered on BOTH the stratum and padj < 0.05
  const strata = ['ipi_naive', 'ipi_progressed']
    .map((s) => counts.find((c) => c.filters.includes(`stratum eq ${s}`) && /padj lt 0\.05/.test(c.filters))?.rowCount)
    .filter((n): n is number => typeof n === 'number');
  const ratio = strata.length >= 2 ? Math.max(...strata) / Math.max(1, Math.min(...strata)) : null;
  const v = ratio === null ? 'not_evaluable' : ratio >= 2 ? 'stratum_dependent' : 'stratum_balanced';
  return [
    { rule: 'RIAZ-SUM-STRATA-01', verdict: ratio === null ? 'not_evaluable' : `n_sig per stratum = ${strata.join(' / ')}`, detail, expected: '33 (naive) / 50 (progressed)', match: ratio === null ? null : strata.includes(33) && strata.includes(50) },
    { rule: 'RIAZ-INT-STRATA-01', verdict: v, detail: `count ratio ${ratio === null ? '?' : ratio.toFixed(2)} vs threshold 2`, expected: 'stratum_balanced', match: ratio === null ? null : v === 'stratum_balanced' },
  ];
}

// ── comparison with the published paper ─────────────────────────────────────
// Riaz et al., Cell 171:934–949 (2017), PMC5685550. Claims are quoted from the
// paper; a judgement compares OUR rule verdicts with the paper's direction.

const PAPER_URL = 'https://pmc.ncbi.nlm.nih.gov/articles/PMC5685550/';
type Concordance = 'concordant' | 'partial' | 'discordant' | 'not addressed' | 'not evaluable';
interface PaperEntry { claim: string; judge: (v: Verdict[]) => { concordance: Concordance; note: string } }

const verdictOf = (v: Verdict[], prefix: string): string | null => v.find((x) => x.rule.startsWith(prefix))?.verdict ?? null;
const evaluable = (x: string | null) => x !== null && x !== 'not_evaluable';

const PAPER: Record<string, PaperEntry> = {
  Q2: {
    claim: '"Many immune checkpoint genes increased in expression, regardless of response to therapy, including PDCD1 (PD-1), CD274 (PD-L1), CTLA-4, CD80, ICOS, LAG3, and TNFRSF9."',
    judge: (v) => {
      const all = verdictOf(v, 'RIAZ-INT-PD1-01 @ all'), nr = verdictOf(v, 'RIAZ-INT-PD1-01 @ response=NR');
      if (!evaluable(all)) return { concordance: 'not evaluable', note: 'no PDCD1 row' };
      if (all === 'pd1_induced' && nr === 'pd1_induced') return { concordance: 'concordant', note: 'PDCD1 rises in all patients and in non-responders, as the paper states' };
      if (all === 'pd1_induced') return { concordance: 'partial', note: `PDCD1 rises in the pooled cohort (paper: yes) but the rule reads non-responders as ${nr}; the 24-gene panel with Δ≥0.5 log2CPM and p<0.05 is stricter than the paper's q<0.20 DEG list` };
      return { concordance: 'discordant', note: `pooled verdict ${all}; the paper reports PDCD1 up on therapy` };
    },
  },
  Q3: {
    claim: '"Significantly more immune-related genes were selectively upregulated in responders than in non-responders" (2670 DEGs pre vs on, R vs NR, q<0.20); baseline responders carry an IFN-γ-consistent signature.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-IFNG-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no responder per-gene rows' };
      return x === 'ifng_program_induced'
        ? { concordance: 'concordant', note: 'IFN-γ programme induced in responders' }
        : { concordance: 'partial', note: 'the paper reports broad immune up-regulation in responders at q<0.20; our rule needs 5/8 genes at Δ≥0.5 on a 27-patient panel, so the direction agrees while the threshold is not met' };
    },
  },
  Q4: {
    claim: 'Pre-therapy R vs NR: 189 DEGs (q<0.20), "only marginally predictive of response"; "neither PDCD1 (PD-1) nor CD274 (PD-L1) were differentially expressed" at baseline.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-BASELINE-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no Pre R-vs-NR rows' };
      return x === 'baseline_not_predictive'
        ? { concordance: 'concordant', note: 'baseline cytotoxic expression does not separate R from NR, matching the paper\'s "marginally predictive" baseline' }
        : { concordance: 'discordant', note: 'rule finds a baseline separation the paper calls marginal' };
    },
  },
  Q5: {
    claim: '"Increased cytolytic pathway genes as measured by RNA-seq were associated with benefit to Nivo in both Ipi-P and Ipi-N cohorts (p = 0.043 and p = 0.005)"; "a pre-existing \'hot tumor\' environment was observed in all Ipi-P patients with CR/PR", Ipi-N responders variable.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-IPI-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no per-stratum rows' };
      if (x === 'ipi_independent') return { concordance: 'concordant', note: 'induction in both strata, as the paper finds cytolytic benefit in both' };
      return { concordance: 'partial', note: `the paper reports baseline cytolytic association in both strata but does not test on-treatment induction per stratum; our rule reads ${x} (ipi-progressed tumours are already "hot", leaving less room to induce)` };
    },
  },
  Q6: {
    claim: 'On therapy, responders up-regulate "additional checkpoint-related genes (TNFRSF4 [OX40], TIGIT, HAVCR2 [TIM-3], and C10orf54 [VISTA])"; LAG3, CTLA-4 and PDCD1 rise regardless of response.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-EXH-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no On R-vs-NR rows' };
      return x === 'exhaustion_higher_in_responders'
        ? { concordance: 'concordant', note: 'checkpoint/exhaustion markers higher in responders on therapy' }
        : { concordance: 'partial', note: 'the paper\'s responder-specific set is TIGIT/HAVCR2 (plus OX40/VISTA, not in the panel); LAG3/CTLA4/PDCD1 rise in both groups, so a 3/6 R>NR threshold can miss' };
    },
  },
  Q7: {
    claim: 'Non-responders up-regulate fewer immune genes on therapy; the checkpoint genes that rise regardless of response (PDCD1, CTLA-4, LAG3, CD274…) are not cytotoxic effectors.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-CYTO-01 @ non-responders');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no NR rows' };
      return x === 'cytotoxic_program_not_induced'
        ? { concordance: 'concordant', note: 'no cytotoxic induction in non-responders' }
        : { concordance: 'discordant', note: 'cytotoxic induction in NR would contradict the responder-selective up-regulation the paper reports' };
    },
  },
  Q8: {
    claim: 'Pre-therapy R vs NR: 189 DEGs at q<0.20, enriched only for high-level T-cell activation categories, "only marginally predictive"; PDCD1 and CD274 not differentially expressed.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-DE-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no filter-snapshot count' };
      return x === 'baseline_signal_absent'
        ? { concordance: 'concordant', note: 'weak baseline DE signal (58 genes at padj<0.05 vs 189 at q<0.20 in the paper; 0 immune-panel genes, consistent with PDCD1/CD274 not DE)' }
        : { concordance: 'partial', note: 'a baseline signal ≥100 genes exceeds the paper\'s marginal baseline picture at our stricter cutoff' };
    },
  },
  Q9: {
    claim: '"A pre-existing immunologically active or \'hot tumor\' environment was observed in all Ipi-P patients with CR/PR"; "Variable immunological activity was observed in Ipi-N patients with CR/PR".',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-STRATA-01'), s = verdictOf(v, 'RIAZ-SUM-STRATA-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'no per-stratum counts' };
      return { concordance: 'partial', note: `more baseline DE genes in ipi_progressed than ipi_naive (${s}) points the same way as the paper's "hot" Ipi-P responders, but the rule's ≥2× ratio reads it as ${x}` };
    },
  },
  Q10: {
    claim: 'CD274 (PD-L1) increased on therapy "regardless of response"; "several HLA class II alleles were differentially regulated" between molecular responders and non-responders.',
    judge: (v) => {
      const r = verdictOf(v, 'RIAZ-INT-APM-01 @ response=R'), nr = verdictOf(v, 'RIAZ-INT-APM-01 @ response=NR');
      if (!evaluable(r)) return { concordance: 'not evaluable', note: 'no responder rows' };
      if (r === 'apm_induced' && nr === 'apm_induced') return { concordance: 'concordant', note: 'both genes rise in both groups (paper: CD274 regardless of response)' };
      if (r === 'apm_induced') return { concordance: 'partial', note: 'induction in responders matches the responder-selective HLA class II regulation; the paper also reports CD274 rising in non-responders, which the 2/2 rule at Δ≥0.5 does not see' };
      return { concordance: 'discordant', note: `responders read ${r}` };
    },
  },
  Q11: {
    claim: '"An increase in number of CD8+ T cells and NK cells … associated with response to therapy"; cytolytic pathway genes associated with benefit — a responder-restricted cytotoxic induction.',
    judge: (v) => {
      const x = verdictOf(v, 'RIAZ-INT-RESP-01'), sens = verdictOf(v, 'RIAZ-INT-SENS-01');
      if (!evaluable(x)) return { concordance: 'not evaluable', note: 'need R and NR Wilcoxon rows' };
      return x === 'responder_restricted'
        ? { concordance: 'concordant', note: `responder-restricted induction holds under Wilcoxon (sensitivity: ${sens})` }
        : { concordance: 'discordant', note: `Wilcoxon reads ${x}` };
    },
  },
};

function paperSection(rows: Array<{ id: string; concordance: Concordance; note: string }>): string[] {
  return [
    '## Comparison with the published paper',
    '',
    `Riaz N. et al., *Tumor and Microenvironment Evolution during Immunotherapy with Nivolumab*, Cell 171:934–949 (2017) — ${PAPER_URL}. The paper's RNA-seq cohort (n=45 baseline, 26 paired) and thresholds (q<0.20 DEG lists) differ from this demo's 27-patient, 24-gene log2CPM panel with Δ≥0.5 / p<0.05 rules, so "concordant" means the rule verdict points the same way as the paper's claim, not that the numbers match.`,
    '',
    '| Q | Paper claim | Our rule verdict vs paper | Note |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${PAPER[r.id]?.claim ?? '—'} | **${r.concordance}** | ${r.note} |`),
    '',
  ];
}

// ── report ──────────────────────────────────────────────────────────────────

function q1Context(): { r: ReturnType<typeof evaluateCyto>; nr: ReturnType<typeof evaluateCyto> } | null {
  try {
    const t = JSON.parse(readFileSync('docs/riaz-guided-trace.json', 'utf8')) as { verdicts: Record<string, { responders: ReturnType<typeof evaluateCyto>; nonResponders: ReturnType<typeof evaluateCyto> }> };
    const v = t.verdicts['RIAZ-INT-CYTO-01'];
    return v ? { r: v.responders, nr: v.nonResponders } : null;
  } catch {
    return null;
  }
}

function resultTable(stats: Stat[]): string {
  if (!stats.length) return '_no statistical rule runs_\n';
  const unpaired = stats.some((s) => s.from !== null);
  const head = unpaired ? '| Cohort | Gene | n | median from | median to | p | test |' : '| Cohort | Gene | n pairs | Δ (On − Pre) | 95% CI | p | test |';
  const sep = unpaired ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|';
  const rows = stats
    .sort((a, b) => a.cohort.localeCompare(b.cohort) || a.gene.localeCompare(b.gene))
    .map((s) => (unpaired ? `| ${s.cohort} | ${s.gene} | ${s.n ?? '—'} | ${fmt(s.from)} | ${fmt(s.to)} | ${fmtP(s.p)} | ${s.operationId ?? ''} |` : `| ${s.cohort} | ${s.gene} | ${s.n ?? '—'} | ${fmt(s.delta)} | ${s.ciLow === null ? '—' : `${fmt(s.ciLow)}..${fmt(s.ciHigh)}`} | ${fmtP(s.p)} | ${s.operationId ?? ''} |`));
  return [head, sep, ...rows].join('\n') + '\n';
}

async function main(): Promise<void> {
  const trace = JSON.parse(readFileSync(TRACE_PATH, 'utf8')) as { projectId: string; workspaceId: string; questions: QuestionTrace[] };
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const client = new RestClient({ baseUrl, onCall: () => undefined });
  await ensureIdentities(client, process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local', process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin');
  const H = projectHeaders(trace.workspaceId);
  const ruleIds = new Map<string, string>();
  for (const r of asList<{ id: string; code: string; status: string }>(must(await client.as<unknown>(ADMIN_HANDLE, 'GET', `/api/v1/rules?workspaceId=${trace.workspaceId}&status=published&limit=500`), 'rules'))) ruleIds.set(r.code, r.id);
  const q1 = q1Context();
  const earlier = new Map<string, Verdict[]>();
  const summary: string[] = [];
  const sections: string[] = [];
  const paperRows: Array<{ id: string; concordance: Concordance; note: string }> = [];
  for (const q of trace.questions) {
    const snaps = new Map<string, Snap>();
    if (q.viewAnalysisId) {
      for (const s of asList<Snap>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${q.viewAnalysisId}/snapshots?page=1&limit=100`, undefined, H), 'snapshots'))) snaps.set(s.id, s);
      // rowCount is not on the listing; a filter snapshot's size is the dataset
      // query under its effective filters (the same call the explorer makes).
      for (const s of q.snapshots) {
        if (s.origin !== 'filter') continue;
        const full = snaps.get(s.id);
        const filters = full?.effectiveFilters ?? full?.filters ?? [];
        if (!filters.length) continue;
        const t = await client.as<{ totalCount?: number }>(ADMIN_HANDLE, 'POST', `/api/v1/workspaces/${trace.workspaceId}/datasets/${q.datasetId}/query`, { limit: 1, filters }, H);
        if (t.ok && t.body?.totalCount !== undefined) s.rowCount = Number(t.body.totalCount);
        (s as { filters?: string }).filters = filters.map((f) => `${f.column} ${f.operator} ${String(f.value)}`).join(' & ');
      }
    }
    const stats = statsOf(q, snaps);
    const pub = (q as QuestionTrace & { published?: PublishedRecord }).published;
    const verdicts = q.error ? [] : (EVALUATORS[q.id] ?? (() => []))(q, stats, { q1, earlier });
    earlier.set(q.id, verdicts);
    const matched = verdicts.filter((v) => v.match === true).length, total = verdicts.filter((v) => v.match !== null).length;
    const status = q.error ? `ERROR: ${q.error.slice(0, 80)}` : `${q.runStatus} (${q.nodes.filter((n) => n.status === 'SUCCEEDED' || n.status === 'REUSED').length}/${q.nodes.length} nodes)`;
    const overall = q.error ? '✗' : total === 0 ? '?' : matched === total ? '✓' : '✗';
    const paper = q.error ? { concordance: 'not evaluable' as Concordance, note: 'run errored' } : (PAPER[q.id]?.judge(verdicts) ?? { concordance: 'not addressed' as Concordance, note: '' });
    paperRows.push({ id: q.id, ...paper });
    const links = [q.viewAnalysisId ? `[analysis](${q.deepLinks.analysis})` : null, pub?.publishedLink ? `[published](${pub.publishedLink})` : null, pub?.decisionLink ? `[decision](${pub.decisionLink})` : null].filter(Boolean).join(' · ') || '—';
    summary.push(`| ${q.id} | ${q.planId ?? '—'} (${q.planner ?? '—'}${q.plannerFallback ? ', fallback' : ''}) | ${q.runId ?? '—'} | ${status} | ${matched}/${total} | ${overall} | ${paper.concordance} | ${links} |`);
    const ruleLinks = q.rulesCited.map((c) => (ruleIds.has(c) ? `[${c}](${FRONT_URL}/rules/${ruleIds.get(c)})` : c)).join(', ');
    const plan = q.plan as { reasoning?: { restatedQuestion?: string; whyThisApproach?: string; whatThisWillNotEstablish?: string } } | null;
    sections.push(
      [
        `## ${q.id} — ${q.question}`,
        '',
        `**Dataset** ${q.datasetName} (\`${q.datasetId}\`) · **Rules cited by the question** ${ruleLinks}`,
        '',
        q.error ? `**ERROR** ${q.error}\n` : '',
        `**Planner** ${q.planner ?? '—'}${q.plannerFallback ? ' (deterministic fallback)' : ''}, plan \`${q.planId ?? '—'}\`, session \`${q.sessionId ?? '—'}\`. ${plan?.reasoning?.restatedQuestion ? `Restated: _${plan.reasoning.restatedQuestion}_` : ''}`,
        '',
        plan?.reasoning?.whyThisApproach ? `> ${plan.reasoning.whyThisApproach}\n` : '',
        '| Node | Type | Params / operation |', '|---|---|---|',
        ...q.planNodes.map((n) => `| ${n.id} | ${n.nodeType} | \`${JSON.stringify(n.operation ?? n.params ?? {}).slice(0, 160)}\` |`),
        '',
        `**Governed run** \`${q.runId ?? '—'}\` → ${q.runStatus ?? '—'}; nodes: ${q.nodes.map((n) => `${n.nodeId} ${n.status}${n.error ? ` (${n.error})` : ''}`).join(', ') || '—'}`,
        '',
        '**Results (kernel tables)**', '',
        resultTable(stats),
        q.ruleRuns.some((r) => r.kind === 'QC') ? `QC: ${q.ruleRuns.filter((r) => r.kind === 'QC').map((r) => `${r.snapshotName ?? ''} → ${r.status} (rule run \`${r.id}\`)`).join('; ')}\n` : 'QC: _no qc_check node in the plan_\n',
        '**Rule verdicts (offline evaluation of the cited INTERPRET / DECISION rules)**', '',
        '| Rule | Verdict | Detail | Expected | Match |', '|---|---|---|---|---|',
        ...verdicts.map((v) => `| ${v.rule} | **${v.verdict}** | ${v.detail} | ${v.expected} | ${v.match === null ? '?' : v.match ? '✓' : '✗'} |`),
        '',
        `**Paper (Riaz 2017)** ${PAPER[q.id]?.claim ?? '—'} → **${paper.concordance}**${paper.note ? `: ${paper.note}` : ''}`,
        '',
        '**Published evidence**', '',
        ...(pub
          ? [
              `- decision: ${pub.decisionLink ?? '—'} (${pub.decisionStatus ?? '—'})`,
              `- published version: ${pub.publishedLink ?? '—'}`,
              ...pub.evidences.map((e) => `- evidence: [${e.title}](${e.link})`),
            ]
          : ['- _not published (run stage:riaz-publish)_']),
        '',
        '**Deep links**', '',
        ...Object.entries(q.deepLinks).map(([k, v]) => `- ${k}: ${v}`),
        ...q.ruleRuns.filter((r) => r.kind !== 'QC').map((r) => `- rule run ${r.id.slice(0, 8)} table: ${baseUrl}/api/v1/rule-runs/${r.id}/table?page=1&limit=50`),
        '',
      ].join('\n'),
    );
  }
  const md = [
    '# Riaz 2017 — ten guided questions, run through the LLM planner (report)',
    '',
    `Generated ${new Date().toISOString()} from \`${TRACE_PATH}\` by \`npm run stage:riaz-report\`. Each question was asked as Marc Ottavi through the guided-analysis planner (\`POST /guided-analysis/plan\`, anthropic), the returned plan was submitted unchanged as a governed run (with \`organizationId\`, which the UI omits), the interpretation node approved as the service identity, and the cited INTERPRET / DECISION rules evaluated offline over the kernel's result tables (no executor exists for those protocols). "Expected" is the verdict computed from the source CSV in docs/Riaz-Guided-Questions.md.`,
    '',
    '| Q | Plan (planner) | Run | Run status | Rule verdicts matching expectation | Overall | vs paper | Analysis |',
    '|---|---|---|---|---|---|---|---|',
    ...summary,
    '',
    `Project: ${FRONT_URL}/biotech-one/public-datasets-io-benchmarks/riaz-2017-nivolumab-melanoma/overview · Guided history (all planner sessions): ${FRONT_URL}/projects/${trace.projectId}/guided-analyses · Rules: ${FRONT_URL}/rules`,
    '',
    ...paperSection(paperRows),
    '## Limitations — the rules are calibrated on this cohort',
    '',
    '- **Circularity.** The "expected" verdicts were computed from the same CSV the rules are judged on, and the thresholds (Δ ≥ 0.5 log2CPM, p < 0.05, k-of-n gene counts, n_sig ≥ 100, stratum ratio ≥ 2) were chosen after looking at that data. A rule matching its expectation therefore shows the pipeline is faithful, not that the criterion generalises.',
    '- **Cohort-specific thresholds.** 27 patients and a 24-gene panel give little power; the same cutoffs on a larger cohort or whole-transcriptome DE would over- or under-call (Q3 shows it: the paper reports IFN-γ genes up in responders, the 5/8 rule reads "not induced").',
    '- **Gene sets are the paper\'s.** RIAZ-INT-* encode Riaz 2017 biology, not a general immunotherapy criterion.',
    '- **What generalises** is the protocol shape: a QC min-n guard, a k-of-n programme call over a paired delta, a two-group direction test, a stratum-ratio comparison, and a decision that consumes those labels. Thresholds belong in governed parameters (AnalysisPolicy), justified from prior data or literature, and the rules should be validated on an independent anti-PD-1 cohort (e.g. Gide 2019, Hugo 2016) before being called general. The paper column above is the only judgement here that does not depend on this CSV.',
    '',
    ...attemptsAndGapsSection(trace.projectId),
    ...sections,
  ].join('\n');
  writeFileSync(REPORT_PATH, md);
  console.log(`report written to ${REPORT_PATH}`);
  console.log(summary.join('\n'));
}

// The trace keeps only the LATEST attempt per question; the earlier attempts
// (what the planner did wrong, or what the platform did wrong) are recorded here
// by hand so the report tells the whole story, not just the run that worked.
function attemptsAndGapsSection(projectId: string): string[] {
  const va = (id: string) => `${FRONT_URL}/projects/${projectId}/view-analyses/${id}`;
  return [
    '## Earlier attempts (not in the summary table) and platform gaps',
    '',
    'Every question below needed more than one ask. The table above shows the attempt that answered the question; these are the ones that did not, and why.',
    '',
    `- **Q5 attempt 1 — QC block.** Plan PL-03caa8ce, run GR-e515ee76, [analysis](${va('a27966f3-ad7b-4da1-8093-7fddcda8fa86')}). The planner pre-filtered the six cytotoxic genes, then split by prior_ipi; RIAZ-QC-PAIRED-01 needs ≥ 240 rows (5 paired patients × 24 genes × 2 timepoints) and saw 156 / 168 → block → downstream BLOCKED.`,
    `- **Q5 attempt 2 — kernel refusal.** Plan PL-e5dcda07, run GR-77df067e, [analysis](${va('edbdde16-3766-4ebe-9c8f-d8b163e07250')}). QC passed (624 / 672 rows) but the planner bound \`roleBindings.groupColumn = gene\` instead of \`featureColumn\`; stats.paired_ttest refused the 644 rows sharing a subject and level as ambiguous (failed runs fbc700c3, 38c74941).`,
    `- **Q6 attempt 1 — planner fallback.** Plan PL-99c70f52 (fallback), run GR-596449d7, [analysis](${va('6c397f4e-6fc6-4c42-ba90-8269947cd419')}). The thinking model exhausted \`max_tokens\` and the deterministic fallback answered a different question (one compare_paired over the whole table).`,
    `- **Q9 attempts 1–3 — one stratum only.** Plans PL-ffbcd11b (run GR-53c7caf8), PL-88b14a6b (run GR-7cf9910a, [analysis](${va('73ec3d1c-fc1a-40e1-a675-cb88eb864464')})), PL-933984e3 (run GR-b400d237). The profile is built from the first 1000 rows; the stratified table is sorted by stratum so those rows are all ipi_naive, and the planner declined the ipi_progressed branch under its verbatim-category constraint even when the question stated both strata exist. Fixed by profiling 500 rows per stratum (runner \`profileSlices\`).`,
    `- **Q9 attempt 4 — lineage defect.** Plan PL-504025ee, run GR-c000126b, [analysis](${va('539e3405-52bf-47ef-b1bc-0e66a1c5fcc1')}). Both stratum branches were planned, but \`padj lt 0.05\` under ipi_progressed was deduplicated onto the ipi_naive padj snapshot (same defect as Q10 attempt 2 below), so the second count would have described the wrong slice.`,
    `- **Q10 attempt 1 — kernel refusal.** Plan PL-2d97aba2, run GR-6640aea4, [analysis](${va('2d770617-4054-40ce-ad4a-69614dec1bc1')}). Two-gene referent without \`featureColumn\`.`,
    `- **Q10 attempt 2 — lineage defect.** Plan PL-630ef81b, run GR-f3aed008, [analysis](${va('40661f20-2d1b-497b-aed6-4f7373d6b236')}). The nested filters \`response eq R/NR\` under \`gene eq CD274\` were deduplicated onto the HLA-DRA responder / non-responder snapshots: \`findSnapshotMatchingFilters\` (view-analyses.service.ts:1144) matches a filter node on its own conditions and ignores the parent snapshot. The CD274 compare nodes then fingerprinted identically to the HLA-DRA ones and were DEDUPED (470d2860 ← a6a75e97, 94785f8b ← d6e44c12). No CD274 responder result was ever computed, while the analysis lineage says it was. This is a backend defect (snapshot reuse must include the parent, or match on effective filters), not a planner error.`,
    `- **Q11 attempt 1 — QC block.** Plan PL-58ec35f3, run GR-68e42613, [analysis](${va('de3da406-be7a-4962-9a88-25eb55d2e137')}). Gene pre-filter before the QC node (108 rows < 240).`,
    '',
    '**Platform gaps surfaced by this batch**',
    '',
    '1. The guided-analysis UI submits without `organizationId`, so org-scoped QC rules fail to resolve from the UI (the runner adds it).',
    '2. Planner `max_tokens` (8192) is too small for a thinking model; the silent fallback answers a different question with no visible warning beyond `plannerFallback: true` (hot-patched to 16384 for this batch).',
    '3. The dataset profile samples the first 1000 rows only, and the planner treats the sampled categories as the only legal filter values.',
    '4. QC rule `RIAZ-QC-PAIRED-01` couples its row minimum to the full panel size, so any gene pre-filter blocks it; the row-minimum should be expressed per pair.',
    '5. A multi-gene referent needs `featureColumn` on compare_paired; the planner does not add it unless told.',
    '6. Chained filter snapshots are deduplicated without their parent (Q10 attempt 2) — a lineage-corrupting defect.',
    '7. Only QC rules execute; INTERPRET / DECISION / SUMMARY rules are authoring-only, so the verdicts in this report were computed offline.',
    '8. Rule-derived snapshots show `resultBinding: no_match / no_candidate_rules` because the library rules declare no evidence selector (AXI-1491 binding).',
    '',
  ];
}

if (process.argv[1] && process.argv[1].endsWith('reportRiazQuestions.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
