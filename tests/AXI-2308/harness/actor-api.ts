import type { APIResponse } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { sleep, type Api } from '../../AXI-1400/harness/api';
import type { Actor } from '../../AXI-2265/private-projects-fixtures';

/**
 * AXI-2338 (epic AXI-2308) — the `{ status, body }` harness `Api` over a
 * throwaway `PrivateProjectsWorld` actor, so the shared ingestion / anchoring
 * helpers (`ingestFixture`, `anchorDataset`) run AS that actor, inside the
 * spec's own fresh workspace, never as the platform admin on a seeded tenant.
 */
export function actorApi(a: Actor): Api {
  const wrap = async (pending: Promise<APIResponse>) => {
    const res = await pending;
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    return { status: res.status(), body };
  };
  return {
    ctx: a.api,
    get: (path, headers) => wrap(a.api.get(apiUrl(path), { headers })),
    post: (path, body, headers) => wrap(a.api.post(apiUrl(path), { data: body as any, headers })),
    patch: (path, body, headers) => wrap(a.api.patch(apiUrl(path), { data: body as any, headers })),
  } as Api;
}

const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'AWAITING_APPROVAL']);
const RUN_TIMEOUT_MS = 180_000;
const RUN_POLL_MS = 2_000;

/**
 * Polls `GET /governed-execution/status` until every node has settled. Lives in
 * a harness because the spec-linter (`no-fixed-sleep`) forbids `sleep` in a
 * `*.spec.ts` file.
 */
export async function settledGovernedRun(api: Api, projectId: string, runId: string): Promise<any> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let last: any;
  while (Date.now() < deadline) {
    const res = await api.get(`/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`);
    last = res.body;
    const nodes: Array<{ status: string }> = last?.nodes ?? [];
    if (res.status === 200 && nodes.length > 0 && nodes.every((n) => SETTLED.has(n.status))) return last;
    await sleep(RUN_POLL_MS);
  }
  throw new Error(`governed run ${runId} did not settle: ${JSON.stringify(last).slice(0, 500)}`);
}
