import { writeFileSync } from 'node:fs';
import { RestClient } from '../client/RestClient';
import { ensureIdentities } from '../identities/ensureIdentities';
import { ADMIN_HANDLE, SERVICE_HANDLE, recordTouched } from './context';
import { ensureDatasetStep, findExistingDataset } from './datasetIngestion';
import { listProjects, projectHeaders } from './projectProvisioning';
import { fetchSnapshots } from './snapshotStaging';
import { ensureMemberRole } from './workspaceMembership';
import { PROJECT, RIAZ_PAIRED_LONG_DATASET, WORKSPACE, riazFixture } from './stageRiaz';
import {
  ALL_RULES,
  CYTO_GENES,
  DEC_CODE,
  INT_CYTO_CODE,
  INT_RESP_CODE,
  QC_RULE_CODE,
  evaluateCyto,
  evaluateDecision,
  evaluateResp,
  type PairedGeneStat,
} from './riazGuidedRules';
import { asList, ensureRule, must } from '../rules/ensureRule';
import type { ProvisioningContext } from './context';

/**
 * `npm run stage:riaz-guided` — the guided, rule-bound workflow on the staged
 * Riaz 2017 project (run `stage:riaz` first). ../axiome-docs/demo/riaz-2017/Riaz-Guided-Rule-Workflow.md
 * is the operator doc; this file is the executable record.
 *
 *   1. bind the `immuno_oncology` semantic profile to the project and verify
 *      `patient_id` / `timepoint` are matched (the paired-operation gate);
 *   2. ingest + link the long paired immune dataset (`RIAZ_PAIRED_LONG_DATASET`);
 *   3. author + publish the four library rules (`riazGuidedRules.ts`);
 *   4. submit a hand-authored AnalysisPlan (qc_check citing RIAZ-QC-PAIRED-01,
 *      three paired t-tests — all / responders / non-responders — behind two
 *      cohort filters) as a governed run and drain it;
 *   5. read the paired-test tables, evaluate the INTERPRET + DECISION rules
 *      offline, approve the run's interpretation node, and record the
 *      human-approved DecisionDraft citing the rule-derived snapshots;
 *   6. write every id + deep link to `../axiome-docs/demo/riaz-2017/riaz-guided-trace.json`.
 *
 * Idempotent where the platform lets it be (profile, dataset, rules are
 * find-or-create). A governed run is NOT reusable by design (every plan
 * submit is a new run + a new "Guided: …" analysis), so each invocation adds
 * one run; `STAGING_RIAZ_GUIDED_REUSE_RUN=<runId>` skips the submit and
 * re-reads that run instead.
 */
export type DecisionDraftConfidence = 'low' | 'medium' | 'high';

const PROFILE_ID = 'immuno_oncology';
const QUESTION =
  'Does nivolumab induce an on-treatment cytotoxic / IFN-γ transcriptional program in melanoma, and is that induction confined to responders?';
const AUTHOR_HANDLE = 'cast-biologist'; // Marc Ottavi — the presenter
const FRONT_URL = (process.env.STAGING_FRONT_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
const TRACE_PATH = process.env.STAGING_RIAZ_GUIDED_TRACE?.trim() || '../axiome-docs/demo/riaz-2017/riaz-guided-trace.json';

const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'AWAITING_APPROVAL']);
const POLL_MS = 2000;
const POLL_MAX = 90;

interface Trace {
  question: string;
  at: string;
  workspaceId: string;
  projectId: string;
  organizationId: string | null;
  profileId: string;
  fieldMappings: Array<{ sourceField: string; canonicalField: string | null; status: string }>;
  datasetId: string;
  datasetVersionHash: string;
  rules: Record<string, { id: string; version: number; status: string }>;
  planId: string;
  runId: string;
  viewAnalysisId: string;
  runStatus: string;
  nodes: Array<{ nodeId: string; status: string; error: string | null }>;
  ruleRuns: Array<{ id: string; kind: string; operationId: string | null; status: string; snapshotId: string | null; producedSnapshotId: string | null; planNode: string | null }>;
  snapshots: Array<{ id: string; name: string | null; version: number; origin: string | null; parentSnapshotId: string | null }>;
  verdicts: Record<string, unknown>;
  decisionId: string;
  decisionStatus: string;
  deepLinks: Record<string, string>;
}

function log(msg: string): void {
  console.log(`[stage:riaz-guided] ${msg}`);
}

// ── 1. tenant + profile ──────────────────────────────────────────────────────

export async function resolveTenant(client: RestClient): Promise<{ workspaceId: string; projectId: string; organizationId: string | null }> {
  const all: Array<{ id: string; name: string; ownerOrganizationId?: string | null }> = [];
  for (let page = 1; page <= 5; page++) {
    const res = must(await client.as<unknown>(ADMIN_HANDLE, 'GET', `/api/v1/workspaces?limit=100&page=${page}`), 'listing workspaces');
    const rows = asList<{ id: string; name: string; ownerOrganizationId?: string | null }>(res);
    all.push(...rows);
    if (rows.length < 100) break;
  }
  const ctxStub = { client } as ProvisioningContext;
  for (const ws of all.filter((w) => w.name === WORKSPACE)) {
    const project = (await listProjects(ctxStub, ws.id)).find((p) => p.name === PROJECT);
    if (project) {
      const detail = must(await client.as<{ ownerOrganizationId?: string | null }>(ADMIN_HANDLE, 'GET', `/api/v1/workspaces/${ws.id}`, undefined, projectHeaders(ws.id)), 'reading workspace');
      return { workspaceId: ws.id, projectId: project.id, organizationId: detail.ownerOrganizationId ?? ws.ownerOrganizationId ?? null };
    }
  }
  throw new Error(`project "${PROJECT}" not found in any workspace named "${WORKSPACE}" — run stage:riaz first`);
}

async function ensureProfile(client: RestClient, workspaceId: string, projectId: string): Promise<void> {
  const H = projectHeaders(workspaceId);
  const project = must(await client.as<{ profileId?: string | null }>(ADMIN_HANDLE, 'GET', `/api/v1/projects/${projectId}`, undefined, H), 'reading project');
  if (project.profileId === PROFILE_ID) return log(`profile ${PROFILE_ID} already bound`);
  must(await client.as(ADMIN_HANDLE, 'PATCH', `/api/v1/projects/${projectId}/profile`, { profileId: PROFILE_ID }, H), `binding profile ${PROFILE_ID}`);
  log(`bound profile ${PROFILE_ID}`);
}

async function fieldMappings(client: RestClient, workspaceId: string, projectId: string): Promise<Trace['fieldMappings']> {
  const rows = asList<{ sourceField: string; canonicalField: string | null; status: string }>(
    must(await client.as<unknown>(ADMIN_HANDLE, 'GET', `/api/v1/projects/${projectId}/field-mappings`, undefined, projectHeaders(workspaceId)), 'reading field mappings'),
  );
  const matched = (canonical: string) => rows.some((r) => r.canonicalField === canonical && r.status === 'matched');
  if (!matched('patient_id') || !matched('timepoint')) {
    throw new Error(`paired gate not satisfied — field mappings: ${JSON.stringify(rows)}`);
  }
  log(`field mappings: ${rows.filter((r) => r.status === 'matched').map((r) => `${r.sourceField}→${r.canonicalField}`).join(', ')}`);
  return rows;
}

// ── 2. dataset ───────────────────────────────────────────────────────────────

async function ensureDataset(client: RestClient, serviceUserId: string, workspaceId: string, organizationId: string | null): Promise<{ datasetId: string; versionHash: string }> {
  const fixture = { ...riazFixture(), content: { ...riazFixture().content, datasets: [RIAZ_PAIRED_LONG_DATASET] } };
  // `orgId` is what `ensure-organization` would have set; upload initiation
  // stamps it on the dataset row (Prisma rejects an undefined organizationId).
  const ctx: ProvisioningContext = { client, fixture, serviceUserId, orgId: organizationId ?? undefined, workspaceIdByFixtureName: new Map([[WORKSPACE, workspaceId]]), touched: [] };
  await ensureDatasetStep.run(ctx);
  const ds = await findExistingDataset(ctx, workspaceId, RIAZ_PAIRED_LONG_DATASET.originalFilename);
  if (!ds) throw new Error('dataset vanished after ingestion');
  const full = must(await client.as<{ fileHash?: string; rawFileHash?: string }>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/datasets/${ds.id}`, undefined, projectHeaders(workspaceId)), 'reading dataset');
  const versionHash = full.fileHash ?? full.rawFileHash ?? '';
  if (!/^sha256:[0-9a-f]{64}$/.test(versionHash)) throw new Error(`dataset ${ds.id} has no sha256 version hash (${versionHash})`);
  ctx.touched.forEach((t) => log(`${t.action} ${t.kind} "${t.name}" (${t.id})`));
  return { datasetId: ds.id, versionHash };
}

// ── 3. rules — `rules/ensureRule.ts` (shared with `stage:rules`) ─────────────

// ── 4. plan + governed run ───────────────────────────────────────────────────

function pairedTest(id: string, stepLabel: string, clinicalQuestion: string, dependsOn: string[], familyId: string): Record<string, unknown> {
  return {
    id,
    nodeType: 'compare_paired',
    stepLabel,
    clinicalQuestion,
    why: 'A per-patient Pre→On contrast removes between-patient baseline differences; the paired t-test on log2 CPM tests whether the mean induction differs from zero per gene.',
    dependsOn,
    params: {},
    expectedEvidence: { effect_measure: 'paired mean difference (log2 CPM, On − Pre) per gene', report_ci: true },
    visualisation: 'comparison_box',
    proposedClaimCeiling: 'inferential',
    familyId,
    operation: {
      operationId: 'stats.paired_ttest',
      operationParams: { alternative: 'two_sided' },
      pivot: { featureColumn: 'gene', valueColumn: 'log2_cpm', valueColumns: ['log2_cpm'] },
      ordering: { levelFrom: 'Pre', levelTo: 'On' },
      roleBindings: {},
    },
  };
}

function cohortFilter(id: string, value: 'R' | 'NR', label: string): Record<string, unknown> {
  return {
    id,
    nodeType: 'filter',
    stepLabel: label,
    clinicalQuestion: `Restrict the paired referent to ${value === 'R' ? 'RECIST responders (CR/PR)' : 'RECIST non-responders (PD)'}`,
    why: 'The second half of the question is a between-cohort contrast of a within-patient effect; each cohort gets its own paired estimate on its own materialised snapshot.',
    dependsOn: ['qc_paired'],
    // Operator vocabulary is bio-compute's (`referent_scope.py`: eq/neq/in/
    // gt/gte/lt/lte/is_null), the same one the staged snapshot filters use —
    // a filter node's params travel verbatim to the materialised snapshot
    // and from there to every downstream operation's referent query.
    params: { column: 'response', operator: 'eq', value },
    expectedEvidence: 'a materialised snapshot of the cohort rows',
    visualisation: null,
    proposedClaimCeiling: 'descriptive_only',
    familyId: null,
    operation: null,
  };
}

export function buildPlan(datasetId: string, versionHash: string): Record<string, unknown> {
  const family = 'induction_by_response';
  return {
    planId: `riaz-guided-${Date.now().toString(36)}`,
    revision: 1,
    question: QUESTION,
    sendData: false,
    reasoning: {
      restatedQuestion: 'Per patient, do effector / IFN-γ genes rise between the pre-treatment and on-treatment biopsy under nivolumab — and does that rise happen in responders but not in non-responders?',
      whyThisApproach: 'Riaz et al. 2017 report that ON-treatment, not pre-treatment, immune induction separates responders. The data are paired (one Pre and one On biopsy per patient), so the right primary estimate is a within-patient delta, tested per gene with a paired t-test, then compared across the two response cohorts on their own snapshots.',
      whatThisWillNotEstablish: 'Causality of nivolumab on the induction; activation vs infiltration (bulk RNA-seq); durable benefit (response is best overall response). n=9 responders.',
      alternativesConsidered: [
        { approach: 'Pre-treatment responder-vs-non-responder DE (the Snapshot v1 volcano)', rejectedBecause: 'answers a different question — baseline prediction, not on-treatment induction.' },
        { approach: 'Wilcoxon signed-rank instead of paired t-test', rejectedBecause: 'log2 CPM deltas are near-symmetric here; the t-test reports the effect size the interpretation rule thresholds on.' },
      ],
    },
    datasetsUsed: [
      { datasetId, role: 'paired_expression_long', why: 'Long-format paired immune panel (patient_id × timepoint × gene → log2 CPM) derived from the BMS038 count matrix.', columnsUsed: ['patient_id', 'timepoint', 'response', 'gene', 'log2_cpm'], versionHash },
    ],
    datasetsAvailableNotUsed: [],
    declaredFamily: {
      id: family,
      correction: 'FDR',
      correctionMethod: 'BH',
      familySize: 3,
      memberNodeIds: ['induction_all', 'induction_responders', 'induction_non_responders'],
      summary: '3 paired contrasts (all patients, responders, non-responders), corrected together (BH FDR) per gene panel',
    },
    nodes: [
      {
        id: 'qc_paired',
        nodeType: 'qc_check',
        stepLabel: `Paired completeness guard (${QC_RULE_CODE})`,
        clinicalQuestion: 'Are there enough paired measurements to estimate a per-patient induction at all?',
        why: `Cites the published QC rule ${QC_RULE_CODE}; its verdict gates every downstream step (block → BLOCKED, degrade → run marked degraded).`,
        dependsOn: [],
        params: { ruleCode: QC_RULE_CODE },
        expectedEvidence: 'a QC verdict (pass / degrade / block) with its evaluated attributes',
        visualisation: null,
        proposedClaimCeiling: 'descriptive_only',
        familyId: null,
        operation: null,
      },
      pairedTest('induction_all', 'Pre→On paired t-test, all patients', 'Is the effector / IFN-γ panel induced on treatment across the whole paired cohort?', ['qc_paired'], family),
      cohortFilter('responders', 'R', 'Responders only'),
      pairedTest('induction_responders', 'Pre→On paired t-test, responders', 'Is the panel induced on treatment in RECIST responders?', ['responders'], family),
      cohortFilter('non_responders', 'NR', 'Non-responders only'),
      pairedTest('induction_non_responders', 'Pre→On paired t-test, non-responders', 'Is the panel induced on treatment in RECIST non-responders?', ['non_responders'], family),
    ],
    declined: [
      { analysis: 'Stratify by prior ipilimumab exposure', reason: 'Cohorts would be 4–5 responders per stratum; declined as underpowered for a paired estimate.' },
    ],
    openQuestions: [
      { decision: 'Induction threshold 0.5 log2 CPM per gene (≈1.4×)', alternative: 'A signature-score approach over the 24-gene panel instead of per-gene K-of-N.' },
    ],
  };
}

interface RunStatus {
  runId: string;
  status: string;
  runStatus?: string;
  nodes: Array<{ nodeId: string; status: string; error?: string | null }>;
  planId?: string | null;
  degraded?: boolean;
  failReason?: string | null;
}

async function submitAndDrain(client: RestClient, t: { workspaceId: string; projectId: string; organizationId: string | null; datasetId: string }, plan: Record<string, unknown>): Promise<{ runId: string; viewAnalysisId: string; status: RunStatus }> {
  const H = projectHeaders(t.workspaceId);
  const reuse = process.env.STAGING_RIAZ_GUIDED_REUSE_RUN?.trim();
  let runId = reuse;
  // The status projection does not carry the analysis id, so a reused run
  // names it explicitly (both come from a previous invocation's trace).
  let viewAnalysisId = reuse ? process.env.STAGING_RIAZ_GUIDED_REUSE_ANALYSIS?.trim() ?? '' : '';
  if (reuse && !viewAnalysisId) throw new Error('STAGING_RIAZ_GUIDED_REUSE_RUN needs STAGING_RIAZ_GUIDED_REUSE_ANALYSIS (the run’s viewAnalysisId)');
  if (!runId) {
    const body = { projectId: t.projectId, plan, datasetId: t.datasetId, workspaceId: t.workspaceId, ...(t.organizationId ? { organizationId: t.organizationId } : {}) };
    const res = must(await client.as<{ runId: string; viewAnalysisId: string }>(ADMIN_HANDLE, 'POST', '/api/v1/governed-execution/submit', body, H), 'submitting governed run');
    runId = res.runId;
    viewAnalysisId = res.viewAnalysisId;
    log(`submitted governed run ${runId} → analysis ${viewAnalysisId}`);
  }
  let status: RunStatus | undefined;
  for (let i = 0; i < POLL_MAX; i++) {
    status = must(await client.as<RunStatus>(ADMIN_HANDLE, 'GET', `/api/v1/governed-execution/status?projectId=${t.projectId}&runId=${runId}`, undefined, H), 'reading run status');
    const nodes = status.nodes ?? [];
    if (nodes.length > 0 && nodes.every((n) => SETTLED.has(n.status))) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!status) throw new Error('no run status');
  status.nodes.forEach((n) => log(`node ${n.nodeId.replace(`${runId}__`, '')}: ${n.status}${n.error ? ` — ${n.error}` : ''}`));
  const failed = status.nodes.filter((n) => n.status === 'FAILED' || n.status === 'BLOCKED');
  if (failed.length > 0) throw new Error(`governed run ${runId} did not complete: ${failed.map((n) => `${n.nodeId}=${n.status} ${n.error ?? ''}`).join('; ')}`);
  return { runId: runId!, viewAnalysisId, status };
}

// ── 5. results, interpretation, decision ─────────────────────────────────────

interface RuleRunRow {
  id: string;
  runKind?: string;
  operationId?: string | null;
  status: string;
  createdAt?: string;
  materializedNodeId?: string | null;
  summaryJson?: { complete_pairs?: number; qc?: unknown } | null;
  /** From the rule_derived snapshot that names this run (not on the run row). */
  referentSnapshotId: string | null;
  producedSnapshotId: string;
  snapshotName: string | null;
}

interface SnapshotRow { id: string; version: number; name: string | null; origin?: string; ruleRunId?: string | null; parentSnapshotId?: string | null }

/** The run's rule runs are read off the analysis's `rule_derived` snapshots
 *  (each names its `ruleRunId` and its referent `parentSnapshotId`); a rule-run
 *  row itself carries neither its analysis nor its referent. */
async function ruleRunsOf(client: RestClient, workspaceId: string, snapshots: SnapshotRow[]): Promise<RuleRunRow[]> {
  const H = projectHeaders(workspaceId);
  const out: RuleRunRow[] = [];
  for (const s of snapshots.filter((s) => s.origin === 'rule_derived' && s.ruleRunId)) {
    const run = must(await client.as<RuleRunRow>(ADMIN_HANDLE, 'GET', `/api/v1/rule-runs/${s.ruleRunId}`, undefined, H), `reading rule run ${s.ruleRunId}`);
    out.push({ ...run, referentSnapshotId: s.parentSnapshotId ?? null, producedSnapshotId: s.id, snapshotName: s.name });
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Reads a paired-test table into per-gene rows, tolerant of the column
 *  vocabulary (the kernel's own column names are read, not assumed). */
type PairedRow = PairedGeneStat & { nPairs: number | null };

async function pairedStats(client: RestClient, workspaceId: string, ruleRunId: string): Promise<{ rows: PairedRow[]; columns: string[] }> {
  const body = must(await client.as<{ rows?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>>; columns?: Array<string | { name: string }> }>(ADMIN_HANDLE, 'GET', `/api/v1/rule-runs/${ruleRunId}/table?page=1&limit=200`, undefined, projectHeaders(workspaceId)), `reading table of ${ruleRunId}`);
  const raw = body.rows ?? body.data ?? [];
  const columns = (body.columns ?? Object.keys(raw[0] ?? {})).map((c) => (typeof c === 'string' ? c : c.name));
  const pick = (row: Record<string, unknown>, candidates: string[]): unknown => {
    const key = Object.keys(row).find((k) => candidates.includes(k.toLowerCase()));
    return key ? row[key] : undefined;
  };
  const rows = raw
    .map((r) => ({
      gene: String(pick(r, ['gene', 'feature', 'measurement', 'feature_column', 'featurecolumn', 'measurement_column']) ?? ''),
      meanDelta: num(pick(r, ['meandifference', 'mean_diff', 'mean_difference', 'mean_delta', 'diff_mean', 'estimate', 'mean_change', 'delta'])) ?? NaN,
      p: num(pick(r, ['pvalue', 'p_value', 'p', 'pval', 'p_val'])),
      nPairs: num(pick(r, ['npairs', 'n_pairs', 'n'])),
    }))
    .filter((r) => r.gene);
  return { rows, columns };
}

async function approveInterpretation(client: RestClient, workspaceId: string, projectId: string, runId: string): Promise<void> {
  const nodeId = `${runId}__interpretation`;
  const res = await client.as(ADMIN_HANDLE, 'POST', '/api/v1/governed-execution/resolve', { projectId, runId, nodeId, approved: true }, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`approving ${nodeId} failed (status ${res.status})`);
  log(`approved interpretation node ${nodeId}`);
}

export interface DecisionRow { id: string; status: string; label: string }

export async function recordDecision(
  client: RestClient,
  serviceUserId: string,
  workspaceId: string,
  viewAnalysisId: string,
  label: string,
  confidence: DecisionDraftConfidence,
  snapshotIds: string[],
): Promise<DecisionRow> {
  const ctx: ProvisioningContext = { client, fixture: riazFixture(), serviceUserId, workspaceIdByFixtureName: new Map([[WORKSPACE, workspaceId]]), touched: [] };
  await ensureMemberRole(ctx, workspaceId, AUTHOR_HANDLE, 'editor');
  const H = projectHeaders(workspaceId);
  const existing = asList<DecisionRow>(must(await client.as<unknown>(AUTHOR_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/decisions?limit=100`, undefined, H), 'listing decisions')).find((d) => d.label === label);
  let decision = existing;
  if (!decision) {
    decision = must(
      await client.as<DecisionRow>(AUTHOR_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/decisions`, {
        label,
        type: 'phenotype_classification',
        confidence,
        context: { intendedUse: 'RUO' },
        evidenceLinks: snapshotIds.map((snapshotId) => ({ snapshotId })),
        evidenceValues: [],
      }, H),
      'creating decision',
    );
    recordTouched(ctx, { kind: 'interpretation', name: label, id: decision.id, action: 'created' });
    log(`created decision ${decision.id} as ${AUTHOR_HANDLE}`);
  }
  // Review/approve need the `decision:review` system permission the author's
  // workspace role does not carry — the service identity transitions, as in
  // `interpretationsEvidenceStaging.ts` (author drafts, reviewer approves).
  for (const target of ['reviewed', 'approved'] as const) {
    const current = must(await client.as<DecisionRow>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/decisions/${decision.id}`, undefined, H), 'reading decision');
    if (current.status === 'approved' || (target === 'reviewed' && current.status === 'reviewed')) continue;
    must(await client.as(SERVICE_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/decisions/${decision.id}/transition`, { targetStatus: target }, H), `transition → ${target}`);
    log(`decision ${decision.id} → ${target}`);
  }
  void viewAnalysisId;
  return must(await client.as<DecisionRow>(AUTHOR_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/decisions/${decision.id}`, undefined, H), 'reading decision');
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function stageRiazGuided(client: RestClient, adminEmail: string, adminPassword: string): Promise<Trace> {
  await ensureIdentities(client, adminEmail, adminPassword);
  const serviceUserId = must(await client.as<{ id: string }>(SERVICE_HANDLE, 'GET', '/api/v1/auth/me'), 'resolving service user').id;

  const tenant = await resolveTenant(client);
  log(`workspace ${tenant.workspaceId} / project ${tenant.projectId} / org ${tenant.organizationId ?? '(none)'}`);
  await ensureProfile(client, tenant.workspaceId, tenant.projectId);
  const { datasetId, versionHash } = await ensureDataset(client, serviceUserId, tenant.workspaceId, tenant.organizationId);
  const mappings = await fieldMappings(client, tenant.workspaceId, tenant.projectId);

  const rules: Trace['rules'] = {};
  for (const make of ALL_RULES) {
    const draft = make();
    const { row } = await ensureRule(client, draft, { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId }, { log, justification: 'Riaz 2017 guided demo — rule library for the on-treatment induction question' });
    rules[draft.create.code as string] = { id: row.id, version: row.version, status: row.status };
  }

  const plan = buildPlan(datasetId, versionHash);
  const run = await submitAndDrain(client, { ...tenant, datasetId }, plan);

  const snapshots = (await fetchSnapshots({ client } as ProvisioningContext, tenant.workspaceId, run.viewAnalysisId)) as SnapshotRow[];
  const ruleRuns = await ruleRunsOf(client, tenant.workspaceId, snapshots);
  const paired = ruleRuns.filter((r) => r.operationId === 'stats.paired_ttest' && r.status === 'SUCCEEDED');
  if (paired.length !== 3) throw new Error(`expected 3 succeeded paired t-test rule runs on analysis ${run.viewAnalysisId}, found ${paired.length}: ${JSON.stringify(ruleRuns.map((r) => [r.id, r.operationId, r.status]))}`);
  const tables = await Promise.all(paired.map((r) => pairedStats(client, tenant.workspaceId, r.id)));
  tables.forEach((t, i) => log(`paired run ${paired[i].id} on snapshot ${paired[i].referentSnapshotId}: ${t.rows.length} genes × ${t.rows[0]?.nPairs ?? '?'} pairs (columns ${t.columns.join(',')})`));
  const byCohort = classifyCohorts(paired, tables);
  const qcRun = ruleRuns.find((r) => r.runKind === 'QC');
  if (qcRun) log(`QC run ${qcRun.id} (${qcRun.snapshotName}): ${JSON.stringify(qcRun.summaryJson?.qc ?? qcRun.summaryJson ?? {}).slice(0, 300)}`);

  const all = evaluateCyto(byCohort.all.rows);
  const responders = evaluateCyto(byCohort.responders.rows);
  const nonResponders = evaluateCyto(byCohort.nonResponders.rows);
  const resp = evaluateResp(responders, nonResponders);
  const decision = evaluateDecision(responders, resp);
  log(`${INT_CYTO_CODE} all: ${all.stateLabel} (${all.genesFired.join(',')}; p<0.05: ${all.genesSignificant.join(',')})`);
  log(`${INT_CYTO_CODE} responders: ${responders.stateLabel} (${responders.genesFired.join(',')}; p<0.05: ${responders.genesSignificant.join(',')})`);
  log(`${INT_CYTO_CODE} non-responders: ${nonResponders.stateLabel} (${nonResponders.genesFired.join(',')}; p<0.05: ${nonResponders.genesSignificant.join(',')})`);
  log(`${INT_RESP_CODE}: ${resp.stateLabel} (confidence ${resp.confidence})`);
  log(`${DEC_CODE}: ${decision.verdict} (confidence ${decision.confidence} → draft ${decision.draftConfidence})`);

  await approveInterpretation(client, tenant.workspaceId, tenant.projectId, run.runId);

  const label = `${DEC_CODE}: ${decision.verdict} — on-treatment cytotoxic induction is ${resp.stateLabel.replace(/_/g, ' ')} (${INT_RESP_CODE}; run ${run.runId})`;
  // The decision cites the rule-derived snapshots: the QC verdict and the three
  // paired-test result tables the interpretation rules were evaluated over.
  const citedSnapshots = [qcRun, byCohort.all.run, byCohort.responders.run, byCohort.nonResponders.run].flatMap((r) => (r ? [r.producedSnapshotId] : []));
  const decisionRow = await recordDecision(client, serviceUserId, tenant.workspaceId, run.viewAnalysisId, label, decision.draftConfidence, [...new Set(citedSnapshots)]);

  const base = `${FRONT_URL}/projects/${tenant.projectId}/view-analyses/${run.viewAnalysisId}`;
  const trace: Trace = {
    question: QUESTION,
    at: new Date().toISOString(),
    workspaceId: tenant.workspaceId,
    projectId: tenant.projectId,
    organizationId: tenant.organizationId,
    profileId: PROFILE_ID,
    fieldMappings: mappings,
    datasetId,
    datasetVersionHash: versionHash,
    rules,
    planId: plan.planId as string,
    runId: run.runId,
    viewAnalysisId: run.viewAnalysisId,
    runStatus: run.status.runStatus ?? run.status.status,
    nodes: run.status.nodes.map((n) => ({ nodeId: n.nodeId, status: n.status, error: n.error ?? null })),
    ruleRuns: ruleRuns.map((r) => ({ id: r.id, kind: r.runKind ?? '', operationId: r.operationId ?? null, status: r.status, snapshotId: r.referentSnapshotId, producedSnapshotId: r.producedSnapshotId, planNode: planNodeFor(r, byCohort) })),
    snapshots: snapshots.map((s) => ({ id: s.id, name: s.name, version: s.version, origin: s.origin ?? null, parentSnapshotId: s.parentSnapshotId ?? null })),
    verdicts: { [INT_CYTO_CODE]: { all, responders, nonResponders }, [INT_RESP_CODE]: resp, [DEC_CODE]: decision },
    decisionId: decisionRow.id,
    decisionStatus: decisionRow.status,
    deepLinks: {
      project: `${FRONT_URL}/biotech-one/public-datasets-io-benchmarks/riaz-2017-nivolumab-melanoma/overview`,
      guidedHistory: `${FRONT_URL}/projects/${tenant.projectId}/guided-analyses`,
      analysis: base,
      provenance: `${base}/provenance`,
      decisions: `${base}/decisions`,
      decision: `${base}/decisions/${decisionRow.id}`,
      ...Object.fromEntries(Object.entries(rules).map(([code, r]) => [`rule:${code}`, `${FRONT_URL}/rules/${r.id}`])),
    },
  };
  writeFileSync(TRACE_PATH, JSON.stringify(trace, null, 2));
  log(`trace written to ${TRACE_PATH}`);
  return trace;
}

interface Cohorts { all: { run: RuleRunRow; rows: PairedGeneStat[] }; responders: { run: RuleRunRow; rows: PairedGeneStat[] }; nonResponders: { run: RuleRunRow; rows: PairedGeneStat[] } }

/** Which paired run is which cohort, read from the runs themselves: the
 *  whole-cohort run is the one whose referent is the run's ROOT snapshot (no
 *  filter parent); of the two cohort runs, responders are the smaller cohort
 *  (the kernel's own `nPairs` / `complete_pairs`, never assumed: 9 R vs 18 NR). */
function classifyCohorts(runs: RuleRunRow[], tables: Array<{ rows: PairedRow[]; columns: string[] }>): Cohorts {
  const pairsOf = (i: number): number => runs[i].summaryJson?.complete_pairs ?? tables[i].rows[0]?.nPairs ?? 0;
  const idx = runs.map((_, i) => i).sort((a, b) => pairsOf(b) - pairsOf(a));
  const [allI, nrI, rI] = idx;
  if (!(pairsOf(allI) > pairsOf(nrI) && pairsOf(nrI) > pairsOf(rI))) {
    throw new Error(`cannot tell the three paired runs apart by pair count: ${runs.map((r, i) => `${r.id}=${pairsOf(i)}`).join(', ')}`);
  }
  const entry = (i: number) => ({ run: runs[i], rows: tables[i].rows });
  return { all: entry(allI), responders: entry(rI), nonResponders: entry(nrI) };
}

function planNodeFor(r: RuleRunRow, c: Cohorts): string | null {
  if (r.id === c.all.run.id) return 'induction_all';
  if (r.id === c.responders.run.id) return 'induction_responders';
  if (r.id === c.nonResponders.run.id) return 'induction_non_responders';
  if (r.runKind === 'QC') return 'qc_paired';
  return null;
}

async function main(): Promise<void> {
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const adminEmail = process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
  const adminPassword = process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin';
  const client = new RestClient({ baseUrl });
  const trace = await stageRiazGuided(client, adminEmail, adminPassword);
  console.log('\nDeep links:');
  Object.entries(trace.deepLinks).forEach(([k, v]) => console.log(`  ${k.padEnd(28)} ${v}`));
  console.log(`\nPASSED — stage:riaz-guided: run ${trace.runId} (${trace.runStatus}), decision ${trace.decisionId} (${trace.decisionStatus}).`);
}

if (process.argv[1] && process.argv[1].endsWith('stageRiazGuided.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
