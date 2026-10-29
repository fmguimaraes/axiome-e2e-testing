import { boundedMessage } from './abort';
import type { ApiClient } from './api-client';
import type { ResolvedFixture } from './fixtures';
import type { PlannedCase } from './run-plan';

/**
 * AXI-2318 — the case-execution SEAM. This story builds the infrastructure
 * that orders, executes and reports the daily cases; WHETHER a case passes is
 * AXI-2319's pass rule (FR31: Paul's methods against the reproduction targets +
 * R parity; every other active rule = run SUCCEEDED + default chart renders).
 *
 * AXI-2319 supplies a {@link CaseExecutor}; until it lands the suite runs with
 * {@link recordOnlyExecutor}, which records each planned case as
 * `not-evaluated` with a reason — never `pass` (a placeholder must not read as
 * a green result). An executor that throws is recorded as `error` for that case
 * and the run continues to the next case: one broken rule never hides the rest.
 */

export type CaseOutcome = 'pass' | 'fail' | 'error' | 'not-evaluated';

export const CASE_OUTCOMES: readonly CaseOutcome[] = ['pass', 'fail', 'error', 'not-evaluated'];

/** Flat, scalar facts only (run id, status, chart rendered…) — never a body dump (NFR3). */
export type CaseFacts = Record<string, string | number | boolean | null>;

export interface CaseResult {
  outcome: CaseOutcome;
  reason: string | null;
  facts: CaseFacts;
}

export interface CaseContext {
  client: ApiClient;
  organizationId: string;
  workspaceId: string;
  fixtures: ResolvedFixture[];
}

export type CaseExecutor = (planned: PlannedCase, ctx: CaseContext) => Promise<CaseResult>;

export interface ExecutedCase extends PlannedCase, CaseResult {}

export const NOT_EVALUATED_REASON = 'pass rule not implemented yet (AXI-2319)';

export const recordOnlyExecutor: CaseExecutor = async () => ({
  outcome: 'not-evaluated',
  reason: NOT_EVALUATED_REASON,
  facts: {},
});

async function runOne(planned: PlannedCase, ctx: CaseContext, executor: CaseExecutor): Promise<ExecutedCase> {
  try {
    const result = await executor(planned, ctx);
    return { ...planned, outcome: result.outcome, reason: result.reason, facts: { ...result.facts } };
  } catch (err) {
    return { ...planned, outcome: 'error', reason: boundedMessage(err), facts: {} };
  }
}

/** Run every planned case IN PLAN ORDER (Paul's methods first, FR30), sequentially. */
export async function runCases(cases: PlannedCase[], ctx: CaseContext, executor: CaseExecutor): Promise<ExecutedCase[]> {
  const ordered = [...cases].sort((a, b) => a.order - b.order);
  const executed: ExecutedCase[] = [];
  for (const planned of ordered) executed.push(await runOne(planned, ctx, executor));
  return executed;
}
