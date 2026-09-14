import { expect } from '@playwright/test';
import type { Api } from './api';
import { sleep, asList } from './api';
import type { Tenant, Analysis } from './seed';
import type { OpRun } from './operationMatrix';

const RUN_TIMEOUT_MS = 120_000;
const RUN_POLL_MS = 2_000;

export interface Descriptor {
  operationId: string;
  runKind: string;
  defaultChart: { type: string; roles?: unknown; annotation?: unknown } | null;
  output: { shapes: Record<string, { columns: string[]; grain: string }> };
}

export async function fetchDescriptors(api: Api): Promise<Map<string, Descriptor>> {
  const res = await api.get('/api/v1/rule-runs/operations');
  const list = Array.isArray(res.body) ? res.body : res.body?.operations ?? res.body?.data;
  if (!Array.isArray(list)) throw new Error('operations response is not a list');
  return new Map(list.map((d: Descriptor) => [d.operationId, d]));
}

function declaredColumns(d: Descriptor): string[] {
  const shape = d.output?.shapes?.[''] ?? Object.values(d.output?.shapes ?? {})[0];
  return shape?.columns ?? [];
}

function runBody(t: Tenant, a: Analysis, datasetId: string, op: OpRun) {
  const body: Record<string, unknown> = {
    ruleId: t.ruleId, runKind: 'STATISTICAL', operationId: op.operationId,
    operationParams: op.operationParams ?? {}, roleBindings: op.roleBindings ?? {},
    projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
    snapshotId: a.snapshotId, viewAnalysisId: a.analysisId, scope: 'FILTERED',
  };
  if (op.pivot) body.pivot = op.pivot;
  if (op.ordering) body.ordering = op.ordering;
  return body;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'DEDUPED']);

async function pollTerminal(api: Api, t: Tenant, ruleRunId: string): Promise<any> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rr = await api.get(`/api/v1/rule-runs/${ruleRunId}`, t.headers);
    if (TERMINAL.has(rr.body?.status)) return rr.body;
    await sleep(RUN_POLL_MS);
  }
  throw new Error(`run ${ruleRunId} did not reach a terminal status within ${RUN_TIMEOUT_MS}ms`);
}

/**
 * A re-run with identical inputs is DEDUPED (FR17) — a valid governed outcome
 * that reuses the original materialised result. Resolve the run the assertions
 * must inspect: the original for a deduped submission, otherwise the run itself.
 */
async function resolveMaterialisedRow(api: Api, t: Tenant, row: any): Promise<any> {
  if (row.status !== 'DEDUPED') return row;
  const originalId = row.dedupedFromRunId;
  expect(originalId, 'DEDUPED run must name its original').toBeTruthy();
  // The dev/HMR stack can transiently 500 a single read under load; a non-2xx is
  // a "real answer" the transport-level withRetry deliberately does not retry, so
  // re-fetch the original run a few times until it resolves to a real row rather
  // than failing the whole op on a transient blip (does not mask a missing run).
  for (let attempt = 0; attempt < 5; attempt++) {
    const original = await api.get(`/api/v1/rule-runs/${originalId}`, t.headers);
    if (original.status < 300 && original.body?.id) return original.body;
    await sleep(1500);
  }
  throw new Error(`could not resolve deduped original run ${originalId}`);
}

/**
 * Submit one governed statistical run and assert the full materialisation
 * contract: SUCCEEDED, executor pin match (FR10/FR11), a materialised
 * statistical_table with its declared columns (FR13/FR15/FR32), a rule-derived
 * snapshot in the triggering analysis (FR33), and a declared defaultChart
 * (FR23). Returns the row + a probe verdict so the caller can group-skip.
 */
export async function runOperation(
  api: Api, t: Tenant, a: Analysis, datasetId: string, op: OpRun, d: Descriptor,
): Promise<{ ok: boolean; libraryAbsent?: boolean; detail?: string }> {
  // The local demo runs in dev/HMR mode and occasionally reloads mid-run,
  // surfacing as a transient "fetch failed"/reset in the executor. Retry a
  // transient FAILED a couple of times before treating it as a real failure.
  let submitted: any;
  let submitBody: any;
  let lastDetail = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const submit = await api.post('/api/v1/rule-runs', runBody(t, a, datasetId, op), t.headers);
    if (submit.status >= 300) {
      lastDetail = `submit ${submit.status}: ${JSON.stringify(submit.body)}`;
      await sleep(3000);
      continue;
    }
    submitBody = submit.body;
    const ruleRunId = submit.body.ruleRunId;
    expect(ruleRunId, `no ruleRunId for ${op.operationId}`).toBeTruthy();
    submitted = await pollTerminal(api, t, ruleRunId);
    if (submitted.status === 'SUCCEEDED' || submitted.status === 'DEDUPED') break;
    const msg = String(submitted.statusMessage ?? submitted.errorMessage ?? '');
    if (!/fetch failed|econn|reset|socket|timeout|unavailable|503/i.test(msg)) {
      const libraryAbsent = /import|module|not installed|no module|library/i.test(msg);
      return { ok: false, libraryAbsent, detail: `${op.operationId} → ${submitted.status}: ${msg}` };
    }
    lastDetail = `${op.operationId} → ${submitted.status} (transient): ${msg}`;
    await sleep(3000);
  }
  if (!submitted || (submitted.status !== 'SUCCEEDED' && submitted.status !== 'DEDUPED')) {
    return { ok: false, detail: lastDetail || `${op.operationId} did not materialise` };
  }
  // On a deduped re-run, assert against the original materialised run (FR17).
  const row = await resolveMaterialisedRow(api, t, submitted);
  const canonicalRunId = row.id;
  expect(canonicalRunId, `${op.operationId} materialised run id`).toBeTruthy();

  // FR10/FR11 — the reported executor version equals the exact pin.
  expect(row.executorVersion, `${op.operationId} executor version`).toBe(op.pin);
  // FR15/FR32 — the run materialised a citable statistical_table node.
  expect(row.materializedNodeId, `${op.operationId} materialized node`).toBeTruthy();
  // Precondition warnings are WARN-only, never a BLOCK on a materialised run.
  expect(row.preconditionWarnings === null || Array.isArray(row.preconditionWarnings)).toBeTruthy();

  // FR13/FR32 — the result table carries the declared output columns.
  const table = await api.get(`/api/v1/rule-runs/${canonicalRunId}/table`, t.headers);
  expect(table.status, `${op.operationId} table`).toBe(200);
  expect(table.body.totalRows, `${op.operationId} rows`).toBeGreaterThanOrEqual(1);
  const cols: string[] = table.body.columns ?? [];
  for (const declared of declaredColumns(d)) {
    expect(cols, `${op.operationId} missing declared column ${declared}`).toContain(declared);
  }

  // FR23 — the operation declares a default chart on its descriptor.
  expect(d.defaultChart, `${op.operationId} defaultChart`).toBeTruthy();
  expect(d.defaultChart!.type, `${op.operationId} chart type`).toBeTruthy();

  // FR33 — a rule-derived snapshot for this operation, named for the operation,
  // exists in the analysis the run materialised into. On a DEDUPE (FR17) an
  // identical prior submission already materialised the result in the ORIGINAL
  // analysis (the run fingerprint keys on the referent's datasetVersionId + rule
  // + operation/params + operandRoles, not the analysis — kernel/run-fingerprint.ts),
  // so the fresh analysis legitimately holds no new snapshot. The submit response
  // names that original analysis; assert the (real, op-named) snapshot THERE,
  // tied to the canonical run — never skipping the check.
  const snapshotAnalysisId: string =
    submitBody?.deduped ? (submitBody.existingViewAnalysisId ?? a.analysisId) : a.analysisId;
  const snaps = await api.get(`/api/v1/view-analyses/${snapshotAnalysisId}/snapshots?page=1&limit=200`, t.headers);
  const derived = asList(snaps.body).filter((s: any) => s.origin === 'rule_derived');
  expect(
    derived.some((s: any) => s.ruleRunId === canonicalRunId && String(s.name ?? '').includes(op.operationId)),
    `${op.operationId} rule-derived snapshot (analysis ${snapshotAnalysisId}, run ${canonicalRunId})`,
  ).toBeTruthy();

  return { ok: true };
}

/**
 * FR8/AC5 — an armed count-based precondition BLOCKs at submission, before any
 * run row exists, naming the failed condition. Asserts a non-2xx whose message
 * names the expected condition.
 */
export async function runNegative(
  api: Api, t: Tenant, a: Analysis, datasetId: string,
  operationId: string, roleBindings: Record<string, string | string[]>, expectCondition: string,
): Promise<void> {
  const body = runBody(t, a, datasetId, { operationId, roleBindings } as OpRun);
  const res = await api.post('/api/v1/rule-runs', body, t.headers);
  expect(res.status, `negative case ${operationId} should be refused`).toBe(400);
  const message = String(res.body?.message ?? '');
  expect(message, `refusal should name ${expectCondition}`).toContain(expectCondition);
  expect(res.body?.ruleRunId ?? null, 'no run row on a BLOCK').toBeFalsy();
}
