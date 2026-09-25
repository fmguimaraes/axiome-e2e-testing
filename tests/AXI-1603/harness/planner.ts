import type { Api } from '../../AXI-1435/harness/api';
import { workspaceHeader, asList } from '../../AXI-1435/harness/api';
import type { Tenant } from '../../AXI-1435/harness/seed';

/**
 * AXI-1603 — Intent-Compiled Planner epic E2E harness (@SI-045/@SI-046).
 *
 * Thin, reuse-or-create helpers over the guided-analysis planner surface, built
 * on top of the AXI-1462 governed harness's envelope shape rather than
 * reinventing it. Kept separate from `tests/AXI-1462/harness/governed.ts`
 * because this harness also drives the prompt library (@SI-046 strategy
 * selection, AC20) and the persisted-plan listing (AC16/AC28/AC17/AC35), which
 * that harness has no reason to know about.
 */

/**
 * A DEDICATED tenant for this epic's E2E — `tests/AXI-1435/harness/seed.ts`'s own
 * `ensureTenant()` reuses a workspace by NAME across the whole shared demo DB, and
 * that workspace was found to be owned by a DIFFERENT bootstrap admin identity
 * than this repo's own `admin` role (`admin@axiome.local` vs the workspace's
 * member `admin@cro-one.com`) — `POST .../datasets` 403s "Not a member of this
 * workspace" before any AXI-1603 spec even runs. Rather than fix a cross-story
 * shared harness (out of this story's ownership boundary), AXI-1603 owns its own
 * org/workspace/project names so its runs never collide with another story's
 * residue tenant.
 */
const NAMES = {
  org: 'AXI-1603 E2E Org',
  workspace: 'AXI-1603 Intent-Compiled Planner',
  project: 'AXI-1603 Intent-Compiled Planner',
};

async function findByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: any) => x.name === name)?.id;
}

export async function ensureTenant1603(api: Api): Promise<Tenant> {
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

export interface PlannerEnvelope {
  projectId: string;
  question: string;
  sendData: boolean;
  context: Record<string, unknown>;
  datasets: Array<{ datasetId: string; name: string; versionHash: string; columns: Array<{ name: string; type: string }> }>;
}

export function buildEnvelope(projectId: string, question: string, datasets: PlannerEnvelope['datasets']): PlannerEnvelope {
  return {
    projectId,
    question,
    sendData: false,
    context: { scientificContext: 'AXI-1603 epic E2E — intent-compiled planner' },
    datasets,
  };
}

/**
 * Discover an available dataset in the workspace to anchor a plan on.
 *
 * FIX (this run): the dataset LIST row carries neither a `columns` array nor a
 * `versionHash`/`latestVersionId` field — the previous version of this helper
 * (copied from `tests/AXI-1462/harness/governed.ts`, which carries the same
 * defect) silently sent `columns: []` and `versionHash: 'sha256:unknown'`.
 * That went unnoticed against the fallback/legacy arms, which never validate
 * an envelope's column/hash shape, but the compiled arm's strict re-validation
 * (P24 — `versionHash` must actually be a sha256 hash; I03/I11 — every cited
 * column must exist in `datasets[].columns`) rejects it on every single
 * attempt, live-logged as "Columns available on dataset ...: (none)" and
 * "versionHash 'sha256:unknown' is not a sha256: hash" — burning the whole
 * 5-attempt budget on a malformed request, not a compiled-arm defect.
 * `loadDatasetForGuided` (axiome-front `src/lib/guidedAnalysis/loadDataset.ts`)
 * is the real contract this mirrors: the dataset's `fileHash` (its real content
 * hash) is the `versionHash`, and columns come from a live query slice
 * (`POST /datasets/:id/query`), never from the list row.
 */
export async function anchorDataset(api: Api, workspaceId: string): Promise<PlannerEnvelope['datasets'][number] | null> {
  const res = await api.get(`/api/v1/workspaces/${workspaceId}/datasets?limit=50`, workspaceHeader(workspaceId));
  const ds = asList(res.body).find((d: any) => (d.availability ?? d.latestIngestion?.status) && d.id);
  if (!ds) return null;
  const query = await api.post(`/api/v1/workspaces/${workspaceId}/datasets/${ds.id}/query`, { limit: 1 }, workspaceHeader(workspaceId));
  const cols = (query.body?.columns ?? []).map((c: any) => ({ name: c.name ?? c, type: c.type ?? 'string' }));
  return { datasetId: ds.id, name: ds.originalFilename ?? ds.name ?? ds.id, versionHash: ds.fileHash ?? 'sha256:unknown', columns: cols };
}

// Live-verified against `POST /guided-analysis/plan` (this run's direct curl
// against the compiled arm): the create response's top-level field is
// `plannerFallback`, never `fallbackOccurred` — there is no `fallbackOccurred`
// key anywhere on the wire. `intentUnsupported`/`attemptCount` ARE present at
// both the top level (create response) AND nested under `plan.*` (both the
// create response and the persisted row) — `findPersistedPlan`'s row exposes
// them only under `.plan`, not at its own top level (see that function's doc).
export interface PlanResponse {
  plan: any;
  status: string;
  planner: string;
  plannerFallback?: boolean;
  intentUnsupported: boolean;
  attemptCount?: number;
  structuralGap?: unknown;
  promptTitle?: string | null;
}

/** Ask the planner for a plan, optionally under a strategy (`promptId`). */
export async function planQuestion(
  api: Api,
  workspaceId: string,
  projectId: string,
  envelope: PlannerEnvelope,
  promptId?: string,
): Promise<{ status: number; body: PlanResponse }> {
  return api.post('/api/v1/guided-analysis/plan', { projectId, envelope, ...(promptId ? { promptId } : {}), sessionId: null }, workspaceHeader(workspaceId));
}

/** The persisted `GuidedAnalysisPlan` row for a given planId (§4.1 step 3, §6). */
/**
 * The persisted row carries `planId`/`planner`/`status`/`envelope`/`plan` at
 * its own top level — `intentUnsupported` and `attemptCount` are NOT top-level
 * fields here (unlike the create response); read them off the returned row's
 * `.plan.intentUnsupported` / `.plan.attemptCount` (live-verified this run,
 * `GET /guided-analysis/plans?projectId=...`).
 */
export async function findPersistedPlan(api: Api, workspaceId: string, projectId: string, planId: string): Promise<any | null> {
  const res = await api.get(`/api/v1/guided-analysis/plans?projectId=${projectId}`, workspaceHeader(workspaceId));
  return asList(res.body).find((p: any) => p.planId === planId) ?? null;
}

/** Reuse-or-create a workspace strategy (prompt) by title (AC20). */
export async function ensureStrategy(api: Api, workspaceId: string, title: string, text: string): Promise<string> {
  const list = await api.get('/api/v1/guided-analysis/prompts', workspaceHeader(workspaceId));
  const existing = asList(list.body).find((p: any) => p.title === title);
  if (existing) return existing.id;
  const created = await api.post('/api/v1/guided-analysis/prompts', { title, text }, workspaceHeader(workspaceId));
  if (created.status >= 300) throw new Error(`strategy '${title}' creation failed (${created.status}): ${JSON.stringify(created.body)}`);
  return created.body.id;
}

/** Submit a plan by id as a governed run (AC19 — must be refused for a flagged plan). */
export async function submitPlanRun(
  api: Api,
  workspaceId: string,
  projectId: string,
  planId: string,
  plan: any,
  datasetId: string,
): Promise<{ status: number; body: any }> {
  return api.post('/api/v1/governed-execution/submit', { projectId, planId, plan, datasetId, workspaceId }, workspaceHeader(workspaceId));
}
