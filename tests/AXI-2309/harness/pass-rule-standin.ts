import { okBody, type ApiClient } from './prod-suite/api-client';

/**
 * AXI-2319 — polling helpers for the pass-rule stand-in spec. Lives here, not
 * in the `.spec.ts`, because the spec-linter (`no-fixed-sleep`) forbids a raw
 * sleep in a spec file (same reason as harness/chart-style.ts).
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until every dataset's latest ingestion is `ready` (a stand-in uploads fresh fixtures). */
export async function waitForIngestion(client: ApiClient, workspaceId: string, datasetIds: string[], timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const id of datasetIds) {
    for (;;) {
      const body = okBody(await client.get(`/api/v1/workspaces/${workspaceId}/datasets/${id}`), 'read dataset');
      const status = body?.latestIngestion?.status;
      if (status === 'ready') break;
      if (status === 'failed') throw new Error(`ingestion of ${id} failed`);
      if (Date.now() >= deadline) throw new Error(`ingestion of ${id} not ready after ${timeoutMs} ms`);
      await sleep(2_000);
    }
  }
}

/** An independent read of a render instance: is it ready with a payload, right now? */
export async function renderInstanceState(client: ApiClient, workspaceId: string, instanceId: string): Promise<{ status: string | null; hasPayload: boolean; payloadError: string | null }> {
  const res = await client.get(`/api/v1/workspaces/${workspaceId}/dataviews/results/${instanceId}`);
  const payload = res.body?.payload;
  return {
    status: res.status === 200 && typeof res.body?.status === 'string' ? res.body.status : null,
    hasPayload: payload != null,
    payloadError: typeof payload?.error === 'string' ? payload.error : null,
  };
}
