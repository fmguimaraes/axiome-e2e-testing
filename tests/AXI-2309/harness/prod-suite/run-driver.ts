import type { ApiClient } from './api-client';
import type { ProbeFilter } from './paul-reference';
import type { RunStatus } from './pass-rule';
import type { Scope } from './workbench';

/**
 * AXI-2319 — the I/O half of the pass rule: submit one rule run, wait for it,
 * read its result rows, and find + render its default chart. Every wait is
 * bounded and returns a FACT (never throws for a platform fault), so the pure
 * verdicts in pass-rule.ts judge it and one broken rule never stops the day.
 *
 * DEDUP (load-bearing for a DAILY suite): the run fingerprint carries no
 * executor version and no date, so from day 2 every submission returns
 * DEDUPED onto day 1's run and the engine would never execute again — the
 * suite would replay a cached answer forever. A DEDUPED STATISTICAL run is
 * therefore re-executed from its canonical record (`POST /rule-runs/:id/re-execute`,
 * AXI-2044: bypasses dedup against that run, same inputs and seed) and the
 * FRESH run is the one judged. Other run kinds (e.g. DESCRIBE, AXI-1558) have
 * no re-execute path: the canonical run's status is returned as a FACT with
 * `deduped: true, reExecuted: false`, and the verdict (`judgeFreshness`) never
 * lets that pass — the engine did not run today.
 */

export interface DriverTiming {
  runTimeoutMs: number;
  mintTimeoutMs: number;
  renderTimeoutMs: number;
  pollMs: number;
}

export const DEFAULT_TIMING: DriverTiming = {
  runTimeoutMs: 180_000,
  mintTimeoutMs: 60_000,
  renderTimeoutMs: 45_000,
  pollMs: 2_000,
};

export interface DriverDeps {
  client: ApiClient;
  workspaceId: string;
  projectId: string;
  sapVersionId: string;
  timing?: DriverTiming;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RunRequest {
  ruleId: string;
  runKind: string;
  operationId: string;
  roleBindings: Record<string, string | string[]>;
  pivot?: Record<string, unknown>;
  operationParams: Record<string, unknown>;
}

export interface RunOutcome {
  status: RunStatus;
  /** The run whose result is judged (the fresh replay when a STATISTICAL run deduped). */
  runId: string | null;
  submittedRunId: string | null;
  deduped: boolean;
  reExecuted: boolean;
  detail: string | null;
}

export type ChartOutcome =
  | { state: 'no-result-snapshot' }
  | { state: 'not-minted'; resultDatasetId: string }
  | { state: 'render-refused'; specId: string; httpStatus: number }
  | { state: 'rendered'; specId: string; templateId: string | null; payload: unknown }
  | { state: 'render-error'; specId: string; instanceId: string; error: string }
  | { state: 'never-ready'; specId: string; instanceId: string | null; diagnostic: string | null };

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'DEDUPED']);
const UNREADABLE = Symbol('unreadable');
const list = (body: any): any[] => (Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []);

/**
 * The kernel's field-level submission refusal (`Rule run rejected` + `errors[]`,
 * SubmissionValidationRefusal): `field: message` pairs, bounded. Without it a
 * refused recipe only says "Rule run rejected" and names nothing.
 */
function fieldErrors(body: any): string | null {
  if (!Array.isArray(body?.errors)) return null;
  const parts = body.errors
    .filter((e: any) => typeof e?.field === 'string' && typeof e?.message === 'string')
    .slice(0, 3)
    .map((e: any) => `${e.field}: ${e.message}`);
  return parts.length > 0 ? `[${parts.join('; ')}]` : null;
}

/** A short description of a refusal: error code, message head and field errors — never the raw body. */
export function refusalDetail(status: number, body: any): string {
  const code = typeof body?.code === 'string' ? body.code : typeof body?.errorCode === 'string' ? body.errorCode : null;
  const msg = typeof body?.message === 'string' ? body.message : Array.isArray(body?.message) ? body.message.join('; ') : null;
  const text = [msg, fieldErrors(body)].filter(Boolean).join(' ');
  return [`HTTP ${status}`, code, text.slice(0, 240) || null].filter(Boolean).join(' ');
}

/** The reason an errored render instance gives (bounded; never the raw body). */
export function renderError(body: any): string {
  const candidates = [body?.payload?.error, body?.error, body?.errorMessage, body?.statusMessage];
  const hit = candidates.find((c) => typeof c === 'string' && c.length > 0) as string | undefined;
  return hit ? hit.slice(0, 160) : 'no error message';
}

export function createRunDriver(deps: DriverDeps) {
  const timing = deps.timing ?? DEFAULT_TIMING;
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const { client, workspaceId, projectId, sapVersionId } = deps;

  /**
   * Poll a run until it is terminal. A 403/404 is terminal too: the run id was
   * just issued to this identity, so "not found / forbidden" means it cannot
   * read it (live: AXI-2044's replay row carries no workspace) — waiting the
   * full timeout would only hide that.
   */
  async function waitTerminal(runId: string): Promise<any | null> {
    const deadline = now() + timing.runTimeoutMs;
    for (;;) {
      const res = await client.get(`/api/v1/rule-runs/${runId}`);
      if (res.status === 403 || res.status === 404) return { status: UNREADABLE, httpStatus: res.status };
      if (res.status === 200 && TERMINAL.has(res.body?.status)) return res.body;
      if (now() >= deadline) return null;
      await sleep(timing.pollMs);
    }
  }

  function settled(run: any, base: Omit<RunOutcome, 'status' | 'detail'>): RunOutcome {
    if (!run) return { ...base, status: 'TIMEOUT', detail: null };
    if (run.status === 'SUCCEEDED') return { ...base, status: 'SUCCEEDED', detail: null };
    if (run.status === 'DEDUPED') return { ...base, status: 'DEDUPED', detail: null };
    if (run.status === UNREADABLE) return { ...base, status: 'UNREADABLE', detail: `GET run HTTP ${run.httpStatus}` };
    return { ...base, status: 'FAILED', detail: [run.errorCode, typeof run.errorMessage === 'string' ? run.errorMessage.slice(0, 160) : null].filter(Boolean).join(' ') || null };
  }

  /** Submit, wait, and resolve a DEDUPED answer (re-execute STATISTICAL, else judge the canonical). */
  async function run(req: RunRequest, scope: Scope): Promise<RunOutcome> {
    const submitted = await client.post('/api/v1/rule-runs', {
      ruleId: req.ruleId, runKind: req.runKind, operationId: req.operationId,
      roleBindings: req.roleBindings, pivot: req.pivot, operationParams: req.operationParams,
      sapVersionId, projectId, workspaceId, datasetId: scope.datasetId,
      snapshotId: scope.snapshotId, viewAnalysisId: scope.analysisId, scope: 'FILTERED', filters: scope.filters,
    });
    const submittedRunId = typeof submitted.body?.ruleRunId === 'string' ? submitted.body.ruleRunId : null;
    if (submitted.status >= 300 || !submittedRunId) {
      return { status: 'REFUSED', runId: null, submittedRunId: null, deduped: false, reExecuted: false, detail: refusalDetail(submitted.status, submitted.body) };
    }
    const first = await waitTerminal(submittedRunId);
    if (first?.status !== 'DEDUPED') return settled(first, { runId: submittedRunId, submittedRunId, deduped: false, reExecuted: false });

    const canonicalId = typeof first.dedupedFromRunId === 'string' ? first.dedupedFromRunId : null;
    if (!canonicalId) return { status: 'DEDUPED', runId: submittedRunId, submittedRunId, deduped: true, reExecuted: false, detail: 'no dedupedFromRunId' };
    if (req.runKind !== 'STATISTICAL') {
      return settled(await waitTerminal(canonicalId), { runId: canonicalId, submittedRunId, deduped: true, reExecuted: false });
    }
    const replay = await client.post(`/api/v1/rule-runs/${canonicalId}/re-execute`, { projectId });
    const replayId = typeof replay.body?.ruleRunId === 'string' ? replay.body.ruleRunId : null;
    if (replay.status >= 300 || !replayId) {
      return { status: 'REFUSED', runId: null, submittedRunId, deduped: true, reExecuted: false, detail: `re-execute ${refusalDetail(replay.status, replay.body)}` };
    }
    const fresh = await waitTerminal(replayId);
    // A replay that itself dedups would mean the bypass failed: judged as such, never as SUCCEEDED.
    return settled(fresh, { runId: replayId, submittedRunId, deduped: true, reExecuted: true });
  }

  /** The run's result rows (first page; the probes read ≤ 50 rows). */
  async function table(runId: string): Promise<Record<string, unknown>[] | null> {
    const res = await client.get(`/api/v1/rule-runs/${runId}/table?page=1&limit=100`);
    return res.status === 200 && Array.isArray(res.body?.rows) ? res.body.rows : null;
  }

  /** The `rule_derived` snapshot of THIS run (matched on its own ruleRunId), all pages. */
  async function resultDatasetId(runId: string, analysisId: string): Promise<string | null> {
    const deadline = now() + timing.mintTimeoutMs;
    for (;;) {
      for (let page = 1; page <= 50; page++) {
        const res = await client.get(`/api/v1/view-analyses/${analysisId}/snapshots?page=${page}&limit=100`);
        if (res.status !== 200) break;
        const hit = list(res.body).find((s: any) => s?.origin === 'rule_derived' && s?.ruleRunId === runId);
        if (hit?.datasetId) return String(hit.datasetId);
        if (!res.body?.meta?.hasNextPage) break;
      }
      if (now() >= deadline) return null;
      await sleep(timing.pollMs);
    }
  }

  async function recommendedSpec(resultId: string, analysisId: string): Promise<any | null> {
    const deadline = now() + timing.mintTimeoutMs;
    for (;;) {
      const res = await client.get(`/api/v1/workspaces/${workspaceId}/datasets/${resultId}/candidates?viewAnalysisId=${analysisId}`);
      const hit = res.status === 200 ? list(res.body).find((s: any) => s?.origin === 'recommended') : null;
      if (hit?.id) return hit;
      if (now() >= deadline) return null;
      await sleep(timing.pollMs);
    }
  }

  /**
   * Best-effort WHY for a render that never became ready: the lineage graph's
   * ChartArtifact for the spec, when the identity can read it. Diagnostic only —
   * it never turns a case green (a stale artifact must not pass a broken path).
   */
  async function renderDiagnostic(specId: string): Promise<string | null> {
    try {
      const edges = await client.get(`/api/v1/graph/edges/DataviewSpec/${specId}?direction=incoming`);
      const srcIds = list(edges.body).map((e: any) => e?.srcId).filter((id: unknown) => typeof id === 'string');
      for (const id of srcIds.slice(0, 3)) {
        const r = await client.get(`/api/v1/workspaces/${workspaceId}/dataviews/results/${id}`);
        const err = r.body?.payload?.error;
        if (typeof err === 'string') return `lineage artifact ${r.body?.status ?? '?'}: ${err.slice(0, 120)}`;
      }
    } catch {
      return null;
    }
    return null;
  }

  /** FR14: find the run's recommended default chart and render it to a ready payload. */
  async function chart(runId: string, analysisId: string, renderWaitMs = timing.renderTimeoutMs): Promise<ChartOutcome> {
    const resultId = await resultDatasetId(runId, analysisId);
    if (!resultId) return { state: 'no-result-snapshot' };
    const spec = await recommendedSpec(resultId, analysisId);
    if (!spec) return { state: 'not-minted', resultDatasetId: resultId };
    const specId = String(spec.id);
    const templateId = typeof spec.templateId === 'string' ? spec.templateId : null;
    const first = await client.post(`/api/v1/workspaces/${workspaceId}/dataviews/${specId}/render`, {});
    if (first.status >= 300) return { state: 'render-refused', specId, httpStatus: first.status };
    if (first.body?.payload != null) return { state: 'rendered', specId, templateId, payload: first.body.payload };
    const instanceId = typeof first.body?.instanceId === 'string' ? first.body.instanceId : null;
    const polled = instanceId ? await pollRender(instanceId, renderWaitMs) : null;
    if (polled?.status === 'ready') return { state: 'rendered', specId, templateId, payload: polled.payload };
    if (polled?.status === 'error') return { state: 'render-error', specId, instanceId: instanceId!, error: polled.error };
    return { state: 'never-ready', specId, instanceId, diagnostic: await renderDiagnostic(specId) };
  }

  /** Poll one render instance until ready, an explicit error, or the wait runs out (null). */
  async function pollRender(instanceId: string, waitMs: number): Promise<{ status: 'ready'; payload: unknown } | { status: 'error'; error: string } | null> {
    const deadline = now() + waitMs;
    for (;;) {
      const res = await client.get(`/api/v1/workspaces/${workspaceId}/dataviews/results/${instanceId}`);
      if (res.status === 200 && res.body?.status === 'ready' && res.body?.payload != null) return { status: 'ready', payload: res.body.payload };
      if (res.status === 200 && res.body?.status === 'error') return { status: 'error', error: renderError(res.body) };
      if (now() >= deadline) return null;
      await sleep(timing.pollMs);
    }
  }

  return { run, table, chart, timing };
}

export type RunDriver = ReturnType<typeof createRunDriver>;

/** Re-exported for recipe authors: the filter shape a scope carries. */
export type { ProbeFilter };
