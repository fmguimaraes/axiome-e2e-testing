import { okBody } from './api-client';
import type { CaseContext, CaseExecutor, CaseFacts, CaseResult } from './cases';
import { describeCheck, loadPaulReference, type PaulProbe, type PaulReference } from './paul-reference';
import { judgeProbe, judgeRenderPayload, judgeRunStatus, type CheckOutcome } from './pass-rule';
import { CATALOGUE_RECIPES, noRecipeReason, recipeParams, type Recipe } from './recipes';
import { createRunDriver, type ChartOutcome, type DriverTiming, type RunDriver, type RunOutcome } from './run-driver';
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
 *   the result table — there is no server artefact to render).
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
  if (c.state === 'render-refused') facts.chartRenderHttp = c.httpStatus;
  return facts;
}

/** The FR14 verdict on a chart outcome (null = passed). */
export function chartFailure(c: ChartOutcome): string | null {
  switch (c.state) {
    case 'no-result-snapshot': return 'default chart: the run produced no result snapshot';
    case 'not-minted': return 'default chart: no recommended chart was minted for the result';
    case 'render-refused': return `default chart: render refused (HTTP ${c.httpStatus})`;
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

  /** Chart check with the render circuit breaker (a dead render path must not cost the full wait × every rule). */
  async function checkChart(s: Session, runId: string, analysisId: string): Promise<{ failure: string | null; facts: CaseFacts }> {
    const wait = consecutiveNeverReady >= breakerAt ? 0 : s.driver.timing.renderTimeoutMs;
    const c = await s.driver.chart(runId, analysisId, wait);
    consecutiveNeverReady = c.state === 'never-ready' ? consecutiveNeverReady + 1 : 0;
    const facts = chartFacts(c, wait);
    const failure = chartFailure(c);
    facts.chartRendered = failure === null;
    return { failure, facts };
  }

  async function paulCase(planned: PlannedCase, s: Session): Promise<CaseResult> {
    const probes: PaulProbe[] = s.reference.probes.filter((p) => p.operationId === planned.operationId);
    if (probes.length === 0) return { outcome: 'not-evaluated', reason: `no Paul probe declared for ${planned.operationId}`, facts: {} };
    const facts: CaseFacts = { probes: probes.length };
    const failures: string[] = [];
    const outcomes: CheckOutcome[] = [];
    let succeeded = 0;
    let deduped = 0;
    let reExecuted = 0;
    for (const probe of probes) {
      const scope = await s.workbench.scope(probe.fixture, probe.filters);
      const run = await s.driver.run({
        ruleId: planned.id, runKind: planned.runKind ?? 'STATISTICAL', operationId: probe.operationId,
        roleBindings: probe.roleBindings, pivot: probe.pivot, operationParams: probe.operationParams,
      }, scope);
      if (run.deduped) deduped += 1;
      if (run.reExecuted) reExecuted += 1;
      const status = judgeRunStatus(run.status, run.detail);
      if (!status.ok || !run.runId) {
        failures.push(`${probe.id}: ${status.ok ? 'no run id' : status.why}`);
        continue;
      }
      succeeded += 1;
      if (!facts.firstRunId) facts.firstRunId = run.runId;
      const rows = await s.driver.table(run.runId);
      const ref = s.reference.r.probes.find((p) => p.id === probe.id)!;
      if (!rows) {
        failures.push(`${probe.id}: result table unreadable`);
        continue;
      }
      for (const o of judgeProbe(probe, rows, ref)) {
        outcomes.push(o);
        if (!o.verdict.ok) failures.push(`${probe.id}: ${o.verdict.why}`);
        if (o.check.target !== undefined) facts[`observed.${probe.id}.${describeCheck(o.check)}`] = o.value;
      }
    }
    Object.assign(facts, {
      runsSucceeded: succeeded, deduped, reExecuted,
      checks: outcomes.length, checksPassed: outcomes.filter((o) => o.verdict.ok).length,
      checksExpected: probes.reduce((n, p) => n + p.checks.length, 0),
    });
    if (failures.length > 0) {
      return { outcome: 'fail', reason: bound(`${failures.length} failed: ${failures.slice(0, 3).join('; ')}`), facts };
    }
    return { outcome: 'pass', reason: null, facts };
  }

  async function catalogueCase(planned: PlannedCase, s: Session): Promise<CaseResult> {
    const recipe = planned.operationId ? recipes[planned.operationId] : undefined;
    if (!recipe) return { outcome: 'not-evaluated', reason: noRecipeReason(planned.operationId, planned.runKind), facts: {} };
    const scope = await s.workbench.scope(recipe.fixture, recipe.filters);
    const run = await s.driver.run({
      ruleId: planned.id, runKind: planned.runKind ?? 'STATISTICAL', operationId: planned.operationId!,
      roleBindings: recipe.roleBindings, pivot: recipe.pivot, operationParams: recipeParams(recipe, { ruleId: planned.id, nonce }),
    }, scope);
    const facts: CaseFacts = runFacts(run);
    const status = judgeRunStatus(run.status, run.detail);
    if (!status.ok || !run.runId) return { outcome: 'fail', reason: bound(status.ok ? 'no run id' : status.why), facts };
    const declaration = s.charts.get(planned.operationId!) ?? 'none';
    facts.chartDeclaration = declaration;
    if (declaration === 'none') {
      return { outcome: 'not-evaluated', reason: `run SUCCEEDED; ${planned.operationId} declares no default chart — FR14 cannot be judged (owner ruling)`, facts };
    }
    if (declaration === 'result-surface-only') {
      return { outcome: 'not-evaluated', reason: `run SUCCEEDED; ${planned.operationId}'s default chart is result-surface only (drawn client-side) — no server artefact to render headless (owner ruling)`, facts };
    }
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
