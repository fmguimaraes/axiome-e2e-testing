import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from '../../AXI-1400/harness/api';
import { sleep, workspaceHeader, asList } from '../../AXI-1400/harness/api';

/**
 * AXI-1234 (epic AXI-1233) — REST seeding for the freeze-rendered-chart-at-
 * citation-time validation surface. Reuses the same ingest/snapshot recipe as
 * AXI-1400/AXI-1640's harnesses (idempotent, additive, `uniq()`-safe names);
 * the fixture CSV is the small AXI-1640 one (`de_small.csv`) since this story
 * needs only a real dataset + real ViewAnalysisSnapshots — `FrozenChartRender`
 * carries no FK to a real DataviewSpec/chart.
 */

export const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1640', 'fixtures');
export const FIXTURE = 'de_small.csv';

export const NAMES = {
  org: 'AXI-1234 Freeze Render Org',
  workspace: 'AXI-1234 Freeze Render Validation',
  project: 'AXI-1234 Freeze Render Project',
};

export interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  datasetId: string;
  headers: Record<string, string>;
}

/** Short unique suffix so repeated runs never collide on names / fingerprints. */
export function uniq(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function findByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: any) => x.name === name)?.id;
}

async function ensureOrgAndWorkspace(api: Api): Promise<{ orgId: string; workspaceId: string }> {
  const orgId =
    (await findByName(api, '/api/v1/organizations', NAMES.org)) ??
    (await api.post('/api/v1/organizations', { name: NAMES.org, type: 'biotech' })).body.id;
  let workspaceId = await findByName(api, '/api/v1/workspaces', NAMES.workspace);
  if (!workspaceId) {
    const res = await api.post('/api/v1/workspaces', {
      name: NAMES.workspace, type: 'internal', ownerOrganizationId: orgId,
    });
    workspaceId = res.body.id;
  }
  return { orgId, workspaceId: workspaceId! };
}

async function ensureProject(api: Api, workspaceId: string, headers: Record<string, string>): Promise<string> {
  const projects = await api.get(`/api/v1/projects?workspaceId=${workspaceId}&limit=100`, headers);
  const found = asList(projects.body).find((p: any) => p.name === NAMES.project)?.id;
  if (found) return found;
  const res = await api.post('/api/v1/projects', { name: NAMES.project, workspaceId }, headers);
  return res.body.id;
}

const INGEST_TIMEOUT_MS = 90_000;

async function ingestFixture(
  api: Api, orgId: string, workspaceId: string, headers: Record<string, string>, filename: string,
): Promise<string> {
  const existing = await api.get(`/api/v1/workspaces/${workspaceId}/datasets?search=${encodeURIComponent(filename)}`, headers);
  const prior = asList(existing.body).find((d: any) => d.originalFilename === filename && d.availability === 'available');
  const waitReady = async (datasetId: string) => {
    const deadline = Date.now() + INGEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const d = await api.get(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`, headers);
      const status = d.body?.latestIngestion?.status;
      if (status === 'ready') return datasetId;
      if (status === 'failed') throw new Error(`ingestion of ${filename} failed`);
      await sleep(2_000);
    }
    throw new Error(`ingestion of ${filename} timed out`);
  };
  if (prior) return waitReady(prior.id);

  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  const init = await api.post(`/api/v1/workspaces/${workspaceId}/datasets`, {
    organizationId: orgId, originalFilename: filename, contentType: 'text/csv',
  }, headers);
  const datasetId = init.body.dataset.id;
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`presigned PUT of ${filename} failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/finalize`, undefined, headers);
  if (fin.status >= 300) throw new Error(`dataset finalize ${filename} failed (${fin.status})`);
  return waitReady(datasetId);
}

/** Idempotent org + workspace + project + ingested dataset. */
export async function ensureTenant(api: Api): Promise<Tenant> {
  const { orgId, workspaceId } = await ensureOrgAndWorkspace(api);
  const headers = workspaceHeader(workspaceId);
  const projectId = await ensureProject(api, workspaceId, headers);
  const datasetId = await ingestFixture(api, orgId, workspaceId, headers, FIXTURE);
  return { orgId, workspaceId, projectId, datasetId, headers };
}

/** Create a fresh ViewAnalysis (one per test run, named uniquely — never reused). */
export async function createAnalysis(api: Api, t: Tenant, name: string): Promise<string> {
  const res = await api.post('/api/v1/view-analyses', { projectId: t.projectId, datasetId: t.datasetId, name }, t.headers);
  if (res.status >= 300) throw new Error(`create view-analysis failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.id;
}

/** Create a snapshot of an analysis with the given filters (distinct filters → distinct snapshot ids). */
export async function createSnapshot(
  api: Api, t: Tenant, analysisId: string, filters: Array<{ column: string; operator: string; value?: unknown }>,
): Promise<string> {
  const res = await api.post('/api/v1/view-analyses/snapshots', { viewAnalysisId: analysisId, filters }, t.headers);
  if (res.status >= 300) throw new Error(`create snapshot failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.id;
}

/** A minimal, deterministic-shape `frozenRender` payload for a chart entry. */
export function frozenRenderPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    dataviewSpecId: `spec-${uniq()}`,
    datasetVersionId: overrides.datasetVersionId ?? `dsv-${uniq()}`,
    templateId: 'scatter_v1',
    templateVersion: '1',
    bindings: { x: 'baseMean', y: 'log2FoldChange' },
    params: {},
    payloadJson: { data: [{ type: 'scatter', x: [1, 2], y: [3, 4] }], layout: {} },
    ...overrides,
  };
}
