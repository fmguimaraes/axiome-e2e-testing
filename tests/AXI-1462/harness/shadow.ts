import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Api } from '../../AXI-1435/harness/api';
import { workspaceHeader } from '../../AXI-1435/harness/api';
import { loadGradosBank, buildEnvelope } from './governed';

/**
 * AXI-1614 (epic AXI-1603 — FR28, AC21, SI-042). The shadow harness: extends the
 * existing Grados-corpus harness (`governed.ts`) to run the bank once against
 * whichever `GUIDED_ANALYSIS_LLM_PROVIDER` the caller says the backend is
 * currently configured with, and write the raw per-question rows the
 * `axiome-back` aggregation script
 * (`guided-analysis/plan/compile/shadow-report/generate-shadow-report.ts`)
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

export type ShadowRunOutcome = 'planned' | 'fallback' | 'unsupported' | 'refused' | 'unavailable';

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
}

interface PlanApiBody {
  plan?: {
    nodes?: Array<{ nodeType?: string; params?: Record<string, unknown> }>;
    attemptCount?: number;
  };
  plannerFallback?: boolean;
  intentUnsupported?: boolean;
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

function outcomeOf(body: PlanApiBody, status: number): ShadowRunOutcome {
  if (status >= 300 || !body.plan) return 'unavailable';
  if (body.intentUnsupported) return 'unsupported';
  if (body.plannerFallback) return 'fallback';
  return 'planned';
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
 */
export async function runShadowBank(
  api: Api,
  workspaceId: string,
  projectId: string,
  provider: string,
  datasets: Parameters<typeof buildEnvelope>[2],
): Promise<ShadowRunRow[]> {
  const bank = loadGradosBank();
  const rows: ShadowRunRow[] = [];
  for (const q of bank) {
    const envelope = buildEnvelope(projectId, q.question, datasets);
    const startedAt = Date.now();
    const res = await api.post<PlanApiBody>(
      '/api/v1/guided-analysis/plan',
      { projectId, envelope },
      workspaceHeader(workspaceId),
    );
    const latencyMs = Date.now() - startedAt;
    rows.push({
      questionId: q.id,
      provider,
      outcome: outcomeOf(res.body, res.status),
      attempts: res.body.plan?.attemptCount ?? 1,
      ruleIdsPerAttempt: [],
      shape: shapeOf(res.body.plan),
      latencyMs,
      usage: null,
      correlationId: correlationIdOf(res.body),
    });
  }
  return rows;
}

/** Writes the raw rows a run produced to a fixed, per-provider JSON artifact. */
export function writeShadowRunRows(provider: string, rows: readonly ShadowRunRow[]): string {
  const path = join(process.cwd(), 'tests', 'AXI-1462', 'harness', 'shadow-run', `${provider}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rows, null, 2), 'utf8');
  return path;
}
