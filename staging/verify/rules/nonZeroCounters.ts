import { SERVICE_HANDLE } from '../../steps/context';
import { assertGovernanceCounterNonZero } from '../../steps/governanceEventsStaging';
import { pass, fail } from '../types';
import type { ProvisioningContext } from '../../steps/context';
import type { RuleResult } from '../types';

/**
 * Capture Spec §2.3/AC13 — "no counter on any captured screen reads zero".
 * Reuses `governanceEventsStaging.ts`'s `assertGovernanceCounterNonZero`
 * (AXI-1379) for the governance-events half, and widens the same live
 * `/home/metrics` read to the other three counters that same endpoint
 * carries (active projects, ingestion jobs, QC jobs) — every counter FR14/
 * AC13 says must never read zero on a captured screen, not just the one.
 */
const RULE = 'Capture Spec §2.3/AC13 — no counter reads zero';

interface HomeMetrics {
  activeProjectsCount: number;
  ingestionJobsCount: number;
  qcJobsCount: number;
  governanceEventsCount: number;
  windowDays: number;
}

export async function checkNonZeroCounters(ctx: ProvisioningContext): Promise<RuleResult> {
  const res = await ctx.client.as<HomeMetrics>(SERVICE_HANDLE, 'GET', '/api/v1/home/metrics');
  if (!res.ok || !res.body) return fail(RULE, `GET /home/metrics failed (status ${res.status})`);
  return evaluateCounters(res.body);
}

/** Pure — exported for unit testing. */
export function evaluateCounters(metrics: HomeMetrics): RuleResult {
  const governanceProblem = describeGovernanceCounterProblem(metrics);
  if (governanceProblem) return fail(RULE, governanceProblem);
  const zero = findZeroCounters(metrics);
  if (zero.length > 0) return fail(RULE, `zero-valued counter(s): ${zero.join(', ')}`);
  return pass(
    RULE,
    `activeProjects=${metrics.activeProjectsCount} ingestionJobs=${metrics.ingestionJobsCount} ` +
      `qcJobs=${metrics.qcJobsCount} governanceEvents=${metrics.governanceEventsCount}`,
  );
}

function describeGovernanceCounterProblem(metrics: HomeMetrics): string | undefined {
  try {
    assertGovernanceCounterNonZero(metrics);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

function findZeroCounters(metrics: HomeMetrics): string[] {
  const checked: [string, number][] = [
    ['activeProjectsCount', metrics.activeProjectsCount],
    ['ingestionJobsCount', metrics.ingestionJobsCount],
    ['qcJobsCount', metrics.qcJobsCount],
  ];
  return checked.filter(([, v]) => v === 0).map(([k]) => k);
}
