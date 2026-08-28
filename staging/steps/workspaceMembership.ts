import { ADMIN_HANDLE } from './context';
import type { ProvisioningContext } from './context';

interface WorkspaceMember {
  userId: string;
}

/**
 * A freshly-created workspace auto-adds its creator as an admin member
 * (organization-service, confirmed by the earlier route audit), but a
 * *reused* pre-existing workspace (Capture Spec §2.1's legacy-named ones)
 * was created by someone else — `service` has no membership and every
 * workspace-scoped route 500s for a non-member (confirmed live, AXI-1371).
 * This grant is bounded and idempotent: skipped once `service` is already a
 * member, so a second `stage` run makes zero admin-authenticated calls here
 * (NFR1).
 */
export async function ensureServiceIsWorkspaceMember(ctx: ProvisioningContext, workspaceId: string): Promise<void> {
  const isMember = await serviceIsMember(ctx, workspaceId);
  if (isMember) return;
  await addServiceAsMember(ctx, workspaceId);
}

async function serviceIsMember(ctx: ProvisioningContext, workspaceId: string): Promise<boolean> {
  const res = await ctx.client.as<{ members: WorkspaceMember[] }>(ADMIN_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}`);
  return (res.body?.members ?? []).some((m) => m.userId === ctx.serviceUserId);
}

async function addServiceAsMember(ctx: ProvisioningContext, workspaceId: string): Promise<void> {
  const adminId = await adminUserId(ctx);
  const res = await ctx.client.as(ADMIN_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/members`, {
    userId: ctx.serviceUserId,
    organizationId: ctx.orgId,
    role: 'admin',
    invitedBy: adminId,
  });
  if (!res.ok) throw new Error(`granting "service" membership on workspace ${workspaceId} failed (status ${res.status})`);
}

async function adminUserId(ctx: ProvisioningContext): Promise<string> {
  const res = await ctx.client.as<{ id: string }>(ADMIN_HANDLE, 'GET', '/api/v1/auth/me');
  if (!res.ok || !res.body) throw new Error(`could not resolve bootstrap admin's user id (status ${res.status})`);
  return res.body.id;
}
