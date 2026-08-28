import { RestClient } from '../client/RestClient';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import { assertFixtureValid } from '../fixtures/validateFixture';
import { ensureIdentities } from '../identities/ensureIdentities';
import { resolveVerifyDeps } from './deps';
import { checkCorpusConsistency } from './rules/corpusConsistency';
import { checkNonZeroCounters } from './rules/nonZeroCounters';
import { checkMultiAuthorThreads } from './rules/multiAuthorThreads';
import { checkChartCountAndOrigin } from './rules/chartCountOrigin';
import { checkGovernanceRecord } from './rules/governanceRecord';
import { checkThresholdsAndSnapshots } from './rules/thresholdsSnapshots';
import { checkAssumptionsCount } from './rules/assumptionsCount';
import { checkExternalScoping } from './rules/externalScoping';
import type { ProvisioningContext } from '../steps/context';
import type { TenantFixture } from '../fixtures/types';
import type { RuleResult } from './types';

/**
 * FR18/AC1 (AXI-1380, Capture Spec §18) — `verify`: asserts every Capture-
 * Spec consistency rule that is REST-checkable against the LIVE tenant, and
 * exits non-zero on any violation. Capture (AXI-1381) is gated on this
 * passing — "`verify` is a gate, not a report" (dev-epic-context).
 *
 * Read-only (NFR3/NFR4): every rule module issues GETs (plus the external-
 * scoping probes, themselves GETs, and one dataset `POST .../query` read),
 * nothing here creates, mutates or deletes anything — so `verify` is safe
 * to re-run any number of times against the same tenant and always
 * converges on the same report (NFR1 applied to a verification tool).
 *
 * DELIBERATELY NOT ASSERTED HERE (honest scope, see the story report):
 *  - AC4 (no forbidden/leaked names) — already a hard gate at STAGE time
 *    (`verifyNoForbiddenNamesStep`, over the in-memory touched-entity list a
 *    live-only `verify` run does not have); re-deriving it from live org/
 *    workspace/project names is a reasonable follow-up, not built here.
 *  - Capture Spec §15.1's full 8-kind/3-author governance-FEED variety —
 *    `governanceEventsStaging.ts` (AXI-1379) already confirmed only 2 of 8
 *    kinds are backend-projected into any REST-readable feed; `verify`
 *    asserts what IS achievable (every `/home/metrics` counter, including
 *    `governanceEventsCount`, is non-zero) and does not hard-assert feed
 *    variety the backend cannot currently produce.
 *  - Capture Spec §18's purely visual/browser rules (2400px @2x export,
 *    light theme, identical window size, no browser chrome, no blur) — not
 *    REST-observable at all; they are AXI-1381 capture-harness
 *    preconditions (FR19), not a `verify` concern.
 */
export async function runVerify(ctx: ProvisioningContext): Promise<RuleResult[]> {
  const deps = await resolveVerifyDeps(ctx);
  return Promise.all([
    checkCorpusConsistency(ctx, deps),
    checkNonZeroCounters(ctx),
    checkMultiAuthorThreads(ctx, deps),
    checkChartCountAndOrigin(ctx, deps),
    checkGovernanceRecord(ctx, deps),
    checkThresholdsAndSnapshots(ctx, deps),
    checkAssumptionsCount(ctx, deps),
    checkExternalScoping(ctx, deps),
  ]);
}

/** Pure — exported for unit testing (proves the gate fails closed). */
export function allPass(results: RuleResult[]): boolean {
  return results.every((r) => r.pass);
}

function report(results: RuleResult[]): void {
  results.forEach((r) => console.log(`[verify] ${r.pass ? 'PASS' : 'FAIL'} — ${r.rule}: ${r.detail}`));
}

function newContext(client: RestClient, fixture: TenantFixture): ProvisioningContext {
  return { client, fixture, serviceUserId: '', workspaceIdByFixtureName: new Map(), touched: [] };
}

async function main(): Promise<void> {
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const adminEmail = process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
  const adminPassword = process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin';

  assertFixtureValid(TENANT_FIXTURE);
  const client = new RestClient({ baseUrl });
  await ensureIdentities(client, adminEmail, adminPassword);
  const ctx = newContext(client, TENANT_FIXTURE);
  const results = await runVerify(ctx);
  report(results);

  if (!allPass(results)) {
    console.error(`FAILED — ${results.filter((r) => !r.pass).length}/${results.length} Capture Spec §18 rule(s) violated.`);
    process.exit(1);
  }
  console.log(`PASSED — all ${results.length} Capture Spec §18 rule(s) hold (FR18/AC1). Capture may proceed.`);
}

if (process.argv[1] && process.argv[1].endsWith('verify.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
