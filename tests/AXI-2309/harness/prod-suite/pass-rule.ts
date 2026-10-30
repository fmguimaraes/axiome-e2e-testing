import { describeCheck, rowMatches, type PaulCheck, type PaulProbe, type RReferenceProbe } from './paul-reference';

/**
 * AXI-2319 (epic AXI-2309, FR31/AC12, SI-042 + SI-053) — THE PASS RULE, as pure
 * functions over facts the run driver collected. No I/O here, so every verdict
 * is unit-tested on its own (harness-unit/AXI-2319).
 *
 * FR31, spec-literal:
 *  - Paul's methods pass on EXPECTED VALUES: every probe's run SUCCEEDED, every
 *    checked field matches Paul's printed slide number at its printed precision
 *    (`ns` = Holm-adjusted p > 0.05) AND agrees with the independent R
 *    computation within the method-validation tolerances (MSR: statistic /
 *    coefficient relative 1e-9; p-value |ln p − ln p_R| ≤ 1e-6).
 *  - Every other active rule passes on run SUCCEEDED + its DEFAULT CHART
 *    rendered (FR14 — AXI-2312's contract: a `recommended`-origin DataviewSpec
 *    was minted for the run's result AND a render of it reached `ready` with a
 *    payload that carries data and no error).
 *  - FR14 is a platform-wide requirement, so the chart is required of Paul's
 *    methods too (the conservative reading — a Paul rule with right numbers
 *    and no chart is not "working").
 *
 * Outcomes: `pass` only when every check held; `fail` when the platform was
 * wrong (refused / FAILED / timed-out run, value mismatch, no chart, render
 * error or never ready); `not-evaluated` when the suite has no way to judge the
 * rule (no recipe, not runnable, no default chart by declaration) — never
 * `pass`. An executor exception is recorded `error` by the infrastructure.
 */

export const STAT_RELATIVE_TOLERANCE = 1e-9;
export const LOG_P_TOLERANCE = 1e-6;

export type Verdict = { ok: true } | { ok: false; why: string };

const OK: Verdict = { ok: true };
const no = (why: string): Verdict => ({ ok: false, why });

export const isPValueField = (field: string) => /pvalue$/i.test(field);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Round half away from zero at `decimals` (a negative value rounds like its magnitude). */
function roundAt(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return (Math.sign(v) * Math.round(Math.abs(v) * f)) / f;
}

/** Paul's slide target, at the precision the slide prints it. */
export function matchesTarget(value: number, target: string): Verdict {
  if (target === 'ns') return value > 0.05 ? OK : no(`${value} is significant, slide says ns (p > 0.05)`);
  if (!/^-?\d+(\.\d+)?$/.test(target)) return no(`unparseable target ${JSON.stringify(target)}`);
  const decimals = (target.split('.')[1] ?? '').length;
  const got = roundAt(value, decimals);
  return got === Number(target) ? OK : no(`${value} rounds to ${got.toFixed(decimals)}, slide says ${target}`);
}

/** R parity within the MSR tolerances. */
export function matchesR(field: string, value: number, r: number): Verdict {
  if (isPValueField(field)) {
    if (!(value > 0) || !(r > 0)) return value === r ? OK : no(`${value} vs R ${r} (p-value not positive)`);
    const d = Math.abs(Math.log(value) - Math.log(r));
    return d <= LOG_P_TOLERANCE ? OK : no(`${value} vs R ${r} (|Δ ln p| ${d.toExponential(2)} > ${LOG_P_TOLERANCE})`);
  }
  const d = Math.abs(value - r);
  const bound = STAT_RELATIVE_TOLERANCE * Math.max(Math.abs(r), 1e-12);
  return d <= bound ? OK : no(`${value} vs R ${r} (relative Δ ${(d / Math.max(Math.abs(r), 1e-12)).toExponential(2)} > ${STAT_RELATIVE_TOLERANCE})`);
}

export interface CheckOutcome {
  check: PaulCheck;
  value: number | null;
  verdict: Verdict;
}

/** One checked field of one probe against the platform's result rows. */
export function judgeCheck(check: PaulCheck, rows: Record<string, unknown>[], ref: RReferenceProbe): CheckOutcome {
  const label = describeCheck(check);
  const hits = rows.filter((row) => rowMatches(row, check.row));
  if (hits.length !== 1) return { check, value: null, verdict: no(`${label}: ${hits.length} result rows match, expected 1`) };
  const value = hits[0][check.field];
  if (!finite(value)) return { check, value: null, verdict: no(`${label}: not a finite number (${JSON.stringify(value)})`) };
  if (check.target !== undefined) {
    const t = matchesTarget(value, check.target);
    if (!t.ok) return { check, value, verdict: no(`${label} vs Paul's slide: ${t.why}`) };
  }
  const refRow = ref.rows.find((row) => rowMatches(row.row, check.row));
  const r = refRow?.values[check.field];
  if (!finite(r)) return { check, value, verdict: no(`${label}: no R reference value`) };
  const p = matchesR(check.field, value, r);
  return { check, value, verdict: p.ok ? OK : no(`${label} vs R: ${p.why}`) };
}

export function judgeProbe(probe: PaulProbe, rows: Record<string, unknown>[], ref: RReferenceProbe): CheckOutcome[] {
  return probe.checks.map((check) => judgeCheck(check, rows, ref));
}

// ── Default chart (FR14, AXI-2312 contract) ────────────────────────────────

/** A render payload is a chart only if it carries data and no error. */
export function judgeRenderPayload(payload: unknown): Verdict {
  if (payload === null || payload === undefined || typeof payload !== 'object') return no('render returned no payload');
  const p = payload as Record<string, unknown>;
  if (p.error) return no(`render payload error: ${String(p.error).slice(0, 120)}`);
  const data = p.data;
  const hasData = Array.isArray(data) ? data.length > 0 : data !== null && typeof data === 'object' && Object.keys(data).length > 0;
  return hasData ? OK : no('render payload carries no data');
}

export type RunStatus = 'SUCCEEDED' | 'FAILED' | 'DEDUPED' | 'TIMEOUT' | 'REFUSED' | 'UNREADABLE';

export function judgeRunStatus(status: RunStatus, detail: string | null): Verdict {
  if (status === 'SUCCEEDED') return OK;
  if (status === 'REFUSED') return no(`run refused${detail ? ` (${detail})` : ''}`);
  if (status === 'TIMEOUT') return no('run did not reach a terminal status in time');
  if (status === 'UNREADABLE') return no(`run not readable by the suite identity${detail ? ` (${detail})` : ''}`);
  if (status === 'DEDUPED') return no('run deduped and could not be re-executed');
  return no(`run FAILED${detail ? ` (${detail})` : ''}`);
}
