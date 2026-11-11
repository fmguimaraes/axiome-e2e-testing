import { expect } from '@playwright/test';
import { asList, sleep, type Api } from '../AXI-1400/harness/api';
import { type Tenant } from '../AXI-1400/harness/seed';

/**
 * AXI-2337 (epic AXI-2358) — render/poll helpers. Kept out of the `.spec.ts`
 * file because the spec-linter forbids a raw `sleep` in a spec (the same reason
 * `tests/AXI-2309/harness/chart-style.ts` exists). Unlike AXI-2312's
 * `renderUntilReady`, these carry a render BODY (`globalFilters`) and return
 * the dispatched id alongside the ready read, so a spec can assert the id
 * round-trips.
 */

const CANDIDATE_TIMEOUT_MS = 60_000;
const RESULT_TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;

export interface RenderGlobalFilter {
  slicer_id: string;
  op: string;
  values?: unknown[];
  value?: unknown;
  min?: unknown;
  max?: unknown;
}

/** Any gallery candidate spec on the dataset (profiling mints them asynchronously). */
export async function pollAnyCandidate(api: Api, t: Tenant, datasetId: string): Promise<any> {
  const deadline = Date.now() + CANDIDATE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/candidates`, t.headers);
    const first = asList(res.body).find((s: any) => typeof s?.id === 'string');
    if (first) return first;
    await sleep(POLL_MS);
  }
  throw new Error(`no gallery candidate spec appeared on dataset ${datasetId}`);
}

export async function renderWith(api: Api, t: Tenant, specId: string, globalFilters?: RenderGlobalFilter[]): Promise<any> {
  const body = globalFilters ? { globalFilters } : {};
  const res = await api.post(`/api/v1/workspaces/${t.workspaceId}/dataviews/${specId}/render`, body, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

/**
 * Render, then (on a cache miss) poll `GET dataviews/results/:instanceId`
 * until `ready`. Returns `{ dispatched, ready }`: `dispatched` is the render
 * response, `ready` the response that carried the payload (the same object on
 * a cache hit).
 */
export async function renderAndPoll(
  api: Api, t: Tenant, specId: string, globalFilters?: RenderGlobalFilter[],
): Promise<{ dispatched: any; ready: any }> {
  const dispatched = await renderWith(api, t, specId, globalFilters);
  expect(dispatched.status, JSON.stringify(dispatched)).not.toBe('error');
  if (dispatched.payload !== undefined && dispatched.payload !== null) return { dispatched, ready: dispatched };
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await api.get(`/api/v1/workspaces/${t.workspaceId}/dataviews/results/${dispatched.instanceId}`, t.headers);
    if (res.body?.status === 'ready' && res.body.payload != null) return { dispatched, ready: res.body };
    await sleep(POLL_MS);
  }
  throw new Error(`render of spec ${specId} (instance ${dispatched.instanceId}) never reached ready — AXI-2337 regression`);
}
