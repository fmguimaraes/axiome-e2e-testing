import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Api } from '../../AXI-1435/harness/api';
import { adminApi, resetAdminToken, workspaceHeader } from '../../AXI-1435/harness/api';
import { loadGradosBank, buildEnvelope } from './governed';

/**
 * AXI-1614 (epic AXI-1603 — FR28, AC21, SI-042). The shadow harness: extends the
 * existing Grados-corpus harness (`governed.ts`) to run the bank once against
 * whichever `GUIDED_ANALYSIS_LLM_PROVIDER` the caller says the backend is
 * currently configured with, and write the raw per-question rows the
 * `axiome-back` aggregation script
 * (`guided-analysis/shadow-run/generate-shadow-report.ts`)
 * turns into the FR28 Markdown table.
 *
 * `GUIDED_ANALYSIS_LLM_PROVIDER` is read ONCE by `createPlanner()` at Nest
 * module construction (`planner.factory.ts`) — it cannot be forced per request.
 * This harness therefore does not itself switch providers; the OPERATOR
 * restarts the backend with the desired value and passes the SAME value to
 * this harness (`--provider`/`SHADOW_RUN_PROVIDER`) purely as a LABEL for the
 * rows it writes, matching FR28's "once per forced provider value" by running
 * this spec twice against two differently-configured backend processes.
 *
 * FR28's "never a second live call inside a user request" is satisfied
 * structurally: this harness issues exactly one `POST /guided-analysis/plan`
 * per question, like any ordinary guided-analysis request — it is not a second
 * call layered on top of one a real user already made.
 *
 * AXI-1631 (epic AXI-1603 — FR28/FR31 join, follow-up to AXI-1624): every row
 * also carries `correlationId`, read off the SAME plan API response's own
 * top-level `correlationId` field (`PlanResponse.correlationId`,
 * `axiome-back/libs/contracts/src/guided-analysis/analysis-plan.patterns.ts`).
 * This harness never mints its own id — the id is minted server-side, once,
 * inside `PlannerService.plan()` (AXI-1624), and is the ONLY value that can
 * join against the FR31 attempt-telemetry log stream the SAME backend process
 * wrote for that request. A harness-invented id would join to nothing while
 * looking populated, which is worse than the 'n/a' the field showed before
 * this story (see `shadow-run-row.ts`'s field doc on the `axiome-back` side).
 */

export interface ShadowRunUsage {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
}

/**
 * AXI-1689 (epic AXI-1687 — FR50/FR51/FR53/FR55). The outcome vocabulary is a
 * STRUCTURAL COPY of `libs/contracts/src/guided-analysis/shadow-run-row.contract.ts`
 * in `axiome-back` (SI-002): this repo cannot import that package, so the copy
 * is pinned by `harness-unit/AXI-1687/shadow-subset.spec.ts` against
 * `SHADOW_RUN_ROW_KEYS` below, and the back's strict `isShadowRunRow` guard
 * refuses a row carrying any other key. `not_answered` is the row that was NOT
 * ANSWERED for a reason the harness or the planner states — never a planner
 * verdict dressed as one.
 */
export type ShadowRunOutcome =
  | 'planned'
  | 'fallback'
  | 'unsupported'
  | 'refused'
  | 'unavailable'
  | 'not_answered';

/**
 * Why a `not_answered` row was not answered (closed, mirrors the back contract):
 * `guard`    — the live-spend guard refused the call before it was made (FR53);
 * `deadline` — the planner reached its deadline and, per FR51, ran NO fallback;
 * `aborted`  — the run was aborted after a provider HTTP 400 (FR50) and this
 *              question was never asked.
 */
export type ShadowRunNotAnsweredReason = 'guard' | 'deadline' | 'aborted';

export interface ShadowRunRow {
  readonly questionId: number;
  readonly provider: string;
  readonly outcome: ShadowRunOutcome;
  readonly attempts: number;
  readonly ruleIdsPerAttempt: readonly (readonly string[])[];
  readonly shape: string;
  readonly latencyMs: number;
  readonly usage: ShadowRunUsage | null;
  /**
   * AXI-1631 — echoes `PlanResponse.correlationId` off the SAME response this
   * row was built from. Omitted (never `null`/empty string) when the response
   * carried none, matching `isShadowRunRow`'s optional-field contract on the
   * `axiome-back` side (`shadow-run-row.ts`). `JSON.stringify` drops an
   * `undefined` property entirely, so `writeShadowRunRows` never writes the
   * key for such a row.
   */
  readonly correlationId?: string;
  /** AXI-1689 — present iff `outcome === 'not_answered'`; omitted otherwise. */
  readonly notAnsweredReason?: ShadowRunNotAnsweredReason;
}

/**
 * AXI-1689 (FR55) — the closed key set of a row, pinned against the back
 * contract's `SHADOW_RUN_ROW_KEYS`. Presence is what is asserted; order is not.
 */
export const SHADOW_RUN_ROW_KEYS = [
  'questionId',
  'provider',
  'outcome',
  'attempts',
  'ruleIdsPerAttempt',
  'shape',
  'latencyMs',
  'usage',
  'correlationId',
  'notAnsweredReason',
] as const;

export interface PlanApiBody {
  plan?: {
    nodes?: Array<{ nodeType?: string; params?: Record<string, unknown> }>;
    attemptCount?: number;
    /**
     * AXI-1677 — the two fields that tell a REFUSAL from an answer. Both are
     * optional on the wire: an older or minimal plan may carry neither, and the
     * classifier must not invent them.
     */
    declined?: unknown[];
    datasetsUsed?: unknown[];
  };
  plannerFallback?: boolean;
  intentUnsupported?: boolean;
  /**
   * AXI-1689 (FR51) — `PlanResponse.unsupportedReason`, present iff
   * `intentUnsupported`. The one value this harness reads is `deadline`: the
   * planner did not reach a verdict in time and, since AXI-1689, ran NO
   * wrong-shaped fallback (the AXI-1683 regression). Every other reason is an
   * honest `unsupported` verdict and is recorded as before.
   */
  unsupportedReason?: string;
  /** AXI-1631 — `PlanResponse.correlationId`, echoed at the top level (AXI-1624). */
  correlationId?: string;
}

/**
 * AXI-1631 — the join key this row will carry, read off the plan API response
 * body. A pure extraction so it is unit-testable without a live backend: a
 * missing/non-string value on the response is treated as "no id" (`undefined`),
 * never fabricated.
 */
export function correlationIdOf(body: PlanApiBody): string | undefined {
  return typeof body.correlationId === 'string' && body.correlationId.length > 0
    ? body.correlationId
    : undefined;
}

/** The shape's own node type, read off the plan's own last non-structural node. */
const STRUCTURAL_NODE_TYPES = new Set(['profile', 'filter']);

function shapeOf(plan: PlanApiBody['plan']): string {
  const nodes = plan?.nodes ?? [];
  const shaped = [...nodes].reverse().find((n) => !STRUCTURAL_NODE_TYPES.has(n.nodeType ?? ''));
  return shaped?.nodeType ?? 'unknown';
}

/**
 * Node types that, on their own, analyse NOTHING. `profile` audits the dataset's
 * structure and `filter` narrows rows; a plan made only of these produces no
 * answer to the question that was asked, whatever else it contains.
 *
 * NOTE this is deliberately NOT `PLAN_STRUCTURAL_NODE_TYPES` from the backend
 * contract, which also counts `describe`, `join` and `qc_check` as structural. A
 * `describe` plan over a real dataset IS an answer to a descriptive question,
 * and calling it a refusal would be a new lie in the opposite direction.
 */
const NON_ANALYTICAL_NODE_TYPES = new Set(['profile', 'filter']);

/**
 * AXI-1677 (epic AXI-1604 — FR28/FR30). Is this plan a REFUSAL dressed as a plan?
 *
 * THE DEFECT THIS REPLACES. `outcomeOf()` used to score any response carrying a
 * `body.plan` as `planned` unless `intentUnsupported`/`plannerFallback` was set.
 * A legacy-arm response of one `profile` node, every inferential analysis moved
 * to `declined[]` and `datasetsUsed: []` satisfied that — so on the 2026-09-25
 * run six questions read `planned` on the legacy arm and `unsupported` on the
 * compiled arm when BOTH arms had given the same answer: "this envelope has no
 * schema; nothing can be planned". The `planned`/`unsupported` columns of that
 * table are not comparable between arms, and the FR30 report names this the
 * single most misleading thing in it. The persisted plans are committed at
 * `axiome-docs/reports/artifacts/2026-09-25-compiled-planner-shadow-run/db-plan-rows.md`
 * and are what `harness-unit/AXI-1462/shadow.spec.ts` tests this against.
 *
 * THE TEST. A plan is a refusal when it USED NO DATASET **and** contains no node
 * that analyses one. Both halves are required and each catches what the other
 * misses: `datasetsUsed: []` alone would libel a legitimately dataset-free plan
 * if one ever existed, and "all nodes are profile/filter" alone would libel a
 * genuine profiling plan that did read a dataset. `declined[]` is strong
 * corroboration and is NOT required — a plan that analyses nothing and declines
 * nothing has still refused the question, it has merely not said so.
 *
 * It is applied to BOTH arms, identically. That is the point: a refusal must
 * cost the same on the arm being measured and on the arm it is compared with.
 */
export function isRefusalPlan(plan: PlanApiBody['plan']): boolean {
  if (!plan) return false;
  const usedADataset = Array.isArray(plan.datasetsUsed) && plan.datasetsUsed.length > 0;
  if (usedADataset) return false;
  const nodes = plan.nodes ?? [];
  return nodes.every((n) => NON_ANALYTICAL_NODE_TYPES.has(n?.nodeType ?? ''));
}

/**
 * The outcome one plan API response is recorded as, most specific label first.
 *
 * `refused` is a member of `ShadowRunOutcome` that the harness never emitted
 * before this story, and of `ShadowRunOutcome` in `axiome-back`'s
 * `shadow-run-row.ts` / FR28's own outcome vocabulary. Nothing downstream needed
 * changing to accept it — the report generator was always ready for a label the
 * harness had simply never used.
 *
 * ORDER MATTERS. `intentUnsupported` and `plannerFallback` are the planner's own
 * explicit statements about what it did, and FR30 conditions (a) and (b) count
 * exactly those two; `refused` is this harness's INFERENCE from the plan body,
 * so it must never mask either of them.
 */
export function outcomeOf(body: PlanApiBody, status: number): ShadowRunOutcome {
  if (status >= 300 || !body.plan) return 'unavailable';
  // AXI-1689 (FR51): a deadline is NOT a planner verdict about the question. It
  // is recorded as `not_answered: deadline` so the report never counts it with
  // the honest `none` intents, and never as a plan.
  if (body.intentUnsupported && body.unsupportedReason === 'deadline') return 'not_answered';
  if (body.intentUnsupported) return 'unsupported';
  if (body.plannerFallback) return 'fallback';
  if (isRefusalPlan(body.plan)) return 'refused';
  return 'planned';
}

/**
 * AXI-1689 — the reason a response is recorded `not_answered`, or `undefined`
 * for every other outcome so `rowOf` never writes the key on an answered row
 * (the back's strict guard refuses a `notAnsweredReason` beside any other
 * outcome). The only reason a RESPONSE can carry is `deadline`; `guard` and
 * `aborted` are decided by the run loop, before or instead of a response.
 */
export function notAnsweredReasonOf(
  body: PlanApiBody,
  status: number,
): ShadowRunNotAnsweredReason | undefined {
  return outcomeOf(body, status) === 'not_answered' ? 'deadline' : undefined;
}

/** The HTTP status that means "your token is no longer good", never an outcome. */
const UNAUTHORIZED = 401;

/**
 * AXI-1677. Thrown when the run cannot authenticate. It is deliberately an
 * EXCEPTION and not an outcome: a 401 made no LLM call, produced no plan and
 * carries no cache datum, so it says nothing whatever about the planner. The
 * 2026-09-25 run recorded 39 of them as `unavailable` rows and the resulting
 * table had to be de-contaminated by hand afterwards, from row latencies.
 */
export class ShadowRunAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShadowRunAuthError';
  }
}

/**
 * The run's authentication, as a seam the run loop can re-mint mid-flight.
 *
 * Injected rather than constructed inside `runShadowBank` so the 401 policy is
 * testable without a backend and without a clock: a stub whose first token is
 * expired proves the retry, and a stub that cannot refresh proves the loud
 * failure. `createAdminShadowRunAuth()` is the live implementation.
 */
export interface ShadowRunAuth {
  /** The client the next request should use. */
  api(): Api;
  /** Re-authenticate; resolves to the new client. Throws if it cannot. */
  refresh(): Promise<Api>;
}

/**
 * Live admin auth that can re-mint its token. `adminToken()` caches for the
 * whole process, so refreshing means dropping that cache (`resetAdminToken`) AND
 * building a new `Api` — the `Authorization` header is baked into the
 * `APIRequestContext` when it is created and cannot be mutated afterwards.
 */
export async function createAdminShadowRunAuth(): Promise<ShadowRunAuth> {
  let current = await adminApi();
  return {
    api: () => current,
    async refresh() {
      const previous = current;
      resetAdminToken();
      current = await adminApi();
      await previous.ctx.dispose();
      return current;
    },
  };
}

export interface ShadowRunOptions {
  /**
   * Proactively re-mint the token every N questions. `0` disables the proactive
   * refresh and leaves only the reactive one.
   *
   * WHY BOTH. The reactive path alone is sufficient for correctness but wastes a
   * round trip and, worse, leaves one question's latency measurement polluted by
   * a re-login. At the legacy arm's measured 104-180 s per question a 46-question
   * run is well over an hour, so the token WILL expire; refreshing every ten
   * questions means it expires between runs instead of inside one.
   */
  readonly reauthEveryQuestions?: number;
}

const DEFAULT_REAUTH_EVERY_QUESTIONS = 10;

interface PlanAttempt {
  readonly status: number;
  readonly body: PlanApiBody;
  readonly latencyMs: number;
}

/** One `POST /guided-analysis/plan`, timed. No retry, no interpretation. */
async function planOnce(
  api: Api,
  workspaceId: string,
  projectId: string,
  envelope: ReturnType<typeof buildEnvelope>,
): Promise<PlanAttempt> {
  const startedAt = Date.now();
  const res = await api.post<PlanApiBody>(
    '/api/v1/guided-analysis/plan',
    { projectId, envelope },
    workspaceHeader(workspaceId),
  );
  return { status: res.status, body: res.body, latencyMs: Date.now() - startedAt };
}

/**
 * One question's plan call, re-authenticating once on a 401. A 401 that survives
 * the refresh FAILS THE RUN — it is never written as a row.
 */
async function planWithRefresh(
  auth: ShadowRunAuth,
  workspaceId: string,
  projectId: string,
  questionId: number,
  envelope: ReturnType<typeof buildEnvelope>,
): Promise<PlanAttempt> {
  const first = await planOnce(auth.api(), workspaceId, projectId, envelope);
  if (first.status !== UNAUTHORIZED) return first;
  await auth.refresh();
  const retry = await planOnce(auth.api(), workspaceId, projectId, envelope);
  if (retry.status === UNAUTHORIZED) {
    throw new ShadowRunAuthError(
      `shadow run: question ${questionId} returned 401 again after re-authenticating. ` +
        'Aborting the run: a 401 made no planner call, so recording it as an outcome would put ' +
        'a harness artefact in the FR30 gate evidence (as 39 of 46 rows were on 2026-09-25).',
    );
  }
  return retry;
}

/**
 * Runs the whole Grados bank once against the LIVE `/guided-analysis/plan`
 * endpoint, labelling every row with `provider` (the caller's own record of
 * what the backend under test is configured with). Token usage and per-attempt
 * rule ids are NOT part of the plan API response (FR31's log line is the only
 * place those live) — this harness leaves them `null`/empty rather than
 * fabricating a value. `correlationId` IS part of the response (AXI-1624) and
 * IS captured (AXI-1631) — it is the join key that later resolves the token
 * usage and per-attempt rule ids against the FR31 log stream, offline.
 *
 * AXI-1677 — takes a `ShadowRunAuth` rather than a bare `Api`, because a run
 * this long outlives its own access token; see `ShadowRunAuthError`.
 */
export async function runShadowBank(
  auth: ShadowRunAuth,
  workspaceId: string,
  projectId: string,
  provider: string,
  datasets: Parameters<typeof buildEnvelope>[2],
  opts: ShadowRunOptions = {},
): Promise<ShadowRunRow[]> {
  const bank = loadGradosBank();
  const every = opts.reauthEveryQuestions ?? DEFAULT_REAUTH_EVERY_QUESTIONS;
  const rows: ShadowRunRow[] = [];
  for (const [index, q] of bank.entries()) {
    if (every > 0 && index > 0 && index % every === 0) await auth.refresh();
    const envelope = buildEnvelope(projectId, q.question, datasets);
    const attempt = await planWithRefresh(auth, workspaceId, projectId, q.id, envelope);
    rows.push(rowOf(q.id, provider, attempt));
  }
  return rows;
}

/** One `ShadowRunRow` from one completed plan attempt. Pure. */
function rowOf(questionId: number, provider: string, attempt: PlanAttempt): ShadowRunRow {
  return {
    questionId,
    provider,
    outcome: outcomeOf(attempt.body, attempt.status),
    attempts: attempt.body.plan?.attemptCount ?? 1,
    ruleIdsPerAttempt: [],
    shape: shapeOf(attempt.body.plan),
    latencyMs: attempt.latencyMs,
    usage: null,
    correlationId: correlationIdOf(attempt.body),
    notAnsweredReason: notAnsweredReasonOf(attempt.body, attempt.status),
  };
}

// ─── AXI-1689 (epic AXI-1687 — FR50, FR53, FR55, NFR1, EC23–EC25) ───────────
//
// The harness half of the ONE live-spend guard. The other half sits in the
// adapter's single provider-client construction site (`provider/anthropic-client.ts`
// in `axiome-back`) and is the real wall: it refuses a call in any test/CI
// environment and outside a registered run whatever this harness says. This
// half exists so that a paid bank is never even ATTEMPTED without a registry
// row with a written go — unset, the harness refuses every call and reports
// `not_answered: guard` (FR53), spending nothing and writing an honest row.
//
// The knob is `GUIDED_ANALYSIS_LIVE_SPEND_GO` (ruling 33), carrying the
// registry row id of the held run, `RUN-YYYY-MM-DD-NN`. `E2E_LIVE_LLM` is a
// DIFFERENT, older opt-in for the route-free Playwright specs and is never
// consulted here: one knob, one grammar (NFR1).

/** The registry row-id grammar (FR9): `RUN-` + ISO date + two-digit ordinal. */
export const LIVE_SPEND_ROW_ID = /^RUN-\d{4}-\d{2}-\d{2}-\d{2}$/;

export type HarnessLiveSpendRefusal =
  | 'not_configured'
  | 'invalid_row_id'
  | 'no_registry'
  | 'row_not_registered'
  | 'row_not_go';

export interface HarnessLiveSpendDecision {
  readonly allowed: boolean;
  /** `allowed` when `allowed` is true; the refusal otherwise. */
  readonly reason: HarnessLiveSpendRefusal | 'allowed';
  /** The row id the decision was made for, when the variable parsed as one. */
  readonly rowId?: string;
}

/**
 * Pure. Decides whether THIS harness process may make a paid call.
 *
 * `registryText` is the text of the run registry (`SHADOW_RUN_REGISTRY_PATH`)
 * when the caller could read it; the registry line for a row must carry the
 * row id AND a `GO:` marker with a non-empty value (the written go). The
 * registry's full grammar is AXI-1690's; this check reads only what a go
 * needs and refuses on anything less — a registry it cannot read is a refusal,
 * never a pass.
 */
export function decideHarnessLiveSpend(
  env: Record<string, string | undefined>,
  registryText: string | undefined,
): HarnessLiveSpendDecision {
  const raw = env.GUIDED_ANALYSIS_LIVE_SPEND_GO?.trim();
  if (!raw) return { allowed: false, reason: 'not_configured' };
  if (!LIVE_SPEND_ROW_ID.test(raw)) return { allowed: false, reason: 'invalid_row_id' };
  if (registryText === undefined) return { allowed: false, reason: 'no_registry', rowId: raw };
  const line = registryText.split(/\r?\n/).find((l) => l.includes(raw));
  if (!line) return { allowed: false, reason: 'row_not_registered', rowId: raw };
  if (!/\bGO:\s*\S+/.test(line)) return { allowed: false, reason: 'row_not_go', rowId: raw };
  return { allowed: true, reason: 'allowed', rowId: raw };
}

/** Reads the registry named by `SHADOW_RUN_REGISTRY_PATH`; `undefined` when unset or unreadable. */
export function readRunRegistry(env: Record<string, string | undefined>): string | undefined {
  const path = env.SHADOW_RUN_REGISTRY_PATH?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * AXI-1689 (FR50). The subset of the bank `SHADOW_RUN_QUESTIONS` names, in BANK
 * order (the order the report expects), deduplicated. Unset or blank ⇒ the
 * whole bank, exactly as before. An id the bank does not carry THROWS — a
 * paid subset that silently ran the wrong questions would be a waste with a
 * clean-looking artefact (the `SHADOW_RUN_DATASET_ID` precedent).
 */
export function selectQuestions<Q extends { id: number }>(
  bank: readonly Q[],
  questionsEnv: string | undefined,
): Q[] {
  const wanted = (questionsEnv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (wanted.length === 0) return [...bank];
  const ids = new Set<number>();
  for (const token of wanted) {
    if (!/^\d+$/.test(token)) {
      throw new Error(`SHADOW_RUN_QUESTIONS: '${token}' is not a bank question id`);
    }
    ids.add(Number(token));
  }
  const known = new Set(bank.map((q) => q.id));
  const missing = [...ids].filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(`SHADOW_RUN_QUESTIONS names question(s) not in the bank: ${missing.join(', ')}`);
  }
  return bank.filter((q) => ids.has(q.id));
}

export type ShadowRunStatus = 'complete' | 'refused' | 'INVALID';

export interface ShadowRunResult {
  readonly rows: ShadowRunRow[];
  /**
   * `complete` — every selected question was asked and answered (or honestly
   *              recorded as unsupported/refused/unavailable/deadline);
   * `refused`  — the guard refused before ANY call; every row is `not_answered: guard`;
   * `INVALID`  — a provider HTTP 400 aborted the run (FR50); the 400'd question
   *              and every question after it are `not_answered: aborted`.
   */
  readonly status: ShadowRunStatus;
  readonly guard: HarnessLiveSpendDecision;
  readonly questionIds: readonly number[];
  readonly abortedAtQuestionId?: number;
}

export interface GuardedShadowRunOptions extends ShadowRunOptions {
  /** Defaults to `process.env`; injectable so the policy is unit-testable. */
  readonly env?: Record<string, string | undefined>;
  /** Defaults to the file `SHADOW_RUN_REGISTRY_PATH` names; injectable likewise. */
  readonly registryText?: string;
}

/** The HTTP status that aborts a run: the provider (or the gateway) rejected the request itself. */
const BAD_REQUEST = 400;

function notAnsweredRow(
  questionId: number,
  provider: string,
  reason: ShadowRunNotAnsweredReason,
): ShadowRunRow {
  return {
    questionId,
    provider,
    outcome: 'not_answered',
    attempts: 0,
    ruleIdsPerAttempt: [],
    shape: 'unknown',
    latencyMs: 0,
    usage: null,
    notAnsweredReason: reason,
  };
}

/**
 * AXI-1689 (FR50/FR53). `runShadowBank` behind the guard and over the selected
 * subset, aborting on the first HTTP 400. `runShadowBank`'s own signature and
 * behaviour are unchanged for its existing callers; this is the entry point
 * every paid run goes through from now on.
 *
 * A refusal or an abort still yields ONE row per selected question, so the
 * artefact is total over the subset and a report reads "not answered — guard"
 * rather than a missing line.
 */
export async function runShadowBankGuarded(
  auth: ShadowRunAuth,
  workspaceId: string,
  projectId: string,
  provider: string,
  datasets: Parameters<typeof buildEnvelope>[2],
  opts: GuardedShadowRunOptions = {},
): Promise<ShadowRunResult> {
  const env = opts.env ?? process.env;
  const registryText = opts.registryText ?? readRunRegistry(env);
  const guard = decideHarnessLiveSpend(env, registryText);
  const questions = selectQuestions(loadGradosBank(), env.SHADOW_RUN_QUESTIONS);
  const questionIds = questions.map((q) => q.id);

  if (!guard.allowed) {
    return {
      rows: questionIds.map((id) => notAnsweredRow(id, provider, 'guard')),
      status: 'refused',
      guard,
      questionIds,
    };
  }

  const every = opts.reauthEveryQuestions ?? DEFAULT_REAUTH_EVERY_QUESTIONS;
  const rows: ShadowRunRow[] = [];
  for (const [index, q] of questions.entries()) {
    if (every > 0 && index > 0 && index % every === 0) await auth.refresh();
    const envelope = buildEnvelope(projectId, q.question, datasets);
    const attempt = await planWithRefresh(auth, workspaceId, projectId, q.id, envelope);
    if (attempt.status === BAD_REQUEST) {
      for (const rest of questions.slice(index)) rows.push(notAnsweredRow(rest.id, provider, 'aborted'));
      return { rows, status: 'INVALID', guard, questionIds, abortedAtQuestionId: q.id };
    }
    rows.push(rowOf(q.id, provider, attempt));
  }
  return { rows, status: 'complete', guard, questionIds };
}

/** The run's sidecar (`<provider>.run.json`): status, guard decision and subset, beside the rows. */
export function writeShadowRunSummary(
  provider: string,
  result: Omit<ShadowRunResult, 'rows'>,
  dir = join(process.cwd(), 'tests', 'AXI-1462', 'harness', 'shadow-run'),
): string {
  const path = join(dir, `${provider}.run.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ provider, writtenAt: new Date().toISOString(), ...result }, null, 2),
    'utf8',
  );
  return path;
}

/**
 * AXI-1677 (epic AXI-1604 — FR30(c) v0.5). Does THIS invocation's arm belong to
 * the set of arms the operator intends to run?
 *
 * WHY THE LEGACY ARM CAN NOW BE SKIPPED. FR30(c) used to require the compiled
 * arm's cache reads to be "no lower than the legacy arm's", which is what made a
 * legacy run part of the gate at all. v0.5 of the feature doc WITHDREW that
 * clause as unsatisfiable by design — the compiled prompt is deliberately
 * smaller, so it necessarily reads fewer cached tokens — and replaced it with
 * FR20's criterion, which is about the compiled arm alone: non-zero cache reads
 * with the cached prefix above the model's minimum. Nothing in the amended gate
 * compares the two arms, so nothing in the amended gate requires paying for a
 * second 46-question live run.
 *
 * The DEFAULT is unchanged: unset, every arm runs, exactly as before.
 */
export function shouldRunArm(armsEnv: string | undefined, provider: string): boolean {
  const declared = (armsEnv ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  if (declared.length === 0) return true;
  return declared.includes(provider.trim().toLowerCase());
}

/** Writes the raw rows a run produced to a fixed, per-provider JSON artifact. */
export function writeShadowRunRows(provider: string, rows: readonly ShadowRunRow[]): string {
  const path = join(process.cwd(), 'tests', 'AXI-1462', 'harness', 'shadow-run', `${provider}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows, null, 2), 'utf8');
  return path;
}
