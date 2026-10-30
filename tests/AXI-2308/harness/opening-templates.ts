import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asList, sleep, type Api } from '../../AXI-1400/harness/api';
import type { Tenant } from '../../AXI-1400/harness/seed';

/**
 * AXI-2339 (epic AXI-2308 — FR20, NFR10; @SI-045). Helpers for the opening-template
 * spec: ingest this epic's own fixture, call the three opening-template routes, and
 * drive a compiled plan through the governed engine. All waits are condition polls
 * kept here (a harness, not a `*.spec.ts` — AXI-1265/NFR4).
 */

const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-2308', 'fixtures');
const INGEST_TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 180_000;
export const OPENING_TEMPLATES_PATH = '/api/v1/guided-analysis/opening-templates';

const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'AWAITING_APPROVAL']);

/** Ingest a CSV fixture once per workspace and link it to the project; returns the dataset id. */
export async function ingestCsvFixture(api: Api, t: Tenant, filename: string): Promise<string> {
  const existing = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets?search=${encodeURIComponent(filename)}`, t.headers);
  const prior = asList(existing.body).find(
    (d: any) => d.originalFilename === filename && d.availability === 'available' && d.latestIngestion?.status === 'ready',
  );
  const datasetId = prior ? prior.id : await uploadAndFinalize(api, t, filename);
  await ensureLink(api, t, datasetId);
  return datasetId;
}

async function uploadAndFinalize(api: Api, t: Tenant, filename: string): Promise<string> {
  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  const init = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: filename, contentType: 'text/csv',
  }, t.headers);
  const datasetId = init.body?.dataset?.id;
  if (!datasetId) throw new Error(`upload init of ${filename} returned no dataset (${init.status}): ${JSON.stringify(init.body)}`);
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`presigned PUT of ${filename} failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/finalize`, undefined, t.headers);
  if (fin.status >= 300) throw new Error(`finalize ${filename} failed (${fin.status}): ${JSON.stringify(fin.body)}`);
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}`, t.headers);
    const status = d.body?.latestIngestion?.status;
    if (status === 'ready') return datasetId;
    if (status === 'failed') throw new Error(`ingestion of ${filename} failed`);
    await sleep(POLL_MS);
  }
  throw new Error(`ingestion of ${filename} timed out`);
}

async function ensureLink(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const linked = async () =>
    asList((await api.get(`/api/v1/projects/${t.projectId}/datasets`, t.headers)).body).some((l: any) => l.datasetId === datasetId);
  if (await linked()) return;
  await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
  if (!(await linked())) throw new Error(`dataset ${datasetId} did not link to project ${t.projectId}`);
}

/** POST /opening-templates/compile; the raw response (a refusal is a 2xx with `ok: false`). */
export function compileTemplate(api: Api, t: Tenant, dataset: unknown, templateId: string, parameters: Record<string, unknown>) {
  return api.post(`${OPENING_TEMPLATES_PATH}/compile`, { projectId: t.projectId, dataset, templateId, parameters }, t.headers);
}

/**
 * AXI-2342 (FR28, AC22, STRETCH). POST /opening-templates/suggestions — the ranked, deterministic,
 * LLM-free "questions this data can answer" (one per eligible template, capped at ~5).
 */
export async function suggestTemplates(api: Api, t: Tenant, dataset: unknown): Promise<any[]> {
  const res = await api.post(`${OPENING_TEMPLATES_PATH}/suggestions`, { projectId: t.projectId, dataset }, t.headers);
  if (res.status >= 300) throw new Error(`suggest refused (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body as any[];
}

/** Submit a compiled plan to the governed engine; throws with the body on refusal. */
export async function submitGoverned(api: Api, t: Tenant, plan: any, datasetId: string): Promise<string> {
  const res = await api.post('/api/v1/governed-execution/submit', {
    projectId: t.projectId, plan, datasetId, workspaceId: t.workspaceId,
  }, t.headers);
  if (res.status >= 300 || !res.body?.runId) {
    throw new Error(`governed submit refused (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.runId as string;
}

/** Poll the governed run until every node has settled; returns the last status body. */
export async function drainGoverned(api: Api, t: Tenant, runId: string): Promise<{ nodes: Array<{ nodeId: string; status: string }>; [k: string]: unknown }> {
  const url = `/api/v1/governed-execution/status?projectId=${t.projectId}&runId=${runId}`;
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let body: any = null;
  while (Date.now() < deadline) {
    body = (await api.get(url, t.headers)).body;
    const nodes = body?.nodes ?? [];
    if (nodes.length > 0 && nodes.every((n: any) => SETTLED.has(n.status))) return body;
    await sleep(POLL_MS);
  }
  throw new Error(`governed run ${runId} did not settle: ${JSON.stringify(body)}`);
}
