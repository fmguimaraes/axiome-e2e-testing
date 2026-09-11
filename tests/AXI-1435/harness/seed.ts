import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from './api';
import { sleep, workspaceHeader, asList } from './api';

/**
 * Idempotent, REST-only seeding for the AXI-1435 statistical-trigger-surface
 * spec. Every helper is reuse-or-create by a stable name/code so re-running
 * against a shared demo DB is safe (additive only).
 *
 * Mirrors the ordering `tests/AXI-1400/harness/seed.ts` verified live for the
 * same feature: a dataset must be LINKED to the project before the semantic
 * profile is assigned (profile assignment recomputes field-mappings over the
 * project's linked datasets); the statistical rule itself is the
 * relationship-rule-family "Statistical" member the merged AXI-1433 seed
 * (`axiome-back/scripts/create-statistical-rule.ts`, code `STATISTICAL-01`)
 * creates — this harness reuses that exact rule when the environment already
 * seeded it, and creates an identical one (same code/tags/shape) when it
 * has not, so the spec has no hidden dependency on seed-script execution
 * order.
 */

export const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1435', 'fixtures');

export const NAMES = {
  org: 'Axiome E2E Org',
  workspace: 'AXI-1435 Statistical Trigger Surface',
  project: 'AXI-1435 Statistical Trigger Surface',
  profileId: 'immuno_oncology',
};

export interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  /** operationId → seeded per-operation rule id (AXI-1456). */
  ruleIds: Record<string, string>;
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

  const ruleIds = await ensureStatisticalRules(api);
  return { orgId, workspaceId: workspaceId!, projectId: projectId!, ruleIds, headers };
}

/** `stats.paired_ttest` → `STAT-PAIRED-TTEST` (mirrors create-statistical-rule.ts). */
export function ruleCodeFor(operationId: string): string {
  const method = operationId.includes('.') ? operationId.slice(operationId.lastIndexOf('.') + 1) : operationId;
  return `STAT-${method.toUpperCase().replace(/_/g, '-')}`;
}

/**
 * Reuse-or-create ONE SYSTEM-scope governed rule per registered STATISTICAL
 * operation (AXI-1456 — FR40, FR41, FR43), descriptor-driven so the seed
 * tracks the registry. Mirrors `axiome-back/scripts/create-statistical-rule.ts`:
 * each rule carries an `op:<operationId>` tag and the FEATURE_RULE-compliant
 * `feature_name`/`value` output contract. Returns operationId → ruleId.
 */
async function ensureStatisticalRules(api: Api): Promise<Record<string, string>> {
  const descriptors = await api.get('/api/v1/rule-runs/operations?runKind=STATISTICAL');
  const ops = (asList(descriptors.body?.operations ?? descriptors.body) as any[]).filter(
    (o) => (o.runKind ?? 'STATISTICAL') === 'STATISTICAL',
  );
  const existing = await api.get('/api/v1/rules?category=relationship_rule&search=STAT-');
  const byCode = new Map<string, string>(asList(existing.body).map((r: any) => [r.code, r.id]));

  const ids: Record<string, string> = {};
  for (const op of ops) {
    const code = ruleCodeFor(op.operationId);
    if (byCode.has(code)) { ids[op.operationId] = byCode.get(code)!; continue; }
    const title = op.label ?? op.operationId;
    const created = await api.post('/api/v1/rules', {
      code,
      title,
      question: `What does a governed ${title} say about this referent?`,
      logicSummary: `Runs the governed statistical operation ${op.operationId} over a pinned referent; role bindings and parameters are chosen per run.`,
      scope: 'system',
      category: 'relationship_rule',
      protocolType: 'FEATURE_RULE',
      tags: ['relationship-rule', 'statistical', `op:${op.operationId}`],
    });
    const ruleId = created.body.id;
    await api.patch(`/api/v1/rules/${ruleId}`, {
      outputFields: [
        { key: 'feature_name', type: 'string', description: 'Name of the computed feature' },
        { key: 'value', type: 'number', description: 'Numeric feature value per row' },
      ],
    });
    const pub = await api.post(`/api/v1/rules/${ruleId}/publish`, {});
    if (pub.status >= 300) throw new Error(`Statistical rule ${code} publish failed (${pub.status}): ${JSON.stringify(pub.body)}`);
    ids[op.operationId] = ruleId;
  }
  return ids;
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

/**
 * Assign the semantic profile (after datasets are linked) and confirm the
 * canonical fields the picker's own referent-compatibility gate needs
 * (`patient_id`, `timepoint` — the alias lists match the fixture's raw
 * column names exactly, so no manual field-mapping override is needed).
 */
export async function assignProfileAndVerify(api: Api, t: Tenant, requiredCanonicals: string[]): Promise<void> {
  await api.patch(`/api/v1/projects/${t.projectId}/profile`, { profileId: NAMES.profileId }, t.headers);
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

/**
 * Create (or reuse by name) an analysis on a dataset, returning a single
 * reused empty-filter referent snapshot to run against — reused rather than
 * re-POSTed every call, mirroring the AXI-1400 harness's own fix for the same
 * "lot of snapshots, no rule result" artifact (a fresh POST versions a new
 * snapshot every call; re-runs then dedup against the latest, leaving it
 * childless).
 */
export async function ensureAnalysis(api: Api, t: Tenant, name: string, datasetId: string): Promise<Analysis> {
  const list = await api.get(`/api/v1/view-analyses?projectId=${t.projectId}`, t.headers);
  const found = asList(list.body).find((a: any) => a.name === name);
  const analysisId = found ? found.id : (await api.post('/api/v1/view-analyses', { projectId: t.projectId, datasetId, name }, t.headers)).body.id;

  const existing = await api.get(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`, t.headers);
  const base = asList(existing.body).find((s: any) => s.origin === 'filter' && (s.filters == null || s.filters.length === 0));
  const snapshotId = base ? base.id
    : (await api.post('/api/v1/view-analyses/snapshots', { viewAnalysisId: analysisId, filters: [] }, t.headers)).body.id;
  return { analysisId, snapshotId };
}

const RUN_TIMEOUT_MS = 120_000;
const RUN_POLL_MS = 2_000;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'DEDUPED']);

/** Poll a rule run to a terminal status (SUCCEEDED/FAILED/CANCELED/DEDUPED). */
export async function pollTerminal(api: Api, t: Tenant, ruleRunId: string): Promise<any> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rr = await api.get(`/api/v1/rule-runs/${ruleRunId}`, t.headers);
    if (TERMINAL.has(rr.body?.status)) return rr.body;
    await sleep(RUN_POLL_MS);
  }
  throw new Error(`run ${ruleRunId} did not reach a terminal status within ${RUN_TIMEOUT_MS}ms`);
}
