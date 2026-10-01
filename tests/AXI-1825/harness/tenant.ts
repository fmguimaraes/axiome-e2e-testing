import type { Api } from '../../AXI-1435/harness/api';
import { workspaceHeader, asList } from '../../AXI-1435/harness/api';
import type { Tenant } from '../../AXI-1435/harness/seed';

/**
 * AXI-1832 (epic AXI-1825) — a DEDICATED, uniquely-named tenant for this
 * story's E2E, deliberately not `tests/AXI-1603/harness/planner.ts`'s
 * `ensureTenant1603()`.
 *
 * `ensureTenant1603` reuses an org/workspace by NAME across the shared demo
 * DB, and that epic's own repeated runs (plus this rework's debugging) have
 * left SEVERAL organizations and workspaces named identically ("AXI-1603 E2E
 * Org" / "AXI-1603 Intent-Compiled Planner") under different owning
 * identities. `findByName()`'s `.find()` on an unordered list picks whichever
 * one the API happens to list first — independently for the org and the
 * workspace — so a run can end up with an org/workspace pair that were never
 * created together, and a dataset-create call 403s with a body shaped
 * nothing like a dataset (`init.body.dataset` is `undefined`). Hit live
 * while authoring this spec. Rather than touch the shared AXI-1603 harness
 * (out of this story's file-ownership boundary) or add a second name that
 * could collide the same way, this story's org/workspace/project NAME is
 * unique to AXI-1832, so there is only ever one match.
 */
const NAMES = {
  org: 'AXI-1832 E2E Org',
  workspace: 'AXI-1832 Recording Missing Label',
  project: 'AXI-1832 Recording Missing Label',
};

async function findByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: any) => x.name === name)?.id;
}

export async function ensureTenant1832(api: Api): Promise<Tenant> {
  const orgId = (await findByName(api, '/api/v1/organizations', NAMES.org))
    ?? (await api.post('/api/v1/organizations', { name: NAMES.org, type: 'biotech' })).body.id;

  let workspaceId = await findByName(api, '/api/v1/workspaces', NAMES.workspace);
  if (!workspaceId) {
    const res = await api.post('/api/v1/workspaces', { name: NAMES.workspace, type: 'internal', ownerOrganizationId: orgId });
    workspaceId = res.body.id;
  }
  const headers = workspaceHeader(workspaceId!);

  const projects = await api.get(`/api/v1/projects?workspaceId=${workspaceId}&limit=100`, headers);
  let projectId = asList(projects.body).find((p: any) => p.name === NAMES.project)?.id;
  if (!projectId) {
    const res = await api.post('/api/v1/projects', { name: NAMES.project, workspaceId }, headers);
    projectId = res.body.id;
  }
  return { orgId, workspaceId: workspaceId!, projectId: projectId!, ruleIds: {}, headers };
}
