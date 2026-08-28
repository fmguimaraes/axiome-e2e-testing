import { ADMIN_HANDLE, recordTouched } from './context';
import type { ProvisioningContext } from './context';
import type { Step } from './types';

/**
 * FR5 — find-or-create the tenant organization. Organization list/get is
 * ADMIN-scoped at the gateway (a non-admin caller's `GET /organizations`
 * returns an empty list even for an org it created itself — confirmed live,
 * AXI-1371) so this step runs as `ADMIN_HANDLE`, bounded to exactly the
 * lookup-then-maybe-create pair, matching AXI-1370's precedent for
 * unavoidable admin-gated bootstrap calls (FR2 deviation).
 */
export const ensureOrganizationStep: Step<ProvisioningContext> = {
  id: 'ensure-organization',
  dependsOn: [],
  async run(ctx) {
    const existingId = await findOrganizationByName(ctx, ctx.fixture.org.name);
    if (existingId) {
      ctx.orgId = existingId;
      recordTouched(ctx, { kind: 'organization', name: ctx.fixture.org.name, id: existingId, action: 'reused' });
      return;
    }
    const created = await createOrganization(ctx);
    ctx.orgId = created;
    recordTouched(ctx, { kind: 'organization', name: ctx.fixture.org.name, id: created, action: 'created' });
  },
};

async function findOrganizationByName(ctx: ProvisioningContext, name: string): Promise<string | undefined> {
  const res = await ctx.client.as<{ data: { id: string; name: string }[] }>(
    ADMIN_HANDLE,
    'GET',
    `/api/v1/organizations?search=${encodeURIComponent(name)}`,
  );
  return res.body?.data.find((o) => o.name === name)?.id;
}

async function createOrganization(ctx: ProvisioningContext): Promise<string> {
  const { name, type } = ctx.fixture.org;
  const res = await ctx.client.as<{ id: string }>(ADMIN_HANDLE, 'POST', '/api/v1/organizations', { name, type });
  if (!res.ok || !res.body) throw new Error(`organization "${name}" creation failed (status ${res.status})`);
  return res.body.id;
}
