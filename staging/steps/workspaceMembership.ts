import { ADMIN_HANDLE, recordTouched } from './context';
import type { ProvisioningContext } from './context';

interface WorkspaceMember {
  userId: string;
  role?: string;
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

/**
 * FR9 (AXI-1373) — grant `handle` a specific workspace role so its framing
 * calls (`FRAMING_ADD_ASSUMPTION` etc.) pass `WorkspacePermissionGuard`.
 * Generalizes `ensureServiceIsWorkspaceMember` above (role fixed to
 * 'admin') to an arbitrary handle/role pair. Idempotent (NFR1): a no-op once
 * `handle` already holds `role`; promotes/demotes in place otherwise rather
 * than adding a second membership row.
 */
export async function ensureMemberRole(
  ctx: ProvisioningContext,
  workspaceId: string,
  handle: string,
  role: string,
): Promise<void> {
  const userId = await resolveUserId(ctx, handle);
  const existing = await findMember(ctx, workspaceId, userId);
  if (existing?.role === role) return;
  if (existing) return updateMemberRole(ctx, workspaceId, userId, role);
  await addMember(ctx, workspaceId, userId, role);
  recordTouched(ctx, { kind: 'membership', name: `${handle}@${workspaceId}`, id: userId, action: 'granted' });
}

async function resolveUserId(ctx: ProvisioningContext, handle: string): Promise<string> {
  const res = await ctx.client.as<{ id: string }>(handle, 'GET', '/api/v1/auth/me');
  if (!res.ok || !res.body) throw new Error(`could not resolve identity "${handle}"'s user id (status ${res.status})`);
  return res.body.id;
}

async function findMember(ctx: ProvisioningContext, workspaceId: string, userId: string): Promise<WorkspaceMember | undefined> {
  const res = await ctx.client.as<{ members: WorkspaceMember[] }>(ADMIN_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}`);
  return (res.body?.members ?? []).find((m) => m.userId === userId);
}

async function updateMemberRole(ctx: ProvisioningContext, workspaceId: string, userId: string, role: string): Promise<void> {
  const res = await ctx.client.as(ADMIN_HANDLE, 'PATCH', `/api/v1/workspaces/${workspaceId}/members/${userId}/role`, { role });
  if (!res.ok) throw new Error(`updating member ${userId}'s role to "${role}" on workspace ${workspaceId} failed (status ${res.status})`);
}

async function addMember(ctx: ProvisioningContext, workspaceId: string, userId: string, role: string): Promise<void> {
  const adminId = await adminUserId(ctx);
  const res = await ctx.client.as(ADMIN_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/members`, {
    userId,
    organizationId: ctx.orgId,
    role,
    invitedBy: adminId,
  });
  if (!res.ok) throw new Error(`granting "${userId}" role "${role}" on workspace ${workspaceId} failed (status ${res.status})`);
}
