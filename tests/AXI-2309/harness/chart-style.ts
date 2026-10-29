import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { asList, sleep, type Api } from '../../AXI-1400/harness/api';
import { type Analysis, type Tenant } from '../../AXI-1400/harness/seed';

/**
 * AXI-2312 (epic AXI-2309 — FR12, FR13, FR15, AC5) — polling helpers.
 *
 * Lives here, not in the `.spec.ts` file, because the spec-linter
 * (`no-fixed-sleep`) forbids a raw `sleep` call anywhere in a `*.spec.ts`
 * file — the same reason `tests/AXI-1474/harness/seed.ts#pollRunTerminal`
 * is a harness function rather than inline spec code.
 */

export const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-2309', 'fixtures');
export const FIXTURE_FILE = 'chart-style-default.csv';

const INGEST_TIMEOUT_MS = 90_000;
const INGEST_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 120_000;
const RUN_POLL_MS = 2_000;
const MINT_TIMEOUT_MS = 60_000;
const MINT_POLL_MS = 2_000;

export async function ingestFixture(api: Api, t: Tenant): Promise<string> {
  const ws = t.workspaceId;
  const existing = await api.get(`/api/v1/workspaces/${ws}/datasets?search=${encodeURIComponent(FIXTURE_FILE)}`, t.headers);
  const prior = asList(existing.body).find((d: any) => d.originalFilename === FIXTURE_FILE && d.availability === 'available');
  const datasetId = prior ? prior.id : await uploadAndFinalize(api, t);
  await ensureLink(api, t, datasetId);
  return datasetId;
}

async function uploadAndFinalize(api: Api, t: Tenant): Promise<string> {
  const ws = t.workspaceId;
  const bytes = readFileSync(join(FIXTURES_DIR, FIXTURE_FILE));
  const init = await api.post(`/api/v1/workspaces/${ws}/datasets`, {
    organizationId: t.orgId, originalFilename: FIXTURE_FILE, contentType: 'text/csv',
  }, t.headers);
  const datasetId = init.body.dataset.id;
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`presigned PUT of ${FIXTURE_FILE} failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${ws}/datasets/${datasetId}/finalize`, undefined, t.headers);
  if (fin.status >= 300) throw new Error(`finalize ${FIXTURE_FILE} failed (${fin.status})`);
  await waitForIngestion(api, t, datasetId);
  return datasetId;
}

async function waitForIngestion(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}`, t.headers);
    const status = d.body?.latestIngestion?.status;
    if (status === 'ready') return;
    if (status === 'failed') throw new Error(`ingestion of ${FIXTURE_FILE} failed`);
    await sleep(INGEST_POLL_MS);
  }
  throw new Error(`ingestion of ${FIXTURE_FILE} timed out`);
}

async function ensureLink(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const linked = async () => {
    const res = await api.get(`/api/v1/projects/${t.projectId}/datasets`, t.headers);
    return asList(res.body).some((l: any) => l.datasetId === datasetId);
  };
  if (await linked()) return;
  await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
  if (!(await linked())) throw new Error(`dataset ${datasetId} did not link to project ${t.projectId}`);
}

export interface RunArgs {
  operationId: string;
  roleBindings: Record<string, string>;
  operationParams: Record<string, unknown>;
  pivot?: { valueColumns?: string[] };
  carrierRuleId: string;
  /** Defaults to `'STATISTICAL'` — override for an operation declared under a
   *  different `RuleRunKind` (e.g. `describe.count` is `DESCRIBE`); the
   *  submitted `runKind` is validated against the operation's own
   *  declaration, so a mismatch here is a 400, not a silent coercion. */
  runKind?: string;
  /**
   * AXI-2312 (review bounce #1, B1) — the chart-style carrier, a FIELD OF ITS
   * OWN on `ExecuteRuleRunRequest`, deliberately NOT inside `operationParams`
   * (see `libs/contracts/src/rule-run/rule-run.patterns.ts`).
   */
  chartStyleOverrides?: Record<string, unknown>;
}

function runBody(t: Tenant, a: Analysis, datasetId: string, args: RunArgs): Record<string, unknown> {
  return {
    ruleId: args.carrierRuleId,
    runKind: args.runKind ?? 'STATISTICAL',
    operationId: args.operationId,
    roleBindings: args.roleBindings,
    operationParams: args.operationParams,
    pivot: args.pivot,
    chartStyleOverrides: args.chartStyleOverrides,
    projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
    snapshotId: a.snapshotId, viewAnalysisId: a.analysisId, scope: 'FILTERED',
  };
}

/**
 * AXI-2312 (review bounce #2) — the RAW `POST /rule-runs` reply (status +
 * body), unasserted: the dedup-visibility and refusal scenarios assert on the
 * submit RESPONSE itself (`chartStyleOverridesApplied`, a 400), which the
 * polled run record below never carries.
 */
export async function submitRun(api: Api, t: Tenant, a: Analysis, datasetId: string, args: RunArgs): Promise<{ status: number; body: any }> {
  return api.post('/api/v1/rule-runs', runBody(t, a, datasetId, args), t.headers);
}

/** The same body, sent to the no-write dry run (`POST /rule-runs/preflight`). */
export async function preflightRun(api: Api, t: Tenant, a: Analysis, datasetId: string, args: RunArgs): Promise<{ status: number; body: any }> {
  return api.post('/api/v1/rule-runs/preflight', runBody(t, a, datasetId, args), t.headers);
}

/** Submits a run and polls until it leaves a non-terminal status. */
export async function runAndWait(api: Api, t: Tenant, a: Analysis, datasetId: string, args: RunArgs): Promise<any> {
  const submitted = await submitRun(api, t, a, datasetId, args);
  expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
  const ruleRunId = submitted.body.ruleRunId;

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await api.get(`/api/v1/rule-runs/${ruleRunId}`, t.headers);
    if (run.body.status === 'SUCCEEDED' || run.body.status === 'FAILED' || run.body.status === 'DEDUPED') {
      return run.body;
    }
    await sleep(RUN_POLL_MS);
  }
  throw new Error(`run of ${args.operationId} timed out`);
}

/** DEDUPED is a real terminal status: a re-run against an already-materialized
 *  fingerprint is created DEDUPED outright, a SEPARATE row pointing at the
 *  canonical (`dedupedFromRunId`) — the one that actually carries the result
 *  dataset / snapshot / recommended spec resolved below. */
export function canonicalRunId(run: any): string {
  return run.dedupedFromRunId ?? run.ruleRunId ?? run.id;
}

/**
 * The result Dataset a run produced is never served directly on the run
 * itself — it is resolved the same way the product does: the run's own
 * `rule_derived` snapshot (parented to the run's referent, `run.snapshotId`)
 * names it in `datasetId` (`rule-runs.service.ts#createRuleDerivedSnapshot`).
 * Polls because the snapshot materializes asynchronously after the run
 * reaches SUCCEEDED.
 */
export async function resolveResultDatasetId(api: Api, t: Tenant, analysisId: string, canonicalId: string): Promise<string> {
  const run = await api.get(`/api/v1/rule-runs/${canonicalId}`, t.headers);
  const referentSnapshotId = run.body.snapshotId;
  const deadline = Date.now() + MINT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await api.get(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`, t.headers);
    const derived = asList(res.body).find(
      (s: any) => s.origin === 'rule_derived' && s.parentSnapshotId === referentSnapshotId,
    );
    if (derived) return derived.datasetId;
    await sleep(MINT_POLL_MS);
  }
  throw new Error(`no rule_derived snapshot (referent ${referentSnapshotId}) appeared for run ${canonicalId}`);
}

/**
 * The `recommended`-origin spec a run mints lands on the result dataset's
 * candidate gallery asynchronously (profiling completion, AXI-1552) — polls
 * until it appears, or until the deadline, returning `null` so a caller can
 * assert absence rather than timing out on a chart that never mints.
 */
export async function pollRecommendedCandidate(
  api: Api, t: Tenant, resultDatasetId: string, analysisId: string,
): Promise<any | null> {
  const deadline = Date.now() + MINT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await api.get(
      `/api/v1/workspaces/${t.workspaceId}/datasets/${resultDatasetId}/candidates?viewAnalysisId=${analysisId}`,
      t.headers,
    );
    const recommended = asList(res.body).find((s: any) => s.origin === 'recommended');
    if (recommended) return recommended;
    await sleep(MINT_POLL_MS);
  }
  return null;
}

export async function render(api: Api, t: Tenant, specId: string): Promise<any> {
  const res = await api.post(`/api/v1/workspaces/${t.workspaceId}/dataviews/${specId}/render`, {}, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

const RESULT_TIMEOUT_MS = 90_000;
const RESULT_POLL_MS = 2_000;

/**
 * AXI-2312 (review bounce #2 advisory) — "never blank" asserted as a REAL
 * payload: a cache-miss render answers `rendering` (which `status !== 'error'`
 * also accepts), so poll `GET dataviews/results/:instanceId` until the job
 * lands `ready` with a payload, or fail at the deadline.
 */
export async function renderUntilReady(api: Api, t: Tenant, specId: string): Promise<any> {
  const first = await render(api, t, specId);
  if (first.payload !== undefined && first.payload !== null) return first;
  expect(first.status, JSON.stringify(first)).not.toBe('error');
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await api.get(`/api/v1/workspaces/${t.workspaceId}/dataviews/results/${first.instanceId}`, t.headers);
    if (res.body?.status === 'ready' && res.body.payload != null) return res.body;
    await sleep(RESULT_POLL_MS);
  }
  throw new Error(`render of spec ${specId} (instance ${first.instanceId}) never reached ready with a payload`);
}
