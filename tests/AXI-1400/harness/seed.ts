import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from './api';
import { sleep, workspaceHeader, asList } from './api';

/**
 * Idempotent, REST-only seeding for the Statistical Surface validation project.
 * Every helper is reuse-or-create by a stable name/code so the spec is safe to
 * re-run against the shared demo DB (it only ever appends an additive project).
 *
 * The creation sequence and its non-obvious ordering were verified live against
 * the demo before this file existed:
 *  - a dataset must be LINKED to the project (and the link POST checked — it can
 *    fail silently) BEFORE the semantic profile is assigned, because assigning
 *    the profile recomputes field-mappings over the project's *linked* datasets;
 *  - `POST /api/v1/rule-runs` needs `datasetId` even when a `snapshotId` referent
 *    is supplied (input-source validation), and `workspaceId` for object-level
 *    auth on a scoped run;
 *  - a statistical run needs a *published* rule; publish enforces protocol
 *    compliance, so the rule is authored as a FEATURE_RULE with its two required
 *    output fields (the run never consumes them — the rule is the governance
 *    wrapper, exactly as the demo's own paired_ttest reused a published QC rule).
 */

export const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1400', 'fixtures');

export const NAMES = {
  org: 'Axiome Validation Org',
  workspace: 'Statistical Surface Validation',
  project: 'Statistical Surface Validation',
  ruleCode: 'AXI-1400-STATSURFACE-E2E',
  profileId: 'immuno_oncology',
};

export interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  ruleId: string;
  headers: Record<string, string>;
}

async function findByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: any) => x.name === name)?.id;
}

export async function ensureTenant(api: Api): Promise<Tenant> {
  const orgId = (await findByName(api, '/api/v1/organizations', NAMES.org))
    ?? (await api.post('/api/v1/organizations', { name: NAMES.org, type: 'biotech' })).body.id;

  let workspaceId = await findByName(api, '/api/v1/workspaces', NAMES.workspace);
  if (!workspaceId) {
    const res = await api.post('/api/v1/workspaces', {
      name: NAMES.workspace, type: 'internal', ownerOrganizationId: orgId,
    });
    workspaceId = res.body.id;
  }
  const headers = workspaceHeader(workspaceId!);

  const projects = await api.get(`/api/v1/projects?workspaceId=${workspaceId}&limit=100`, headers);
  let projectId = asList(projects.body).find((p: any) => p.name === NAMES.project)?.id;
  if (!projectId) {
    const res = await api.post('/api/v1/projects', { name: NAMES.project, workspaceId }, headers);
    projectId = res.body.id;
  }

  const ruleId = await ensureRule(api, workspaceId!, projectId!, headers);
  return { orgId, workspaceId: workspaceId!, projectId: projectId!, ruleId, headers };
}

/** Reuse-or-create a published FEATURE_RULE governance wrapper for the runs. */
async function ensureRule(api: Api, workspaceId: string, projectId: string, headers: Record<string, string>): Promise<string> {
  const existing = await api.get(`/api/v1/rules?search=${NAMES.ruleCode}`, headers);
  const found = asList(existing.body).find((r: any) => r.code === NAMES.ruleCode && r.status === 'published');
  if (found) return found.id;

  const created = await api.post('/api/v1/rules', {
    code: NAMES.ruleCode, title: 'Statistical Surface Validation',
    workspaceId, projectId, protocolType: 'FEATURE_RULE',
  }, headers);
  const ruleId = created.body.id;
  await api.patch(`/api/v1/rules/${ruleId}`, {
    outputFields: [
      { key: 'feature_name', type: 'string', description: 'feature' },
      { key: 'value', type: 'number', description: 'value' },
    ],
  }, headers);
  const pub = await api.post(`/api/v1/rules/${ruleId}/publish`, {}, headers);
  if (pub.status >= 300) throw new Error(`rule publish failed (${pub.status}): ${JSON.stringify(pub.body)}`);
  return ruleId;
}

const INGEST_TIMEOUT_MS = 90_000;
const INGEST_POLL_MS = 2_000;

/** Ingest one fixture CSV and link it to the project (link POST is verified). */
export async function ingestFixture(api: Api, t: Tenant, filename: string): Promise<string> {
  const ws = t.workspaceId;
  const existing = await api.get(`/api/v1/workspaces/${ws}/datasets?search=${encodeURIComponent(filename)}`, t.headers);
  const prior = asList(existing.body).find((d: any) => d.originalFilename === filename && d.availability === 'available');
  const datasetId = prior ? prior.id : await uploadAndFinalize(api, t, filename);
  await ensureLink(api, t, datasetId);
  return datasetId;
}

async function uploadAndFinalize(api: Api, t: Tenant, filename: string): Promise<string> {
  const ws = t.workspaceId;
  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  const init = await api.post(`/api/v1/workspaces/${ws}/datasets`, {
    organizationId: t.orgId, originalFilename: filename, contentType: 'text/csv',
  }, t.headers);
  const datasetId = init.body.dataset.id;
  const presignedUrl = init.body.presignedUrl;
  const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`presigned PUT of ${filename} failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${ws}/datasets/${datasetId}/finalize`, undefined, t.headers);
  if (fin.status >= 300) throw new Error(`finalize ${filename} failed (${fin.status})`);
  await waitForIngestion(api, t, datasetId, filename);
  return datasetId;
}

async function waitForIngestion(api: Api, t: Tenant, datasetId: string, filename: string): Promise<void> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}`, t.headers);
    const status = d.body?.latestIngestion?.status;
    if (status === 'ready') return;
    if (status === 'failed') throw new Error(`ingestion of ${filename} failed`);
    await sleep(INGEST_POLL_MS);
  }
  throw new Error(`ingestion of ${filename} timed out`);
}

/** Link the dataset to the project and VERIFY it — the POST can fail silently. */
async function ensureLink(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const linked = async () => {
    const res = await api.get(`/api/v1/projects/${t.projectId}/datasets`, t.headers);
    return asList(res.body).some((l: any) => l.datasetId === datasetId);
  };
  if (await linked()) return;
  await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
  if (!(await linked())) throw new Error(`dataset ${datasetId} did not link to project ${t.projectId}`);
}

/** Assign the semantic profile (after datasets are linked) and confirm the
 *  canonical fields the semantic role sources need are matched. */
export async function assignProfileAndVerify(api: Api, t: Tenant, requiredCanonicals: string[]): Promise<void> {
  await api.patch(`/api/v1/projects/${t.projectId}/profile`, { profileId: NAMES.profileId }, t.headers);
  // The mapping recompute is asynchronous, so poll until the canonicals the
  // semantic role sources need are matched (bounded).
  const deadline = Date.now() + 30_000;
  let matched = new Set<string>();
  while (Date.now() < deadline) {
    const res = await api.get(`/api/v1/projects/${t.projectId}/field-mappings`, t.headers);
    const mappings = asList(res.body);
    matched = new Set(mappings.filter((m: any) => m.status === 'matched').map((m: any) => m.canonicalField));
    if (requiredCanonicals.every((c) => matched.has(c))) return;
    await sleep(1_500);
  }
  const missing = requiredCanonicals.filter((c) => !matched.has(c));
  throw new Error(`semantic mapping missing after profile assignment: ${missing.join(', ')}`);
}

export interface Analysis { analysisId: string; snapshotId: string; }

/** Create (or reuse by name) an analysis on a dataset, returning a single
 *  reused empty-filter referent snapshot to run against.
 *
 *  Referent snapshots are REUSED, not recreated: an explicit POST creates a new
 *  snapshot version every call, so seeding on each spec re-run piled up
 *  identical empty-filter referents (Snapshot v1, v2, v7 …). Because re-runs
 *  dedup against whichever referent was latest, the newest one ended up childless
 *  — a "lot of snapshots, no rule result" artifact in the provenance graph. One
 *  stable referent per analysis keeps the graph to input → referent → results. */
export async function ensureAnalysis(api: Api, t: Tenant, name: string, datasetId: string): Promise<Analysis> {
  const list = await api.get(`/api/v1/view-analyses?projectId=${t.projectId}`, t.headers);
  const found = asList(list.body).find((a: any) => a.name === name);
  const analysisId = found ? found.id : (await api.post('/api/v1/view-analyses', { projectId: t.projectId, datasetId, name }, t.headers)).body.id;

  // Reuse an existing empty-filter base snapshot if one exists; only create when none does.
  const existing = await api.get(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`, t.headers);
  const base = asList(existing.body).find((s: any) => s.origin === 'filter' && (s.filters == null || s.filters.length === 0));
  const snapshotId = base ? base.id
    : (await api.post('/api/v1/view-analyses/snapshots', { viewAnalysisId: analysisId, filters: [] }, t.headers)).body.id;
  return { analysisId, snapshotId };
}
