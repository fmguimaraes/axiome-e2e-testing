import type { ProvisioningContext } from './context';
import type { CastMemberFixture } from '../fixtures/types';
import type { Step } from './types';

/**
 * FR6 (cast identities) — applies each cast member's Capture Spec §3 display
 * name onto the AXI-1370 identity it belongs to, self-service via
 * `PATCH /api/v1/auth/profile` (each identity updates its own profile — no
 * admin call, no change to `ensureIdentities()`'s auth logic). Idempotent by
 * construction: PATCH-ing the same name twice converges to the same state
 * (NFR1), so no "already applied" check is needed.
 */
export const applyCastNamesStep: Step<ProvisioningContext> = {
  id: 'apply-cast-names',
  dependsOn: [],
  async run(ctx) {
    for (const member of ctx.fixture.cast) await applyCastName(ctx, member);
  },
};

async function applyCastName(ctx: ProvisioningContext, member: CastMemberFixture): Promise<void> {
  const res = await ctx.client.as(member.handle, 'PATCH', '/api/v1/auth/profile', {
    firstName: member.displayFirstName,
    lastName: member.displayLastName,
  });
  if (!res.ok) throw new Error(`applying cast display name for "${member.handle}" failed (status ${res.status})`);
}
