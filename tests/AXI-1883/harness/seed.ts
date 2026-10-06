import type { Api } from './api';
import { workspaceHeader, asList } from './api';

/**
 * AXI-1893 (epic AXI-1883) — REST-only, idempotent-by-name fixtures for the
 * analysis lifecycle (delete/archive/unarchive) scenarios. Deliberately
 * minimal: a `ViewAnalysis` only needs a `datasetId` FK to a real `Dataset`
 * row (`view-analyses.service.ts#create` writes `createDto.datasetId`
 * straight through with no existence/availability check beyond the FK), so
 * this harness mints a dataset via the init-only `POST
 * /workspaces/:ws/datasets` call and never uploads/finalizes it — there is no
 * data to query, which this story's scenarios never need.
 */

export const NAMES = {
  org: 'Axiome E2E Org',
  workspace: 'AXI-1893 Analysis Lifecycle',
  project: 'AXI-1893 Analysis Lifecycle',
};

export interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  datasetId: string;
  headers: Record<string, string>;
}

async function findByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: any) => x.name === name)?.id;
}

async function ensureDataset(api: Api, t: { orgId: string; workspaceId: string; headers: Record<string, string> }): Promise<string> {
  const filename = 'AXI-1893-fixture.csv';
  const existing = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets?search=${encodeURIComponent(filename)}`, t.headers);
  const prior = asList(existing.body).find((d: any) => d.originalFilename === filename);
  if (prior) return prior.id;

  const init = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: filename, contentType: 'text/csv',
  }, t.headers);
  if (init.status >= 300) throw new Error(`dataset init failed (${init.status}): ${JSON.stringify(init.body)}`);
  return init.body.dataset.id;
}

export async function ensureTenant(api: Api): Promise<Tenant> {
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

  const datasetId = await ensureDataset(api, { orgId, workspaceId: workspaceId!, headers });
  return { orgId, workspaceId: workspaceId!, projectId: projectId!, datasetId, headers };
}

/** Create a uniquely-named fixture ViewAnalysis — never reused across specs,
 *  so a delete/archive side effect in one test can never leak into another. */
export async function createAnalysis(api: Api, t: Tenant, name: string): Promise<string> {
  const res = await api.post('/api/v1/view-analyses', { projectId: t.projectId, datasetId: t.datasetId, name }, t.headers);
  if (res.status >= 300) throw new Error(`create analysis "${name}" failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.id;
}

export async function fetchAnalysis(api: Api, t: Tenant, id: string): Promise<any> {
  const res = await api.get(`/api/v1/view-analyses/${id}`, t.headers);
  if (res.status >= 300) throw new Error(`fetch analysis ${id} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}
