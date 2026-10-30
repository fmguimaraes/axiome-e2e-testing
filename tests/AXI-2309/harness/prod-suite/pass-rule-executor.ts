import { okBody } from './api-client';
import type { CaseContext, CaseExecutor, CaseFacts, CaseResult } from './cases';
import { describeCheck, loadPaulReference, type PaulProbe, type PaulReference } from './paul-reference';
import { judgeFreshness, judgeProbe, judgeRenderPayload, judgeRunStatus, type CheckOutcome } from './pass-rule';
import { CATALOGUE_RECIPES, noRecipeReason, recipeParams, type Recipe } from './recipes';
import { createRunDriver, type ChartOutcome, type DriverTiming, type RunDriver, type RunOutcome, type RunRequest } from './run-driver';
import { PAUL_OPERATIONS, type PlannedCase } from './run-plan';
import { ensureWorkbench, type Workbench } from './workbench';

/**
 * AXI-2319 (epic AXI-2309, FR31/AC12, SI-042 + SI-053) — THE DAILY CASE
 * EXECUTOR: runs one planned case and applies the FR31 pass rule
 * (pass-rule.ts). Plugged into AXI-2318's `CaseExecutor` seam unchanged:
 * flat scalar facts, a known outcome, a bounded reason.
 *
 * - Paul's methods (phase 1) pass on EXPECTED VALUES, as FR31 states: every
 *   probe declared for the case's operation in `paul-probes.json` is run with
 *   the case's OWN rule, and the case passes only if every run SUCCEEDED and
 *   every checked value matches Paul's slide and R. The chart is not part of
 *   this verdict: Paul's probes are shaped by Paul's questions (one
 *   measurement, one pair), which the platform's chart governance correctly
 *   answers with no gallery chart (row floor / result-surface-only).
 * - Catalogue (phase 2) passes on run SUCCEEDED + DEFAULT CHART RENDERED —
 *   AXI-2312's contract: a `recommended`-origin DataviewSpec minted for the
 *   run's result and rendered to a ready payload with data and no error.
 * - `not-evaluated` (never pass) when the rule is not runnable, has no recipe,
 *   or its default chart cannot be judged headless: the operation declares
 *   none, or declares it for the RESULT surface only (drawn client-side from
 *   the result table — there is no server artefact to render) — and when the
 *   engine did not run today: a SUCCEEDED answer from the dedup cache that
 *   could not be re-executed (non-STATISTICAL kinds) carries `engineRanToday:
 *   false` and is never judged on its cached result or chart.
 *
 * Shared state is built ONCE per suite run, on the first case: the expected
 * values (refused if stale), the operation registry's chart declarations and
 * the idempotent workbench.
 */

export interface PassRuleExecutorOptions {
  reference?: PaulReference;
  recipes?: Readonly<Record<string, Recipe>>;
  /** Per-executor-run token a recipe may fold into its params (default: start time, base 36). */
  nonce?: string;
  timing?: DriverTiming;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Consecutive never-ready renders after which later cases stop WAITING for a render (one check only). */
  renderBreakerThreshold?: number;
}

/** What the registry declares about an operation's default chart. */
export type ChartDeclaration = 'none' | 'result-surface-only' | 'gallery';

interface Session {
  reference: PaulReference;
  charts: Map<string, ChartDeclaration>;
  workbench: Workbench;
  driver: RunDriver;
}

const MAX_REASON = 300;
const bound = (s: string) => (s.length > MAX_REASON ? `${s.slice(0, MAX_REASON)}…` : s);

/** Registry `defaultChart` → declaration (omitted `surfaces` means result + gallery, recommended-chart-spec.ts). */
export function chartDeclarationOf(defaultChart: any): ChartDeclaration {
  if (defaultChart == null) return 'none';
  const surfaces: unknown = defaultChart.surfaces;
  if (Array.isArray(surfaces) && !surfaces.includes('gallery')) return 'result-surface-only';
  return 'gallery';
}

async function fetchChartDeclarations(ctx: CaseContext): Promise<Map<string, ChartDeclaration>> {
  const body = okBody(await ctx.client.get('/api/v1/rule-runs/operations'), 'list operations');
  const ops: any[] = Array.isArray(body?.operations) ? body.operations : [];
  if (ops.length === 0) throw new Error('operation registry is empty');
  return new Map(ops.map((o) => [String(o.operationId), chartDeclarationOf(o.defaultChart)]));
}

function chartFacts(c: ChartOutcome, waitedMs: number): CaseFacts {
  const facts: CaseFacts = { chartState: c.state, renderWaitMs: waitedMs };
  if ('specId' in c) facts.chartSpecId = c.specId;
  if (c.state === 'rendered') facts.chartTemplate = c.templateId;
  if (c.state === 'never-ready') {
    facts.chartInstanceId = c.instanceId;
    facts.chartDiagnostic = c.diagnostic;
  }
  if (c.state === 'render-error') {
    facts.chartInstanceId = c.instanceId;
    facts.chartDiagnostic = c.error;
  }
  if (c.state === 'render-refused') facts.chartRenderHttp = c.httpStatus;
  return facts;
}

/** The FR14 verdict on a chart outcome (null = passed). */
export function chartFailure(c: ChartOutcome): string | null {
  switch (c.state) {
    case 'no-result-snapshot': return 'default chart: the run produced no result snapshot';
    case 'not-minted': return 'default chart: no recommended chart was minted for the result';
    case 'render-refused': return `default chart: render refused (HTTP ${c.httpStatus})`;
    case 'render-error': return `default chart: render failed (${c.error})`;
    case 'never-ready': return `default chart: render never reached ready${c.diagnostic ? ` (${c.diagnostic})` : ''}`;
    case 'rendered': {
      const v = judgeRenderPayload(c.payload);
      return v.ok ? null : `default chart: ${v.why}`;
    }
  }
}

function runFacts(r: RunOutcome): CaseFacts {
  return { runId: r.runId, runStatus: r.status, runDetail: r.detail, deduped: r.deduped, reExecuted: r.reExecuted };
}

/** What one Paul probe contributed to its case. */
export interface ProbeTally {
  succeeded: boolean;
  deduped: boolean;
  reExecuted: boolean;
  runId: string | null;
  stale: string | null;
  failures: string[];
  outcomes: CheckOutcome[];
  /** `observed.<probe>.<check>` → value, for checks that carry a slide target. */
  observed: CaseFacts;
}

const emptyTally = (run: RunOutcome): ProbeTally => ({
  succeeded: false, deduped: run.deduped, reExecuted: run.reExecuted, runId: null, stale: null, failures: [], outcomes: [], observed: {},
});

/** Roll a Paul case's probe tallies into its verdict: any failure fails; any stale probe (and no failure) is not-evaluated. */
export function paulVerdict(tallies: ProbeTally[], probes: PaulProbe[]): CaseResult {
  const outcomes = tallies.flatMap((t) => t.outcomes);
  const failures = tallies.flatMap((t) => t.failures);
  const stale = tallies.map((t) => t.stale).filter((x): x is string => x !== null);
  const facts: CaseFacts = {
    probes: probes.length, runsSucceeded: tallies.filter((t) => t.succeeded).length,
    deduped: tallies.filter((t) => t.deduped).length, reExecuted: tallies.filter((t) => t.reExecuted).length,
    checks: outcomes.length, checksPassed: outcomes.filter((o) => o.verdict.ok).length,
    checksExpected: probes.reduce((n, p) => n + p.checks.length, 0), engineRanToday: stale.length === 0,
  };
  const firstRunId = tallies.find((t) => t.runId)?.runId;
  if (firstRunId) facts.firstRunId = firstRunId;
  for (const t of tallies) Object.assign(facts, t.observed);
  if (failures.length > 0) return { outcome: 'fail', reason: bound(`${failures.length} failed: ${failures.slice(0, 3).join('; ')}`), facts };
  if (stale.length > 0) return { outcome: 'not-evaluated', reason: bound(`${stale.length} probe(s): ${stale[0]}`), facts };
  return { outcome: 'pass', reason: null, facts };
}

/** One Paul probe's rows judged against the slide and R. */
function judgeRows(probe: PaulProbe, rows: Record<string, unknown>[], reference: PaulReference): Pick<ProbeTally, 'failures' | 'outcomes' | 'observed'> {
  const ref = reference.r.probes.find((p) => p.id === probe.id)!;
  const outcomes = judgeProbe(probe, rows, ref);
  const failures = outcomes.filter((o) => !o.verdict.ok).map((o) => `${probe.id}: ${(o.verdict as { why: string }).why}`);
  const observed: CaseFacts = {};
  for (const o of outcomes) if (o.check.target !== undefined) observed[`observed.${probe.id}.${describeCheck(o.check)}`] = o.value;
  return { failures, outcomes, observed };
}

function catalogueRequest(planned: PlannedCase, recipe: Recipe, runKind: string, nonce: string): RunRequest {
  return {
    ruleId: planned.id, runKind, operationId: planned.operationId!,
    roleBindings: recipe.roleBindings, pivot: recipe.pivot, operationParams: recipeParams(recipe, { ruleId: planned.id, nonce }),
  };
}

/** A SUCCEEDED run whose default chart cannot be judged headless (null = gallery chart, judge it). */
function chartUnjudgeable(declaration: ChartDeclaration, operationId: string, facts: CaseFacts): CaseResult | null {
  facts.chartDeclaration = declaration;
  if (declaration === 'none') {
    return { outcome: 'not-evaluated', reason: `run SUCCEEDED; ${operationId} declares no default chart — FR14 cannot be judged (owner ruling)`, facts };
  }
  if (declaration === 'result-surface-only') {
    return { outcome: 'not-evaluated', reason: `run SUCCEEDED; ${operationId}'s default chart is result-surface only (drawn client-side) — no server artefact to render headless (owner ruling)`, facts };
  }
  return null;
}

export function createPassRuleExecutor(opts: PassRuleExecutorOptions = {}): CaseExecutor {
  const recipes = opts.recipes ?? CATALOGUE_RECIPES;
  const breakerAt = opts.renderBreakerThreshold ?? 3;
  const nonce = opts.nonce ?? (opts.now ?? Date.now)().toString(36);
  let session: Promise<Session> | null = null;
  let consecutiveNeverReady = 0;

  const open = (ctx: CaseContext): Promise<Session> => {
    if (!session) {
      session = (async () => {
        const reference = opts.reference ?? loadPaulReference();
        const charts = await fetchChartDeclarations(ctx);
        const workbench = await ensureWorkbench(ctx.client, ctx.workspaceId, ctx.fixtures, [...PAUL_OPERATIONS]);
        const driver = createRunDriver({
          client: ctx.client, workspaceId: ctx.workspaceId, projectId: workbench.projectId,
          sapVersionId: workbench.sapVersionId, timing: opts.timing, sleep: opts.sleep, now: opts.now,
        });
        return { reference, charts, workbench, driver };
      })();
      session.catch(() => { session = null; });
    }
    return session;
  };

  /**
   * Chart check with the render circuit breaker (a dead render path must not
   * cost the full wait × every rule). Once tripped, a case is checked once
   * without waiting and says so (`renderBreakerTripped`), so its fail is
   * distinguishable from a render that was given the full window.
   */
  async function checkChart(s: Session, runId: string, analysisId: string): Promise<{ failure: string | null; facts: CaseFacts }> {
    const tripped = consecutiveNeverReady >= breakerAt;
    const wait = tripped ? 0 : s.driver.timing.renderTimeoutMs;
    const c = await s.driver.chart(runId, analysisId, wait);
    consecutiveNeverReady = c.state === 'never-ready' ? consecutiveNeverReady + 1 : 0;
    const facts: CaseFacts = { ...chartFacts(c, wait), renderBreakerTripped: tripped };
    const failure = chartFailure(c);
    facts.chartRendered = failure === null;
    const note = tripped && c.state === 'never-ready' ? ` [render breaker tripped after ${breakerAt} consecutive never-ready renders: checked once, not waited]` : '';
    return { failure: failure && `${failure}${note}`, facts };
  }

  /** Run one Paul probe with the case's own rule and judge its rows (never on a cached, un-re-executed answer). */
  async function paulProbe(planned: PlannedCase, probe: PaulProbe, s: Session): Promise<ProbeTally> {
    const scope = await s.workbench.scope(probe.fixture, probe.filters);
    const runKind = planned.runKind ?? 'STATISTICAL';
    const run = await s.driver.run({
      ruleId: planned.id, runKind, operationId: probe.operationId,
      roleBindings: probe.roleBindings, pivot: probe.pivot, operationParams: probe.operationParams,
    }, scope);
    const t = emptyTally(run);
    const status = judgeRunStatus(run.status, run.detail);
    if (!status.ok || !run.runId) return { ...t, failures: [`${probe.id}: ${status.ok ? 'no run id' : status.why}`] };
    const fresh = judgeFreshness(run, runKind);
    if (!fresh.ok) return { ...t, succeeded: true, runId: run.runId, stale: `${probe.id}: ${fresh.why}` };
    const rows = await s.driver.table(run.runId);
    if (!rows) return { ...t, succeeded: true, runId: run.runId, failures: [`${probe.id}: result table unreadable`] };
    return { ...t, succeeded: true, runId: run.runId, ...judgeRows(probe, rows, s.reference) };
  }

  async function paulCase(planned: PlannedCase, s: Session): Promise<CaseResult> {
    const probes: PaulProbe[] = s.reference.probes.filter((p) => p.operationId === planned.operationId);
    if (probes.length === 0) return { outcome: 'not-evaluated', reason: `no Paul probe declared for ${planned.operationId}`, facts: {} };
    const tallies: ProbeTally[] = [];
    for (const probe of probes) tallies.push(await paulProbe(planned, probe, s));
    return paulVerdict(tallies, probes);
  }

  async function catalogueCase(planned: PlannedCase, s: Session): Promise<CaseResult> {
    const recipe = planned.operationId ? recipes[planned.operationId] : undefined;
    if (!recipe) return { outcome: 'not-evaluated', reason: noRecipeReason(planned.operationId, planned.runKind), facts: {} };
    const scope = await s.workbench.scope(recipe.fixture, recipe.filters);
    const runKind = planned.runKind ?? 'STATISTICAL';
    const run = await s.driver.run(catalogueRequest(planned, recipe, runKind, nonce), scope);
    const facts: CaseFacts = runFacts(run);
    const status = judgeRunStatus(run.status, run.detail);
    if (!status.ok || !run.runId) return { outcome: 'fail', reason: bound(status.ok ? 'no run id' : status.why), facts };
    const fresh = judgeFreshness(run, runKind);
    facts.engineRanToday = fresh.ok;
    if (!fresh.ok) return { outcome: 'not-evaluated', reason: bound(fresh.why), facts };
    const unjudgeable = chartUnjudgeable(s.charts.get(planned.operationId!) ?? 'none', planned.operationId!, facts);
    if (unjudgeable) return unjudgeable;
    const chart = await checkChart(s, run.runId, scope.analysisId);
    Object.assign(facts, chart.facts);
    return chart.failure ? { outcome: 'fail', reason: bound(chart.failure), facts } : { outcome: 'pass', reason: null, facts };
  }

  return async (planned, ctx) => {
    if (planned.runnable === false) {
      return { outcome: 'not-evaluated', reason: 'rule is not runnable on the platform (runnable=false)', facts: {} };
    }
    const s = await open(ctx);
    return planned.phase === 'paul-methods' ? paulCase(planned, s) : catalogueCase(planned, s);
  };
}
