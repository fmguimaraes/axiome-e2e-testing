import { RestClient } from '../staging/client/RestClient';
import { TENANT_FIXTURE } from '../staging/fixtures/tenantFixture';
import { assertFixtureValid } from '../staging/fixtures/validateFixture';
import { ensureIdentities } from '../staging/identities/ensureIdentities';
import { allPass, runVerify } from '../staging/verify/verify';
import type { ProvisioningContext } from '../staging/steps/context';
import type { RuleResult } from '../staging/verify/types';

/**
 * FR18 gate — capture MUST run `verify` first and ABORT if it fails.
 * "`verify` is a gate, not a report" (dev-epic-context): a staged tenant
 * that violates a Capture Spec §18 rule must not be capturable at all, so
 * this call happens before a single browser is launched.
 *
 * In-process (imports `runVerify` directly) rather than shelling out to
 * `npm run verify` — same rule set, same exit semantics, no process-spawn
 * flakiness, and it stays a plain async function `runCapture.ts` can await.
 */
export async function runVerifyGate(baseUrl: string, adminEmail: string, adminPassword: string): Promise<RuleResult[]> {
  assertFixtureValid(TENANT_FIXTURE);
  const client = new RestClient({ baseUrl });
  await ensureIdentities(client, adminEmail, adminPassword);
  const ctx = newContext(client);
  const results = await runVerify(ctx);
  assertGatePasses(results);
  return results;
}

/** Pure — exported for unit testing the fail-closed behaviour without a live server. */
export function assertGatePasses(results: RuleResult[]): void {
  if (!allPass(results)) {
    const failures = results.filter((r) => !r.pass).map((r) => `${r.rule}: ${r.detail}`);
    throw new Error(`capture ABORTED — verify gate failed (FR18): ${failures.join(' | ')}`);
  }
}

function newContext(client: RestClient): ProvisioningContext {
  return { client, fixture: TENANT_FIXTURE, serviceUserId: '', workspaceIdByFixtureName: new Map(), touched: [] };
}
