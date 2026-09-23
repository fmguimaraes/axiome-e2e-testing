/**
 * stage:riaz-publish — make the ten questions' results citable evidence and
 * publish them, visual first.
 *
 * For every traced question (../axiome-docs/demo/riaz-2017/riaz-questions-trace.json) whose governed
 * run produced rule-derived snapshots this step, idempotently:
 *   1. SELECTS the platform's own `origin: 'recommended'` DataviewSpec(s) already
 *      minted on each rule-derived result table (AXI-1552: on profiling completion
 *      for a new run, and by self-heal the first time this step lists a dataset's
 *      candidates) — never creates a chart. A snapshot with no recommended spec
 *      publishes table-only (logged, not an error);
 *   2. records one Evidence per rule-derived result table (`POST /view-analyses/
 *      evidences`), or updates the existing one (`PATCH` → a new immutable
 *      EvidenceVersion) when its title, text or charts changed: the recommended
 *      chart(s) are bound through `chartEntries`, the text is a short summary
 *      built from the kernel rows (`riazEvidenceText.ts`), and the whole rule-run
 *      table stays the citation (AXI-1161, kind `table`);
 *   3. records one Decision per question whose label STATES the verdict of the
 *      cited INTERPRET / DECISION rules (evaluated offline by
 *      `riazQuestionVerdicts.ts`, the same code `stage:riaz-report` prints),
 *      cites the evidences and snapshots, and is approved by the service identity.
 *      An approved decision is edited in place when the backend allows it,
 *      otherwise a new one is created and the old one deprecated;
 *   4. publishes a NEW version (`POST /view-analyses/publish`) whenever the
 *      latest published version does not carry exactly these evidence versions
 *      and this decision — never when it already does.
 * The ids and deep links are written back into the trace (`published`) so
 * `stage:riaz-report` can link them.
 *
 * Flags: `--only Q4,Q6`, `--dry-run` (reads only, prints what it would do),
 * `--prune-user-charts` (deletes the AXI-1553 hand-built `Qn · …` user specs
 * this step used to create — a one-off cleanup, run alone, idempotent).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { RestClient } from '../client/RestClient';
import { ensureIdentities } from '../identities/ensureIdentities';
import { deriveEvidenceKind } from '../lib/evidenceKind';
import { asList, must } from '../rules/ensureRule';
import { SERVICE_HANDLE } from './context';
import { projectHeaders } from './projectProvisioning';
import { recordDecision, type DecisionRow } from './stageRiazGuided';
import { EVALUATORS, q1Context, statsOf, type Verdict } from './riazQuestionVerdicts';
import {
  TEXT_OVERRIDES,
  cohortName,
  confidenceBand,
  configFor,
  decisionLabel,
  filterKey,
  qcTitle,
  statisticalTitle,
  summariseQc,
  summariseStatistical,
  type CohortFilter,
  type QuestionConfig,
} from './riazEvidenceText';
import type { QuestionTrace } from './runRiazQuestions';

const TRACE_PATH = process.env.STAGING_RIAZ_QUESTIONS_TRACE?.trim() || '../axiome-docs/demo/riaz-2017/riaz-questions-trace.json';
const FRONT_URL = (process.env.STAGING_FRONT_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
const BASE_URL = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');

/** A hand-built user chart from before AXI-1553 — titled `Qn · …` — is what `--prune-user-charts` removes. */
const HAND_BUILT_CHART_TITLE = /^Q\d+\s·\s/;

export interface PublishedChart { id: string; title: string; templateId: string; datasetId: string; snapshotId: string; renderStatus: number | null }
export interface PublishedRecord {
  at: string;
  evidences: Array<{ id: string; versionId: string; versionNumber: number | null; title: string; text: string; snapshotId: string; ruleRunId: string; link: string; charts: PublishedChart[] }>;
  decisionId: string | null;
  decisionLabel: string | null;
  decisionStatus: string | null;
  decisionLink: string | null;
  supersededDecisionId?: string | null;
  verdicts: Array<{ rule: string; verdict: string }>;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  publishedLink: string | null;
  previewApi: string | null;
}
type PublishedTrace = QuestionTrace & { published?: PublishedRecord };
interface Trace { projectId: string; workspaceId: string; organizationId: string | null; questions: PublishedTrace[] }
interface Snap {
  id: string;
  name: string | null;
  origin: string | null;
  ruleRunId: string | null;
  datasetId: string;
  parentSnapshotId?: string | null;
  derivedColumns?: string[] | null;
  effectiveFilters?: CohortFilter[] | null;
  filters?: CohortFilter[] | null;
  sourceScope?: { filters?: CohortFilter[] } | null;
}
interface EvidenceVersion { id: string; versionNumber?: number; title: string | null; text?: string | null; chartArtifactIds?: string[]; citationContext?: unknown }
interface EvidenceRow { id: string; currentVersion?: EvidenceVersion }
interface SpecRow { id: string; title: string | null; origin: 'auto' | 'user' | 'recommended'; templateId: string; datasetVersionId?: string; bindings?: unknown; params?: unknown; filters?: unknown }
interface PublishedVersion { id: string; versionNumber: number; evidenceVersionIds: string[]; decisionIds: string[] }
type RuleRun = QuestionTrace['ruleRuns'][number];

const scopeOf = (s: Snap): string => (s.sourceScope?.filters ?? []).map(filterKey).join(' & ') || 'whole dataset';
const cohortFiltersOf = (s: Snap): CohortFilter[] => s.effectiveFilters ?? s.sourceScope?.filters ?? s.filters ?? [];
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

function log(msg: string): void {
  console.log(`[stage:riaz-publish] ${msg}`);
}

// ── plan facts the wording needs ────────────────────────────────────────────

interface PairedLevels { levelFrom: string | null; levelTo: string | null }
function pairedLevels(q: QuestionTrace): PairedLevels {
  for (const n of q.planNodes) {
    const op = (n.operation ?? {}) as { ordering?: { levelFrom?: string; levelTo?: string } };
    const p = (n.params ?? {}) as { levelFrom?: string; levelTo?: string };
    const levelFrom = op.ordering?.levelFrom ?? p.levelFrom, levelTo = op.ordering?.levelTo ?? p.levelTo;
    if (levelFrom && levelTo) return { levelFrom, levelTo };
  }
  return { levelFrom: null, levelTo: null };
}

// ── listings ─────────────────────────────────────────────────────────────────

async function listSnapshots(client: RestClient, H: Record<string, string>, analysisId: string): Promise<Snap[]> {
  return asList<Snap>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`, undefined, H), 'snapshots'));
}

async function listEvidence(client: RestClient, H: Record<string, string>, analysisId: string): Promise<EvidenceRow[]> {
  const res = must(await client.as<{ data: EvidenceRow[] }>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/evidences?page=1&limit=50`, undefined, H), 'evidence listing');
  return res.data ?? [];
}

async function listSpecs(client: RestClient, H: Record<string, string>, workspaceId: string, datasetId: string, analysisId: string | null): Promise<SpecRow[]> {
  const qs = analysisId ? `?viewAnalysisId=${analysisId}` : '';
  return asList<SpecRow>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates${qs}`, undefined, H), `candidates of ${datasetId}`));
}

// ── charts (selector, never a creator — AXI-1553) ───────────────────────────

/** Pure selection: every `origin: 'recommended'` spec in a dataset's candidate list. Exported for UT-STAGE-168..170. */
export const selectRecommended = (specs: SpecRow[]): SpecRow[] => specs.filter((x) => x.origin === 'recommended');

/** Pure filter: an AXI-1553-era hand-built `Qn · …` user spec — what `--prune-user-charts` targets. Exported for UT-STAGE-171..172. */
export const isHandBuiltUserChart = (spec: Pick<SpecRow, 'origin' | 'title'>): boolean => spec.origin === 'user' && HAND_BUILT_CHART_TITLE.test(spec.title ?? '');

/**
 * Every `origin: 'recommended'` DataviewSpec the platform already minted on
 * this rule-derived result table (AXI-1552). Listing candidates is what
 * triggers the backend's self-heal for a dataset that predates that story, so
 * this call alone is enough — no compute-run/candidates POST needed. Several
 * recommended templates on one dataset (e.g. a statistical card plus a QC
 * card) are all bound; none is logged, not an error — a passing QC gate can
 * legitimately have no recommended card.
 */
async function recommendedCharts(client: RestClient, H: Record<string, string>, workspaceId: string, s: Snap, qId: string): Promise<PublishedChart[]> {
  const specs = await listSpecs(client, H, workspaceId, s.datasetId, null);
  const recs = selectRecommended(specs);
  if (!recs.length) { log(`${qId}: no recommended chart for snapshot ${s.id} (dataset ${s.datasetId})`); return []; }
  return recs.map((r) => ({ id: r.id, title: r.title ?? r.templateId, templateId: r.templateId, datasetId: s.datasetId, snapshotId: s.id, renderStatus: null }));
}

/** `--prune-user-charts`: deletes every AXI-1553-era hand-built `Qn · …` user
 *  spec across every traced question's snapshots' datasets. Idempotent (a
 *  second run finds nothing left to delete) and safe to run before or after
 *  `stage:riaz-publish` has already rebound each evidence's `chartEntries` to
 *  the recommended spec — `EvidenceChart.chartArtifactId` is a plain string,
 *  not a foreign key, so a stale reference on an OLD evidence version does not
 *  block the delete; a delete the backend still refuses is logged and skipped
 *  (non-fatal), never crashes the run. */
async function pruneUserCharts(client: RestClient, serviceUserId: string, t: Trace, dryRun: boolean): Promise<void> {
  const H = projectHeaders(t.workspaceId);
  const datasetIds = new Set<string>();
  for (const q of t.questions) {
    if (!q.viewAnalysisId) continue;
    for (const s of await listSnapshots(client, H, q.viewAnalysisId)) datasetIds.add(s.datasetId);
  }
  for (const datasetId of datasetIds) {
    const stale = (await listSpecs(client, H, t.workspaceId, datasetId, null)).filter(isHandBuiltUserChart);
    for (const spec of stale) {
      if (dryRun) { log(`would delete user chart ${spec.id} "${spec.title}" on dataset ${datasetId}`); continue; }
      const res = await client.as<unknown>(SERVICE_HANDLE, 'DELETE', `/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/candidates/${spec.id}?performedBy=${serviceUserId}`, undefined, H);
      if (res.ok) log(`deleted user chart ${spec.id} "${spec.title}"`);
      else log(`WARNING could not delete user chart ${spec.id} "${spec.title}" (status ${res.status}) — left in place`);
    }
  }
}

// ── evidence ─────────────────────────────────────────────────────────────────

const qcRowsEvaluated = (rr: RuleRun): number | null => {
  const n = ((rr.summary ?? {}) as { qc?: { rowsEvaluated?: unknown } }).qc?.rowsEvaluated;
  return typeof n === 'number' ? n : null;
};

interface EvidenceContent { title: string; text: string; charts: PublishedChart[] }

function evidenceContent(q: QuestionTrace, cfg: QuestionConfig, s: Snap, rr: RuleRun, cohort: string, levels: PairedLevels, charts: PublishedChart[]): EvidenceContent {
  const override = TEXT_OVERRIDES[`${q.id}:${rr.id}`];
  if (rr.kind === 'QC') {
    const qc = ((rr.summary ?? {}) as { qc?: { verdict?: string; ruleCode?: string; ruleVersion?: number; rowsEvaluated?: number; failReasons?: string[] } }).qc ?? {};
    const ruleCodeOf = qc.ruleCode ?? (s.name ?? '').replace(/^QC result:\s*/, '').replace(/\s+v\d+$/, '') ?? 'QC';
    return {
      title: qcTitle(q.id, cohort, qc.verdict ?? null),
      text: override ?? summariseQc({ cohort, ruleCode: ruleCodeOf, ruleVersion: qc.ruleVersion ?? null, rowsEvaluated: qc.rowsEvaluated ?? rr.rows.length ?? null, verdict: qc.verdict ?? null, failReasons: qc.failReasons ?? [] }),
      charts,
    };
  }
  const n = typeof rr.rows[0]?.nPairs === 'number' ? (rr.rows[0].nPairs as number) : null;
  return {
    title: statisticalTitle(q.id, rr.operationId, cohort, n, levels.levelFrom, levels.levelTo),
    text: override ?? summariseStatistical({ rows: rr.rows, cohort, operationId: rr.operationId, focusGenes: cfg.focusGenes, levelFrom: levels.levelFrom, levelTo: levels.levelTo }),
    charts,
  };
}

/** The evidence this snapshot already has: by the id the trace recorded, by the new title, or by the title the first version of this step gave it. */
function findExisting(existing: EvidenceRow[], prior: PublishedRecord | undefined, q: QuestionTrace, s: Snap, title: string): EvidenceRow | undefined {
  const priorId = prior?.evidences.find((e) => e.snapshotId === s.id)?.id;
  const legacyTitle = `${q.id} · ${s.name ?? 'result'} [${scopeOf(s)}] · run ${q.runId}`;
  return existing.find((e) => e.id === priorId) ?? existing.find((e) => e.currentVersion?.title === title) ?? existing.find((e) => e.currentVersion?.title === legacyTitle);
}

async function ensureOneEvidence(client: RestClient, H: Record<string, string>, t: Trace, q: PublishedTrace, cfg: QuestionConfig, s: Snap, existing: EvidenceRow[], levels: PairedLevels, dryRun: boolean): Promise<PublishedRecord['evidences'][number] | null> {
  const rr = q.ruleRuns.find((r) => r.id === s.ruleRunId);
  if (!rr) { log(`${q.id}: snapshot ${s.id} cites rule run ${s.ruleRunId} the trace does not carry — skipped`); return null; }
  const cohort = cohortName(cohortFiltersOf(s), cfg);
  const charts = await recommendedCharts(client, H, t.workspaceId, s, q.id);
  const content = evidenceContent(q, cfg, s, rr, cohort, levels, charts);
  const link = (id: string) => `${FRONT_URL}/projects/${t.projectId}/view-analyses/${q.viewAnalysisId}/evidences/${id}`;
  const chartEntries = charts.map((c) => ({ chartArtifactId: c.id, snapshotId: c.snapshotId, datasetVersionId: c.datasetId }));
  // AXI-1555: this step KNOWS the run kind behind the cited snapshot (`rr.kind`,
  // the live `rule_runs.run_kind`) and whether it bound a recommended chart — the
  // same facts the backend's own derivation would read off provenance, computed
  // here instead of guessed from `content.title`. See `lib/evidenceKind.ts`.
  const kind = deriveEvidenceKind({ runKinds: [rr.kind], hasChartEntries: charts.length > 0, hasCitationContext: true });
  const body = {
    chartEntries,
    title: content.title,
    text: content.text,
    kind,
    citationContext: {
      kind: 'table',
      evidence_id: rr.id,
      snapshot_id: s.id,
      dataset_id: s.datasetId,
      // the trace samples a rule run's rows (200); a QC gate reports how many rows it evaluated
      row_count: qcRowsEvaluated(rr) ?? rr.rows.length ?? undefined,
      column_names: rr.columns,
      derived_columns: s.derivedColumns ?? null,
      view_state: { filters: [] },
      captured_at: new Date().toISOString(),
      captured_by: 'stage:riaz-publish',
    },
  };
  const record = (e: EvidenceRow): PublishedRecord['evidences'][number] => ({
    id: e.id, versionId: e.currentVersion!.id, versionNumber: e.currentVersion!.versionNumber ?? null, title: content.title, text: content.text, snapshotId: s.id, ruleRunId: rr.id, link: link(e.id), charts,
  });
  const found = findExisting(existing, q.published, q, s, content.title);
  if (found?.currentVersion) {
    const cv = found.currentVersion;
    const citedRows = (cv.citationContext as { row_count?: number } | undefined)?.row_count ?? null;
    const unchanged = cv.title === content.title && (cv.text ?? '') === content.text && sameSet(cv.chartArtifactIds ?? [], charts.map((c) => c.id)) && citedRows === (body.citationContext.row_count ?? null);
    if (unchanged) { log(`${q.id}: evidence ${found.id} v${cv.versionNumber ?? '?'} already reads "${content.title}" — reused`); return record(found); }
    if (dryRun) { log(`would update evidence ${found.id} → "${content.title}" (${charts.length} chart(s))\n    ${content.text}`); return record(found); }
    must(await client.as<unknown>(SERVICE_HANDLE, 'PATCH', `/api/v1/view-analyses/evidences/${found.id}`, body, H), `updating evidence ${found.id}`);
    const after = must(await client.as<EvidenceRow>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/evidences/${found.id}`, undefined, H), `reading evidence ${found.id}`);
    if (!after.currentVersion || after.currentVersion.id === cv.id) throw new Error(`evidence ${found.id} did not get a new version after PATCH`);
    log(`updated evidence ${found.id} → v${after.currentVersion.versionNumber ?? '?'} "${content.title}" (${charts.length} chart(s))`);
    return record(after);
  }
  if (dryRun) { log(`would create evidence "${content.title}" (${charts.length} chart(s))\n    ${content.text}`); return null; }
  const created = must(await client.as<EvidenceRow>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/evidences', { viewAnalysisId: q.viewAnalysisId, ...body }, H), `creating evidence "${content.title}"`);
  if (!created.currentVersion) throw new Error(`evidence "${content.title}" created without a current version`);
  log(`created evidence ${created.id} "${content.title}" (${charts.length} chart(s))`);
  return record(created);
}

// ── decision ─────────────────────────────────────────────────────────────────

interface DecisionWant { label: string; type: string; confidence: 'high' | 'medium' | 'low'; evidenceIds: string[]; snapshotIds: string[] }

const linkIds = (d: DecisionRow): string[] => (d.evidenceLinks ?? []).map((l) => l.evidenceId ?? l.snapshotId ?? '').filter(Boolean);
const decisionMatches = (d: DecisionRow, w: DecisionWant): boolean => d.label === w.label && (d.type ?? 'phenotype_classification') === w.type && (d.confidence ?? null) === w.confidence && sameSet(linkIds(d), [...w.evidenceIds, ...w.snapshotIds]);

async function readDecision(client: RestClient, H: Record<string, string>, workspaceId: string, id: string): Promise<DecisionRow | null> {
  const res = await client.as<DecisionRow>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/decisions/${id}`, undefined, H);
  return res.ok && res.body ? res.body : null;
}

async function approve(client: RestClient, H: Record<string, string>, workspaceId: string, d: DecisionRow): Promise<DecisionRow> {
  let status = d.status;
  for (const target of ['reviewed', 'approved'] as const) {
    if (status === 'approved' || (target === 'reviewed' && status === 'reviewed')) continue;
    must(await client.as(SERVICE_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/decisions/${d.id}/transition`, { targetStatus: target }, H), `decision ${d.id} → ${target}`);
    status = target;
    log(`decision ${d.id} → ${target}`);
  }
  return (await readDecision(client, H, workspaceId, d.id)) ?? { ...d, status };
}

/**
 * The question's decision, stating the verdict. Reuses the decision the trace
 * recorded (or one already carrying the label); edits it in place when the
 * backend accepts the PATCH (an approved decision is not in
 * `guardMutableState`'s immutable set — `reviewed` is), else creates the new
 * one through `recordDecision` and deprecates the old one.
 */
async function ensureDecision(client: RestClient, serviceUserId: string, H: Record<string, string>, t: Trace, q: PublishedTrace, want: DecisionWant, dryRun: boolean): Promise<{ decision: DecisionRow | null; superseded: string | null }> {
  const listed = asList<DecisionRow>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${t.workspaceId}/decisions?viewAnalysisId=${q.viewAnalysisId}&limit=100`, undefined, H), 'listing decisions'));
  const prior = q.published?.decisionId ? await readDecision(client, H, t.workspaceId, q.published.decisionId) : null;
  const current = prior ?? listed.find((d) => d.label === want.label && d.status !== 'deprecated') ?? listed.find((d) => d.label.startsWith(`${q.id} — `) && d.status !== 'deprecated') ?? null;
  if (current && decisionMatches(current, want)) {
    log(`${q.id}: decision ${current.id} already states "${want.label}" (${current.status})`);
    return { decision: dryRun ? current : await approve(client, H, t.workspaceId, current), superseded: null };
  }
  if (dryRun) { log(`would ${current ? `update decision ${current.id}` : 'create a decision'} → "${want.label}" (${want.type}, ${want.confidence}, ${want.evidenceIds.length} evidence + ${want.snapshotIds.length} snapshot links)`); return { decision: current, superseded: null }; }
  const links = [...want.evidenceIds.map((evidenceId) => ({ evidenceId })), ...want.snapshotIds.map((snapshotId) => ({ snapshotId }))];
  if (current && current.status !== 'deprecated') {
    const patched = await client.as<DecisionRow>(SERVICE_HANDLE, 'PATCH', `/api/v1/workspaces/${t.workspaceId}/decisions/${current.id}`, { label: want.label, type: want.type, confidence: want.confidence, evidenceLinks: links }, H);
    if (patched.ok) {
      log(`updated decision ${current.id} in place (was ${current.status}) → "${want.label}"`);
      return { decision: await approve(client, H, t.workspaceId, (await readDecision(client, H, t.workspaceId, current.id)) ?? current), superseded: null };
    }
    log(`decision ${current.id} (${current.status}) cannot be edited (status ${patched.status}) — creating a new one and deprecating it`);
    const fresh = await recordDecision(client, serviceUserId, t.workspaceId, q.viewAnalysisId as string, want.label, want.confidence, want.snapshotIds, { type: want.type, evidenceIds: want.evidenceIds });
    must(await client.as(SERVICE_HANDLE, 'POST', `/api/v1/workspaces/${t.workspaceId}/decisions/${current.id}/transition`, { targetStatus: 'deprecated' }, H), `deprecating decision ${current.id}`);
    log(`decision ${current.id} → deprecated, superseded by ${fresh.id}`);
    return { decision: fresh, superseded: current.id };
  }
  const fresh = await recordDecision(client, serviceUserId, t.workspaceId, q.viewAnalysisId as string, want.label, want.confidence, want.snapshotIds, { type: want.type, evidenceIds: want.evidenceIds });
  return { decision: fresh, superseded: null };
}

// ── publish ──────────────────────────────────────────────────────────────────

/** Publishes a new version unless the latest one already carries exactly these evidence versions and decisions. */
async function ensurePublished(client: RestClient, H: Record<string, string>, analysisId: string, evidenceVersionIds: string[], decisionIds: string[], dryRun: boolean): Promise<PublishedVersion | null> {
  const existing = must(await client.as<{ data: PublishedVersion[] }>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/published-versions`, undefined, H), 'published versions').data ?? [];
  const latest = [...existing].sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0))[0];
  if (latest && sameSet(latest.evidenceVersionIds ?? [], evidenceVersionIds) && sameSet(latest.decisionIds ?? [], decisionIds)) {
    log(`published version ${latest.id} (v${latest.versionNumber}) already carries these ${evidenceVersionIds.length} evidence version(s) — reused`);
    return latest;
  }
  if (dryRun) { log(`would publish analysis ${analysisId} as v${(latest?.versionNumber ?? 0) + 1} with ${evidenceVersionIds.length} evidence version(s) and ${decisionIds.length} decision(s)`); return latest ?? null; }
  const res = must(await client.as<PublishedVersion>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/publish', { viewAnalysisId: analysisId, evidenceVersionIds, decisionIds }, H), 'publishing analysis');
  log(`published analysis ${analysisId} → version ${res.id} (v${res.versionNumber ?? '?'})`);
  return res;
}

// ── one question ─────────────────────────────────────────────────────────────

function verdictsFor(q: QuestionTrace, snaps: Snap[]): Verdict[] {
  const snapMap = new Map(snaps.map((s) => [s.id, s]));
  const stats = statsOf(q, snapMap);
  return q.error ? [] : (EVALUATORS[q.id] ?? (() => []))(q, stats, { q1: q1Context(), earlier: new Map() });
}

async function publishOne(client: RestClient, serviceUserId: string, t: Trace, q: PublishedTrace, dryRun: boolean): Promise<void> {
  const H = projectHeaders(t.workspaceId);
  if (!q.viewAnalysisId || !q.runId) { log(`${q.id}: no run — skipped`); return; }
  const cfg = configFor(q.id);
  const all = await listSnapshots(client, H, q.viewAnalysisId);
  const snaps = all.filter((s) => s.origin === 'rule_derived' && s.ruleRunId);
  if (!snaps.length) { log(`${q.id}: no rule-derived snapshots — skipped`); return; }
  const levels = pairedLevels(q);
  const existing = await listEvidence(client, H, q.viewAnalysisId);
  const evidences: PublishedRecord['evidences'] = [];
  for (const s of snaps) {
    const e = await ensureOneEvidence(client, H, t, q, cfg, s, existing, levels, dryRun);
    if (e) evidences.push(e);
  }
  const verdicts = verdictsFor(q, all);
  const want: DecisionWant = {
    label: decisionLabel(q.id, cfg, verdicts),
    type: cfg.decisionType,
    confidence: confidenceBand(verdicts),
    evidenceIds: evidences.map((e) => e.id),
    snapshotIds: snaps.map((s) => s.id),
  };
  const { decision, superseded } = await ensureDecision(client, serviceUserId, H, t, q, want, dryRun);
  const version = evidences.length && (decision || dryRun) ? await ensurePublished(client, H, q.viewAnalysisId, evidences.map((e) => e.versionId), decision ? [decision.id] : [], dryRun) : null;
  q.published = {
    at: new Date().toISOString(),
    evidences,
    decisionId: decision?.id ?? null,
    decisionLabel: decision?.label ?? want.label,
    decisionStatus: decision?.status ?? null,
    decisionLink: decision ? `${FRONT_URL}/projects/${t.projectId}/view-analyses/${q.viewAnalysisId}/decisions/${decision.id}` : null,
    supersededDecisionId: superseded ?? q.published?.supersededDecisionId ?? null,
    verdicts: verdicts.map((v) => ({ rule: v.rule, verdict: v.verdict })),
    publishedVersionId: version?.id ?? null,
    publishedVersionNumber: version?.versionNumber ?? null,
    publishedLink: version ? `${FRONT_URL}/sponsor-review/views/${version.id}/export-preview` : null,
    previewApi: version ? `${BASE_URL}/api/v1/exports/sponsor/${version.id}/preview` : null,
  };
  log(`${q.id}: ${evidences.length} evidence(s) / ${evidences.reduce((n, e) => n + e.charts.length, 0)} chart(s), decision ${decision?.id ?? '—'} (${decision?.status ?? '—'}) "${want.label}", published ${version?.id ?? '—'}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const pruneOnly = argv.includes('--prune-user-charts');
  const onlyArg = argv.indexOf('--only');
  const only = onlyArg >= 0 ? new Set(argv[onlyArg + 1].split(',').map((s) => s.trim())) : null;
  const trace = JSON.parse(readFileSync(TRACE_PATH, 'utf8')) as Trace;
  const client = new RestClient({ baseUrl: BASE_URL, onCall: () => undefined });
  await ensureIdentities(client, process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local', process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin');
  const serviceUserId = must(await client.as<{ id: string }>(SERVICE_HANDLE, 'GET', '/api/v1/auth/me'), 'resolving service user').id;
  if (pruneOnly) {
    await pruneUserCharts(client, serviceUserId, trace, dryRun);
    log(dryRun ? 'dry run — nothing deleted' : 'prune complete');
    return;
  }
  for (const q of trace.questions) {
    if (only && !only.has(q.id)) continue;
    await publishOne(client, serviceUserId, trace, q, dryRun);
    if (!dryRun) writeFileSync(TRACE_PATH, JSON.stringify(trace, null, 2));
  }
  log(dryRun ? 'dry run — nothing written' : `trace updated: ${TRACE_PATH}`);
}

if (process.argv[1] && process.argv[1].endsWith('publishRiazEvidence.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
