import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Api } from '../../AXI-1435/harness/api';
import { adminApi, resetAdminToken, workspaceHeader } from '../../AXI-1435/harness/api';
import { loadGradosBank, buildEnvelope } from './governed';
import { loadRiazBank } from '../../AXI-1865/harness/riazBank';

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
 * `guard`             — the live-spend guard refused the call before it was made (FR53);
 * `deadline`          — the planner reached its deadline and, per FR51, ran NO fallback;
 * `aborted`           — the run was aborted after a provider HTTP 400 (FR50) and this
 *                        question was never asked;
 * `recording_missing` — AXI-1811: the recorded transport had no committed answer for
 *                        this exact request (`RecordingMissingError`, `axiome-back`
 *                        `llm-transport.ts`). Never scored as an `unsupported` verdict —
 *                        a missing recording is an infrastructure miss, not the planner
 *                        judging the question.
 */
export type ShadowRunNotAnsweredReason = 'guard' | 'deadline' | 'aborted' | 'recording_missing';

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
  /**
   * AXI-1811 (R-LLM-1) — `'live'` or `'claude-code'`, present on every row an
   * actual call was attempted under (i.e. the run was not guard-refused before
   * any call). Never absent for such a row and never inferred by a reader —
   * `transportLabelFor()` is the one place that decides it, from the run's
   * `decideHarnessBankRun` decision — i.e. from the backend's own transport
   * statement, never the harness's env (AXI-1857).
   */
  readonly transport?: ShadowRunTransport;
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
  'transport',
] as const;

export interface PlanApiBody {
  plan?: {
    nodes?: Array<{ nodeType?: string; params?: Record<string, unknown> }>;
    attemptCount?: number;
    /**
     * AXI-1837 (epic AXI-1825) — `AnalysisPlan.ruleIdsPerAttempt`/`.shape` on
     * the `axiome-back` side (`analysis-plan.patterns.ts`). Stamped ONLY by
     * the compiled arm; absent for any other arm, matching every other
     * additive field on this interface. `ruleIdsPerAttempt` is one entry per
     * attempt the invocation actually made — never a coarsened `[]`.
     * `shape` is the compiled intent's OWN shape label (e.g.
     * `compare_groups_omnibus`), which can differ from every node's wire
     * `nodeType` (several shapes compile to the same node type).
     */
    ruleIdsPerAttempt?: readonly (readonly string[])[];
    shape?: string;
    /**
     * AXI-1677 — the two fields that tell a REFUSAL from an answer. Both are
     * optional on the wire: an older or minimal plan may carry neither, and the
     * classifier must not invent them.
     */
    declined?: unknown[];
    datasetsUsed?: unknown[];
  };
  /**
   * AXI-1837 — `PlanResponse.attemptCount` echoed at the TOP level
   * (`plan-orchestrator.service.ts`): `plan.attemptCount ?? outcome.attemptCount`,
   * i.e. a superset of the nested `plan.attemptCount` — populated for every
   * arm, not only the compiled one. Preferred over the nested field in
   * `rowOf` below for exactly that reason.
   */
  attemptCount?: number;
  plannerFallback?: boolean;
  /**
   * AXI-1830 (epic AXI-1825) — `PlanResponse.fallbackReason`, present iff
   * `plannerFallback` (`PLANNER_FALLBACK_REASONS` in `axiome-back`'s
   * `analysis-plan.patterns.ts`). Read ONLY to decide whether the provider
   * under test answered at all (`providerAnswered`) — `attempts_exhausted` is
   * the provider answering and being rejected; every other token is the
   * provider never answering. Never written to a row: the row's key set is
   * closed and pinned against the back contract (`SHADOW_RUN_ROW_KEYS`).
   */
  fallbackReason?: string;
  /**
   * AXI-1830 — `PlanResponse.planner`: the `name` of the arm that produced the
   * plan (`compiled` / `anthropic` / `fallback`, `planner.factory.ts`). On a
   * non-fallback response it is the arm the backend is CONFIGURED with, which
   * is how a run labelled `compiled` against a backend serving `fallback` (or
   * `anthropic`) is caught. Never written to a row (closed key set).
   */
  planner?: string;
  intentUnsupported?: boolean;
  /**
   * AXI-1689 (FR51) — `PlanResponse.unsupportedReason`, present iff
   * `intentUnsupported`. The values this harness reads specially are `deadline`
   * and, since AXI-1811, `recording_missing`: neither is the planner judging
   * the question, so neither is recorded as an honest `unsupported` verdict.
   * Every other reason stays an honest `unsupported` verdict, as before.
   */
  unsupportedReason?: string;
  /**
   * AXI-1811 — `PlanResponse.unsupportedDetail`, present iff `unsupportedReason
   * === 'recording_missing'`. Carries the pending payload sha the operator
   * needs (`RecordingMissingError`'s message, `LLM recording missing <sha>
   * (<callSite>) - run llm-debug:record`) — read here only to surface it, never
   * to gate on.
   */
  unsupportedDetail?: string;
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

/**
 * AXI-1837 — prefers the plan's OWN `shape` label (`plan.shape`, stamped by
 * the compiled arm) over inferring one from `nodes[].nodeType`. The two are
 * NOT the same fact: several shapes compile to the identical node type (e.g.
 * `compare_groups_omnibus` and `compare_groups` both emit a `compare_groups`
 * node), so the node-type inference coarsens two distinct shapes into one
 * label. Falls back to the old inference ONLY for a response that never
 * carries `plan.shape` (any arm but the compiled one, or a legacy recording).
 */
export function shapeOf(plan: PlanApiBody['plan']): string {
  if (plan?.shape) return plan.shape;
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
  // AXI-1811 (R-LLM-1): a missing recording is a TRANSPORT miss, not a planner
  // verdict either — the model was never actually asked. Scoring it
  // `unsupported` would look like an honest `none` and could pass a subset
  // through the gate on an answer that was never given.
  if (body.intentUnsupported && body.unsupportedReason === 'recording_missing') return 'not_answered';
  if (body.intentUnsupported) return 'unsupported';
  if (body.plannerFallback) return 'fallback';
  if (isRefusalPlan(body.plan)) return 'refused';
  return 'planned';
}

/**
 * AXI-1689 — the reason a response is recorded `not_answered`, or `undefined`
 * for every other outcome so `rowOf` never writes the key on an answered row
 * (the back's strict guard refuses a `notAnsweredReason` beside any other
 * outcome). A RESPONSE can carry `deadline` or, since AXI-1811,
 * `recording_missing`; `guard` and `aborted` are decided by the run loop,
 * before or instead of a response.
 */
export function notAnsweredReasonOf(
  body: PlanApiBody,
  status: number,
): ShadowRunNotAnsweredReason | undefined {
  if (outcomeOf(body, status) !== 'not_answered') return undefined;
  return body.unsupportedReason === 'recording_missing' ? 'recording_missing' : 'deadline';
}

/**
 * AXI-1811 — the pending payload sha named in `RecordingMissingError`'s
 * message (`LLM recording missing <sha> (<callSite>) - run llm-debug:record`),
 * read off `unsupportedDetail` for a `recording_missing` row so the operator
 * can find the exact file under `llm-debug/pending/` without re-deriving the
 * hash by hand. `undefined` when the detail carries no recognisable sha (never
 * invented).
 */
export function pendingRecordingShaOf(body: PlanApiBody): string | undefined {
  const match = body.unsupportedDetail?.match(/recording missing ([a-f0-9]{6,})/i);
  return match?.[1];
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

export interface PlanAttempt {
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

/**
 * One `ShadowRunRow` from one completed plan attempt. `transport` is
 * `undefined` for this function's own (unguarded, legacy) caller — only
 * `runShadowBankGuarded` knows the run's transport decision. AXI-1811: a
 * `recording_missing` row logs its pending sha to stderr so an operator
 * scanning console output sees the miss without grepping the JSON artefact —
 * never SILENTLY recorded as an ordinary `unsupported` answer.
 */
export function rowOf(
  questionId: number,
  provider: string,
  attempt: PlanAttempt,
  transport?: ShadowRunTransport,
): ShadowRunRow {
  const notAnsweredReason = notAnsweredReasonOf(attempt.body, attempt.status);
  if (notAnsweredReason === 'recording_missing') {
    const sha = pendingRecordingShaOf(attempt.body);
    // eslint-disable-next-line no-console -- AXI-1811: deliberately loud, mirrors the back's own logger.error on the same miss.
    console.error(
      `[shadow-run] Q${questionId}: recording missing` +
        (sha ? ` — pending payload llm-debug/pending/${sha}.request.json` : ' (no sha recovered from the response)') +
        ' — run `npm --workspace organization-service run llm-debug:record` after authoring a blind response; NOT recorded as an answer.',
    );
  }
  return {
    questionId,
    provider,
    outcome: outcomeOf(attempt.body, attempt.status),
    // AXI-1837: the TOP-LEVEL `attemptCount` (populated for every arm —
    // `plan.attemptCount ?? outcome.attemptCount` server-side) is preferred
    // over the nested `plan.attemptCount`, which is absent for any arm but
    // the compiled one and would otherwise silently fall back to a wrong `1`.
    attempts: attempt.body.attemptCount ?? attempt.body.plan?.attemptCount ?? 1,
    ruleIdsPerAttempt: attempt.body.plan?.ruleIdsPerAttempt ?? [],
    shape: shapeOf(attempt.body.plan),
    latencyMs: attempt.latencyMs,
    usage: null,
    correlationId: correlationIdOf(attempt.body),
    notAnsweredReason,
    transport,
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
//
// AXI-1857 (fixes AXI-1811). AXI-1811 briefly added a second axis here, a
// harness-side `SHADOW_RUN_TRANSPORT=recorded` that allowed a run with no
// spend-go and labelled it free. It is DELETED: the harness's own env says
// nothing about the transport the BACKEND runs (`GUIDED_ANALYSIS_LLM_TRANSPORT`,
// read by organization-service), so pointed at a `live` backend with a key it
// bought an unregistered paid run whose artefact claimed 0 USD. The only way
// into a free run is the backend's own statement — `decideHarnessBankRun`
// below (AXI-1716). Do not re-add a transport variable to this function.

/** The registry row-id grammar (FR9): `RUN-` + ISO date + two-digit ordinal. */
export const LIVE_SPEND_ROW_ID = /^RUN-\d{4}-\d{2}-\d{2}-\d{2}$/;

export type HarnessLiveSpendRefusal =
  | 'not_configured'
  | 'invalid_row_id'
  | 'no_registry'
  | 'row_not_registered'
  | 'row_not_go';

/** AXI-1811 — the label an allowed run's rows carry (never inferred downstream). */
export type ShadowRunTransport = 'live' | 'claude-code';

/**
 * AXI-1716. How a run that WAS allowed is paid for.
 * `free_recorded`   — the serving backend stated `recorded`; no key, no network, no go needed.
 * `registered_live` — the FR116 procedure, entirely unchanged: registry row + written go.
 */
export type ShadowRunSpendMode = 'free_recorded' | 'registered_live';

export interface HarnessLiveSpendDecision {
  readonly allowed: boolean;
  /** `allowed` when `allowed` is true; the refusal otherwise. */
  readonly reason: HarnessLiveSpendRefusal | 'allowed';
  /** The row id the decision was made for, when the variable parsed as one. */
  readonly rowId?: string;
  /**
   * AXI-1716, additive. What the SERVING backend said about its transport, when
   * it was asked (`decideHarnessBankRun`). `decideHarnessLiveSpend` never sets
   * it — that function's five refusal labels and its `allowed` shape are
   * untouched, so every report string that reads them still reads the same.
   */
  readonly transport?: HarnessTransportMode;
  /** AXI-1716, additive. Present only on an allowed decision. */
  readonly spendMode?: ShadowRunSpendMode;
}

/**
 * AXI-1811 — pure. The transport label an allowed decision's rows carry;
 * `undefined` for a refusal, since no call was made and nothing may be
 * labelled for one (never inferred). The SINGLE mapping from decision to
 * label — never restated at a call site.
 *
 * AXI-1857: keyed on `spendMode`, which only `decideHarnessBankRun` sets and
 * only from the backend's own statement — never on `reason`, which reads
 * `allowed` for a free run and a paid one alike.
 */
export function transportLabelFor(
  decision: Pick<HarnessLiveSpendDecision, 'allowed' | 'spendMode'>,
): ShadowRunTransport | undefined {
  if (!decision.allowed) return undefined;
  if (decision.spendMode === 'free_recorded') return 'claude-code';
  if (decision.spendMode === 'registered_live') return 'live';
  return undefined;
}

/**
 * Pure. Decides whether THIS harness process may run a PAID bank: the FR116
 * procedure, nothing else. It knows nothing about transports —
 * `decideHarnessBankRun` composes it with the backend's statement.
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

// ─── AXI-1716 (epic AXI-1687 — the recorded-bank-run blocker) ───────────────
//
// `decideHarnessLiveSpend` above knows exactly one thing: whether the operator
// registered a PAID run. That is the whole FR116 procedure and it stays exactly
// as it is. What it does NOT know is whether the run would cost anything at all.
//
// Since AXI-1758 the platform's default transport is `recorded`: the backend
// serves every LLM answer from `llm-debug/recordings/`, reads no API key and
// reaches no network. A bank run against such a backend spends nothing — and
// yet the guard above refused it, every question came back
// `not_answered: 'guard'`, and `shadow-run/gate/classify.ts` scored those
// `not_answered`, failing gate condition (a). The recorded strategy could not
// produce a scoreable bank run at all. That is the blocker this section lifts.
//
// A recorded run needs no registry go because there is nothing to authorise.
// The entire risk is in HOW the harness learns the run is free:
//
//   NOT from its own environment. A harness-side `SHADOW_RUN_TRANSPORT=recorded`
//   would be a straight bypass of FR116 — set it, point at a `live` backend, and
//   you have an unregistered paid run whose artefact says it was free. NOTHING in
//   this file reads a transport variable out of `env`, by design.
//
//   FROM THE BACKEND THAT WILL SERVE THE CALLS. `GET /api/v1/guided-analysis/
//   llm-transport` is answered by organization-service — the one process that
//   constructs the transport — out of `resolveLlmTransportMode(process.env)`, the
//   SAME function `DelegatingLlmTransport.send()` re-evaluates on every send. The
//   probe travels the same base URL, the same token and the same workspace header
//   as the run's own plan calls, so the "free" answer cannot come from one backend
//   while the spending happens on another.
//
// A backend that cannot be asked, answers something else, or names a service
// other than `organization-service` yields `unknown`, and an `unknown` transport
// falls straight through to the UNCHANGED FR116 guard — which, with no go, is the
// refusal it has always been. The free path needs an affirmative `recorded`
// statement; there is no other way into it.

/** The gateway route carrying the serving backend's own transport statement (AXI-1716). */
export const LLM_TRANSPORT_PROBE_PATH = '/api/v1/guided-analysis/llm-transport';

/** The only service allowed to speak for the transport: the one that constructs it. */
export const TRANSPORT_STATEMENT_SERVICE = 'organization-service';

export type HarnessTransportMode = 'live' | 'recorded' | 'unknown';

/**
 * What the SERVING backend said. `source` records where the fact came from and
 * has exactly one trustworthy value: `backend`. `detail` explains an `unknown`.
 */
export interface HarnessTransportStatement {
  readonly mode: HarnessTransportMode;
  readonly source: 'backend' | 'unavailable';
  readonly detail?: string;
}

const TRANSPORT_UNKNOWN = (detail: string): HarnessTransportStatement => ({
  mode: 'unknown',
  source: 'unavailable',
  detail,
});

/**
 * Pure. Turns one probe response into a statement, refusing anything short of an
 * unambiguous, self-identifying answer.
 *
 * The `service` check is load-bearing, not decoration: `GUIDED_ANALYSIS_LLM_TRANSPORT`
 * exists in the environment of more than one process, and a reply that does not
 * name `organization-service` is a guess by something that does not own the
 * transport seam. Treat it as no answer at all.
 */
export function interpretTransportProbe(status: number, body: unknown): HarnessTransportStatement {
  if (status !== 200) return TRANSPORT_UNKNOWN(`transport probe returned HTTP ${status}`);
  if (typeof body !== 'object' || body === null) {
    return TRANSPORT_UNKNOWN('transport probe returned no JSON object');
  }
  const { mode, service } = body as { mode?: unknown; service?: unknown };
  if (service !== TRANSPORT_STATEMENT_SERVICE) {
    return TRANSPORT_UNKNOWN(
      `transport statement was not made by ${TRANSPORT_STATEMENT_SERVICE} (got ${JSON.stringify(service)})`,
    );
  }
  if (mode !== 'live' && mode !== 'recorded') {
    return TRANSPORT_UNKNOWN(`transport probe returned an unrecognised mode ${JSON.stringify(mode)}`);
  }
  return { mode, source: 'backend' };
}

/**
 * Asks the backend the run is about to hit. Never throws: an unreachable probe
 * is an `unknown` statement, which refuses through the unchanged FR116 guard
 * rather than failing the run with a stack trace.
 */
export async function readBackendTransportMode(
  api: Api,
  workspaceId: string,
): Promise<HarnessTransportStatement> {
  try {
    const res = await api.get(LLM_TRANSPORT_PROBE_PATH, workspaceHeader(workspaceId));
    return interpretTransportProbe(res.status, res.body);
  } catch (err) {
    return TRANSPORT_UNKNOWN(`transport probe failed: ${(err as Error)?.message ?? String(err)}`);
  }
}

/**
 * `readBackendTransportMode` against the run's own auth. Separate only so that
 * `auth.api()` itself — which mints/returns the client and can fail — is inside
 * the same catch as the request: a probe that cannot even be attempted is still
 * just `unknown`, never a thrown run.
 */
async function probeTransport(
  auth: ShadowRunAuth,
  workspaceId: string,
): Promise<HarnessTransportStatement> {
  try {
    return await readBackendTransportMode(auth.api(), workspaceId);
  } catch (err) {
    return TRANSPORT_UNKNOWN(`transport probe could not be attempted: ${(err as Error)?.message ?? String(err)}`);
  }
}

/**
 * Pure. The ONE decision a bank run is gated on, composed from two independent
 * facts: what the backend said, and what the operator registered.
 *
 * `transport` must come from `readBackendTransportMode` — it is the backend's
 * own statement. It is a parameter rather than something this function reads so
 * the policy is testable without a backend; the one thing it is never derived
 * from is `env`.
 */
export function decideHarnessBankRun(
  env: Record<string, string | undefined>,
  registryText: string | undefined,
  transport: HarnessTransportStatement,
): HarnessLiveSpendDecision {
  if (transport.mode === 'recorded' && transport.source === 'backend') {
    return { allowed: true, reason: 'allowed', transport: 'recorded', spendMode: 'free_recorded' };
  }
  const live = decideHarnessLiveSpend(env, registryText);
  return {
    ...live,
    transport: transport.mode,
    ...(live.allowed ? { spendMode: 'registered_live' as const } : {}),
  };
}

/**
 * The run's own record of how it obtained its answers — the thing that stops a
 * free run being read as a paid one six months later.
 *
 * Authored HERE and nowhere else: the harness is the process that made (or
 * refused) the calls. `axiome-back`'s report prints these values verbatim
 * (`shadow-run/shadow-run-provenance.ts`) instead of re-deriving them, so the
 * budget sentence has exactly one author.
 */
export type ShadowRunLabel = 'claude-code' | 'live' | 'none';

export interface ShadowRunProvenance {
  readonly transport: HarnessTransportMode;
  readonly label: ShadowRunLabel;
  readonly budget: string;
  readonly registryRowId?: string;
}

/**
 * Per `LLM-RECORDED-TRANSPORT.md` § "What a recorded run proves" and the
 * superrepo CLAUDE.md § LLM Calls: a recorded run is labelled `claude-code`,
 * NEVER `live`, and its budget is `0 USD (claude-code, blind)`. A live run's
 * budget is not the harness's to state — the owner's FR116 registry row carries
 * it — so the provenance points at the row instead of inventing a number.
 */
export function shadowRunProvenanceOf(decision: HarnessLiveSpendDecision): ShadowRunProvenance {
  if (!decision.allowed) {
    return {
      transport: decision.transport ?? 'unknown',
      label: 'none',
      budget: `0 USD — no call was made (${decision.reason})`,
    };
  }
  if (decision.spendMode === 'free_recorded') {
    return { transport: 'recorded', label: 'claude-code', budget: '0 USD (claude-code, blind)' };
  }
  // AXI-1857: mirror `transportLabelFor` — only a stated `registered_live` is
  // `live`; an allowed decision with no spend mode is never presumed paid or free.
  if (decision.spendMode !== 'registered_live') {
    return {
      transport: decision.transport ?? 'unknown',
      label: 'none',
      budget: 'unknown — the decision stated no spend mode; do NOT read it as free',
    };
  }
  return {
    transport: decision.transport ?? 'live',
    label: 'live',
    budget: `paid — see REGISTRY.md row ${decision.rowId ?? 'unregistered'}`,
    ...(decision.rowId ? { registryRowId: decision.rowId } : {}),
  };
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
  /** AXI-1716 — what the serving backend said about its own transport, verbatim. */
  readonly transport: HarnessTransportStatement;
  /** AXI-1716 — the run's own record of how its answers were obtained (label + budget). */
  readonly provenance: ShadowRunProvenance;
  readonly questionIds: readonly number[];
  readonly abortedAtQuestionId?: number;
  /**
   * AXI-1830 — who answered each question the run actually ASKED, keyed by
   * question id (absent for a guard-refused or 400-aborted question). Kept
   * BESIDE the rows, never on them, because the row key set is a closed
   * contract with `axiome-back`; it exists so `shadowRunEvidenceVerdict` can
   * tell the provider under test answering from the deterministic arm
   * answering in its place.
   */
  readonly responseFacts: Readonly<Record<number, ShadowRunResponseFacts>>;
}

/** AXI-1830 — the three response fields that say which arm answered a question. */
export interface ShadowRunResponseFacts {
  readonly planner?: string;
  readonly plannerFallback: boolean;
  readonly fallbackReason?: string;
}

/** AXI-1830 — pure. The facts `shadowRunEvidenceVerdict` needs, read off one response. */
export function responseFactsOf(body: PlanApiBody): ShadowRunResponseFacts {
  return {
    ...(typeof body.planner === 'string' ? { planner: body.planner } : {}),
    plannerFallback: body.plannerFallback === true,
    ...(typeof body.fallbackReason === 'string' ? { fallbackReason: body.fallbackReason } : {}),
  };
}

/**
 * The sidecar's content: the result minus its rows and minus the AXI-1830
 * response-facts side table (an in-process input to the evidence verdict, not
 * part of the `<provider>.run.json` artefact `axiome-back` reads).
 */
export type ShadowRunSummary = Omit<ShadowRunResult, 'rows' | 'responseFacts'>;

/**
 * AXI-1865 — the hard budget cap for one paid run, decided BEFORE any call.
 * The harness captures no token usage (`ShadowRunRow.usage` is always null), so
 * spend cannot be measured after the fact. Instead the cap is a fail-closed
 * worst case: `questionCount x SHADOW_RUN_MAX_USD_PER_QUESTION` must not exceed
 * `SHADOW_RUN_BUDGET_USD`. Unset cap ⇒ no cap (free/recorded runs). Pure.
 */
export interface BudgetCapDecision {
  readonly allowed: boolean;
  readonly reason: 'no_cap' | 'within_cap' | 'over_cap' | 'missing_per_question' | 'invalid';
  readonly worstCaseUsd?: number;
  readonly capUsd?: number;
}

const MICRO_USD = 1_000_000;

export function decideBudgetCap(
  env: Record<string, string | undefined>,
  questionCount: number,
): BudgetCapDecision {
  const capRaw = env.SHADOW_RUN_BUDGET_USD?.trim();
  if (!capRaw) return { allowed: true, reason: 'no_cap' };
  const cap = Number(capRaw);
  if (!Number.isFinite(cap) || cap <= 0) return { allowed: false, reason: 'invalid', capUsd: cap };
  const perRaw = env.SHADOW_RUN_MAX_USD_PER_QUESTION?.trim();
  const per = Number(perRaw);
  if (!perRaw || !Number.isFinite(per) || per <= 0) {
    return { allowed: false, reason: 'missing_per_question', capUsd: cap };
  }
  // Integer micro-USD arithmetic so 10 x 0.103 compares exactly against 1.03.
  const worstMicro = questionCount * Math.round(per * MICRO_USD);
  const worstCaseUsd = worstMicro / MICRO_USD;
  if (worstMicro <= Math.round(cap * MICRO_USD)) {
    return { allowed: true, reason: 'within_cap', worstCaseUsd, capUsd: cap };
  }
  return { allowed: false, reason: 'over_cap', worstCaseUsd, capUsd: cap };
}

export interface GuardedShadowRunOptions extends ShadowRunOptions {
  /** Defaults to `process.env`; injectable so the policy is unit-testable. */
  readonly env?: Record<string, string | undefined>;
  /** Defaults to the file `SHADOW_RUN_REGISTRY_PATH` names; injectable likewise. */
  readonly registryText?: string;
  /**
   * AXI-1716. Defaults to asking the backend this run is about to hit
   * (`readBackendTransportMode`); injectable ONLY so the policy is unit-testable
   * without a running stack. A live run never passes it — and passing it is not
   * a bypass either, because a unit test is not a run: nothing here reads a
   * transport claim out of the environment, which is the vector that matters.
   */
  readonly transport?: HarnessTransportStatement;
}

/** The HTTP status that aborts a run: the provider (or the gateway) rejected the request itself. */
const BAD_REQUEST = 400;

function notAnsweredRow(
  questionId: number,
  provider: string,
  reason: ShadowRunNotAnsweredReason,
  transport?: ShadowRunTransport,
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
    transport,
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
  // AXI-1716: the backend's own statement first, then the FR116 guard. An
  // unreachable backend yields `unknown` and falls through to the guard
  // unchanged — never to a free pass.
  const transport = opts.transport ?? (await probeTransport(auth, workspaceId));
  const guard = decideHarnessBankRun(env, registryText, transport);
  const provenance = shadowRunProvenanceOf(guard);
  const rowTransport = transportLabelFor(guard);
  const bankName = env.SHADOW_RUN_BANK?.trim() || 'grados';
  if (bankName !== 'grados' && bankName !== 'riaz') {
    throw new Error(`SHADOW_RUN_BANK: '${bankName}' is not a known bank (grados | riaz)`);
  }
  const bank = bankName === 'riaz' ? loadRiazBank() : loadGradosBank();
  const questions = selectQuestions(bank, env.SHADOW_RUN_QUESTIONS);
  const questionIds = questions.map((q) => q.id);
  const budget = decideBudgetCap(env, questionIds.length);

  const context = { guard, transport, provenance, questionIds };
  if (!guard.allowed || !budget.allowed) {
    const rows = questionIds.map((id) => notAnsweredRow(id, provider, 'guard'));
    return { ...context, rows, status: 'refused', responseFacts: {} };
  }
  const asked = await askSelectedQuestions(auth, workspaceId, projectId, provider, datasets, questions, {
    reauthEveryQuestions: opts.reauthEveryQuestions,
    rowTransport,
  });
  return { ...context, ...asked, status: asked.abortedAtQuestionId === undefined ? 'complete' : 'INVALID' };
}

interface AskedQuestions {
  readonly rows: ShadowRunRow[];
  readonly responseFacts: Record<number, ShadowRunResponseFacts>;
  readonly abortedAtQuestionId?: number;
}

/**
 * The allowed run's question loop, split out of `runShadowBankGuarded`
 * (AXI-1830) so the response-facts side table is collected in the same pass
 * as the rows. Aborts on the first HTTP 400 (FR50): the 400'd question and
 * every one after it become `not_answered: aborted`.
 */
async function askSelectedQuestions(
  auth: ShadowRunAuth,
  workspaceId: string,
  projectId: string,
  provider: string,
  datasets: Parameters<typeof buildEnvelope>[2],
  questions: ReadonlyArray<{ id: number; question: string }>,
  opts: { reauthEveryQuestions?: number; rowTransport?: ShadowRunTransport },
): Promise<AskedQuestions> {
  const every = opts.reauthEveryQuestions ?? DEFAULT_REAUTH_EVERY_QUESTIONS;
  const rows: ShadowRunRow[] = [];
  const responseFacts: Record<number, ShadowRunResponseFacts> = {};
  for (const [index, q] of questions.entries()) {
    if (every > 0 && index > 0 && index % every === 0) await auth.refresh();
    const envelope = buildEnvelope(projectId, q.question, datasets);
    const attempt = await planWithRefresh(auth, workspaceId, projectId, q.id, envelope);
    if (attempt.status === BAD_REQUEST) {
      for (const rest of questions.slice(index)) rows.push(notAnsweredRow(rest.id, provider, 'aborted', opts.rowTransport));
      return { rows, responseFacts, abortedAtQuestionId: q.id };
    }
    responseFacts[q.id] = responseFactsOf(attempt.body ?? {});
    rows.push(rowOf(q.id, provider, attempt, opts.rowTransport));
  }
  return { rows, responseFacts };
}

// ─── AXI-1830 (epic AXI-1825) — a run the provider never answered is not green ─
//
// THE DEFECT. The AXI-1614 spec asserted only `rows.length === questionIds.length`
// — one row per selected question, whatever the row said. The FR113 recorded
// first pass (2026-09-28) came back 9 of 9 `fallback` with
// `fallbackReason: provider_not_configured` in ~70 ms (the compiled arm could
// not reach the recorded transport without a key, AXI-1821) and the spec passed
// green. Every sibling of that run passed the same way: a guard-refused run
// (every row `not_answered: guard`), a run aborted on a 400 (`INVALID`), a run of
// nothing but `recording_missing` or HTTP errors, and a backend serving a
// DIFFERENT arm than the run's label (`GUIDED_ANALYSIS_LLM_PROVIDER=fallback`
// plans every question deterministically with `plannerFallback: false`, so
// every row reads `planned`). Each one measured nothing about the provider
// under test.
//
// THE RULE. `shadowRunEvidenceVerdict` is the spec's pass/fail, written as a
// pure function so it is unit-tested without a backend. The spec still writes
// the artefacts FIRST (an honest record of a failed run is still a record —
// FR115 counts it as a run), then fails with the verdict's message.

/** `PlanResponse.planner` of the deterministic arm (`DeterministicPlannerAdapter.name`). */
export const DETERMINISTIC_PLANNER = 'fallback';

/**
 * The ONE fallback token that means the provider was asked and answered: every
 * answer was rejected through the whole repair budget (`attempts_exhausted`,
 * `PLANNER_FALLBACK_REASONS` in `axiome-back`). `provider_unavailable`,
 * `provider_not_configured`, `provider_request_invalid` and an absent reason
 * all mean no answer came back from the provider.
 */
const PROVIDER_ANSWERED_FALLBACK_REASON = 'attempts_exhausted';

/** Outcomes that carry no planner answer at all, whatever the response said. */
const NO_ANSWER_OUTCOMES: ReadonlySet<ShadowRunOutcome> = new Set(['unavailable', 'not_answered']);

/**
 * Pure. Did the provider under test answer this row's question?
 *
 * Decided from the RESPONSE FACTS, never from `row.outcome` alone: `outcomeOf`
 * ranks `intentUnsupported` above `plannerFallback`, so a deterministic
 * fallback that refused its declared scope (AXI-1730) reads `unsupported` —
 * a row that looks like a planner verdict but came from the fallback arm.
 *
 * - `unavailable` / `not_answered` — no.
 * - a fallback — only when its reason is `attempts_exhausted`.
 * - otherwise — only when the arm that planned it IS the provider under test
 *   (an absent `planner` is not evidence against it).
 */
export function providerAnswered(
  row: ShadowRunRow,
  facts: ShadowRunResponseFacts | undefined,
  provider: string,
): boolean {
  if (NO_ANSWER_OUTCOMES.has(row.outcome) || !facts) return false;
  if (facts.plannerFallback) return facts.fallbackReason === PROVIDER_ANSWERED_FALLBACK_REASON;
  return facts.planner === undefined || facts.planner === provider;
}

export type ShadowRunEvidenceFailure =
  | 'guard_refused'
  | 'run_invalid'
  | 'provider_not_configured'
  | 'arm_mismatch'
  | 'no_provider_answer';

export type ShadowRunEvidenceVerdict =
  | { readonly ok: true; readonly answered: number; readonly total: number }
  | {
      readonly ok: false;
      readonly failure: ShadowRunEvidenceFailure;
      readonly answered: number;
      readonly total: number;
      readonly message: string;
    };

type VerdictInput = Pick<ShadowRunResult, 'rows' | 'status' | 'guard' | 'abortedAtQuestionId' | 'responseFacts'>;

/**
 * Pure. One label per row for the failure message — the outcome qualified by
 * its `notAnsweredReason`, its fallback reason, or the arm that planned it —
 * counted, in bank order: e.g. `fallback:provider_not_configured×9`.
 */
export function tallyShadowRunOutcomes(
  rows: readonly ShadowRunRow[],
  responseFacts: Readonly<Record<number, ShadowRunResponseFacts>>,
): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const facts = responseFacts[row.questionId];
    const qualifier = row.notAnsweredReason ?? (facts?.plannerFallback ? facts.fallbackReason ?? 'no reason' : facts?.planner);
    const label = qualifier ? `${row.outcome}:${qualifier}` : row.outcome;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${label}×${n}`).join(', ') || 'no rows';
}

/**
 * Pure. Is this run evidence about `provider`, the arm under test? Checked most
 * specific first, so the message names the real cause:
 *
 * 1. `guard_refused` — no call was made at all (FR53).
 * 2. `run_invalid` — a 400 aborted the run (FR50); INVALID by definition,
 *    however many questions answered before the abort.
 * 3. `provider_not_configured` — ANY response fell back for this reason: the
 *    serving backend has no working provider for the arm (the 2026-09-28 FR113
 *    first pass). A deployment fact, not a per-question one — one is enough.
 * 4. `arm_mismatch` — ANY non-fallback response was planned by an arm other
 *    than `provider`: the backend is configured with a different
 *    `GUIDED_ANALYSIS_LLM_PROVIDER` than this run's `SHADOW_RUN_PROVIDER` label,
 *    so every row is labelled with an arm that did not produce it.
 * 5. `no_provider_answer` — the provider answered zero questions (every row
 *    `unavailable`, `recording_missing`, `provider_unavailable`, …).
 *
 * A run where the provider answered at least one question, however badly, is
 * `ok`: scoring HOW WELL it answered is the gate's job, not this spec's.
 */
export function shadowRunEvidenceVerdict(result: VerdictInput, providerLabel: string): ShadowRunEvidenceVerdict {
  // Planner names are lower-case (`planner.factory.ts`); `shouldRunArm` already
  // reads `SHADOW_RUN_PROVIDER` case-insensitively, so this does too.
  const provider = providerLabel.trim().toLowerCase();
  const { rows, responseFacts } = result;
  const total = rows.length;
  const answered = rows.filter((r) => providerAnswered(r, responseFacts[r.questionId], provider)).length;
  const failure = evidenceFailureOf(result, provider, answered);
  if (!failure) return { ok: true, answered, total };
  const message =
    `shadow run is not evidence about provider '${provider}' (${failure}): ` +
    `${EVIDENCE_FAILURE_TEXT[failure](result, provider)} The provider answered ${answered} of ${total} ` +
    `selected question(s); outcomes: ${tallyShadowRunOutcomes(rows, responseFacts)}.`;
  return { ok: false, failure, answered, total, message };
}

function evidenceFailureOf(
  result: VerdictInput,
  provider: string,
  answered: number,
): ShadowRunEvidenceFailure | undefined {
  const facts = Object.values(result.responseFacts);
  if (result.status === 'refused') return 'guard_refused';
  if (result.status === 'INVALID') return 'run_invalid';
  if (facts.some((f) => f.plannerFallback && f.fallbackReason === 'provider_not_configured')) {
    return 'provider_not_configured';
  }
  if (facts.some((f) => !f.plannerFallback && f.planner !== undefined && f.planner !== provider)) return 'arm_mismatch';
  return answered === 0 ? 'no_provider_answer' : undefined;
}

/** The arms that planned a non-fallback response, for the `arm_mismatch` message. */
function servingArmsOf(result: VerdictInput): string {
  const arms = new Set(
    Object.values(result.responseFacts)
      .filter((f) => !f.plannerFallback && f.planner !== undefined)
      .map((f) => f.planner as string),
  );
  return [...arms].map((a) => `'${a}'`).join(', ');
}

const EVIDENCE_FAILURE_TEXT: Record<ShadowRunEvidenceFailure, (result: VerdictInput, provider: string) => string> = {
  guard_refused: (r) =>
    `the live-spend guard refused the run before any call (${r.guard.reason}) — every row is not_answered: guard.`,
  run_invalid: (r) => `the run aborted on an HTTP 400 at question ${r.abortedAtQuestionId ?? '?'} (FR50) and is INVALID.`,
  provider_not_configured: () =>
    'the serving backend answered from the deterministic fallback with fallbackReason=provider_not_configured — ' +
    'the arm under test has no working provider (check GUIDED_ANALYSIS_LLM_PROVIDER and the transport on organization-service).',
  arm_mismatch: (r, provider) =>
    `the serving backend planned with ${servingArmsOf(r)}, not '${provider}' — SHADOW_RUN_PROVIDER does not match ` +
    "the backend's GUIDED_ANALYSIS_LLM_PROVIDER, so every row would be labelled with an arm that did not produce it.",
  no_provider_answer: () =>
    'not one selected question was answered by the provider under test. A recording_missing row means: author the ' +
    'pending recording (llm-debug:record) and re-run; a fallback/unavailable row means the provider could not be reached.',
};

/**
 * The run's sidecar (`<provider>.run.json`): status, guard decision and subset,
 * beside the rows.
 *
 * AXI-1716 — and, since this story, its `transport` and `provenance`. Both are
 * REQUIRED by the parameter type, so a caller cannot write a summary that omits
 * how the run's answers were obtained: an artefact silent about its transport is
 * one a later reader can mistake for a paid run.
 * `axiome-back`'s `generate-shadow-report.ts` reads this file's `provenance`
 * verbatim into the report's own provenance section.
 */
export function writeShadowRunSummary(
  provider: string,
  result: ShadowRunSummary,
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

/**
 * Writes the raw rows a run produced to a per-provider JSON artifact.
 *
 * AXI-1749 (B2): `filenameSuffix` is OPTIONAL and defaults to `''`, so every
 * existing caller keeps writing the fixed `<provider>.json` it always has
 * (`AXI-1677-synthetic-grados-seed.spec.ts`'s own call is untouched). A
 * caller running a NAMED subset (`SHADOW_RUN_QUESTIONS`, a Haiku smoke run
 * against three questions rather than the full bank) passes one so its rows
 * land beside, never overwriting, a prior full-bank `compiled.json` —
 * `harness/shadow.ts`'s own header already warns `compiled.json` is not a
 * valid frozen corpus for exactly this reason.
 */
export function writeShadowRunRows(
  provider: string,
  rows: readonly ShadowRunRow[],
  filenameSuffix = '',
): string {
  const path = join(
    process.cwd(),
    'tests',
    'AXI-1462',
    'harness',
    'shadow-run',
    `${provider}${filenameSuffix}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows, null, 2), 'utf8');
  return path;
}
