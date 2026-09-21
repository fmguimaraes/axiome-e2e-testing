import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from '../../AXI-1400/harness/api';
import { sleep, workspaceHeader, asList } from '../../AXI-1400/harness/api';

/**
 * AXI-1531 (epic AXI-1507 — FR27, AC-DEMO) — REST-only seeding for the discovery
 * composition (AXI-1516) scenarios D.7/D.8/D.9. Reuses the `Api`/`adminApi`
 * harness from AXI-1400, exactly as AXI-1474's own harness does (an established
 * cross-story-dir convention in this suite) — never a second HTTP client.
 *
 * All requests here are THE SAME contract the front-end trigger
 * (`StartDiscoveryPlanModal`, axiome-front) calls: `POST /v1/discovery/*`. This
 * is deliberately additive-only seeding — no destructive step, and every
 * `ensure*` here is idempotent (reuse-or-create), like AXI-1474's own.
 */

export const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1507', 'fixtures');

export const NAMES = {
  org: 'Axiome Validation Org',
  workspace: 'Executable QC Validation',
  project: 'AXI-1531 Discovery Validation',
  // Fewer than the platform's v0 `min_sample_size` default (10) — a QC.rule_gate
  // `IMM-QC-01` evaluation of this referent verdicts `block` (D.9's third
  // paragraph: "a registered container whose IMM-QC-01 verdict is block").
  smallFixture: 'discovery_small.csv',
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

export async function ensureProject(api: Api, t: Tenant, name: string): Promise<string> {
  const projects = await api.get(`/api/v1/projects?workspaceId=${t.workspaceId}&limit=100`, t.headers);
  const found = asList(projects.body).find((p: any) => p.name === name)?.id;
  if (found) return found;
  const res = await api.post('/api/v1/projects', { name, workspaceId: t.workspaceId }, t.headers);
  return res.body.id;
}

const INGEST_TIMEOUT_MS = 90_000;
const INGEST_POLL_MS = 2_000;

/** Ingest a fixture once (by filename), reused across scenarios. */
export async function ingestFixture(api: Api, t: Tenant, filename: string): Promise<string> {
  const ws = t.workspaceId;
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

/** The dataset's real content hash — required verbatim by `InstantiateDiscoveryPlanDto`. */
export async function datasetVersionHash(api: Api, t: Tenant, datasetId: string): Promise<string> {
  const res = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}`, t.headers);
  const hash = res.body?.fileHash;
  if (!hash) throw new Error(`dataset ${datasetId} carries no fileHash yet`);
  return hash;
}

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

/** Link the dataset, then poll for its `auto_default` view analysis. */
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

/** A second, user-created analysis on the same dataset — an ordinary, non-default container. */
export async function createViewAnalysis(
  api: Api, t: Tenant, projectId: string, datasetId: string, name: string,
): Promise<string> {
  const res = await api.post('/api/v1/view-analyses', { projectId, datasetId, name }, t.headers);
  if (res.status >= 300) throw new Error(`view-analysis create failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.id;
}

/** The seven-field envelope, all declared with a value — D.1/D.6's "fully declared" shape. */
export function declaredEnvelopeFields(): Record<string, unknown> {
  const declared = (value: string) => ({ state: 'declared', value });
  return {
    tissue: declared('blood'),
    disease: declared('NSCLC'),
    panel: declared('panel-1'),
    gateDefinition: declared('gate-1'),
    denominator: declared('live_cells'),
    timepoint: declared('baseline'),
    cohort: declared('cohort-A'),
  };
}

/**
 * Idempotent bind: checks first rather than binding-and-catching-409. A live
 * probe against this suite's stack found the gateway maps the org-service's
 * `ConflictException` (an already-bound envelope) to a bare 500, not 409 — a
 * pre-existing defect in AXI-1516's `DiscoveryProxyController`, unrelated to
 * this story's front-end/REST-consumer change, routed to the epic lead rather
 * than fixed here. Checking first keeps this harness's own idempotency off
 * that defective path entirely.
 */
export async function bindEnvelope(api: Api, t: Tenant, viewAnalysisId: string): Promise<{ status: number; body: any }> {
  const existing = await api.get(`/api/v1/discovery/analyses/${viewAnalysisId}/envelope`, t.headers);
  if (existing.body) return existing;
  return api.post(
    `/api/v1/discovery/analyses/${viewAnalysisId}/envelope`,
    { viewAnalysisId, fields: declaredEnvelopeFields() },
    t.headers,
  );
}

/**
 * Declares the split thresholds (undeclared by default, and required even when
 * `takeSplit: false` — the composition refuses an INCOMPLETE config, not only a
 * config missing what THIS run happens to use, FR29) and approves the resulting
 * config hash under `governs_analysis_parameters`. Idempotent: a config hash
 * already approved is reported by the platform as such, never re-approved.
 */
export async function ensureApprovedDiscoveryConfig(api: Api, t: Tenant): Promise<void> {
  await api.post(`/api/v1/workspaces/${t.workspaceId}/analysis-policy`, {
    entries: {
      'split.exploration_holdout': {
        holdoutRatio: { value: 0.3, locked: false },
        minPatientsPerArm: { value: 20, locked: false },
        minPatientsPerClass: { value: 5, locked: false },
      },
    },
  }, t.headers);
  const cfg = await api.get('/api/v1/discovery/config', t.headers);
  await api.post('/api/v1/discovery/config/approvals', { configHash: cfg.body.configHash }, t.headers);
}

export interface InstantiatePlanInput {
  viewAnalysisId: string;
  projectId: string;
  datasetId: string;
  datasetVersionHash: string;
  questionKey: string;
}

/** `POST /v1/discovery/plans` — the SAME contract the canvas trigger calls. */
export async function instantiatePlan(api: Api, t: Tenant, input: InstantiatePlanInput) {
  return api.post('/api/v1/discovery/plans', {
    viewAnalysisId: input.viewAnalysisId,
    projectId: input.projectId,
    datasetId: input.datasetId,
    datasetVersionHash: input.datasetVersionHash,
    questionKey: input.questionKey,
    question: 'Does the marker associate with response?',
    takeSplit: false,
    measurementColumns: ['biomarker_x', 'biomarker_y'],
    comparisons: [{ from: 'A', to: 'B' }],
    rankBy: 'qValue',
    outcomeColumn: 'response',
  }, t.headers);
}
