import { RestClient } from '../client/RestClient';
import { assertFixtureValid } from '../fixtures/validateFixture';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import { ensureIdentities } from '../identities/ensureIdentities';
import { applyCastNamesStep } from './applyCastNamesStep';
import { SERVICE_HANDLE } from './context';
import { ensureDatasetStep } from './datasetIngestion';
import { ensureOrganizationStep } from './ensureOrganization';
import { ensureWorkspacesStep } from './ensureWorkspacesStep';
import { runSteps } from './runSteps';
import { verifyNoForbiddenNamesStep } from './verifyNoForbiddenNamesStep';
import type { ProvisioningContext, TouchedEntity } from './context';
import type { TenantFixture } from '../fixtures/types';

/**
 * `stage` (FR5/FR6/NFR1/NFR8/AC4/EC1, AXI-1371; FR7/AC5 dataset step added
 * AXI-1372) — provisions the demo tenant (org -> workspaces -> projects ->
 * dataset) from the content fixture, over REST only, converging idempotently
 * on re-run. Ordering is the declared step graph in `STEPS`, not call
 * sequence (dev-epic-context).
 */
const STEPS = [ensureOrganizationStep, ensureWorkspacesStep, ensureDatasetStep, applyCastNamesStep, verifyNoForbiddenNamesStep];

export async function stageTenant(client: RestClient, fixture: TenantFixture, adminEmail: string, adminPassword: string): Promise<TouchedEntity[]> {
  assertFixtureValid(fixture);
  const identities = await ensureIdentities(client, adminEmail, adminPassword);
  const serviceUserId = await resolveServiceUserId(client);
  const ctx = newContext(client, fixture, serviceUserId);
  await runSteps(STEPS, ctx);
  void identities; // identities.created/reused already logged by ensureIdentities itself
  return ctx.touched;
}

function newContext(client: RestClient, fixture: TenantFixture, serviceUserId: string): ProvisioningContext {
  return { client, fixture, serviceUserId, workspaceIdByFixtureName: new Map(), touched: [] };
}

async function resolveServiceUserId(client: RestClient): Promise<string> {
  const res = await client.as<{ id: string }>(SERVICE_HANDLE, 'GET', '/api/v1/auth/me');
  if (!res.ok || !res.body) throw new Error(`could not resolve "service" identity's user id (status ${res.status})`);
  return res.body.id;
}

async function main(): Promise<void> {
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const adminEmail = process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
  const adminPassword = process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin';

  const client = new RestClient({ baseUrl });
  const touched = await stageTenant(client, TENANT_FIXTURE, adminEmail, adminPassword);
  touched.forEach((t) => console.log(`[stage] ${t.action} ${t.kind} "${t.name}" (${t.id})`));
  console.log(`PASSED — stage converged, ${touched.length} entity action(s), AC4 clean.`);
}

if (process.argv[1] && process.argv[1].endsWith('stage.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
