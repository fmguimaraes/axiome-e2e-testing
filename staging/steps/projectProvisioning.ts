import { SERVICE_HANDLE, recordTouched } from './context';
import type { ProvisioningContext } from './context';
import type { ProjectFixture } from '../fixtures/types';

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
}

/**
 * FR5 — find-or-rename-or-create one project. Runs entirely as `service`:
 * by this point `service` already holds workspace membership (granted in
 * `ensureWorkspace`), and `/api/v1/projects/*` accepts workspace-member
 * callers directly — no ADMIN needed here, unlike organization/workspace
 * discovery. Every `/api/v1/projects/*` call requires an `X-Workspace-Id`
 * header (confirmed live, AXI-1371) in addition to `workspaceId` in a
 * create body; {@link projectHeaders} is the one place that's built.
 */
export async function ensureProject(ctx: ProvisioningContext, workspaceId: string, fixture: ProjectFixture): Promise<void> {
  const projects = await listProjects(ctx, workspaceId);
  const found = [fixture.name, ...fixture.legacyNames].map((n) => projects.find((p) => p.name === n)).find(Boolean);
  if (found) return reuseProject(ctx, workspaceId, fixture, found);
  await createProject(ctx, workspaceId, fixture);
}

async function reuseProject(ctx: ProvisioningContext, workspaceId: string, fixture: ProjectFixture, found: ProjectSummary): Promise<void> {
  if (found.name !== fixture.name) await renameProject(ctx, workspaceId, found.id, fixture.name);
  const action = found.name === fixture.name ? 'reused' : 'renamed';
  recordTouched(ctx, { kind: 'project', name: fixture.name, id: found.id, action });
}

export async function listProjects(ctx: ProvisioningContext, workspaceId: string): Promise<ProjectSummary[]> {
  const res = await ctx.client.as<{ data: ProjectSummary[] }>(SERVICE_HANDLE, 'GET', `/api/v1/projects?workspaceId=${workspaceId}`);
  return res.body?.data ?? [];
}

export async function renameProject(ctx: ProvisioningContext, workspaceId: string, projectId: string, name: string): Promise<void> {
  const res = await ctx.client.as(SERVICE_HANDLE, 'PATCH', `/api/v1/projects/${projectId}`, { name }, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`renaming project ${projectId} to "${name}" failed (status ${res.status})`);
}

async function createProject(ctx: ProvisioningContext, workspaceId: string, fixture: ProjectFixture): Promise<void> {
  const body = { name: fixture.name, workspaceId };
  const res = await ctx.client.as<{ id: string }>(SERVICE_HANDLE, 'POST', '/api/v1/projects', body, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`creating project "${fixture.name}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'project', name: fixture.name, id: res.body.id, action: 'created' });
}

export function projectHeaders(workspaceId: string): Record<string, string> {
  return { 'X-Workspace-Id': workspaceId };
}
