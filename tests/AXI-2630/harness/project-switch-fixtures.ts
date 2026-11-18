import { workspaceHeader, type Api } from '../../AXI-1400/harness/api';
import { person, unique, type Person } from '../../AXI-2308/harness/result-page';

/**
 * AXI-2656 (epic AXI-2630) — self-provisioned fixtures for the project-switch-follows-page
 * E2E spec. Every org/workspace/project is additive (created by the admin fixture, never a
 * seeded/shared one) and thrown away on `dispose`. Mirrors the established self-registration
 * pattern (`tests/AXI-2308/harness/result-page.ts#person`, `tests/AXI-2265/private-projects-
 * fixtures.ts`): a throwaway identity's password is set by the fixture at registration time,
 * never read from any shared/seeded account's credentials.
 */

export const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';

export interface FixtureWorkspace {
  id: string;
  name: string;
  orgId: string;
  headers: Record<string, string>;
}

export interface FixtureProject {
  id: string;
  name: string;
}

/** The admin's own first organization — same lookup `PrivateProjectsWorld.create()` uses. */
async function adminOrgId(api: Api): Promise<string> {
  const res = await api.get<{ data?: Array<{ id: string }> }>('/api/v1/organizations?limit=1');
  const org = (Array.isArray(res.body) ? res.body : res.body?.data)?.[0];
  if (!org?.id) throw new Error(`AXI-2656 fixture: no organization visible to admin (${res.status})`);
  return org.id as string;
}

/** A throwaway workspace under the admin's own organization. */
export async function createWorkspace(api: Api, label: string): Promise<FixtureWorkspace> {
  const orgId = await adminOrgId(api);
  const name = unique(`AXI-2656 ${label}`);
  const res = await api.post<{ id: string }>('/api/v1/workspaces', { name, type: 'internal', ownerOrganizationId: orgId });
  if (res.status >= 300) throw new Error(`AXI-2656 fixture: create workspace ${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return { id: res.body.id, name, orgId, headers: workspaceHeader(res.body.id) };
}

/** A throwaway project inside `ws`. */
export async function createProject(api: Api, ws: FixtureWorkspace, label: string): Promise<FixtureProject> {
  const name = unique(`AXI-2656 ${label}`);
  const res = await api.post<{ id: string }>('/api/v1/projects', { name, workspaceId: ws.id }, ws.headers);
  if (res.status >= 300) throw new Error(`AXI-2656 fixture: create project ${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
  return { id: res.body.id, name };
}

/** Adds `p` to `ws` holding the workspace-scoped Investigator role. */
export async function addInvestigator(api: Api, ws: FixtureWorkspace, p: Person): Promise<void> {
  const res = await api.post(`/api/v1/workspaces/${ws.id}/members`, { userId: p.userId, organizationId: ws.orgId, roleId: INVESTIGATOR_ROLE_ID }, ws.headers);
  if (res.status >= 300) throw new Error(`AXI-2656 fixture: add investigator to ${ws.id} -> ${res.status}: ${JSON.stringify(res.body)}`);
}

/** A throwaway self-registered person (own, fixture-set password — never a shared account's). */
export async function investigatorPerson(label: string, ws: FixtureWorkspace): Promise<Person> {
  return person(label, ws.id);
}
