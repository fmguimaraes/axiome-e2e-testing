import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createApiClient, type ApiResponse, type Transport } from '../../tests/AXI-2309/harness/prod-suite/api-client';
import { recordOnlyExecutor, validateCaseResult, type CaseContext } from '../../tests/AXI-2309/harness/prod-suite/cases';
import { dailyExecutor } from '../../tests/AXI-2309/harness/prod-suite/executor';
import { FIXTURES_DIR, PROD_SUITE_FIXTURES } from '../../tests/AXI-2309/harness/prod-suite/fixtures';
import {
  assertReferenceCovers, assertReferenceFresh, currentInputHashes, loadPaulReference,
  type PaulProbe, type PaulReference, type RReference,
} from '../../tests/AXI-2309/harness/prod-suite/paul-reference';
import { judgeCheck, judgeRenderPayload, judgeRunStatus, matchesR, matchesTarget } from '../../tests/AXI-2309/harness/prod-suite/pass-rule';
import { chartDeclarationOf, chartFailure, createPassRuleExecutor } from '../../tests/AXI-2309/harness/prod-suite/pass-rule-executor';
import { CATALOGUE_RECIPES, recipeParams } from '../../tests/AXI-2309/harness/prod-suite/recipes';
import { createRunDriver, refusalDetail, type DriverTiming } from '../../tests/AXI-2309/harness/prod-suite/run-driver';
import { PAUL_OPERATIONS, type PlannedCase } from '../../tests/AXI-2309/harness/prod-suite/run-plan';
import { ensureWorkbench, scopeName, WORKBENCH_PROJECT_NAME, WORKBENCH_SAP_TITLE } from '../../tests/AXI-2309/harness/prod-suite/workbench';

/**
 * UT-PRODE2E-6046 .. UT-PRODE2E-6078 (epic AXI-2309 — AXI-2319, FR31/AC12,
 * SI-042 + SI-053). Unit coverage of the prod E2E PASS RULE: the pure verdicts
 * (Paul's slide targets at printed precision, R parity tolerances, the default
 * chart payload), the committed expected values (fresh, complete, and
 * consistent with Paul's slides), the run driver's dedup re-execution and
 * bounded waits, the workbench's reuse-by-name, and the executor's outcomes.
 * HTTP is a scripted fake platform — no network, no browser, no Docker.
 * Run via `npm run harness:unit`. See `UT.md`.
 */

const WS = '22222222-2222-4222-8222-222222222222';
const DS1 = '33333333-3333-4333-8333-333333333333';
const DS2 = '44444444-4444-4444-8444-444444444444';
const PAUL = '66666666-6666-4666-8666-666666666666';
const FIXTURES = [
  { key: 'tableau1', datasetId: DS1, rawFileHash: 'sha256:a' },
  { key: 'tableau2', datasetId: DS2, rawFileHash: 'sha256:b' },
];

const FAST: DriverTiming = { runTimeoutMs: 10, mintTimeoutMs: 10, renderTimeoutMs: 10, pollMs: 1 };

/** A clock that advances on every sleep, so bounded waits terminate instantly. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

// ── a scripted fake platform ────────────────────────────────────────────

interface FakeOptions {
  /** Result rows per submitted probe, keyed by roleBindings JSON. */
  rowsFor?: (body: any) => Record<string, unknown>[];
  submitStatus?: number;
  /** Body of a refused submission (default: a coded refusal carrying a fake data row). */
  submitBody?: any;
  runStatus?: string;
  dedupOnSubmit?: boolean;
  replayStatus?: string;
  /** The replayed run is unreadable by the caller (live: AXI-2044 stamps no workspace). */
  replayUnreadable?: boolean;
  mint?: boolean;
  renderReady?: boolean;
  payload?: unknown;
  defaultChartNullFor?: string[];
  existing?: { project?: boolean; sap?: boolean };
}

function fakePlatform(o: FakeOptions = {}) {
  const calls: Array<{ method: string; url: string; data?: any }> = [];
  const runs = new Map<string, any>();
  const snapshots: any[] = [];
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const projects: any[] = o.existing?.project
    ? [{ id: 'proj-old', name: WORKBENCH_PROJECT_NAME, workspaceId: WS, createdAt: '2026-01-01' },
       { id: 'proj-elsewhere', name: WORKBENCH_PROJECT_NAME, workspaceId: 'other-ws', createdAt: '2025-01-01' }]
    : [{ id: 'proj-other-name', name: `${WORKBENCH_PROJECT_NAME} (copy)`, workspaceId: WS, createdAt: '2025-01-01' }];
  const saps: any[] = o.existing?.sap ? [{ id: 'sap-old', title: WORKBENCH_SAP_TITLE, projectId: 'proj-old', sapVersionId: 'sapv-old', createdAt: '2026-01-01' }] : [];
  const analyses: any[] = [];
  const ops = ['stats.dunn_posthoc', 'stats.mann_whitney_u', 'stats.kruskal_wallis', 'stats.correlation', 'stats.partial_correlation', 'stats.chi_square', 'stratify.explicit_groups']
    .map((operationId) => ({ operationId, defaultChart: (o.defaultChartNullFor ?? []).includes(operationId) ? null : { type: 'box_plot' } }))
    .concat([{ operationId: 'stats.fisher_exact', defaultChart: { type: 'heatmap', surfaces: ['result'] } as any }]);

  const newRun = (body: any, extra: Record<string, unknown> = {}) => {
    const runId = id('run');
    runs.set(runId, { id: runId, status: o.runStatus ?? 'SUCCEEDED', body, rows: o.rowsFor?.(body) ?? [], ...extra });
    if ((o.runStatus ?? 'SUCCEEDED') === 'SUCCEEDED' && !extra.dedupedFromRunId) {
      snapshots.push({ id: id('snap'), origin: 'rule_derived', ruleRunId: runId, datasetId: id('result'), viewAnalysisId: body?.viewAnalysisId });
    }
    return runId;
  };

  const transport: Transport = async (method, url, _h, data: any): Promise<ApiResponse> => {
    calls.push({ method, url, data });
    const u = new URL(url);
    const p = u.pathname;
    if (method === 'GET' && p === '/api/v1/rule-runs/operations') return { status: 200, body: { operations: ops } };
    if (method === 'GET' && p === '/api/v1/projects') return { status: 200, body: { data: projects, meta: { hasNextPage: false } } };
    if (method === 'POST' && p === '/api/v1/projects') { const pr = { id: id('proj'), ...data }; projects.push(pr); return { status: 201, body: pr }; }
    let m = p.match(/^\/api\/v1\/projects\/([^/]+)\/datasets$/);
    if (m) return method === 'GET' ? { status: 200, body: [] } : { status: 201, body: {} };
    m = p.match(/^\/api\/v1\/projects\/([^/]+)\/saps$/);
    if (m && method === 'GET') return { status: 200, body: { data: saps.filter((s) => s.projectId === m![1]), meta: { hasNextPage: false } } };
    if (m && method === 'POST') { const s = { id: id('sap'), sapVersionId: id('sapv'), projectId: m[1], ...data }; saps.push(s); return { status: 201, body: s }; }
    if (method === 'GET' && p === '/api/v1/view-analyses') return { status: 200, body: { data: analyses, meta: { hasNextPage: false } } };
    if (method === 'POST' && p === '/api/v1/view-analyses') { const a = { id: id('va'), ...data }; analyses.push(a); return { status: 201, body: a }; }
    if (method === 'POST' && p === '/api/v1/view-analyses/snapshots') { const s = { id: id('ref'), origin: 'filter', ...data }; snapshots.push(s); return { status: 201, body: s }; }
    m = p.match(/^\/api\/v1\/view-analyses\/([^/]+)\/snapshots$/);
    if (m) return { status: 200, body: { data: snapshots.filter((s) => s.viewAnalysisId === m![1]).reverse(), meta: { hasNextPage: false } } };
    if (method === 'POST' && p === '/api/v1/rule-runs') {
      if (o.submitStatus && o.submitStatus >= 300) return { status: o.submitStatus, body: o.submitBody ?? { code: 'SAP_VERSION_REQUIRED', message: 'refused', patientRows: ['SECRET-ROW'] } };
      if (o.dedupOnSubmit) {
        const canonical = newRun(data, { status: 'SUCCEEDED' });
        const dup = id('run');
        runs.set(dup, { id: dup, status: 'DEDUPED', dedupedFromRunId: canonical, body: data, rows: [] });
        return { status: 201, body: { ruleRunId: dup, status: 'DEDUPED' } };
      }
      return { status: 201, body: { ruleRunId: newRun(data), status: 'QUEUED' } };
    }
    m = p.match(/^\/api\/v1\/rule-runs\/([^/]+)\/re-execute$/);
    if (m && method === 'POST') {
      const original = runs.get(m[1]);
      if (o.replayStatus === 'DEDUPED') {
        const again = id('run');
        runs.set(again, { id: again, status: 'DEDUPED', dedupedFromRunId: m[1], rows: [] });
        return { status: 201, body: { ruleRunId: again } };
      }
      return { status: 201, body: { ruleRunId: newRun(original.body, o.replayUnreadable ? { unreadable: true } : {}) } };
    }
    m = p.match(/^\/api\/v1\/rule-runs\/([^/]+)\/table$/);
    if (m) return { status: 200, body: { columns: [], rows: runs.get(m[1])?.rows ?? [] } };
    m = p.match(/^\/api\/v1\/rule-runs\/([^/]+)$/);
    if (m && method === 'GET') { const r = runs.get(m[1]); if (r?.unreadable) return { status: 404, body: {} }; return r ? { status: 200, body: { ...r, rows: undefined, body: undefined } } : { status: 404, body: {} }; }
    m = p.match(/\/datasets\/([^/]+)\/candidates$/);
    if (m) return { status: 200, body: o.mint === false ? [] : [{ id: `spec-${m[1]}`, origin: 'recommended', templateId: 'boxplot_v1' }] };
    m = p.match(/\/dataviews\/([^/]+)\/render$/);
    if (m) return { status: 201, body: { instanceId: `dvi-${m[1]}`, status: 'rendering' } };
    m = p.match(/\/dataviews\/results\/([^/]+)$/);
    if (m) {
      if (m[1].startsWith('art-')) return { status: 200, body: { status: 'ready', payload: { error: 'binding columns not found', data: [] } } };
      return o.renderReady === false
        ? { status: 200, body: { status: 'pending' } }
        : { status: 200, body: { status: 'ready', payload: o.payload ?? { type: 'boxplot', data: [{ x: 1 }] } } };
    }
    if (p.startsWith('/api/v1/graph/edges/DataviewSpec/')) return { status: 200, body: [{ srcId: 'art-1' }] };
    return { status: 404, body: {} };
  };
  const client = createApiClient({ apiBaseUrl: 'http://api.test', token: 't', workspaceId: WS, forbiddenIds: [PAUL] }, transport);
  return { client, calls, runs, projects, saps, analyses, snapshots };
}

const ctxOf = (client: CaseContext['client']): CaseContext => ({ client, organizationId: 'org', workspaceId: WS, fixtures: FIXTURES });

const planned = (over: Partial<PlannedCase>): PlannedCase => ({
  id: 'rule-1', code: 'X', operationId: 'stats.chi_square', runKind: 'STATISTICAL', runnable: true, order: 1, phase: 'catalogue', ...over,
});

const reference = loadPaulReference();

/** Platform rows that reproduce the R reference for a probe exactly. */
function rowsFromR(ref: PaulReference, probe: PaulProbe, perturb?: { field: string; by: number }) {
  const r = ref.r.probes.find((x) => x.id === probe.id)!;
  return r.rows.map((row) => {
    const values = { ...row.values };
    if (perturb && perturb.field in values) values[perturb.field] *= perturb.by;
    return { ...row.row, ...values };
  });
}

function probeForBody(ref: PaulReference, body: any): PaulProbe | undefined {
  return ref.probes.find((p) => p.operationId === body?.operationId
    && JSON.stringify(p.roleBindings) === JSON.stringify(body?.roleBindings)
    && JSON.stringify(p.filters) === JSON.stringify(body?.filters));
}

// ── pure verdicts ───────────────────────────────────────────────────────

test("UT-PRODE2E-6046: Paul's target is checked at the precision the slide prints it", () => {
  assert.equal(matchesTarget(0.021726630476149797, '0.022').ok, true);
  assert.equal(matchesTarget(0.0378040196350719, '0.038').ok, true);
  assert.equal(matchesTarget(0.0225, '0.022').ok, false, '0.0225 prints as 0.023');
  assert.equal(matchesTarget(0.0214, '0.022').ok, false);
  assert.equal(matchesTarget(0.780628, '0.78').ok, true);
  assert.equal(matchesTarget(0.775, '0.77').ok, false);
});

test("UT-PRODE2E-6047: 'ns' means the adjusted p is above 0.05 — 0.05 itself and below are significant", () => {
  assert.equal(matchesTarget(0.4372, 'ns').ok, true);
  assert.equal(matchesTarget(0.05, 'ns').ok, false);
  assert.equal(matchesTarget(0.01, 'ns').ok, false);
});

test('UT-PRODE2E-6048: an unparseable target is a failure, never a pass', () => {
  assert.equal(matchesTarget(0.02, '~0.02').ok, false);
  assert.equal(matchesTarget(0.02, '').ok, false);
});

test('UT-PRODE2E-6049: a p-value agrees with R within |Δ ln p| ≤ 1e-6, and a non-positive p never passes loosely', () => {
  assert.equal(matchesR('pValue', 0.0072422101587166 * (1 + 5e-7), 0.0072422101587166).ok, true);
  assert.equal(matchesR('adjustedPValue', 0.0217 * (1 + 5e-6), 0.0217).ok, false);
  assert.equal(matchesR('pValue', 0, 1e-5).ok, false);
  assert.equal(matchesR('pValue', -1, -1).ok, true, 'identical sentinel values agree');
});

test('UT-PRODE2E-6050: a statistic agrees with R within relative 1e-9; a sign flip or a 1e-8 drift fails', () => {
  assert.equal(matchesR('zStatistic', -2.6854966462123038, -2.6854966462123).ok, true);
  assert.equal(matchesR('zStatistic', 2.6854966462123, -2.6854966462123).ok, false);
  assert.equal(matchesR('coefficient', 0.780628115089281 * (1 + 1e-8), 0.780628115089281).ok, false);
  assert.equal(matchesR('uStatistic', 48.5, 48.5).ok, true);
});

const dunn = reference.probes.find((p) => p.id === 'dunn-ent059')!;
const dunnRef = reference.r.probes.find((p) => p.id === 'dunn-ent059')!;
const firstCheck = dunn.checks[0];

test('UT-PRODE2E-6051: a check reads exactly ONE result row — none or two matching rows is a failure', () => {
  const rows = rowsFromR(reference, dunn);
  assert.equal(judgeCheck(firstCheck, rows, dunnRef).verdict.ok, true);
  assert.equal(judgeCheck(firstCheck, rows.filter((r) => r.groupB !== 'IgG4-RD'), dunnRef).verdict.ok, false);
  assert.match(String((judgeCheck(firstCheck, [...rows, rows[0]], dunnRef).verdict as any).why), /2 result rows match/);
});

test('UT-PRODE2E-6052: a missing, null or string value is a failure, never coerced', () => {
  const rows = rowsFromR(reference, dunn).map((r) => ({ ...r, adjustedPValue: null }));
  assert.equal(judgeCheck(firstCheck, rows, dunnRef).verdict.ok, false);
  const strRows = rowsFromR(reference, dunn).map((r) => ({ ...r, adjustedPValue: '0.0217' }));
  assert.equal(judgeCheck(firstCheck, strRows, dunnRef).verdict.ok, false);
});

test("UT-PRODE2E-6053: a value must satisfy BOTH Paul's slide and R — either alone is not a pass", () => {
  // within the slide's rounding but 1e-4 off R
  const offR = rowsFromR(reference, dunn, { field: 'adjustedPValue', by: 1 + 1e-4 });
  const v1 = judgeCheck(firstCheck, offR, dunnRef).verdict;
  assert.equal(v1.ok, false);
  assert.match((v1 as any).why, /vs R/);
  // agreeing with a (wrong) R but not with the slide
  const wrongRef = { ...dunnRef, rows: dunnRef.rows.map((r) => ({ ...r, values: { ...r.values, adjustedPValue: 0.03 } })) };
  const rows = rowsFromR({ ...reference, r: { ...reference.r, probes: [wrongRef] } }, dunn);
  const v2 = judgeCheck(firstCheck, rows, wrongRef).verdict;
  assert.equal(v2.ok, false);
  assert.match((v2 as any).why, /slide/);
});

// ── the committed expected values ───────────────────────────────────────

test("UT-PRODE2E-6054: the committed R reference is fresh, complete, and itself reproduces every one of Paul's slide targets", () => {
  const targets = reference.probes.flatMap((p) => p.checks.filter((c) => c.target !== undefined).map((c) => ({ p, c })));
  assert.equal(targets.length, 14, '6 Dunn + KW + MWU + 6 Spearman slide numbers');
  for (const { p, c } of targets) {
    const ref = reference.r.probes.find((x) => x.id === p.id)!;
    const row = ref.rows.find((r) => Object.entries(c.row ?? {}).every(([k, v]) => r.row[k] === v))!;
    assert.equal(matchesTarget(row.values[c.field], c.target!).ok, true, `${p.id} ${c.field}: R ${row.values[c.field]} vs slide ${c.target}`);
  }
  assert.equal(reference.r.generator.packages.FSA, '0.9.5');
  assert.equal(reference.r.generator.packages.ppcor, '1.1');
  assert.match(reference.r.generator.rVersion, /^R version 4\.4\.2/);
});

test('UT-PRODE2E-6055: a reference generated from other probes, another R script or other fixture bytes is refused as stale', () => {
  const current = currentInputHashes();
  assert.doesNotThrow(() => assertReferenceFresh(reference.r, current));
  for (const edit of [
    { ...current, probesSha256: 'x' },
    { ...current, scriptSha256: 'x' },
    { ...current, fixtureSha256: { ...current.fixtureSha256, tableau2: 'x' } },
  ]) assert.throws(() => assertReferenceFresh(reference.r, edit), /stale/);
});

test('UT-PRODE2E-6056: a probe with no R entry, or a checked row R never computed, is refused at load', () => {
  const r: RReference = { ...reference.r, probes: reference.r.probes.filter((p) => p.id !== 'dunn-ent059') };
  assert.throws(() => assertReferenceCovers(reference.probes, r), /no entry for probe dunn-ent059/);
  const noRow: RReference = { ...reference.r, probes: reference.r.probes.map((p) => (p.id === 'dunn-ent059' ? { ...p, rows: p.rows.slice(1) } : p)) };
  assert.throws(() => assertReferenceCovers(reference.probes, noRow), /no single value/);
});

test("UT-PRODE2E-6057: every one of Paul's operations has at least one probe, and probes bind only real fixture columns", () => {
  for (const op of PAUL_OPERATIONS) assert.ok(reference.probes.some((p) => p.operationId === op), `no probe for ${op}`);
  const headers = Object.fromEntries(PROD_SUITE_FIXTURES.map((f) => [f.key,
    new Set(readFileSync(path.join(FIXTURES_DIR, f.file), 'utf8').split(/\r?\n/)[0].split(','))]));
  const columnsOf = (b: Record<string, unknown> | undefined) => Object.values(b ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string');
  for (const p of reference.probes) {
    for (const col of [...columnsOf(p.roleBindings), ...columnsOf(p.pivot as any), ...p.filters.map((f) => f.column)]) {
      assert.ok(headers[p.fixture].has(col), `${p.id}: ${col} is not a ${p.fixture} column`);
    }
  }
});

test('UT-PRODE2E-6058: every catalogue recipe binds only real fixture columns', () => {
  const headers = Object.fromEntries(PROD_SUITE_FIXTURES.map((f) => [f.key,
    new Set(readFileSync(path.join(FIXTURES_DIR, f.file), 'utf8').split(/\r?\n/)[0].split(','))]));
  for (const [op, r] of Object.entries(CATALOGUE_RECIPES)) {
    const cols = [...Object.values(r.roleBindings), ...Object.values(r.pivot ?? {})].flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string');
    for (const col of cols) assert.ok(headers[r.fixture].has(col), `${op}: ${col} is not a ${r.fixture} column`);
  }
  assert.equal(PAUL_OPERATIONS.some((op) => op in CATALOGUE_RECIPES), false, "Paul's operations are judged on probes, never on a recipe");
});

test('UT-PRODE2E-6059: a chart payload passes only with data and no error', () => {
  assert.equal(judgeRenderPayload({ type: 'boxplot', data: [{ x: 1 }] }).ok, true);
  assert.equal(judgeRenderPayload({ type: 'heatmap', data: { z: [[1]] } }).ok, true);
  assert.equal(judgeRenderPayload({ type: 'boxplot', data: [], error: 'binding columns not found' }).ok, false);
  assert.equal(judgeRenderPayload({ type: 'boxplot', data: [] }).ok, false);
  assert.equal(judgeRenderPayload({ type: 'heatmap', data: {} }).ok, false);
  assert.equal(judgeRenderPayload({ type: 'boxplot' }).ok, false, 'no data key is not a chart');
  assert.equal(judgeRenderPayload(null).ok, false);
});

test('UT-PRODE2E-6060: only SUCCEEDED passes the run check; FAILED, refused, timed-out and un-replayed DEDUPED all fail', () => {
  assert.equal(judgeRunStatus('SUCCEEDED', null).ok, true);
  for (const s of ['FAILED', 'REFUSED', 'TIMEOUT', 'DEDUPED'] as const) assert.equal(judgeRunStatus(s, 'x').ok, false, s);
});

// ── run driver ──────────────────────────────────────────────────────────

const scope = { analysisId: 'va-1', snapshotId: 'ref-1', datasetId: DS2, filters: [] };
const req = { ruleId: 'rule-1', runKind: 'STATISTICAL', operationId: 'stats.chi_square', roleBindings: { rowColumn: 'sexe', columnColumn: 'rechutes' }, operationParams: {} };
const driverOf = (f: ReturnType<typeof fakePlatform>) =>
  createRunDriver({ client: f.client, workspaceId: WS, projectId: 'proj-1', sapVersionId: 'sapv-1', timing: FAST, ...fakeClock() });

test('UT-PRODE2E-6061: a DEDUPED STATISTICAL run is re-executed from its canonical record and the FRESH run is judged', async () => {
  const f = fakePlatform({ dedupOnSubmit: true });
  const out = await driverOf(f).run(req, scope);
  assert.equal(out.status, 'SUCCEEDED');
  assert.equal(out.deduped, true);
  assert.equal(out.reExecuted, true);
  const replay = f.calls.find((c) => c.url.endsWith('/re-execute'))!;
  assert.ok(replay, 're-execute was called');
  assert.deepEqual(replay.data, { projectId: 'proj-1' });
  assert.notEqual(out.runId, out.submittedRunId);
  assert.ok(replay.url.includes('/rule-runs/run-1/'), 'replays the CANONICAL run, not the deduped row');
});

test('UT-PRODE2E-6062: a DEDUPED non-STATISTICAL run is judged on its canonical and says deduped; a replay that dedups again never passes', async () => {
  const f = fakePlatform({ dedupOnSubmit: true });
  const out = await driverOf(f).run({ ...req, runKind: 'DESCRIBE' }, scope);
  assert.equal(out.status, 'SUCCEEDED');
  assert.deepEqual([out.deduped, out.reExecuted], [true, false]);
  assert.equal(f.calls.some((c) => c.url.endsWith('/re-execute')), false);
  const again = await driverOf(fakePlatform({ dedupOnSubmit: true, replayStatus: 'DEDUPED' })).run(req, scope);
  assert.equal(again.status, 'DEDUPED');
  assert.equal(judgeRunStatus(again.status, again.detail).ok, false);
});

test('UT-PRODE2E-6063: a refused submission is REFUSED with its status, code and message — never the rest of the response body', async () => {
  const out = await driverOf(fakePlatform({ submitStatus: 422 })).run(req, scope);
  assert.equal(out.status, 'REFUSED');
  assert.match(out.detail!, /HTTP 422 SAP_VERSION_REQUIRED/);
  assert.equal(out.detail!.includes('SECRET-ROW'), false);
});

test('UT-PRODE2E-6064: a run that never leaves QUEUED is a TIMEOUT within the bounded wait', async () => {
  const out = await driverOf(fakePlatform({ runStatus: 'QUEUED' })).run(req, scope);
  assert.equal(out.status, 'TIMEOUT');
  const failed = await driverOf(fakePlatform({ runStatus: 'FAILED' })).run(req, scope);
  assert.equal(failed.status, 'FAILED');
});

test('UT-PRODE2E-6065: the chart check finds the recommended spec of THIS run and waits for a ready payload', async () => {
  const f = fakePlatform();
  const d = driverOf(f);
  const out = await d.run(req, scope);
  const chart = await d.chart(out.runId!, 'va-1');
  assert.equal(chart.state, 'rendered');
  assert.equal(chartFailure(chart), null);
  const none = await driverOf(fakePlatform({ mint: false }));
  const r2 = await none.run(req, scope);
  assert.equal((await none.chart(r2.runId!, 'va-1')).state, 'not-minted');
});

test('UT-PRODE2E-6066: a render that never becomes ready fails with the lineage diagnostic — the stale artifact never passes it', async () => {
  const d = driverOf(fakePlatform({ renderReady: false }));
  const out = await d.run(req, scope);
  const chart = await d.chart(out.runId!, 'va-1');
  assert.equal(chart.state, 'never-ready');
  assert.match(chartFailure(chart)!, /never reached ready \(lineage artifact ready: binding columns not found\)/);
});

test('UT-PRODE2E-6067: a ready render whose payload is an error or empty is a failure', async () => {
  const d = driverOf(fakePlatform({ payload: { type: 'boxplot', data: [], error: 'binding columns not found' } }));
  const out = await d.run(req, scope);
  assert.match(chartFailure(await d.chart(out.runId!, 'va-1'))!, /payload error: binding columns not found/);
});

// ── workbench ───────────────────────────────────────────────────────────

test('UT-PRODE2E-6068: the workbench reuses the project and SAP of the same name in THIS workspace, ignoring look-alikes', async () => {
  const f = fakePlatform({ existing: { project: true, sap: true } });
  const wb = await ensureWorkbench(f.client, WS, FIXTURES, [...PAUL_OPERATIONS]);
  assert.equal(wb.projectId, 'proj-old', 'not the same-named project in another workspace');
  assert.equal(wb.sapVersionId, 'sapv-old');
  assert.equal(f.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/projects')), false);
});

test('UT-PRODE2E-6069: the workbench creates what is missing, and a scope is created once then reused', async () => {
  const f = fakePlatform();
  const wb = await ensureWorkbench(f.client, WS, FIXTURES, [...PAUL_OPERATIONS]);
  assert.notEqual(wb.projectId, 'proj-other-name', 'a look-alike name is never reused');
  const filters = [{ column: 'group', operator: 'in' as const, value: ['HD'] }];
  const a = await wb.scope('tableau1', filters);
  const b = await wb.scope('tableau1', filters);
  assert.deepEqual(a, b);
  assert.equal(f.analyses.length, 1);
  assert.equal(f.analyses[0].name, scopeName('tableau1', filters));
  // a second suite run (fresh memo) finds the analysis and snapshot again instead of minting new ones
  const wb2 = await ensureWorkbench(f.client, WS, FIXTURES, [...PAUL_OPERATIONS]);
  const c = await wb2.scope('tableau1', filters);
  assert.deepEqual([c.analysisId, c.snapshotId], [a.analysisId, a.snapshotId]);
  assert.equal(f.projects.filter((p) => p.name === WORKBENCH_PROJECT_NAME).length, 1);
});

// ── executor outcomes ───────────────────────────────────────────────────

const exec = (f: ReturnType<typeof fakePlatform>, over: Parameters<typeof createPassRuleExecutor>[0] = {}) =>
  createPassRuleExecutor({ reference, timing: FAST, ...fakeClock(), ...over });

test('UT-PRODE2E-6070: a non-runnable rule and an operation with no recipe are not-evaluated with a reason, never pass', async () => {
  const f = fakePlatform();
  const e = exec(f);
  const a = validateCaseResult(await e(planned({ runnable: false }), ctxOf(f.client)));
  assert.equal(a.outcome, 'not-evaluated');
  const b = validateCaseResult(await e(planned({ operationId: 'stats.kaplan_meier' }), ctxOf(f.client)));
  assert.equal(b.outcome, 'not-evaluated');
  assert.match(b.reason!, /no recipe for stats\.kaplan_meier/);
  const c = validateCaseResult(await e(planned({ operationId: null, runKind: 'INTERPRET' }), ctxOf(f.client)));
  assert.equal(c.outcome, 'not-evaluated');
});

test('UT-PRODE2E-6071: a catalogue rule passes on SUCCEEDED + default chart rendered, and fails when the run FAILED', async () => {
  const ok = fakePlatform();
  const r = validateCaseResult(await exec(ok)(planned({}), ctxOf(ok.client)));
  assert.equal(r.outcome, 'pass', r.reason ?? '');
  assert.equal(r.facts.chartRendered, true);
  assert.equal(r.facts.runStatus, 'SUCCEEDED');
  const bad = fakePlatform({ runStatus: 'FAILED' });
  const r2 = validateCaseResult(await exec(bad)(planned({}), ctxOf(bad.client)));
  assert.equal(r2.outcome, 'fail');
});

test('UT-PRODE2E-6072: a default chart that is undeclared, or declared for the result surface only, is not-evaluated even when the run SUCCEEDED', async () => {
  const f = fakePlatform({ defaultChartNullFor: ['stratify.explicit_groups'] });
  const recipes = {
    'stratify.explicit_groups': { fixture: 'tableau2' as const, filters: [], roleBindings: {}, operationParams: {} },
    'stats.fisher_exact': { fixture: 'tableau2' as const, filters: [], roleBindings: { rowColumn: 'sexe', columnColumn: 'rechutes' }, operationParams: {} },
  };
  const e = exec(f, { recipes });
  const r = validateCaseResult(await e(planned({ operationId: 'stratify.explicit_groups', runKind: 'STRATIFY' }), ctxOf(f.client)));
  assert.equal(r.outcome, 'not-evaluated');
  assert.match(r.reason!, /declares no default chart/);
  assert.equal(r.facts.runStatus, 'SUCCEEDED');
  const r2 = validateCaseResult(await e(planned({ operationId: 'stats.fisher_exact' }), ctxOf(f.client)));
  assert.equal(r2.outcome, 'not-evaluated');
  assert.match(r2.reason!, /result-surface only/);
  assert.equal(chartDeclarationOf(null), 'none');
  assert.equal(chartDeclarationOf({ type: 'box_plot' }), 'gallery', 'omitted surfaces = result + gallery');
  assert.equal(chartDeclarationOf({ type: 'bar_chart', surfaces: ['result', 'gallery'] }), 'gallery');
  assert.equal(chartDeclarationOf({ type: 'scatter', surfaces: ['result'] }), 'result-surface-only');
});

const paulRows = (perturb?: { field: string; by: number }) => (body: any) => {
  const probe = probeForBody(reference, body);
  return probe ? rowsFromR(reference, probe, perturb) : [];
};

test("UT-PRODE2E-6073: a Paul case passes when every probe reproduces the slide and R, each probe running the case's own rule", async () => {
  const f = fakePlatform({ rowsFor: paulRows() });
  const r = validateCaseResult(await exec(f)(planned({ phase: 'paul-methods', operationId: 'stats.correlation' }), ctxOf(f.client)));
  assert.equal(r.outcome, 'pass', r.reason ?? '');
  assert.equal(r.facts.probes, 6);
  assert.equal(r.facts.checks, 12);
  assert.equal(r.facts.checksPassed, 12);
  assert.equal(r.facts['observed.spearman-ent059-sigg4.coefficient'], 0.780628115089281);
  assert.equal(f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/v1/rule-runs')).every((c) => c.data.ruleId === 'rule-1'), true, "every probe runs the case's OWN rule");
});

test("UT-PRODE2E-6074: a Paul case with one value off R, or one probe run FAILED, FAILS and names it; the chart is not part of Paul's verdict", async () => {
  const f = fakePlatform({ rowsFor: paulRows({ field: 'zStatistic', by: 1 + 1e-6 }) });
  const r = validateCaseResult(await exec(f)(planned({ phase: 'paul-methods', operationId: 'stats.dunn_posthoc' }), ctxOf(f.client)));
  assert.equal(r.outcome, 'fail');
  assert.match(r.reason!, /zStatistic\[HD vs IgG4-RD\] vs R/);
  assert.ok((r.reason ?? '').length <= 301, 'reason is bounded');
  const g = fakePlatform({ rowsFor: paulRows(), runStatus: 'FAILED' });
  const r2 = validateCaseResult(await exec(g)(planned({ phase: 'paul-methods', operationId: 'stats.kruskal_wallis' }), ctxOf(g.client)));
  assert.equal(r2.outcome, 'fail');
  assert.match(r2.reason!, /run FAILED/);
  const h = fakePlatform({ rowsFor: paulRows(), mint: false });
  const r3 = validateCaseResult(await exec(h)(planned({ phase: 'paul-methods', operationId: 'stats.mann_whitney_u' }), ctxOf(h.client)));
  assert.equal(r3.outcome, 'pass', r3.reason ?? '');
  assert.equal(h.calls.some((c) => c.url.includes('/candidates')), false);
});

test('UT-PRODE2E-6075: after 3 consecutive never-ready renders later cases stop waiting (breaker) but still FAIL; the daily executor is no longer the placeholder', async () => {
  const f = fakePlatform({ renderReady: false });
  const e = exec(f, { timing: { ...FAST, renderTimeoutMs: 50 } });
  const waits: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    const r = validateCaseResult(await e(planned({ id: `rule-${i}` }), ctxOf(f.client)));
    assert.equal(r.outcome, 'fail');
    waits.push(r.facts.renderWaitMs);
  }
  assert.deepEqual(waits, [50, 50, 50, 0, 0]);
  assert.notEqual(dailyExecutor, recordOnlyExecutor);
});

test("UT-PRODE2E-6076: a field-level submission refusal names its fields (bounded), and still never echoes other body content", async () => {
  const body = {
    message: 'Rule run rejected',
    errors: [
      { field: 'columnColumn', code: 'shape', message: "columnColumn requires a categorical column; 'rechutes' is numeric." },
      { field: 'rowColumn', code: 'shape', message: 'x'.repeat(400) },
    ],
    patientRows: ['SECRET-ROW'],
  };
  const out = await driverOf(fakePlatform({ submitStatus: 400, submitBody: body })).run(req, scope);
  assert.equal(out.status, 'REFUSED');
  assert.match(out.detail!, /^HTTP 400 Rule run rejected \[columnColumn: columnColumn requires a categorical column/);
  assert.equal(out.detail!.includes('SECRET-ROW'), false);
  assert.ok(out.detail!.length <= 'HTTP 400 '.length + 240, 'detail is bounded');
  assert.equal(refusalDetail(400, { message: 'm', errors: 'not-an-array' }), 'HTTP 400 m');
  assert.equal(refusalDetail(500, null), 'HTTP 500');
});

test('UT-PRODE2E-6077: every split rule asks its own question per run (unique questionKey), and contingency recipes bind categorical columns only', async () => {
  const split = CATALOGUE_RECIPES['split.exploration_holdout'];
  const a = recipeParams(split, { ruleId: 'rule-a', nonce: 'n1' });
  const b = recipeParams(split, { ruleId: 'rule-b', nonce: 'n1' });
  const c = recipeParams(split, { ruleId: 'rule-a', nonce: 'n2' });
  assert.equal(new Set([a.questionKey, b.questionKey, c.questionKey]).size, 3);
  assert.deepEqual([a.holdoutRatio, a.splitSeed], [0.5, 2319]);
  const f = fakePlatform();
  const e = exec(f, { recipes: { 'split.exploration_holdout': split }, nonce: 'day1' });
  for (const id of ['rule-a', 'rule-b']) await e(planned({ id, operationId: 'split.exploration_holdout' }), ctxOf(f.client));
  const keys = f.calls.filter((x) => x.method === 'POST' && x.url.endsWith('/api/v1/rule-runs')).map((x) => x.data.operationParams.questionKey);
  assert.deepEqual(keys, ['axi2319-prod-pass-rule-rule-a-day1', 'axi2319-prod-pass-rule-rule-b-day1']);
  const header = readFileSync(path.join(FIXTURES_DIR, 'final_tableau2_synthetic.csv'), 'utf8').split(/\r?\n/);
  const cols = header[0].split(',');
  const rows = header.slice(1).filter(Boolean).map((l) => l.split(','));
  const isCategorical = (col: string) => rows.some((r) => r[cols.indexOf(col)] !== '' && Number.isNaN(Number(r[cols.indexOf(col)])));
  for (const op of ['stats.chi_square', 'stats.fisher_exact']) {
    const { rowColumn, columnColumn } = CATALOGUE_RECIPES[op].roleBindings as Record<string, string>;
    assert.equal(isCategorical(rowColumn) && isCategorical(columnColumn), true, `${op} binds two categorical columns`);
  }
});

test('UT-PRODE2E-6078: a run the identity cannot read (403/404) is UNREADABLE at once — never a wait-out, never a pass from the dedup cache', async () => {
  const f = fakePlatform({ dedupOnSubmit: true, replayUnreadable: true });
  const out = await driverOf(f).run(req, scope);
  assert.equal(out.status, 'UNREADABLE');
  assert.deepEqual([out.deduped, out.reExecuted], [true, true]);
  assert.equal(out.detail, 'GET run HTTP 404');
  const polls = f.calls.filter((c) => c.method === 'GET' && c.url.includes(`/rule-runs/${out.runId}`));
  assert.equal(polls.length, 1, 'one read, not a poll until the timeout');
  const v = judgeRunStatus(out.status, out.detail);
  assert.equal(v.ok, false);
  assert.match((v as { why: string }).why, /run not readable by the suite identity \(GET run HTTP 404\)/);
});
