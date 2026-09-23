import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CYTO_GENES, evaluateCyto, evaluateResp, type PairedGeneStat } from './riazGuidedRules';
import type { QuestionTrace } from './runRiazQuestions';

/**
 * Offline verdicts of the INTERPRET / DECISION rules each Riaz question cites
 * (the platform executes QC rules only). Shared by `stage:riaz-report` (the
 * verdict tables) and `stage:riaz-publish` (the decision label / confidence),
 * so neither script imports the other.
 */
const DEFAULT_GUIDED_TRACE_PATH = '../axiome-docs/demo/riaz-2017/riaz-guided-trace.json';

/**
 * Q1's trace (stage:riaz-guided) — the paired t-test verdicts Q11's sensitivity
 * rule compares against. `STAGING_RIAZ_GUIDED_TRACE` wins outright when set;
 * otherwise the guided trace is a SIBLING of `riaz-questions-trace.json`
 * (`riaz-guided-trace.json` in the same directory), derived from
 * `STAGING_RIAZ_QUESTIONS_TRACE` when the caller set that — a cwd-relative
 * default only resolves when cwd happens to be the e2e-testing checkout root
 * with `axiome-docs` as its exact sibling, which is false from a story
 * worktree and silently produced `not_evaluable` (AXI-1553 review finding).
 */
export function deriveGuidedTracePath(questionsTracePathEnv: string | undefined, overrideEnv: string | undefined): string {
  if (overrideEnv?.trim()) return overrideEnv.trim();
  const questionsTracePath = questionsTracePathEnv?.trim();
  return questionsTracePath ? join(dirname(questionsTracePath), 'riaz-guided-trace.json') : DEFAULT_GUIDED_TRACE_PATH;
}

const GUIDED_TRACE_PATH = deriveGuidedTracePath(process.env.STAGING_RIAZ_QUESTIONS_TRACE, process.env.STAGING_RIAZ_GUIDED_TRACE);
const DELTA = 0.5;
const P = 0.05;

export interface Filter { column: string; operator: string; value: unknown }
export interface Snap { id: string; origin?: string | null; ruleRunId?: string | null; parentSnapshotId?: string | null; effectiveFilters?: Filter[] | null; filters?: Filter[] | null; rowCount?: number | null }

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
export const fmt = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));
export const fmtP = (v: number | null) => (v === null ? '—' : v < 0.001 ? '<0.001' : v.toFixed(3));

export interface Verdict { rule: string; verdict: string; detail: string; expected: string; match: boolean | null; /** the rule's own numeric confidence when it reports one (RIAZ-INT-RESP-01) */ confidence?: number }

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

export type Q1Context = { r: ReturnType<typeof evaluateCyto>; nr: ReturnType<typeof evaluateCyto> } | null;
export type Evaluator = (q: QuestionTrace, stats: Stat[], ctx: { q1: { r: ReturnType<typeof evaluateCyto>; nr: ReturnType<typeof evaluateCyto> } | null; earlier: Map<string, Verdict[]> }) => Verdict[];

export const EVALUATORS: Record<string, Evaluator> = {
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
      { rule: 'RIAZ-INT-RESP-01', verdict: resp.stateLabel, detail: `confidence ${resp.confidence}`, expected: 'responder_restricted', match: resp.stateLabel === 'responder_restricted', confidence: resp.confidence },
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


export function q1Context(): { r: ReturnType<typeof evaluateCyto>; nr: ReturnType<typeof evaluateCyto> } | null {
  let raw: string;
  try {
    raw = readFileSync(GUIDED_TRACE_PATH, 'utf8');
  } catch (err) {
    // A missing/unreadable Q1 trace used to degrade RIAZ-INT-SENS-01 to
    // "not_evaluable" silently (AXI-1553 review finding) — fail loudly instead,
    // naming the resolved path, so a wrong cwd/env is caught at the call site
    // rather than shipped as a quiet wrong verdict.
    throw new Error(`q1Context: could not read the Q1 guided trace at "${GUIDED_TRACE_PATH}" (set STAGING_RIAZ_GUIDED_TRACE to override): ${(err as Error).message}`);
  }
  const t = JSON.parse(raw) as { verdicts: Record<string, { responders: ReturnType<typeof evaluateCyto>; nonResponders: ReturnType<typeof evaluateCyto> }> };
  const v = t.verdicts['RIAZ-INT-CYTO-01'];
  return v ? { r: v.responders, nr: v.nonResponders } : null;
}

