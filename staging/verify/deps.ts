import { ADMIN_HANDLE } from '../steps/context';
import { resolveAttestationDeps } from '../steps/attestationStaging';
import { findExistingDataset } from '../steps/datasetIngestion';
import type { ProvisioningContext } from '../steps/context';
import type { DataRequirement, DatasetFixture } from '../fixtures/types';

/**
 * FR18 (AXI-1380) — dependency resolution shared by every rule check.
 * `verify` runs standalone (not chained after `stageTenant` in the same
 * process), so `ctx.orgId`/`ctx.workspaceIdByFixtureName` start empty —
 * unlike `stage.ts`'s steps, this module NEVER creates or renames anything
 * to fill them in. It re-derives them with the SAME live lookups
 * `ensureOrganizationStep`/`ensureWorkspacesStep` use (ADMIN-scoped list
 * routes, AXI-1371 finding), minus their create/rename fallback: `verify`
 * runs against an ALREADY-staged tenant, so "not found live" here is a real
 * finding to report, never something to fix by creating it (NFR3: no
 * mutation from a verification tool).
 */
export interface VerifyDeps {
  workspaceId: string;
  projectId: string;
  analysisId: string;
  deTableDatasetId: string;
  datasetIdByRole: Map<DataRequirement, string>;
}

export async function resolveVerifyDeps(ctx: ProvisioningContext): Promise<VerifyDeps> {
  await resolveLiveContext(ctx);
  const base = await resolveAttestationDeps(ctx);
  if (!base) throw new Error('no de_table dataset declared in the fixture — nothing to verify');
  const datasetIdByRole = await resolveDatasetIdsByRole(ctx, base.workspaceId, ctx.fixture.content.datasets);
  return { workspaceId: base.workspaceId, projectId: base.projectId, analysisId: base.analysisId, deTableDatasetId: base.datasetId, datasetIdByRole };
}

/** Read-only population of `ctx.orgId`/`ctx.workspaceIdByFixtureName` —
 *  exported for unit testing of the pure lookups it's built from is not
 *  possible (it's all network), so it stays thin and is exercised live. */
async function resolveLiveContext(ctx: ProvisioningContext): Promise<void> {
  ctx.orgId = await requireOrgId(ctx);
  for (const ws of ctx.fixture.workspaces) {
    ctx.workspaceIdByFixtureName.set(ws.name, await requireWorkspaceIdLive(ctx, ws.name));
  }
}

async function requireOrgId(ctx: ProvisioningContext): Promise<string> {
  const name = ctx.fixture.org.name;
  const res = await ctx.client.as<{ data: { id: string; name: string }[] }>(ADMIN_HANDLE, 'GET', `/api/v1/organizations?search=${encodeURIComponent(name)}`);
  const found = res.body?.data.find((o) => o.name === name);
  if (!found) throw new Error(`organization "${name}" not found live — has the tenant been staged (npm run stage)?`);
  return found.id;
}

async function requireWorkspaceIdLive(ctx: ProvisioningContext, name: string): Promise<string> {
  const res = await ctx.client.as<{ data: { id: string; name: string }[] }>(ADMIN_HANDLE, 'GET', `/api/v1/workspaces?search=${encodeURIComponent(name)}&ownerOrganizationId=${ctx.orgId}`);
  const found = res.body?.data.find((w) => w.name === name);
  if (!found) throw new Error(`workspace "${name}" not found live — has the tenant been staged (npm run stage)?`);
  return found.id;
}

async function resolveDatasetIdsByRole(ctx: ProvisioningContext, workspaceId: string, datasets: DatasetFixture[]): Promise<Map<DataRequirement, string>> {
  const map = new Map<DataRequirement, string>();
  for (const d of datasets) {
    const found = await findExistingDataset(ctx, workspaceId, d.originalFilename);
    if (found) map.set(d.role, found.id);
  }
  return map;
}
