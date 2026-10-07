import { expect } from '@playwright/test';
import type { Api } from './api';
import { sleep, asList } from './api';
import { carrierRuleId, ensureCutoffChoice, type Tenant, type Analysis } from './seed';
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

/**
 * The columns the descriptor declares for this run's shape. A delta declares one
 * shape per `outputMode` with TEMPLATED names (`delta_{measurement}`), resolved
 * here from the run's own pivot and ordering.
 */
function declaredColumns(d: Descriptor, op: OpRun): string[] {
  const shapes = d.output?.shapes ?? {};
  const shape = shapes[op.outputMode ?? ''] ?? shapes[''] ?? Object.values(shapes)[0];
  const vars: Record<string, string | undefined> = {
    measurement: op.pivot?.valueColumn as string | undefined, levelFrom: op.ordering?.levelFrom, levelTo: op.ordering?.levelTo,
  };
  return (shape?.columns ?? []).map((c) => c.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m));
}

const runKindOf = (op: OpRun) => op.runKind ?? 'STATISTICAL';

/**
 * What a run's rule-derived snapshot name must contain. A statistical result is
 * named for its operation, a delta for its formula ("Delta result: difference").
 */
function snapshotNameMark(op: OpRun): string {
  return runKindOf(op) === 'DELTA' ? `Delta result: ${op.formula}` : op.operationId;
}

/** DELTA and STRATIFY carry the kind's own fields, exactly as the analysis page sends them. */
function kindFields(op: OpRun): Record<string, unknown> {
  if (runKindOf(op) === 'DELTA') return { formula: op.formula, outputMode: op.outputMode, ordering: op.ordering, pivot: op.pivot };
  if (runKindOf(op) === 'STRATIFY') return { partitionRule: op.partitionRule };
  const fields: Record<string, unknown> = { operationId: op.operationId, roleBindings: op.roleBindings ?? {} };
  if (op.pivot) fields.pivot = op.pivot;
  if (op.ordering) fields.ordering = op.ordering;
  return fields;
}

async function runBody(api: Api, t: Tenant, a: Analysis, datasetId: string, op: OpRun) {
  const operationParams: Record<string, unknown> = { ...(op.operationParams ?? {}) };
  if (op.cutoffChoice) {
    operationParams.cutoffChoiceId = await ensureCutoffChoice(api, t, a, op.cutoffChoice.measurement, op.cutoffChoice.cutoff);
  }
  return {
    ruleId: await carrierRuleId(op.operationId), runKind: runKindOf(op),
    ...(runKindOf(op) === 'STATISTICAL' ? { operationParams } : {}),
    ...kindFields(op),
    projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
    snapshotId: a.snapshotId, viewAnalysisId: a.analysisId, scope: 'FILTERED',
  };
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
 * A split is taken once per question (FR4 `split_is_unique_per_question`): a
 * re-run of this spec in the same workspace is REFUSED, not deduped, because a
 * second split would let a better-looking holdout be chosen. That refusal is the
 * governed outcome of a re-run, so the split already taken is the one asserted.
 */
function isRepeatSplitRefusal(submit: { status: number; body: any }): boolean {
  return submit.status === 400 && String(submit.body?.message ?? '').includes('split_is_unique_per_question');
}

/** The run behind this operation's rule-derived snapshot in the analysis. */
async function priorRunInAnalysis(api: Api, t: Tenant, a: Analysis, op: OpRun): Promise<any> {
  const snaps = asList((await api.get(`/api/v1/view-analyses/${a.analysisId}/snapshots?page=1&limit=200`, t.headers)).body);
  const prior = snaps.find((s: any) => s.origin === 'rule_derived' && String(s.name ?? '').includes(op.operationId));
  expect(prior?.ruleRunId, `${op.operationId} refused as a repeat, but no prior run in analysis ${a.analysisId}`).toBeTruthy();
  return (await api.get(`/api/v1/rule-runs/${prior.ruleRunId}`, t.headers)).body;
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
    const submit = await api.post('/api/v1/rule-runs', await runBody(api, t, a, datasetId, op), t.headers);
    if (isRepeatSplitRefusal(submit)) {
      submitted = await priorRunInAnalysis(api, t, a, op);
      break;
    }
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

  const snapshotAnalysisId: string =
    submitBody?.deduped ? (submitBody.existingViewAnalysisId ?? a.analysisId) : a.analysisId;
  const snaps = asList((await api.get(`/api/v1/view-analyses/${snapshotAnalysisId}/snapshots?page=1&limit=200`, t.headers)).body);
  if (runKindOf(op) === 'STRATIFY') assertStratifyResult(op, row, snaps);
  else await assertTableResult(api, t, op, d, row, snaps, snapshotAnalysisId);
  return { ok: true };
}

/**
 * A stratification computes no table: it partitions the referent into one
 * filtered snapshot per non-empty declared group ("Stratification group: <label>"),
 * and its summary counts every row into a group or into `unassigned_n`.
 */
function assertStratifyResult(op: OpRun, row: any, snaps: any[]): void {
  const summary = row.summaryJson ?? {};
  const counts: Record<string, number> = summary.group_counts ?? {};
  const declared = op.partitionRule!.groups;
  expect(Object.keys(counts).sort(), `${op.label} counts every declared group`).toEqual(declared.map((g) => g.id).sort());
  const assigned = Object.values(counts).reduce((n, c) => n + c, 0);
  expect(assigned + (summary.unassigned_n ?? 0), `${op.label} accounts for every row`).toBe(summary.scope_n);
  for (const g of declared.filter((x) => counts[x.id] > 0)) {
    expect(
      snaps.some((s: any) => s.ruleRunId === row.id && s.name === `Stratification group: ${g.label ?? g.id}`),
      `${op.label} snapshot for group ${g.id}`,
    ).toBeTruthy();
  }
}

/** A statistical or delta run: a result table with the declared columns, a default chart, a named rule-derived snapshot. */
async function assertTableResult(api: Api, t: Tenant, op: OpRun, d: Descriptor, row: any, snaps: any[], snapshotAnalysisId: string): Promise<void> {
  // FR13/FR32 — the result table carries the declared output columns.
  const table = await api.get(`/api/v1/rule-runs/${row.id}/table`, t.headers);
  expect(table.status, `${op.operationId} table`).toBe(200);
  expect(table.body.totalRows, `${op.operationId} rows`).toBeGreaterThanOrEqual(1);
  const cols: string[] = table.body.columns ?? [];
  for (const declared of declaredColumns(d, op)) {
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
  const derived = snaps.filter((s: any) => s.origin === 'rule_derived');
  expect(
    derived.some((s: any) => s.ruleRunId === row.id && String(s.name ?? '').includes(snapshotNameMark(op))),
    `${op.operationId} rule-derived snapshot (analysis ${snapshotAnalysisId}, run ${row.id})`,
  ).toBeTruthy();
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
  const body = await runBody(api, t, a, datasetId, { operationId, roleBindings } as OpRun);
  const res = await api.post('/api/v1/rule-runs', body, t.headers);
  expect(res.status, `negative case ${operationId} should be refused`).toBe(400);
  const message = String(res.body?.message ?? '');
  expect(message, `refusal should name ${expectCondition}`).toContain(expectCondition);
  expect(res.body?.ruleRunId ?? null, 'no run row on a BLOCK').toBeFalsy();
}
