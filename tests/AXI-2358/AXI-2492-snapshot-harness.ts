import { expect } from '@playwright/test';
import { asList, sleep, type Api } from '../AXI-1400/harness/api';
import { type Tenant } from '../AXI-1400/harness/seed';

/**
 * AXI-2492 (epic AXI-2358) — snapshot-scoped render helpers. Kept out of the
 * `.spec.ts` because the spec-linter forbids a raw `sleep` in a spec.
 */

const RESULT_TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;

export interface SnapshotFilter {
  column: string;
  operator: string;
  value?: unknown;
}

/**
 * Reuse a snapshot with exactly these filters (and parent) on the analysis, or
 * create it. Reused, not recreated, so spec re-runs do not pile up versions.
 */
export async function ensureSnapshot(
  api: Api, t: Tenant, analysisId: string, filters: SnapshotFilter[], parentSnapshotId?: string,
): Promise<string> {
  const list = await api.get(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`, t.headers);
  const same = asList(list.body).find((s: any) =>
    s.origin === 'filter'
    && JSON.stringify(s.filters ?? []) === JSON.stringify(filters)
    && (s.parentSnapshotId ?? undefined) === parentSnapshotId);
  if (same) return same.id;
  const res = await api.post('/api/v1/view-analyses/snapshots', {
    viewAnalysisId: analysisId, filters, ...(parentSnapshotId ? { parentSnapshotId } : {}),
  }, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body.id;
}

/** `POST …/render` with a snapshot; returns the raw response (status + body). */
export async function renderSnapshotRaw(api: Api, t: Tenant, specId: string, snapshotId: unknown): Promise<any> {
  return api.post(`/api/v1/workspaces/${t.workspaceId}/dataviews/${specId}/render`, { snapshotId }, t.headers);
}

/** Render a snapshot, then poll until `ready`. Returns `{ dispatched, ready }`. */
export async function renderSnapshotAndPoll(
  api: Api, t: Tenant, specId: string, snapshotId: string,
): Promise<{ dispatched: any; ready: any }> {
  const res = await renderSnapshotRaw(api, t, specId, snapshotId);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const dispatched = res.body;
  expect(dispatched.status, JSON.stringify(dispatched)).not.toBe('error');
  if (dispatched.payload !== undefined && dispatched.payload !== null) return { dispatched, ready: dispatched };
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const poll = await api.get(`/api/v1/workspaces/${t.workspaceId}/dataviews/results/${dispatched.instanceId}`, t.headers);
    if (poll.body?.status === 'ready' && poll.body.payload != null) return { dispatched, ready: poll.body };
    await sleep(POLL_MS);
  }
  throw new Error(`snapshot render of spec ${specId} (instance ${dispatched.instanceId}) never reached ready — AXI-2492 regression (bio-compute ignoring snapshot_scope is never cached)`);
}
