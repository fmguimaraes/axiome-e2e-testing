import type { Api } from '../../AXI-1400/harness/api';
import { asList, sleep } from '../../AXI-1400/harness/api';
import type { Tenant } from '../../AXI-1474/harness/seed';

/**
 * AXI-2014 (epic AXI-2006) — REST-only waits for what a Feature run produces AFTER it
 * succeeds: the recommended chart (minted once the result table is profiled, which is
 * asynchronous) and the descriptive_summary Decision carrying its sentence. Kept out of
 * the `.spec.ts` because the spec linter forbids a raw `sleep` there (NFR4).
 */

const WAIT_TIMEOUT_MS = 90_000;
const WAIT_POLL_MS = 2_000;

async function waitFor<T>(label: string, read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await read();
    if (found) return found;
    await sleep(WAIT_POLL_MS);
  }
  throw new Error(`${label} did not appear within ${WAIT_TIMEOUT_MS / 1000}s`);
}

/** Every `origin: recommended` spec on a result dataset, once at least one exists. */
export async function waitForRecommendedSpecs(api: Api, t: Tenant, datasetId: string): Promise<any[]> {
  return waitFor(`recommended chart on dataset ${datasetId}`, async () => {
    const res = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/candidates`, t.headers);
    if (res.status >= 300) throw new Error(`candidates of ${datasetId} failed (${res.status}): ${JSON.stringify(res.body)}`);
    const recommended = asList(res.body).filter((c: any) => c.origin === 'recommended');
    return recommended.length > 0 ? recommended : null;
  });
}

/** Every descriptive_summary Decision of the project whose context names the run, once at least one exists. */
export async function waitForRunDecisions(api: Api, t: Tenant, projectId: string, ruleRunId: string): Promise<any[]> {
  return waitFor(`descriptive_summary decision for run ${ruleRunId}`, async () => {
    const res = await api.get(
      `/api/v1/workspaces/${t.workspaceId}/decisions?projectId=${projectId}&type=descriptive_summary&limit=100`,
      t.headers,
    );
    if (res.status >= 300) throw new Error(`decisions of ${projectId} failed (${res.status}): ${JSON.stringify(res.body)}`);
    const forRun = asList(res.body).filter((d: any) => d.context?.ruleRunId === ruleRunId);
    return forRun.length > 0 ? forRun : null;
  });
}

/** The thresholds a visualization spec lists (authored + governed, one list). */
export async function thresholdsOf(api: Api, t: Tenant, specId: string): Promise<any[]> {
  const res = await api.get(`/api/v1/visualization-specs/${specId}/thresholds`, t.headers);
  if (res.status >= 300) throw new Error(`thresholds of ${specId} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return asList(res.body);
}
