import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from './api';
import { sleep, workspaceHeader, asList } from './api';

/**
 * AXI-1235 (epic AXI-1233) — idempotent, REST-only seeding for the merge
 * covariate-preservation E2E (AC1-AC6, with AC5 — the Stratify compatibility
 * gate — as this spec's load-bearing assertion).
 *
 * Ordering mirrors the AXI-1400/AXI-1435 harnesses this one was modelled on:
 * a dataset must be LINKED to the project before the semantic profile is
 * (re-)assigned, because assignment recomputes `ProjectFieldMapping` rows
 * over the project's *currently linked* datasets only (AXI-1082 —
 * `SemanticProfilesService.getDatasetFieldMappings` is scoped per
 * (project, dataset), never copied forward automatically). The merge RUN
 * mints a brand-new `Dataset` row for its output
 * (`MergeRunService.registerOutputDataset`) that starts out linked to
 * nothing and mapped to nothing — this harness links it and re-assigns the
 * profile a SECOND time so the output dataset's own `subject_id` column gets
 * matched to the canonical `patient_id` field the Stratify gate requires
 * (`RuleRunsService.resolveSubjectKeyColumn`).
 */

export const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1233', 'fixtures');

export const NAMES = {
  org: 'Axiome E2E Org',
  workspace: 'AXI-1235 Merge Covariates',
  project: 'AXI-1235 Merge Covariates',
  profileId: 'immuno_oncology',
  stratifyRuleCode: 'STRATIFY-EXPLICIT-GROUPS',
};

export interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  stratifyRuleId: string;
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

  const stratifyRuleId = await ensureStratifyRule(api);
  return { orgId, workspaceId: workspaceId!, projectId: projectId!, stratifyRuleId, headers };
}

/**
 * Reuse-or-create a published SYSTEM-scope `STRATIFY_RULE` governance wrapper
 * for `stratify.explicit_groups` (mirrors AXI-1435's
 * `ensureStatisticalRules`, adapted for the STRATIFY run kind and the
 * `STRATIFY_RULE` protocol's own required output fields —
 * `protocol-registry.ts`: `stratify_mode`, `group_id`, `n_included`).
 */
async function ensureStratifyRule(api: Api): Promise<string> {
  const existing = await api.get(`/api/v1/rules?search=${NAMES.stratifyRuleCode}`);
  const found = asList(existing.body).find((r: any) => r.code === NAMES.stratifyRuleCode && r.status === 'published');
  if (found) return found.id;

  const created = await api.post('/api/v1/rules', {
    code: NAMES.stratifyRuleCode,
    title: 'Explicit groups (E2E)',
    question: 'What does a governed explicit-group stratification say about this referent?',
    logicSummary: 'Runs the governed stratify.explicit_groups operation over a pinned referent; the partition field and groups are chosen per run.',
    scope: 'system',
    category: 'relationship_rule',
    protocolType: 'STRATIFY_RULE',
    tags: ['relationship-rule', 'stratify', 'op:stratify.explicit_groups'],
  });
  const ruleId = created.body.id;
  await api.patch(`/api/v1/rules/${ruleId}`, {
    outputFields: [
      { key: 'stratify_mode', type: 'string', description: 'Stratification mode' },
      { key: 'group_id', type: 'string', description: 'Group identifier for an assignment' },
      { key: 'n_included', type: 'number', description: 'Number of included rows in the group' },
    ],
  });
  const pub = await api.post(`/api/v1/rules/${ruleId}/publish`, {});
  if (pub.status >= 300) throw new Error(`Stratify rule publish failed (${pub.status}): ${JSON.stringify(pub.body)}`);
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

/** Link a dataset to the project and VERIFY it — the POST can fail silently. */
export async function ensureLink(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const linked = async () => {
    const res = await api.get(`/api/v1/projects/${t.projectId}/datasets`, t.headers);
    return asList(res.body).some((l: any) => l.datasetId === datasetId);
  };
  if (await linked()) return;
  await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
  if (!(await linked())) throw new Error(`dataset ${datasetId} did not link to project ${t.projectId}`);
}

/**
 * Assign (or re-assign — idempotent) the semantic profile and poll until the
 * required canonical fields are matched PROJECT-WIDE. Call again after
 * linking a new dataset (e.g. the merge output) to force the recompute over
 * it too.
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

/** Create (or reuse by name) an analysis on a dataset, returning a single
 *  reused empty-filter referent snapshot (mirrors AXI-1400/AXI-1435: a fresh
 *  POST versions a new snapshot every call, so re-runs must reuse one). */
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

/** Poll a rule run to a terminal status. */
export async function pollTerminal(api: Api, t: Tenant, ruleRunId: string): Promise<any> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rr = await api.get(`/api/v1/rule-runs/${ruleRunId}`, t.headers);
    if (TERMINAL.has(rr.body?.status)) return rr.body;
    await sleep(RUN_POLL_MS);
  }
  throw new Error(`run ${ruleRunId} did not reach a terminal status within ${RUN_TIMEOUT_MS}ms`);
}
