import { boundedMessage, ProdSuiteAbort } from './abort';
import type { ApiClient } from './api-client';
import { recordOnlyExecutor, runCases, type CaseExecutor, type ExecutedCase } from './cases';
import { safeRunId, type ProdSuiteConfig } from './config';
import { resolveFixtures, type ResolvedFixture } from './fixtures';
import { verifyIsolation } from './isolation-guard';
import { buildReport, type ProdSuiteReport } from './report';
import { buildRunPlan, fetchActiveCatalogue, type RunPlan } from './run-plan';

/**
 * AXI-2318 — the daily suite, phase by phase:
 *   isolation (EC9) → fixtures by ID (FR29) → plan (FR30) → cases → report (FR33).
 * Each phase runs only if the previous one succeeded. A {@link ProdSuiteAbort}
 * (or any unexpected error) stops the run and is RECORDED in the report, which
 * is always produced — an aborted run still lands in S3 so the admin page shows
 * the red day instead of a gap.
 */

export interface SuiteDeps {
  /** Log in and build the client — inside the suite, so a login failure is a recorded abort too. */
  connect: () => Promise<ApiClient>;
  config: ProdSuiteConfig;
  executor?: CaseExecutor;
  now?: () => Date;
}

interface Progress {
  testOrg: ProdSuiteReport['testOrg'];
  fixtures: ResolvedFixture[];
  plan: RunPlan | null;
  cases: ExecutedCase[];
}

async function runPhases(deps: SuiteDeps, p: Progress): Promise<void> {
  const { config } = deps;
  const client = await connectOrAbort(deps);
  p.testOrg = await verifyIsolation(client, config);
  p.fixtures = await resolveFixtures(client, config.workspaceId, config.fixtureIdsJson);
  p.plan = buildRunPlan(await fetchActiveCatalogue(client));
  const ctx = { client, organizationId: config.organizationId, workspaceId: config.workspaceId, fixtures: p.fixtures };
  p.cases = await runCases(p.plan.cases, ctx, deps.executor ?? recordOnlyExecutor);
}

async function connectOrAbort(deps: SuiteDeps): Promise<ApiClient> {
  try {
    return await deps.connect();
  } catch (err) {
    throw new ProdSuiteAbort('config', 'LOGIN_FAILED', `the test identity could not log in: ${boundedMessage(err)}`);
  }
}

function abortOf(err: unknown, p: Progress): ProdSuiteReport['abort'] {
  if (err instanceof ProdSuiteAbort) return { phase: err.phase, code: err.code, message: boundedMessage(err.detail) };
  const phase = !p.testOrg ? 'isolation' : p.fixtures.length === 0 ? 'fixtures' : !p.plan ? 'plan' : 'cases';
  const code = (err as { code?: string })?.code ?? 'UNEXPECTED_ERROR';
  return { phase, code, message: boundedMessage(err) };
}

/** Run the suite and return its report (never throws for a phase failure — the report says it). */
export async function runProdSuite(deps: SuiteDeps): Promise<ProdSuiteReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const p: Progress = { testOrg: null, fixtures: [], plan: null, cases: [] };
  let abort: ProdSuiteReport['abort'] = null;
  try {
    await runPhases(deps, p);
  } catch (err) {
    abort = abortOf(err, p);
  }
  const { runId, trigger, gitSha, targetLabel } = deps.config;
  return buildReport({
    run: { runId, trigger, gitSha, targetLabel, startedAt, finishedAt: now().toISOString() },
    abort, testOrg: p.testOrg, fixtures: p.fixtures, plan: p.plan, cases: p.cases,
  });
}

/** The report of a run that could not even read its configuration (still published, never silent). */
export function configAbortReport(missing: string[], env: Record<string, string | undefined>, now = new Date()): ProdSuiteReport {
  const at = now.toISOString();
  return buildReport({
    run: {
      runId: safeRunId(env.PROD_E2E_RUN_ID?.trim() ?? '', now), trigger: env.GITHUB_EVENT_NAME?.trim() || 'local',
      gitSha: env.GITHUB_SHA?.trim() || null, targetLabel: env.PROD_E2E_TARGET_LABEL?.trim() || 'unlabelled',
      startedAt: at, finishedAt: at,
    },
    abort: { phase: 'config', code: 'CONFIG_MISSING', message: `missing: ${missing.join(', ')}` },
    testOrg: null, fixtures: [], plan: null, cases: [],
  });
}
