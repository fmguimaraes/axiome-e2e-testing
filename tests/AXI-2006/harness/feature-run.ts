import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api } from '../../AXI-1400/harness/api';
import { asList, sleep } from '../../AXI-1400/harness/api';
import type { Tenant } from '../../AXI-1474/harness/seed';

/**
 * AXI-2012 (epic AXI-2006) — REST-only helpers for the Feature-run specs. Kept out
 * of the `.spec.ts` because the spec linter forbids a raw `sleep` there (NFR4).
 */

export const AXI_2006_FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-2006', 'fixtures');

const INGEST_TIMEOUT_MS = 90_000;
const INGEST_POLL_MS = 2_000;

/** Upload + finalize one CSV from `tests/AXI-2006/fixtures` and wait for its ingestion to be ready. */
export async function ingestCsv(api: Api, t: Tenant, filename: string): Promise<string> {
  const ws = t.workspaceId;
  const bytes = readFileSync(join(AXI_2006_FIXTURES_DIR, filename));
  const init = await api.post(
    `/api/v1/workspaces/${ws}/datasets`,
    { organizationId: t.orgId, originalFilename: filename, contentType: 'text/csv' },
    t.headers,
  );
  if (init.status >= 300) throw new Error(`dataset init for ${filename} failed (${init.status}): ${JSON.stringify(init.body)}`);
  const datasetId: string = init.body.dataset.id;
  const put = await fetch(init.body.presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: new Uint8Array(bytes),
  });
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

/** Every snapshot of one analysis (the list route returns `{ snapshots, total }`, a bare array or `{ data }`). */
export async function snapshotsOf(api: Api, t: Tenant, viewAnalysisId: string): Promise<any[]> {
  const res = await api.get(`/api/v1/view-analyses/${viewAnalysisId}/snapshots?page=1&limit=200`, t.headers);
  if (res.status >= 300) throw new Error(`snapshots of ${viewAnalysisId} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return Array.isArray(res.body?.snapshots) ? res.body.snapshots : asList(res.body);
}

/** Every rule run of the project (the list route is paginated; one page of 100 is enough for a throwaway project). */
export async function runsOf(api: Api, t: Tenant, projectId: string): Promise<any[]> {
  const res = await api.get(`/api/v1/rule-runs?workspaceId=${t.workspaceId}&projectId=${projectId}&limit=100`, t.headers);
  if (res.status >= 300) throw new Error(`rule-runs of ${projectId} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return asList(res.body);
}

/** The rows and ordered column names of a dataset, through the generic query route every picker reads. */
export async function queryDataset(
  api: Api,
  t: Tenant,
  datasetId: string,
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
  const res = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/query`, { limit: 500 }, t.headers);
  if (res.status !== 200) throw new Error(`query of ${datasetId} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return {
    columns: (res.body.columns ?? []).map((c: { name: string }) => c.name),
    rows: res.body.rows ?? [],
  };
}
