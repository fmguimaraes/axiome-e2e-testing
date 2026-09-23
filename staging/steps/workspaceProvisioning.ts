import { ADMIN_HANDLE, SERVICE_HANDLE, recordTouched } from './context';
import { ensureServiceIsWorkspaceMember } from './workspaceMembership';
import type { ProvisioningContext } from './context';
import type { WorkspaceFixture } from '../fixtures/types';

interface WorkspaceSummary {
  id: string;
  name: string;
  ownerOrganizationId?: string | null;
}

/**
 * AXI-1587 bounce (live incident): `ensure-organization` finds `ctx.orgId`
 * by an exact NAME match on the org (`findOrganizationByName`). The org can
 * drift out from under that name entirely independent of this fixture — a
 * live incident renamed the shared demo tenant's org from "Biotech One" to
 * "Meridian Oncology" (a website-screenshot branding pass, unrelated to
 * this pipeline) between one run and the next. `ensure-organization` has no
 * way to detect that: the name search comes up empty, so it creates a
 * BRAND NEW org, and every workspace looked up afterwards is scoped to that
 * new, wrong `ownerOrganizationId` — `findWorkspaceByExactName`'s filter
 * then misses the real workspace by construction (it is owned by the
 * renamed org, not the new one), and `ensureWorkspace` dutifully creates a
 * SECOND duplicate workspace + project + re-ingested datasets under it.
 *
 * Fix: `resolveWorkspaceMatch` — if the org-scoped lookup misses, fall back
 * to a name-only lookup across ALL orgs (mirroring `resolveTenant` in
 * `stageRiazGuided.ts`, which never hit this bug because it never scopes by
 * org at all). If that finds the workspace, it is authoritative: adopt its
 * actual `ownerOrganizationId` onto `ctx.orgId` instead of creating a
 * duplicate under the freshly (wrongly) created org. This makes reuse
 * survive an org rename that happens entirely outside this fixture's
 * control, without this file needing to know the org's current name.
 */
export function resolveWorkspaceMatch(
  scoped: WorkspaceSummary | undefined,
  anyOrg: WorkspaceSummary | undefined,
): { workspace: WorkspaceSummary; adoptOrgId: string | null } | undefined {
  if (scoped) return { workspace: scoped, adoptOrgId: null };
  if (anyOrg) return { workspace: anyOrg, adoptOrgId: anyOrg.ownerOrganizationId ?? null };
  return undefined;
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
  const names = [fixture.name, ...fixture.legacyNames];
  const scoped = await findWorkspace(ctx, names);
  const anyOrg = scoped ? undefined : await findWorkspaceAnyOrg(ctx, names);
  const match = resolveWorkspaceMatch(scoped, anyOrg);
  if (match) {
    if (match.adoptOrgId && match.adoptOrgId !== ctx.orgId) {
      recordTouched(ctx, { kind: 'organization', name: '(adopted from existing workspace, org rename drift)', id: match.adoptOrgId, action: 'reused' });
      ctx.orgId = match.adoptOrgId;
    }
    return reuseWorkspace(ctx, fixture, match.workspace);
  }
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

/**
 * Org-rename-drift fallback (AXI-1587) — same lookup, no `ownerOrganizationId`
 * filter, paginated like `resolveTenant` (`stageRiazGuided.ts`) since a
 * plain `search=` match can span more than one page in a shared demo tenant.
 * Only called once the org-scoped lookup has already missed.
 */
async function findWorkspaceAnyOrg(ctx: ProvisioningContext, candidateNames: string[]): Promise<WorkspaceSummary | undefined> {
  const names = new Set(candidateNames);
  for (let page = 1; page <= 5; page++) {
    const res = await ctx.client.as<{ data: WorkspaceSummary[] }>(ADMIN_HANDLE, 'GET', `/api/v1/workspaces?limit=100&page=${page}`);
    const rows = res.body?.data ?? [];
    const match = rows.find((w) => names.has(w.name));
    if (match) return match;
    if (rows.length < 100) break;
  }
  return undefined;
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
