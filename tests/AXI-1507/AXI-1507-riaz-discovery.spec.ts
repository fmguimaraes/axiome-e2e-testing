import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { adminApi, asList, sleep, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import {
  FIXTURES_DIR, ingestFixture, datasetVersionHash, createViewAnalysis, type Tenant,
} from './harness/seed';

/**
 * AXI-1507 (Guided Biomarker Discovery) — the FIRST end-to-end execution of the
 * nine-step discovery composition against REAL data: the Riaz 2017 nivolumab
 * melanoma cohort (27 patients, 9 R / 18 NR, 24 immune genes, Pre + On biopsy)
 * already staged as the "Riaz 2017 — Nivolumab Melanoma" demo project
 * (`axiome-docs/demo/riaz-2017/README.md`).
 *
 * Headless, REST-only, the SAME contract the workbench calls
 * (`POST /v1/discovery/*` → governed run), following the programmatic path of
 * `Riaz-Guided-Questions-Runbook.md` (submit → drain the governed run → read
 * the rule-derived snapshots' rule runs and tables). Additive to the demo
 * project: it ingests one derived WIDE table (one row per patient, one column per
 * gene × timepoint — the shape `stats.screen_shortlist` and the cutoff proposals
 * need; the demo's long/DE tables cannot be split, screened or cut off) and
 * creates fresh view analyses under a per-run label, so it is re-runnable.
 *
 * PRECONDITIONS (stack, not spec): `make demo-up`; `npm run stage:riaz`; and the
 * `op:<operationId>` carrier rules seeded — `npx tsx scripts/create-statistical-rule.ts`
 * in `axiome-back` (descriptor-driven, idempotent; the discovery operations
 * declare `runKind: STATISTICAL`, so it covers them). Without it every discovery
 * step fails at submit with "no seeded system rule for stats.screen_shortlist" —
 * the same class of precondition the runbook records for the `DESC-*` carriers.
 *
 * Two independent serial blocks, on purpose: block A follows the plan through
 * screen → cutoffs → association and stops at the first defect; block B exercises
 * the guards and refusals (one plan per container, literature-cutoff block,
 * split min-n block, the missing cutoff-choice surface) on its own analyses so
 * they still execute when block A stops early.
 *
 * The whole observed record (ids, node statuses, tables, refusals) is written to
 * `riaz-discovery-trace.json` next to the other Riaz traces so the result is
 * readable without the Playwright report.
 *
 * Reads the population as "gene": the feature spec is written for gated flow
 * tables; here `measurementColumns` are the 48 `<GENE>_pre|_on` log2 CPM columns
 * and the comparison family is the single declared arm pair NR → R on `response`.
 *
 * ── AXI-1807: RE-AUTHORED against the one-click step path ────────────────────
 * The owner ruled that INSTANTIATING a discovery plan must run nothing, and
 * AXI-1779 implemented it: `POST /discovery/plans` now DECLARES the container, the
 * run, the nodes and the edges and issues no `StartRun`, so the instance run stays
 * `DRAFT` for ever and every declared node is unrun. This spec was written for the
 * previous model, in which instantiating executed d1–d10, and drained that run.
 *
 * Every step is therefore now SUBMITTED by the scientist, one click each, through
 * `POST /discovery/analyses/:va/steps/:nodeRef/submit` (AXI-1721 FR11) — a ONE-node
 * governed plan per step, followed by that run's own node. Nothing about the
 * SUBJECT of the assertions changed: the same shortlist, the same four cutoff
 * proposals, the same split ledger, the same lineage.
 *
 * Two assertions of the previous model could NOT be preserved, and are stated here
 * rather than dropped quietly:
 *
 *   1. AC2/AC6's QC half (`d1`–`d4` reach SUCCEEDED). The profile and the three
 *      `qc_check` guards live only in the instantiation run, and no product surface
 *      submits them: the step path builds a one-node plan of a requested OPERATION
 *      and the `qc_guards` step declares no operation ids. They are asserted as
 *      DECLARED-and-unattempted instead, and the gap is filed (see the AXI-1807
 *      report; filed as AXI-1819, also recorded in `tests/AXI-1775/AXI-1792-*`).
 *   2. The split's seed is no longer the scientist's declared `RIAZ.splitSeed`.
 *      AXI-1781 made the seed a SERVER-derived fact of the plan instance, and a
 *      plan that declares one can no longer submit its split step at all (the
 *      `test.fail()` GAP in block B pins that contradiction; filed as AXI-1820). The split tests run
 *      the step under the generated seed; every per-class count they assert is
 *      stratified and therefore seed-independent.
 */

const RIAZ = {
  workspace: 'Public Datasets — IO Benchmarks',
  project: 'Riaz 2017 — Nivolumab Melanoma',
  fixture: 'riaz2017_immune_wide.csv',
  outcomeColumn: 'response',
  // The split's declared unit is the PERSON, and the platform will not guess which
  // column identifies one (NFR4) — exactly as it will not generate the seed.
  patientKeyColumn: 'patient_id',
  // WHICH class the cut-points are proposed FOR, and the population the reference
  // proposal quantiles — both required by the kernel with no default, because a
  // cut-point separates a population the author names (FR12).
  outcomePositiveLevel: 'R',
  referenceGroup: 'NR',
  comparisons: [{ from: 'NR', to: 'R' }],
  rankBy: 'qValue',
  splitSeed: 4172,
  // 30 % holdout of 9 responders ≈ 3 < minPatientsPerClass 5 → the split MUST
  // block naming the class (FR5 / EC4) — the natural Riaz edge case.
  splitPolicy: { holdoutRatio: 0.3, minPatientsPerArm: 5, minPatientsPerClass: 5 },
};

/**
 * The authored guiding questions. REAL question prose, never placeholders (AXI-1596): the
 * platform persists the question on the plan instance and reads it back through the
 * view-analysis (`guidingQuestion`), so a placeholder would make that read-back assertion
 * vacuous. One per analysis; the second plan on a container is refused, so its question is
 * never persisted.
 */
const QUESTIONS = {
  a: 'Which immune-panel transcripts (Pre or On biopsy) are associated with response to nivolumab (R vs NR) in the Riaz 2017 cohort?',
  b: 'Which immune-panel transcripts separate nivolumab responders from non-responders in the Riaz 2017 melanoma cohort when a sealed holdout is requested but its responder arm is too small to be valid?',
  c: 'Do baseline (Pre) or on-treatment (On) immune-panel transcripts better discriminate nivolumab responders from non-responders in the Riaz 2017 melanoma cohort?',
  cRepeat: 'Is on-treatment expression of the 24-gene immune panel associated with RECIST response to nivolumab in the Riaz 2017 cohort?',
  d: 'Which immune-panel transcripts separate nivolumab responders from non-responders in the Riaz 2017 melanoma cohort, screened on an exploration arm with a sealed validation holdout?',
};

/** AXI-1807 — the operations each step runs, as the one-click submit names them. */
const SPLIT_OP = 'split.exploration_holdout';
const SCREEN_OP = 'stats.screen_shortlist';
const CUTOFF_OPS = ['stats.cutoff_roc_youden', 'stats.cutoff_maxstat', 'stats.cutoff_distribution', 'stats.cutoff_reference'] as const;

/** The AXI-1720 dataset roles the split step binds (`role:subject`, `role:outcome`) — Riaz's own. */
const RIAZ_ROLES = {
  outcome: { state: 'declared', column: RIAZ.outcomeColumn, outcomeKind: 'binary' },
  subject: { state: 'declared', column: RIAZ.patientKeyColumn },
  timepoint: { state: 'declared_uncaptured', reason: 'AXI-1507 e2e: Pre and On are columns, not rows' },
  representation: { state: 'declared_uncaptured', reason: 'AXI-1507 e2e: bulk RNA-seq log2 CPM' },
  batch: { state: 'declared_uncaptured', reason: 'AXI-1507 e2e: none recorded upstream' },
  site: { state: 'declared_uncaptured', reason: 'AXI-1507 e2e: single cohort' },
};

const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'CANCELLED']);
const LABEL = `riaz-disc-${Date.now().toString(36)}`;
const TRACE_PATH = resolve(
  process.env.STAGING_RIAZ_DISCOVERY_TRACE?.trim()
    || join(process.cwd(), '..', 'axiome-docs', 'demo', 'riaz-2017', 'riaz-discovery-trace.json'),
);

/** `error` is the node's own `StepFailed` reason (governed-execution.message.controller `toNodeStatus`). */
interface NodeStatus { nodeId: string; status: string; error?: string | null; [k: string]: unknown }
interface RunStatus { runId: string; status: string; runStatus?: string; nodes: NodeStatus[]; failReason?: string | null; [k: string]: unknown }
interface RuleRunRecord { id: string; planNode: string | null; operationId: string | null; runKind: string; status: string; summary: unknown; columns: string[]; rows: Array<Record<string, unknown>>; producedSnapshotId: string; parentSnapshotId: string | null; runFingerprint: string | null; dedupedFromRunId: string | null; snapshotName: string }
interface Ctx { api: Api; t: Tenant; projectId: string; datasetId: string; hash: string; measurementColumns: string[] }

/** Merge one block's record into the shared trace file (blocks may run in different workers). */
function writeTrace(block: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(TRACE_PATH), { recursive: true });
  let current: Record<string, unknown> = {};
  try { if (existsSync(TRACE_PATH)) current = JSON.parse(readFileSync(TRACE_PATH, 'utf8')); } catch { current = {}; }
  // Blocks run in separate workers (each with its own LABEL) — merge, never reset.
  current[block] = { label: LABEL, at: new Date().toISOString(), ...record };
  writeFileSync(TRACE_PATH, JSON.stringify(current, null, 2));
  console.log(`[AXI-1507 riaz] ${block} written to ${TRACE_PATH}`);
}

/** The Riaz tenant: the workspace of that name whose project list holds the Riaz project. */
async function resolveRiazTenant(a: Api): Promise<{ t: Tenant; projectId: string }> {
  const ws = asList((await a.get('/api/v1/workspaces?limit=100')).body).filter((w: any) => w.name === RIAZ.workspace);
  expect(ws.length, `workspace "${RIAZ.workspace}" exists`).toBeGreaterThan(0);
  for (const w of ws) {
    const projects = asList((await a.get(`/api/v1/projects?workspaceId=${w.id}&limit=100`, workspaceHeader(w.id))).body);
    const p = projects.find((x: any) => x.name === RIAZ.project);
    if (p) return { t: { orgId: w.ownerOrganizationId, workspaceId: w.id, headers: workspaceHeader(w.id) }, projectId: p.id };
  }
  throw new Error(`project "${RIAZ.project}" not found in any "${RIAZ.workspace}" workspace — run stage:riaz first`);
}

async function ensureLinked(a: Api, tn: Tenant, pid: string, dsId: string): Promise<void> {
  const linked = asList((await a.get(`/api/v1/projects/${pid}/datasets`, tn.headers)).body).some((l: any) => l.datasetId === dsId);
  if (!linked) await a.post(`/api/v1/projects/${pid}/datasets`, { datasetId: dsId }, tn.headers);
}

/** Tenant + WIDE dataset + link, shared by both blocks (idempotent: ingestion reuses by filename). */
async function bootstrap(): Promise<Ctx> {
  const api = await adminApi();
  const { t, projectId } = await resolveRiazTenant(api);
  const datasetId = await ingestFixture(api, t, RIAZ.fixture);
  const hash = await datasetVersionHash(api, t, datasetId);
  await ensureLinked(api, t, projectId, datasetId);
  const measurementColumns = readFileSync(join(FIXTURES_DIR, RIAZ.fixture), 'utf8').split('\n')[0].trim().split(',')
    .filter((c) => c.endsWith('_pre') || c.endsWith('_on'));
  return { api, t, projectId, datasetId, hash, measurementColumns };
}

/** Riaz's real context, with the two fields the RNA-seq pack never captured declared as such (FR1). */
function riazEnvelopeFields(): Record<string, unknown> {
  const declared = (value: string) => ({ state: 'declared', value });
  const uncaptured = (reason: string) => ({ state: 'declared_uncaptured', reason });
  return {
    tissue: declared('melanoma tumour biopsy'),
    disease: declared('metastatic melanoma (BMS038, nivolumab)'),
    panel: declared('24-gene immune panel, log2 CPM (RNA-seq)'),
    gateDefinition: uncaptured('bulk RNA-seq: no gating step exists upstream of this table'),
    denominator: uncaptured('log2 CPM is library-size normalised; no parent population denominator'),
    timepoint: declared('Pre and On biopsy (paired, per patient)'),
    cohort: declared('27 patients with both biopsies and a clean RECIST call'),
  };
}

async function bindEnvelope(c: Ctx, viewAnalysisId: string) {
  return c.api.post(`/api/v1/discovery/analyses/${viewAnalysisId}/envelope`, { viewAnalysisId, projectId: c.projectId, fields: riazEnvelopeFields() }, c.t.headers);
}

/** Declares the split thresholds and approves the config hash — idempotent (409 "already approved" is success). */
async function ensureApprovedConfig(c: Ctx, splitPolicy: Record<string, number> = RIAZ.splitPolicy): Promise<Record<string, unknown>> {
  const policy = await c.api.post(`/api/v1/workspaces/${c.t.workspaceId}/analysis-policy`, {
    entries: { 'split.exploration_holdout': Object.fromEntries(Object.entries(splitPolicy).map(([k, v]) => [k, { value: v, locked: false }])) },
  }, c.t.headers);
  const cfg = await c.api.get('/api/v1/discovery/config', c.t.headers);
  const approval = await c.api.post('/api/v1/discovery/config/approvals', { configHash: cfg.body?.configHash, notes: `${LABEL} Riaz e2e` }, c.t.headers);
  const alreadyApproved = approval.status === 409 && /already approved/.test(JSON.stringify(approval.body));
  expect(policy.status, `analysis-policy: ${JSON.stringify(policy.body)}`).toBeLessThan(300);
  expect(approval.status < 300 || alreadyApproved, `approval: ${JSON.stringify(approval.body)}`).toBe(true);
  return { policy: policy.status, configHash: cfg.body?.configHash, approval: approval.status, alreadyApproved };
}

function planBody(c: Ctx, viewAnalysisId: string, questionKey: string, question: string, split?: { seed: number }) {
  return {
    viewAnalysisId, projectId: c.projectId, datasetId: c.datasetId, datasetVersionHash: c.hash, questionKey, question,
    takeSplit: !!split, ...(split ? { splitSeed: split.seed } : {}),
    measurementColumns: c.measurementColumns, comparisons: RIAZ.comparisons, rankBy: RIAZ.rankBy, outcomeColumn: RIAZ.outcomeColumn,
    patientKeyColumn: RIAZ.patientKeyColumn,
    outcomePositiveLevel: RIAZ.outcomePositiveLevel,
    referenceGroup: RIAZ.referenceGroup,
    // No `association`: this cohort carries no time-to-event column and no
    // dichotomised marker (that exists only after a cutoff CHOICE is captured, and
    // FR13's capture has no surface — see the GAP test). The template therefore
    // omits those operations and STATES the omission in the plan's `declined` list,
    // rather than emitting nodes that could only refuse.
  };
}

/**
 * AXI-1807 — the AXI-1720 roles, confirmed once per (workspace, dataset). The route answers
 * only for an analysis that already holds a plan instance, so it is called after the first
 * instantiation of a block. Idempotent: an already-confirmed dataset is left alone.
 */
async function ensureConfirmedRoles(c: Ctx, viewAnalysisId: string): Promise<void> {
  const url = `/api/v1/discovery/analyses/${viewAnalysisId}/datasets/${c.datasetId}/roles`;
  const current = await c.api.get(url, c.t.headers);
  expect(current.status, `GET roles: ${JSON.stringify(current.body)}`).toBe(200);
  if (current.body?.confirmed) return;
  const put = await c.api.ctx.put(`${process.env.API_BASE_URL ?? 'http://localhost:3000'}${url}`, {
    data: { roles: RIAZ_ROLES, confirm: true }, headers: c.t.headers,
  });
  expect(put.status(), await put.text()).toBeLessThan(300);
}

/**
 * AXI-1807 (FR11) — the scientist's one click on a step. `submit` re-resolves server-side and
 * refuses unless every slot is bound; a refusal is a 200-family output, never a throw, so it is
 * returned for the caller to assert on rather than swallowed.
 */
async function submitStep(
  c: Ctx, viewAnalysisId: string, nodeRef: string, operationId: string, extra: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const res = await c.api.post(`/api/v1/discovery/analyses/${viewAnalysisId}/steps/${nodeRef}/submit`, {
    operationId, datasetId: c.datasetId, projectId: c.projectId, datasetVersionHash: c.hash, ...extra,
  }, c.t.headers);
  return { status: res.status, body: res.body };
}

/**
 * Submit a step and drain ITS OWN governed run. Each step run carries the engine's appended
 * `__interpretation` node (AXI-1721 D5), which halts AWAITING_APPROVAL — `drain` already
 * approves that, so the step's operation node is followed to a verdict exactly as before.
 */
async function runStep(
  c: Ctx, viewAnalysisId: string, nodeRef: string, operationId: string, extra: Record<string, unknown> = {},
): Promise<{ runId: string; nodeId: string; run: RunStatus; bindingSources: Record<string, string> }> {
  const res = await submitStep(c, viewAnalysisId, nodeRef, operationId, extra);
  expect(res.status, `submit ${nodeRef}/${operationId}: ${JSON.stringify(res.body)}`).toBe(201);
  expect(res.body.submitted, `step ${nodeRef}/${operationId} refused: ${JSON.stringify(res.body.reasons)}`).toBe(true);
  const run = await drain(c, res.body.runId);
  return { runId: res.body.runId as string, nodeId: res.body.nodeId as string, run, bindingSources: res.body.bindingSources ?? {} };
}

async function drain(c: Ctx, runId: string): Promise<RunStatus> {
  let status: RunStatus | undefined;
  for (let i = 0; i < 120; i++) {
    status = (await c.api.get<RunStatus>(`/api/v1/governed-execution/status?projectId=${c.projectId}&runId=${runId}`, c.t.headers)).body;
    const nodes = status?.nodes ?? [];
    for (const n of nodes.filter((n) => n.status === 'AWAITING_APPROVAL')) {
      await c.api.post('/api/v1/governed-execution/resolve', { projectId: c.projectId, runId, nodeId: n.nodeId, approved: true, note: 'AXI-1507 Riaz e2e' }, c.t.headers);
    }
    if (nodes.length > 0 && nodes.every((n) => SETTLED.has(n.status))) break;
    await sleep(2_500);
  }
  if (!status) throw new Error('no run status returned');
  return status;
}

/** Every rule-derived snapshot's rule run + table on an analysis (runbook `collect`). */
async function collect(c: Ctx, viewAnalysisId: string, runId: string): Promise<RuleRunRecord[]> {
  const snaps = asList((await c.api.get(`/api/v1/view-analyses/${viewAnalysisId}/snapshots?page=1&limit=100`, c.t.headers)).body);
  const out: RuleRunRecord[] = [];
  for (const s of snaps.filter((s: any) => s.origin === 'rule_derived' && s.ruleRunId)) {
    const run = (await c.api.get(`/api/v1/rule-runs/${s.ruleRunId}`, c.t.headers)).body;
    const table = await c.api.get(`/api/v1/rule-runs/${s.ruleRunId}/table?page=1&limit=200`, c.t.headers);
    const rows: Array<Record<string, unknown>> = table.status < 300 ? (table.body?.rows ?? []) : [];
    const columns: string[] = (table.body?.columns ?? Object.keys(rows[0] ?? {})).map((x: any) => (typeof x === 'string' ? x : x.name));
    out.push({
      id: run.id, runKind: run.runKind ?? '', operationId: run.operationId ?? null, status: run.status,
      planNode: run.materializedNodeId ? String(run.materializedNodeId).replace(`${runId}__`, '') : null,
      summary: run.summaryJson ?? null, columns, rows, producedSnapshotId: s.id, snapshotName: s.name,
      parentSnapshotId: s.parentSnapshotId ?? null, runFingerprint: run.runFingerprint ?? null, dedupedFromRunId: run.dedupedFromRunId ?? null,
    });
  }
  return out;
}

const shortId = (n: NodeStatus) => n.nodeId.replace(/^GR-[0-9a-f]+__/, '');
const byNode = (status: RunStatus, id: string) => status.nodes.find((n) => shortId(n) === id);
const nodeRows = (status: RunStatus) => status.nodes.map((n) => ({ id: shortId(n), status: n.status, error: n.error ?? null }));
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

/** Every snapshot on an analysis (rule-derived and the baseline filter snapshot alike). */
async function snapshotsOf(c: Ctx, viewAnalysisId: string): Promise<any[]> {
  return asList((await c.api.get(`/api/v1/view-analyses/${viewAnalysisId}/snapshots?page=1&limit=100`, c.t.headers)).body);
}

/** The analysis' baseline: the one snapshot with no parent (the plan's declared referent). */
function baselineOf(snaps: any[]): any {
  const roots = snaps.filter((s) => !s.parentSnapshotId);
  expect(roots, 'exactly one root snapshot (the baseline referent)').toHaveLength(1);
  return roots[0];
}

/** The authored question must read back from BOTH the instance and the analysis (FR31 / AXI-1594). */
async function expectQuestionReadBack(c: Ctx, instance: any, viewAnalysisId: string, question: string): Promise<void> {
  expect(instance.question, 'plan-instance response carries the authored question').toBe(question);
  const detail = await c.api.get(`/api/v1/view-analyses/${viewAnalysisId}`, c.t.headers);
  expect(detail.body?.guidingQuestion, 'view-analysis detail reads the authored question back').toBe(question);
  const list = asList((await c.api.get(`/api/v1/view-analyses?projectId=${c.projectId}&limit=100`, c.t.headers)).body);
  const listed = list.find((v: any) => v.id === viewAnalysisId);
  expect(listed?.guidingQuestion, 'view-analysis list reads the authored question back').toBe(question);
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('AXI-1507 Riaz — block A: the plan through screen → cutoffs → association', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  const rec: Record<string, unknown> = {};
  let c: Ctx;
  let analysisA: string;
  /** The scientist's OWN screen step run (AXI-1807) — the instantiation run runs nothing. */
  let screenA: { runId: string; nodeId: string; run: RunStatus };
  let cutoffA: Array<{ operationId: string; nodeId: string; status: string; error: string | null }> = [];
  let ruleRunsA: RuleRunRecord[] = [];

  test.beforeAll(async () => {
    c = await bootstrap();
    rec.tenant = { orgId: c.t.orgId, workspaceId: c.t.workspaceId, projectId: c.projectId, datasetId: c.datasetId, hash: c.hash, measurementColumns: c.measurementColumns.length };
  });
  test.afterAll(async () => {
    const runA = screenA?.run;
    rec.runA = runA ? { status: runA.status, runStatus: runA.runStatus, failReason: runA.failReason, nodes: nodeRows(runA) } : null;
    rec.ruleRunsA = ruleRunsA.map((r) => ({ ...r, rows: r.rows.slice(0, 60) }));
    writeTrace('blockA', rec);
    await c?.api.ctx.dispose();
  });

  test('0 — the Riaz WIDE per-patient table is ingested and linked to the demo project', { tag: ['@SI-014'] }, async () => {
    expect(c.measurementColumns, '24 genes × Pre/On').toHaveLength(48);
    expect(c.hash, 'dataset carries its content hash').toBeTruthy();
  });

  test('FR1/AC1 — the context envelope binds to a fresh Riaz analysis, uncaptured fields declared as such', { tag: ['@SI-045', '@SI-017'] }, async () => {
    analysisA = await createViewAnalysis(c.api, c.t, c.projectId, c.datasetId, `${LABEL} — discovery A (no split)`);
    const bound = await bindEnvelope(c, analysisA);
    rec.envelopeA = { analysisA, status: bound.status, body: bound.body };
    expect([200, 201], `bind: ${JSON.stringify(bound.body)}`).toContain(bound.status);
    const read = await c.api.get(`/api/v1/discovery/analyses/${analysisA}/envelope`, c.t.headers);
    expect(read.body, 'envelope readable after bind').toBeTruthy();
    expect(JSON.stringify(read.body)).toContain('declared_uncaptured');
  });

  test('FR29/FR30 — the split thresholds are declared and the discovery config approved for this workspace', { tag: ['@SI-017'] }, async () => {
    rec.config = await ensureApprovedConfig(c);
  });

  test('FR27/FR28 — the nine-step plan instantiates into analysis A over all 48 gene columns (NR → R)', { tag: ['@SI-045', '@SI-047'] }, async () => {
    const res = await c.api.post('/api/v1/discovery/plans', planBody(c, analysisA, `${LABEL}-a`, QUESTIONS.a), c.t.headers);
    rec.instantiateA = res.body;
    expect(res.status, `instantiate: ${JSON.stringify(res.body)}`).toBe(201);
    expect(res.body.instantiated, `refused: ${JSON.stringify(res.body.reasons)}`).toBe(true);
    expect(res.body.instance.viewAnalysisId).toBe(analysisA);
    expect(res.body.instance.nodeIds, 'd1 profile … d6 screen').toEqual(expect.arrayContaining(['d1', 'd6']));
    await expectQuestionReadBack(c, res.body.instance, analysisA, QUESTIONS.a);
    await ensureConfirmedRoles(c, analysisA);
  });

  /**
   * AXI-1807. What this test used to do — drain the instantiation run and assert that d1–d4
   * and d6 had all reached a verdict — describes the defect AXI-1779 removed: the platform
   * executed the whole template on a container the scientist had only just declared.
   *
   * The half that survives is the SCREEN, and it is stronger now: the scientist submits it and
   * it is HER run that reaches the verdict. The half that does not survive is the QC guards'
   * own verdicts (d2–d4) — they are declared and, with no surface that submits a `qc_check`
   * node, permanently unattempted. That is asserted as what it is, so the loss is visible in
   * the suite instead of being quietly deleted.
   */
  test('AC2/AC6 — the scientist\'s screen step reaches a verdict; the envelope and QC guards stand DECLARED and unattempted', { tag: ['@SI-047', '@SI-017'] }, async () => {
    const declared = await c.api.get(`/api/v1/discovery/analyses/${analysisA}/plan`, c.t.headers);
    expect(declared.status, JSON.stringify(declared.body)).toBe(200);
    const nodes: Array<{ nodeId: string; status: string | null; runId: string | null }> = declared.body.nodes;
    rec.declaredNodesA = nodes;
    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      const node = nodes.find((n) => n.nodeId === id);
      expect(node, `${id} (envelope / QC guard) is declared`).toBeTruthy();
      // AXI-1779: instantiating declares and starts nothing, so a declared node claims
      // no activity at all — not `PENDING` against the instance run, but nothing.
      expect(node, `${id} was never attempted by the platform`).toMatchObject({ status: null, runId: null });
    }

    screenA = await runStep(c, analysisA, 'screen', SCREEN_OP);
    const run = screenA.run;
    for (const n of run.nodes) expect(SETTLED.has(n.status), `node ${shortId(n)} settled (${n.status})`).toBe(true);
    const failed = run.nodes.filter((n) => n.status === 'FAILED').map((n) => `${shortId(n)}: ${n.error ?? 'no reason'}`);
    expect(failed, 'no node FAILED (BLOCKED is a verdict, FAILED is a defect)').toEqual([]);
    expect(byNode(run, 'd6')?.status, `screen d6: ${byNode(run, 'd6')?.error ?? ''}`).toMatch(/SUCCEEDED|REUSED/);
  });

  test('FR7/FR8/EC5 — the screen shortlist covers the family, BH-corrected, before/after correction distinguished', { tag: ['@SI-021', '@SI-022'] }, async () => {
    ruleRunsA = await collect(c, analysisA, screenA.runId);
    const screen = ruleRunsA.find((r) => r.operationId === 'stats.screen_shortlist' || r.planNode === 'd6');
    expect(screen, `a screen rule run exists among ${ruleRunsA.map((r) => `${r.planNode}:${r.operationId}`).join(', ')}`).toBeTruthy();
    expect(screen!.rows.length, '48 measurements × 1 comparison').toBe(48);
    const pKey = screen!.columns.find((x) => /^p_?[vV]alue$/.test(x));
    const qKey = screen!.columns.find((x) => /^q_?[vV]alue$/.test(x));
    expect(pKey && qKey, `p and q present in ${screen!.columns.join(', ')}`).toBeTruthy();
    for (const r of screen!.rows) expect(num(r[qKey!]), 'BH q ≥ p').toBeGreaterThanOrEqual(num(r[pKey!]) - 1e-12);
    const name = (r: Record<string, unknown>) => String(r.measurement ?? r.valueColumn ?? '');
    const minQ = (rows: Array<Record<string, unknown>>) => Math.min(...rows.map((r) => num(r[qKey!])));
    const onQ = minQ(screen!.rows.filter((r) => name(r).endsWith('_on')));
    const preQ = minQ(screen!.rows.filter((r) => name(r).endsWith('_pre')));
    rec.screenDirection = { minQ_on: onQ, minQ_pre: preQ };
    expect(onQ, 'the strongest signal is on-treatment, not baseline (Riaz 2017)').toBeLessThanOrEqual(preQ);
  });

  /**
   * AXI-1807: the four proposals are now the scientist's four clicks, each resolved against
   * the shortlist ROW she chose (FR11/FR12 — `upstream:d6` for the marker, `upstream:d7…d10`
   * for the positive class this plan declared). The subject is unchanged: all four proposal
   * operations reach a verdict over the same measurement, and a BLOCK is a verdict.
   */
  test('AC7/FR11 — the four cutoff proposals reach a verdict over the same chosen measurement', { tag: ['@SI-021', '@SI-022'] }, async () => {
    const screen = ruleRunsA.find((r) => r.operationId === SCREEN_OP);
    expect(screen, 'the screen ran in the previous test').toBeTruthy();
    const top = screen!.rows.find((r) => Number(r.rank) === 1) ?? screen!.rows[0];
    const marker = String(top.measurement ?? top.valueColumn ?? '');
    expect(marker, 'the chosen shortlist row names a measurement').toBeTruthy();
    const selection = { kind: 'shortlist_row', nodeId: 'd6', runId: screenA.runId, values: { marker } };

    cutoffA = [];
    for (const operationId of CUTOFF_OPS) {
      const { nodeId, run } = await runStep(c, analysisA, 'cutoff', operationId, { selection });
      const node = byNode(run, nodeId);
      cutoffA.push({ operationId, nodeId, status: node?.status ?? 'missing', error: node?.error ?? null });
    }
    rec.cutoffs = { marker, proposals: cutoffA };
    expect(cutoffA.map((x) => x.nodeId), 'the four cutoff proposal nodes, one per declared operation').toEqual(['d7', 'd8', 'd9', 'd10']);
    for (const x of cutoffA) expect(x.status, `${x.nodeId} (${x.operationId}): ${x.error ?? ''}`).toMatch(/SUCCEEDED|REUSED|BLOCKED/);
  });

  test('FR16/FR17/FR18 — the association operations are OMITTED and the omission is stated, not emitted as a node that could only refuse', { tag: ['@SI-021'] }, async () => {
    const declined = (rec.instantiateA as any).instance?.declined ?? (rec.instantiateA as any).declined ?? null;
    // AXI-1807: read off the DECLARED node list, which is where "what the template emitted"
    // has always lived; before AXI-1779 it happened to be observable on the platform's own run.
    const declaredIds: string[] = (rec.instantiateA as any).instance.nodeIds;
    const associationNodes = declaredIds.filter((id) => /^d(11|12|13)$/.test(id));
    rec.association = { declined, nodes: associationNodes };
    // Riaz 2017's immune panel carries no time/event column, and the dichotomised
    // marker Fisher would cross-tabulate exists only once a cutoff CHOICE has been
    // captured — which has no surface (see the FR13/FR19 GAP test).
    expect(associationNodes, 'no unrunnable association node was emitted').toEqual([]);
  });

  // AC14 / NFR7 — lineage, not statuses. With NO split there is no exploration arm to
  // narrow onto, so the honest referent of every step is the analysis' one baseline
  // snapshot; what must hold is that each result snapshot is a real edge INTO that
  // baseline (the plan is not a set of dangling, parentless results).
  test('AC14/NFR7 — no split: every step result derives from the baseline snapshot (lineage edge), nothing is narrowed', { tag: ['@SI-022', '@SI-045'] }, async () => {
    ruleRunsA = await collect(c, analysisA, screenA.runId);
    const snaps = await snapshotsOf(c, analysisA);
    const baseline = baselineOf(snaps);
    const derived = snaps.filter((s) => s.origin === 'rule_derived');
    rec.lineageA = { baseline: baseline.id, derived: derived.map((s) => ({ id: s.id, name: s.name, parent: s.parentSnapshotId })) };
    expect(derived.length, 'the plan produced result snapshots').toBeGreaterThan(0);
    for (const s of derived) expect(s.parentSnapshotId, `${s.name} derives from the baseline`).toBe(baseline.id);
    expect(snaps.some((s) => s.origin === 'filter' && s.parentSnapshotId), 'no exploration-arm snapshot without a split').toBe(false);
    const screen = ruleRunsA.find((r) => r.operationId === 'stats.screen_shortlist');
    rec.screenA = { runFingerprint: screen?.runFingerprint, dedupedFromRunId: screen?.dedupedFromRunId };
    expect(screen?.runFingerprint, 'the screen run is fingerprinted').toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('AXI-1507 Riaz — block B: guards and refusals', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  const rec: Record<string, unknown> = {};
  let c: Ctx;
  let splitRun: RuleRunRecord | null = null;
  let freeAnalysis = '';
  let freeRunId = '';
  let refusedAnalysis = '';
  // The TAKEN-split plan, shared by the two tests that follow it.
  let taken: { analysis: string; run: RunStatus; ruleRuns: RuleRunRecord[]; snaps: any[]; baseline: any; ledger: any; splitRun: RuleRunRecord; freeScreen: RuleRunRecord } | null = null;

  test.beforeAll(async () => {
    c = await bootstrap();
    rec.config = await ensureApprovedConfig(c);
  });
  test.afterAll(async () => {
    writeTrace('blockB', rec);
    await c?.api.ctx.dispose();
  });

  test('FR27 — a second plan on the same analysis is refused (one plan per container)', { tag: ['@SI-045'] }, async () => {
    const analysisC = await createViewAnalysis(c.api, c.t, c.projectId, c.datasetId, `${LABEL} — discovery C (container)`);
    await bindEnvelope(c, analysisC);
    const first = await c.api.post('/api/v1/discovery/plans', planBody(c, analysisC, `${LABEL}-c1`, QUESTIONS.c), c.t.headers);
    const second = await c.api.post('/api/v1/discovery/plans', planBody(c, analysisC, `${LABEL}-c2`, QUESTIONS.cRepeat), c.t.headers);
    rec.onePlanPerContainer = { first: first.body, second: second.body };
    expect(first.body.instantiated, `first: ${JSON.stringify(first.body.reasons)}`).toBe(true);
    freeAnalysis = analysisC;
    freeRunId = first.body.instance.runId;
    await expectQuestionReadBack(c, first.body.instance, analysisC, QUESTIONS.c);
    expect(second.body.instantiated).toBe(false);
    expect(second.body.reasons.join(' ')).toMatch(/already holds an instantiated discovery plan/);
    // The refused plan must not overwrite the question the container already carries.
    const detail = await c.api.get(`/api/v1/view-analyses/${analysisC}`, c.t.headers);
    expect(detail.body?.guidingQuestion, 'the refused repeat did not replace the authored question').toBe(QUESTIONS.c);
    await ensureConfirmedRoles(c, analysisC);
  });

  /**
   * AXI-1807 — GAP, expected to FAIL until the contradiction below is ruled on.
   *
   * AXI-1507 FR3/NFR7 makes the seed the SCIENTIST'S declaration: `POST /discovery/plans`
   * refuses a `takeSplit` question that declares none ("Axiome will not generate the seed
   * for you"). AXI-1781 (D2, owner ruling 2026-09-28) makes the seed the SERVER'S derived
   * fact of the plan instance, and `commitSplitSeed` refuses a submit whose resolved seed is
   * not the one it records. A declared seed binds `upstream:d5`, which outranks `generated:`,
   * so the two authorities disagree by construction and the split step of a `takeSplit` plan
   * can never be submitted — the plan instantiates and then cannot run its own split.
   *
   * Recorded as an expected failure (this spec's `test.fail()` precedent, AXI-1595/AXI-1632)
   * so that whichever way the ruling goes, this test moves (filed as AXI-1820). The other split tests below run
   * the step under the generated seed, which is the only path the product allows today.
   */
  test.fail('FR3/NFR7 vs AXI-1781 — GAP: a plan that DECLARES its split seed cannot submit its split step', { tag: ['@SI-045', '@SI-017'] }, async () => {
    const seeded = await createViewAnalysis(c.api, c.t, c.projectId, c.datasetId, `${LABEL} — discovery S (declared seed)`);
    await bindEnvelope(c, seeded);
    const plan = await c.api.post('/api/v1/discovery/plans', planBody(c, seeded, `${LABEL}-s`, QUESTIONS.b, { seed: RIAZ.splitSeed }), c.t.headers);
    expect(plan.body.instantiated, `a declared seed is REQUIRED by FR3: ${JSON.stringify(plan.body.reasons)}`).toBe(true);
    const res = await submitStep(c, seeded, 'split', SPLIT_OP);
    rec.declaredSeedGap = { instantiated: plan.body.instantiated, submit: res.body };
    expect(res.body.submitted, `the declared seed is refused at submit: ${JSON.stringify(res.body.reasons)}`).toBe(true);
  });

  test('FR15/AC9/EC6 — a literature cutoff on a different unit scale is blocked with a reason and no cut-point', { tag: ['@SI-017', '@SI-010'] }, async () => {
    const res = await c.api.post('/api/v1/rule-runs/cutoff-admission', {
      sourceType: 'literature',
      citation: 'Illustrative: PDCD1 > 12 TPM (different normalisation than this log2 CPM table)',
      cutPoint: { operator: '>', valueLow: 12 },
      cited: { axes: { unitScale: 'TPM', valuePresent: true, derivationKnown: true } },
      dataset: { axes: { unitScale: 'log2_cpm', valuePresent: true, derivationKnown: true } },
    }, c.t.headers);
    rec.literatureCutoff = { status: res.status, body: res.body };
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cutPoint ?? res.body.admittedCutPoint ?? null, 'no cut-point emitted').toBeNull();
    expect(JSON.stringify(res.body)).toMatch(/block|refus|not applied|mismatch/i);
  });

  test('FR13/FR19 — GAP: the cutoff CHOICE has no REST surface, so a candidate cannot be declared headlessly', { tag: ['@SI-015', '@SI-010'] }, async () => {
    // `DeclareCandidateDto` requires a `cutoffChoiceId`; `CutoffChoiceService.capture`
    // has no controller and no message pattern (cohort-splits.module.ts: "the
    // HTTP/message surface belongs to the story that…"). Recorded as the boundary
    // this e2e stops at, not silently skipped.
    const probe = await c.api.post('/api/v1/discovery/cutoff-choices', {}, c.t.headers);
    const zero = '00000000-0000-0000-0000-000000000000';
    const declare = await c.api.post(`/api/v1/workspaces/${c.t.workspaceId}/candidate-validations/declare`, {
      decisionDraftId: zero, cutoffChoiceId: zero, citedAssociationRunId: zero, discoverySnapshotId: zero,
    }, c.t.headers);
    rec.candidateGap = { cutoffChoiceRoute: probe.status, declareWithoutChoice: { status: declare.status, body: declare.body } };
    expect(probe.status, 'no cutoff-choice route exists').toBe(404);
    expect(declare.status, 'declare refuses a candidate without a captured choice').toBeGreaterThanOrEqual(400);
  });

  test('FR3/NFR4/NFR7 — the 70/30 split step partitions PATIENTS, stratified by outcome, with every patient accounted for', { tag: ['@SI-017', '@SI-022'] }, async () => {
    const analysisB = await createViewAnalysis(c.api, c.t, c.projectId, c.datasetId, `${LABEL} — discovery B (split)`);
    refusedAnalysis = analysisB;
    await bindEnvelope(c, analysisB);
    const res = await c.api.post('/api/v1/discovery/plans', planBody(c, analysisB, `${LABEL}-b`, QUESTIONS.b), c.t.headers);
    rec.instantiateB = res.body;
    expect(res.body.instantiated, `refused: ${JSON.stringify(res.body.reasons)}`).toBe(true);
    await expectQuestionReadBack(c, res.body.instance, analysisB, QUESTIONS.b);
    // AXI-1807 — the SCIENTIST runs the split, one click, on a container where nothing has run.
    // The seed is the server's derived fact for this question (`generated:`, AXI-1781); the
    // partition is still stratified, so every per-class count asserted here is seed-independent.
    const { runId: splitRunId, nodeId, run: runB, bindingSources } = await runStep(c, analysisB, 'split', SPLIT_OP);
    rec.runB = { status: runB.status, nodes: nodeRows(runB), bindingSources };
    const split = byNode(runB, nodeId);
    expect(split, 'the split step ran its own d5 node').toBeTruthy();
    expect(nodeId, 'the step targets the template\'s split node').toBe('d5');
    // FR9 — every binding names where it came from. The seed is the SERVER's derived fact
    // (AXI-1781), the unit and the outcome are the confirmed dataset roles (AXI-1720), and
    // the three governed minimums are the customer's approved config (FR29) — nothing is
    // invented and nothing is client-asserted.
    expect(bindingSources.splitSeed, JSON.stringify(bindingSources)).toBe(`generated:${SPLIT_OP}.splitSeed`);
    expect(bindingSources.patientKey, JSON.stringify(bindingSources)).toBe('role:subject');
    expect(bindingSources.outcomeColumn, JSON.stringify(bindingSources)).toBe('role:outcome');
    for (const knob of ['holdoutRatio', 'minPatientsPerArm', 'minPatientsPerClass']) {
      expect(bindingSources[knob], `${knob} is the customer's approved config`).toBe(`policy:${SPLIT_OP}.${knob}`);
    }
    // The run COMPLETES: the refusal is a governed verdict recorded on the ledger
    // (summary.splitLedger), not a failed node — asserted below, not here.
    expect(split!.status, `split node: ${split!.error ?? ''}`).toMatch(/SUCCEEDED|REUSED/);

    splitRun = (await collect(c, analysisB, splitRunId))
      .find((r) => r.operationId === SPLIT_OP) ?? null;
    expect(splitRun, 'the split materialized its own arm table').toBeTruthy();
    rec.splitRun = { id: splitRun!.id, columns: splitRun!.columns, summary: splitRun!.summary, rows: splitRun!.rows };

    // The unit is the PERSON (NFR4): one row per patient, never per sample.
    const patients = splitRun!.rows.map((r) => String(r.patient));
    expect(new Set(patients).size, 'one row per patient, no patient in two arms').toBe(patients.length);
    expect(patients.length, 'all 27 Riaz patients are placed or discarded').toBe(27);
    for (const row of splitRun!.rows) {
      expect(String(row.arm), 'every row names a declared arm').toMatch(/^(exploration|holdout)$/);
      expect(String(row.outcomeClass), 'every patient carries the outcome it was stratified on').toMatch(/^(R|NR)$/);
    }
  });

  // FLIPPED by AXI-1595 (was `test.fail()` "GAP"): the governed per-class minimum IS now
  // graded against the MEASURED arms. Riaz's holdout carries 3 responders against a declared
  // minimum of 5, so the split is REFUSED — naming the arm, the class and the minimum — and a
  // refused split publishes NO exploration arm (Rule-Kernel-Architecture §4.31).
  test('FR5/EC4 — the governed per-class minimum is graded: the Riaz split is REFUSED naming arm and class, and publishes no arm', { tag: ['@SI-017', '@SI-022'] }, async () => {
    expect(splitRun, 'the split ran in the previous test').toBeTruthy();
    const ledger = (splitRun!.summary as any)?.splitLedger;
    rec.refusedLedger = ledger;
    expect(ledger, 'the run summary carries the split ledger').toBeTruthy();
    expect(ledger.graded, 'the partition was measured, so it was graded (not silently passed)').toBe(true);
    expect(ledger.taken, 'a holdout below the declared minimum is not taken').toBe(false);
    expect(ledger.cohortSplitId, 'a refused split writes no cohort_splits row').toBeFalsy();
    expect(ledger.explorationSnapshotId, 'a refused split publishes no exploration arm').toBeFalsy();
    const reasons: string[] = ledger.reasons ?? [];
    expect(reasons.length, 'the refusal states why').toBeGreaterThan(0);
    const why = reasons.join(' | ');
    expect(why, 'names the failing arm').toMatch(/arm 'holdout'/);
    expect(why, 'names the failing class').toMatch(/class 'R'/);
    expect(why, 'names the declared minimum').toMatch(new RegExp(`minimum of ${RIAZ.splitPolicy.minPatientsPerClass}\\b`));

    // Cross-check the ledger against the measured arm table it graded.
    const holdout = splitRun!.rows.filter((r) => String(r.arm) === 'holdout' && !r.discarded);
    const perClass = new Map<string, number>();
    for (const r of holdout) perClass.set(String(r.outcomeClass), (perClass.get(String(r.outcomeClass)) ?? 0) + 1);
    rec.holdoutPerClass = Object.fromEntries(perClass);
    expect(perClass.get('R'), 'the measured holdout really is below the minimum').toBeLessThan(RIAZ.splitPolicy.minPatientsPerClass);

    // Lineage of a REFUSED split: nothing is narrowed, so every step still derives from the
    // baseline and NO exploration snapshot exists (the confinement guard speaks instead).
    const snaps = await snapshotsOf(c, refusedAnalysis);
    const baseline = baselineOf(snaps);
    for (const s of snaps.filter((x) => x.origin === 'rule_derived')) {
      expect(s.parentSnapshotId, `${s.name} derives from the baseline (refused split ⇒ no arm)`).toBe(baseline.id);
    }
    expect(snaps.filter((s) => s.origin === 'filter' && s.parentSnapshotId), 'no exploration snapshot minted').toEqual([]);
  });

  // The split is TAKEN when the governed minimum is one the Riaz holdout clears (3 responders
  // ≥ 3). This is the scenario that proves the split CHANGES what comes next — the only
  // observation the earlier 15/15-green suite could not make (AXI-1596, AXI-1595 step 4).
  test('AC5/FR23 — a TAKEN split writes a ledger row and publishes the exploration arm as a filtered child snapshot', { tag: ['@SI-017', '@SI-022', '@SI-045'] }, async () => {
    test.setTimeout(600_000);
    // 1. the split-free reference: analysis C (from the container test) runs its screen step
    // with NO split taken — the comparison this test's "no dedupe" half needs.
    expect(freeAnalysis, 'the split-free reference plan was instantiated').toBeTruthy();
    const free = await runStep(c, freeAnalysis, 'screen', SCREEN_OP);
    freeRunId = free.runId;
    const freeRun = free.run;
    const freeRuns = await collect(c, freeAnalysis, freeRunId);
    const freeScreen = freeRuns.find((r) => r.operationId === SCREEN_OP);
    expect(freeScreen, `split-free screen exists among ${freeRuns.map((r) => r.operationId).join(',')}`).toBeTruthy();

    // 2. declare a minimum the holdout clears; restore the Riaz-realistic minimum afterwards.
    const relaxed = { ...RIAZ.splitPolicy, minPatientsPerClass: 3 };
    try {
      rec.relaxedConfig = await ensureApprovedConfig(c, relaxed);
      const analysisD = await createViewAnalysis(c.api, c.t, c.projectId, c.datasetId, `${LABEL} — discovery D (taken split)`);
      await bindEnvelope(c, analysisD);
      const res = await c.api.post('/api/v1/discovery/plans', planBody(c, analysisD, `${LABEL}-d`, QUESTIONS.d), c.t.headers);
      expect(res.body.instantiated, `refused: ${JSON.stringify(res.body.reasons)}`).toBe(true);
      await expectQuestionReadBack(c, res.body.instance, analysisD, QUESTIONS.d);
      const taking = await runStep(c, analysisD, 'split', SPLIT_OP);
      const runD = taking.run;
      rec.takenRun = { status: runD.status, nodes: nodeRows(runD), free: nodeRows(freeRun) };
      // What came AFTER the split is the next test's subject (AXI-1632); this one
      // asserts only what the split itself did.
      expect(byNode(runD, 'd5')?.status, 'the split node itself succeeded').toMatch(/SUCCEEDED|REUSED/);

      const ruleRuns = await collect(c, analysisD, taking.runId);
      const split = ruleRuns.find((r) => r.operationId === SPLIT_OP);
      expect(split, 'the split ran').toBeTruthy();
      const ledger = (split!.summary as any)?.splitLedger;
      rec.takenLedger = ledger;
      expect(ledger?.graded, `graded: ${JSON.stringify(ledger)}`).toBe(true);
      expect(ledger.taken, `taken: ${JSON.stringify(ledger)}`).toBe(true);
      expect(ledger.cohortSplitId, 'a cohort_splits ledger row').toBeTruthy();
      expect(ledger.explorationSnapshotId, 'the exploration arm is published').toBeTruthy();

      const snaps = await snapshotsOf(c, analysisD);
      const baseline = baselineOf(snaps);
      const arm = snaps.find((s) => s.id === ledger.explorationSnapshotId);
      expect(arm, 'the published arm is a snapshot of this analysis').toBeTruthy();
      expect(arm.origin, 'the arm is a plain filtered child snapshot').toBe('filter');
      expect(arm.parentSnapshotId, 'the arm derives from the split\'s own referent').toBe(baseline.id);
      const armPredicate = (arm.filters ?? []).find((f: any) => f.column === RIAZ.patientKeyColumn || f.field === RIAZ.patientKeyColumn);
      rec.armFilters = arm.filters;
      expect(armPredicate, `the arm carries an "in" predicate on ${RIAZ.patientKeyColumn}`).toBeTruthy();
      const armPatients: unknown[] = armPredicate.values ?? armPredicate.value ?? [];
      const exploration = new Set(split!.rows.filter((r) => String(r.arm) === 'exploration' && !r.discarded).map((r) => String(r.patient)));
      expect(new Set(armPatients.map(String)), 'the arm lists exactly the exploration patients').toEqual(exploration);
      // AXI-1807: WHICH patients land in which arm is the server-derived seed's business now
      // (AXI-1781), so the arm is asserted by what stratification fixes — it narrows, and it
      // narrows to exactly the patients the measured table calls `exploration`.
      expect(exploration.size, 'the exploration arm is a NARROWING of the 27-patient cohort').toBeLessThan(27);
      expect(exploration.size, 'and it is not empty').toBeGreaterThan(0);

      const splitSnap = snaps.find((s) => s.origin === 'rule_derived' && s.ruleRunId === split!.id);
      expect(splitSnap!.parentSnapshotId, 'the split is not narrowed onto itself').toBe(baseline.id);
      taken = { analysis: analysisD, run: runD, ruleRuns, snaps, baseline, ledger, splitRun: split!, freeScreen: freeScreen! };
    } finally {
      // Leave the workspace declaring the Riaz-realistic minimum the other tests rely on.
      rec.restoredConfig = await ensureApprovedConfig(c);
    }
  });

  // FLIPPED by AXI-1632 (was `test.fail()` — the defect this spec found on 2026-09-25):
  // AXI-1595 mints the exploration arm as an `origin: filter` snapshot stamped with
  // `ruleRunId = <the split's run>`, and `assertReferentEligible` (AXI-1423 / FR37) read that
  // run, saw a STATISTICAL operation with no `referentEligible: true` — the split's holdout
  // SEAL is exactly that absence — and refused the ARM. So the screen after a TAKEN split
  // FAILED and the four cutoffs + interpretation were BLOCKED (run GR-bfa2a7ac). AXI-1632
  // asks FR37 of the snapshot's provenance SHAPE instead: a snapshot that only NARROWS its
  // parent (origin `filter`, same dataset) answers with its parent's eligibility, while the
  // split's own `rule_derived` result — the table naming the sealed patients — stays refused.
  test('AC14/AC3/NFR7 — the steps after a TAKEN split derive from the exploration arm and do NOT dedupe onto the split-free plan', { tag: ['@SI-017', '@SI-022', '@SI-045'] }, async () => {
    test.setTimeout(900_000);
    expect(taken, 'the taken-split plan ran in the previous test').toBeTruthy();
    const { analysis: analysisD, ledger, freeScreen } = taken!;

    // AXI-1807 — the steps AFTER the split are the scientist's own clicks now: the screen on
    // the published arm, then the four cutoff proposals on the row she chose from it. Running
    // them here (rather than reading them off a platform-driven instantiation run) is what
    // makes the FR37 regression this test was written for observable at all: if the arm were
    // refused as a referent again, these submits would be the thing that failed.
    const screenD = await runStep(c, analysisD, 'screen', SCREEN_OP);
    expect(screenD.run.nodes.filter((n) => n.status === 'FAILED').map((n) => `${shortId(n)}: ${n.error}`), 'the screen on the ARM did not fail').toEqual([]);
    const afterSplit = await collect(c, analysisD, screenD.runId);
    const armScreen = afterSplit.find((r) => r.operationId === SCREEN_OP)!;
    const top = armScreen.rows.find((r) => Number(r.rank) === 1) ?? armScreen.rows[0];
    const selection = { kind: 'shortlist_row', nodeId: 'd6', runId: screenD.runId, values: { marker: String(top.measurement ?? top.valueColumn ?? '') } };
    for (const operationId of CUTOFF_OPS) {
      const { run, nodeId } = await runStep(c, analysisD, 'cutoff', operationId, { selection });
      expect(byNode(run, nodeId)?.status, `${operationId} on the arm: ${byNode(run, nodeId)?.error ?? ''}`).toMatch(/SUCCEEDED|REUSED|BLOCKED/);
    }

    const ruleRuns = await collect(c, analysisD, screenD.runId);
    // 3. LINEAGE: the split itself stays on the baseline (never narrowed onto its own output);
    // every step after it derives from the ARM, not the baseline.
    const downstream = ruleRuns.filter((r) => r.operationId === SCREEN_OP || /^stats\.cutoff_/.test(r.operationId ?? ''));
    expect(downstream.map((r) => r.operationId).sort(), 'screen + four cutoff proposals ran').toEqual([SCREEN_OP, ...CUTOFF_OPS].sort());
    rec.downstreamLineage = downstream.map((r) => ({ op: r.operationId, parent: r.parentSnapshotId }));
    for (const r of downstream) {
      expect(r.parentSnapshotId, `${r.operationId} derives from the exploration arm, not the baseline`).toBe(ledger.explorationSnapshotId);
    }

    // 4. NO DEDUPE: the split-bearing screen is its own run, with a different fingerprint.
    const screen = ruleRuns.find((r) => r.operationId === SCREEN_OP)!;
    rec.dedupe = { free: { id: freeScreen!.id, fp: freeScreen!.runFingerprint }, split: { id: screen.id, fp: screen.runFingerprint, deduped: screen.dedupedFromRunId } };
    expect(screen.runFingerprint, 'fingerprinted').toBeTruthy();
    expect(screen.runFingerprint, 'split-bearing screen fingerprint differs from the split-free screen').not.toBe(freeScreen!.runFingerprint);
    expect(screen.id, 'not the same run').not.toBe(freeScreen!.id);
    expect(screen.dedupedFromRunId, 'the split-bearing screen did not dedupe onto any earlier run').toBeNull();
    expect(byNode(screenD.run, 'd6')?.status, 'the screen executed rather than being REUSED').not.toBe('REUSED');
  });
});
