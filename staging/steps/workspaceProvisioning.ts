import { ADMIN_HANDLE, SERVICE_HANDLE, recordTouched } from './context';
import { ensureServiceIsWorkspaceMember } from './workspaceMembership';
import type { ProvisioningContext } from './context';
import type { WorkspaceFixture } from '../fixtures/types';

interface WorkspaceSummary {
  id: string;
  name: string;
}

/**
 * FR5/EC1 — find-or-rename-or-create one workspace. Lookup runs as ADMIN
 * because `GET /api/v1/workspaces` is scoped the same way organizations are
 * (empty for a caller with no relationship to the owning org — confirmed
 * live, AXI-1371); everything past discovery runs as `service`, once it has
 * been granted membership, so the actor of record for the actual rename/
 * create is the toolkit's own service account, not the bootstrap admin.
 */
export async function ensureWorkspace(ctx: ProvisioningContext, fixture: WorkspaceFixture): Promise<string> {
  const found = await findWorkspace(ctx, [fixture.name, ...fixture.legacyNames]);
  if (found) return reuseWorkspace(ctx, fixture, found);
  return createWorkspace(ctx, fixture);
}

async function reuseWorkspace(ctx: ProvisioningContext, fixture: WorkspaceFixture, found: WorkspaceSummary): Promise<string> {
  await ensureServiceIsWorkspaceMember(ctx, found.id);
  if (found.name !== fixture.name) await renameWorkspace(ctx, found.id, fixture.name);
  const action = found.name === fixture.name ? 'reused' : 'renamed';
  recordTouched(ctx, { kind: 'workspace', name: fixture.name, id: found.id, action });
  return found.id;
}

async function findWorkspace(ctx: ProvisioningContext, candidateNames: string[]): Promise<WorkspaceSummary | undefined> {
  for (const name of candidateNames) {
    const match = await findWorkspaceByExactName(ctx, name);
    if (match) return match;
  }
  return undefined;
}

async function findWorkspaceByExactName(ctx: ProvisioningContext, name: string): Promise<WorkspaceSummary | undefined> {
  const res = await ctx.client.as<{ data: WorkspaceSummary[] }>(
    ADMIN_HANDLE,
    'GET',
    `/api/v1/workspaces?search=${encodeURIComponent(name)}&ownerOrganizationId=${ctx.orgId}`,
  );
  return res.body?.data.find((w) => w.name === name);
}

async function renameWorkspace(ctx: ProvisioningContext, workspaceId: string, name: string): Promise<void> {
  const res = await ctx.client.as(SERVICE_HANDLE, 'PATCH', `/api/v1/workspaces/${workspaceId}`, { name });
  if (!res.ok) throw new Error(`renaming workspace ${workspaceId} to "${name}" failed (status ${res.status})`);
}

/** Fresh-instance path (AC1): no workspace exists at all yet under this org,
 *  so there is no membership to grant `service` before creation — ADMIN
 *  creates it, then `service` is added exactly as the reuse path adds it. */
async function createWorkspace(ctx: ProvisioningContext, fixture: WorkspaceFixture): Promise<string> {
  const res = await ctx.client.as<WorkspaceSummary>(ADMIN_HANDLE, 'POST', '/api/v1/workspaces', {
    name: fixture.name,
    type: fixture.type,
    ownerOrganizationId: ctx.orgId,
  });
  if (!res.ok || !res.body) throw new Error(`creating workspace "${fixture.name}" failed (status ${res.status})`);
  await ensureServiceIsWorkspaceMember(ctx, res.body.id);
  recordTouched(ctx, { kind: 'workspace', name: fixture.name, id: res.body.id, action: 'created' });
  return res.body.id;
}
