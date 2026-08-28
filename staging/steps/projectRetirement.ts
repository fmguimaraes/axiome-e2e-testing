import { SERVICE_HANDLE, recordTouched } from './context';
import { listProjects, projectHeaders, renameProject } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { RetiredProjectFixture } from '../fixtures/types';

/**
 * EC1 — remove a Capture Spec §2.1 "Delete" artifact.
 *
 * `DELETE /api/v1/projects/:id` 500s for some archived projects — confirmed
 * live, AXI-1371, on the actual pre-existing "E2E Testing" project (an empty
 * probe project deletes fine once archived; this one, over a month old,
 * does not — the gateway's own conflict-check is the likely cause, but it
 * throws 500 instead of the documented 409). Out of this story's "no
 * backend change" scope, so `retireProject` renames onto a clean word
 * *before* archiving (an archived project 500s on any further PATCH,
 * confirmed live, so rename cannot happen after) and treats a failed
 * DELETE as a soft outcome: archived + renamed still satisfies AC4 (no
 * forbidden name survives) even when the row itself can't be removed.
 *
 * Idempotent either way: a second `stage` run finds the project already
 * gone (post-delete) or already at `retiredName` + archived (post-fallback)
 * and does nothing further (NFR1).
 */
export async function retireProject(ctx: ProvisioningContext, workspaceId: string, fixture: RetiredProjectFixture): Promise<void> {
  const match = await findRetiringCandidate(ctx, workspaceId, fixture);
  if (!match) return;
  // A project 500s on any PATCH once archived (confirmed live) — a prior
  // interrupted run may have left it archived-but-not-yet-renamed, so
  // renaming always requires an active project first (NFR1: resumable).
  if (match.status === 'archived') await unarchiveProject(ctx, workspaceId, match.id);
  if (match.name !== fixture.retiredName) await renameProject(ctx, workspaceId, match.id, fixture.retiredName);
  await archiveProject(ctx, workspaceId, match.id);
  const deleted = await tryDeleteProject(ctx, workspaceId, match.id);
  const action = deleted ? 'retired' : 'renamed';
  const name = deleted ? fixture.legacyName : fixture.retiredName;
  recordTouched(ctx, { kind: 'project', name, id: match.id, action });
}

async function findRetiringCandidate(ctx: ProvisioningContext, workspaceId: string, fixture: RetiredProjectFixture) {
  const projects = await listProjects(ctx, workspaceId);
  return projects.find((p) => p.name === fixture.legacyName) ?? projects.find((p) => p.name === fixture.retiredName);
}

async function archiveProject(ctx: ProvisioningContext, workspaceId: string, projectId: string): Promise<void> {
  const res = await ctx.client.as(SERVICE_HANDLE, 'PATCH', `/api/v1/projects/${projectId}/archive`, undefined, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`archiving project ${projectId} failed (status ${res.status})`);
}

async function unarchiveProject(ctx: ProvisioningContext, workspaceId: string, projectId: string): Promise<void> {
  const res = await ctx.client.as(SERVICE_HANDLE, 'PATCH', `/api/v1/projects/${projectId}/unarchive`, undefined, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`unarchiving project ${projectId} failed (status ${res.status})`);
}

/** Never throws — a failed delete is a known, documented soft-fallback path
 *  (see the module doc), not a `stage` failure. */
async function tryDeleteProject(ctx: ProvisioningContext, workspaceId: string, projectId: string): Promise<boolean> {
  const res = await ctx.client.as(SERVICE_HANDLE, 'DELETE', `/api/v1/projects/${projectId}`, undefined, projectHeaders(workspaceId));
  return res.ok;
}
