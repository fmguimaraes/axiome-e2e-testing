import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from '../../AXI-1400/harness/api';
import { sleep, workspaceHeader, asList } from '../../AXI-1400/harness/api';

/**
 * AXI-1474-validation (W5 E2E) — idempotent, REST-only seeding for the
 * Executable QC epic's dataset-referent scenarios (AXI-1482 §4.1-4.3).
 *
 * Reuses the `Api`/`adminApi` harness from AXI-1400 (cross-story-dir import is
 * an established convention in this suite) rather than duplicating it.
 *
 * `ProjectsService.linkDataset` materializes the project's `auto_default` view
 * analysis via a fire-and-forget call (AXI-1474-validation backend fix, not
 * awaited) — `ensureDefaultAnalysis` below polls for it instead of assuming it
 * exists the instant the link POST returns.
 */

export const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1474', 'fixtures');

export const NAMES = {
  org: 'Axiome Validation Org',
  workspace: 'Executable QC Validation',
  project: 'Executable QC Validation',
  refusalProject: 'Executable QC Validation — No Container',
  qcRuleCode: 'IMM-QC-01',
  fixture: 'qc_sample.csv',
};

export interface Tenant {
  orgId: string;
  workspaceId: string;
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
  return { orgId, workspaceId: workspaceId!, headers: workspaceHeader(workspaceId!) };
}

/** Reuse-or-create a named project in the validation workspace. */
export async function ensureProject(api: Api, t: Tenant, name: string): Promise<string> {
  const projects = await api.get(`/api/v1/projects?workspaceId=${t.workspaceId}&limit=100`, t.headers);
  const found = asList(projects.body).find((p: any) => p.name === name)?.id;
  if (found) return found;
  const res = await api.post('/api/v1/projects', { name, workspaceId: t.workspaceId }, t.headers);
  return res.body.id;
}

/** The seeded system QC rule (`IMM-QC-01`) — declarative, never authored here. */
export async function findQcRuleId(api: Api, t: Tenant): Promise<string> {
  const res = await api.get(`/api/v1/rules?search=${NAMES.qcRuleCode}&scope=system`, t.headers);
  const found = asList(res.body).find((r: any) => r.code === NAMES.qcRuleCode);
  if (!found) throw new Error(`seeded system rule ${NAMES.qcRuleCode} not found`);
  return found.id;
}

const INGEST_TIMEOUT_MS = 90_000;
const INGEST_POLL_MS = 2_000;

/** Ingest the QC fixture once, reused across scenarios (never re-uploaded). */
export async function ingestFixture(api: Api, t: Tenant): Promise<string> {
  const ws = t.workspaceId;
  const filename = NAMES.fixture;
  const existing = await api.get(`/api/v1/workspaces/${ws}/datasets?search=${encodeURIComponent(filename)}`, t.headers);
  const prior = asList(existing.body).find((d: any) => d.originalFilename === filename && d.availability === 'available');
  if (prior) return prior.id;

  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  const init = await api.post(`/api/v1/workspaces/${ws}/datasets`, {
    organizationId: t.orgId, originalFilename: filename, contentType: 'text/csv',
  }, t.headers);
  const datasetId = init.body.dataset.id;
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`presigned PUT of ${filename} failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${ws}/datasets/${datasetId}/finalize`, undefined, t.headers);
  if (fin.status >= 300) throw new Error(`finalize ${filename} failed (${fin.status})`);

  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await api.get(`/api/v1/workspaces/${ws}/datasets/${datasetId}`, t.headers);
    const status = d.body?.latestIngestion?.status;
    if (status === 'ready') return datasetId;
    if (status === 'failed') throw new Error(`ingestion of ${filename} failed`);
    await sleep(INGEST_POLL_MS);
  }
  throw new Error(`ingestion of ${filename} timed out`);
}

/** Link the dataset to the project and VERIFY it — the POST can fail silently. */
async function ensureLink(api: Api, t: Tenant, projectId: string, datasetId: string): Promise<void> {
  const linked = async () => {
    const res = await api.get(`/api/v1/projects/${projectId}/datasets`, t.headers);
    return asList(res.body).some((l: any) => l.datasetId === datasetId);
  };
  if (await linked()) return;
  await api.post(`/api/v1/projects/${projectId}/datasets`, { datasetId }, t.headers);
  if (!(await linked())) throw new Error(`dataset ${datasetId} did not link to project ${projectId}`);
}

const DEFAULT_ANALYSIS_TIMEOUT_MS = 30_000;
const DEFAULT_ANALYSIS_POLL_MS = 1_500;

const TERMINAL_RUN_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'DEDUPED']);

/** Poll a rule run to a terminal status. Lives here, not in the spec, because
 *  the spec-linter forbids a raw `sleep` in a `.spec.ts` file (NFR4). */
export async function pollRunTerminal(api: Api, t: Tenant, runId: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const rr = await api.get(`/api/v1/rule-runs/${runId}`, t.headers);
    if (TERMINAL_RUN_STATUSES.has(rr.body?.status)) return rr.body;
    await sleep(2000);
  }
  throw new Error(`run ${runId} did not reach a terminal status`);
}

/**
 * A re-run against the same referent DEDUPES (the seed's `ingestFixture` /
 * `ensureDefaultAnalysis` reuse-or-create pattern makes every scenario re-run
 * idempotent, so a second suite run legitimately dedupes onto the first).
 * Resolve the run the assertions must inspect: the original for a deduped
 * submission, otherwise the row itself.
 */
export async function resolveMaterialisedRow(api: Api, t: Tenant, row: any): Promise<any> {
  if (row.status !== 'DEDUPED') return row;
  const original = await api.get(`/api/v1/rule-runs/${row.dedupedFromRunId}`, t.headers);
  if (original.status >= 300 || !original.body?.id) {
    throw new Error(`could not resolve deduped original run ${row.dedupedFromRunId}`);
  }
  return original.body;
}

/**
 * Link the dataset to the project, then poll for the `auto_default` view
 * analysis `linkDataset`'s fire-and-forget call materializes (AXI-895,
 * restored by AXI-1474-validation) — it is not present the instant the link
 * POST returns.
 */
export async function ensureDefaultAnalysis(
  api: Api, t: Tenant, projectId: string, datasetId: string,
): Promise<string> {
  await ensureLink(api, t, projectId, datasetId);
  const deadline = Date.now() + DEFAULT_ANALYSIS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const list = await api.get(`/api/v1/view-analyses?projectId=${projectId}`, t.headers);
    const found = asList(list.body).find((a: any) => a.datasetId === datasetId && a.origin === 'auto_default');
    if (found) return found.id;
    await sleep(DEFAULT_ANALYSIS_POLL_MS);
  }
  throw new Error(`auto_default view analysis for dataset ${datasetId} in project ${projectId} did not appear`);
}
