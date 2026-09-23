/**
 * stage:riaz-publish — make the ten questions' results citable evidence and
 * publish them, visual first.
 *
 * For every traced question (../axiome-docs/demo/riaz-2017/riaz-questions-trace.json) whose governed
 * run produced rule-derived snapshots this step, idempotently:
 *   1. creates the user charts that show each STATISTICAL result — a ranked
 *      horizontal bar of the effect size per gene on the result table, and a
 *      grouped bar of the measured value per focus gene on the cohort's source
 *      slice (`POST /workspaces/:ws/datasets/:ds/candidates`, matched by title
 *      on re-run) — and verifies they render;
 *   2. records one Evidence per rule-derived result table (`POST /view-analyses/
 *      evidences`), or updates the existing one (`PATCH` → a new immutable
 *      EvidenceVersion) when its title, text or charts changed: the charts are
 *      bound through `chartEntries`, the text is a short summary built from the
 *      kernel rows (`riazEvidenceText.ts`), and the whole rule-run table stays
 *      the citation (AXI-1161, kind `table`). QC evidences keep the table alone
 *      (or a `qc_fail_reason_counts_v1` spec when the platform recommended one);
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
 * Flags: `--only Q4,Q6`, `--dry-run` (reads only, prints what it would do).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { RestClient } from '../client/RestClient';
import { ensureIdentities } from '../identities/ensureIdentities';
import { asList, must } from '../rules/ensureRule';
import { SERVICE_HANDLE } from './context';
import { projectHeaders } from './projectProvisioning';
import { recordDecision, type DecisionRow } from './stageRiazGuided';
import { EVALUATORS, q1Context, statsOf, type Verdict } from './riazQuestionVerdicts';
import {
  CYTOTOXIC_FOCUS,
  TEXT_OVERRIDES,
  cohortName,
  confidenceBand,
  configFor,
  decisionLabel,
  filterKey,
  qcTitle,
  rankedChartTitle,
  sliceChartTitle,
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

/** The long Riaz table every question runs on: which columns the source-slice chart binds. */
const SLICE_CHART = { xColumn: 'gene', yColumn: 'log2_cpm', colorColumn: 'timepoint', valueLabel: 'log2 CPM' };
const RANKED_CHART = { featureColumn: 'feature', valueColumn: 'effectSize' };
const QC_RECOMMENDED_TEMPLATE = 'qc_fail_reason_counts_v1';
/** A user chart binds columns by NAME (`{ column_id: 'feature' }`, what the
 *  front sends): bio-compute's `resolve_column` matches `column_id` against the
 *  dataframe's columns, and the sponsor export's `resolveBindingValue` passes a
 *  name through unchanged. The profile's `col_<name>` ids the auto candidates
 *  carry render in the export only — the interactive route answers
 *  "binding columns not found" for them on this stack. */
const colId = (name: string): string => name;

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
interface SpecRow { id: string; title: string | null; origin: 'auto' | 'user'; templateId: string; datasetVersionId?: string; bindings?: unknown; params?: unknown; filters?: unknown }
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

// ── charts ───────────────────────────────────────────────────────────────────

interface ChartSpec { templateId: string; bindings: Record<string, { column_id: string }>; params: Record<string, unknown>; filters: CohortFilter[]; title: string }

/** Creates the user chart unless a user spec with this title already exists on
 *  the dataset for this analysis; then reads it back and asks the render route
 *  for it (the same call the gallery makes) so a chart that cannot render is
 *  visible in the log, not in the sponsor preview. */
async function ensureChart(client: RestClient, H: Record<string, string>, workspaceId: string, datasetId: string, analysisId: string, snapshotId: string, spec: ChartSpec, dryRun: boolean): Promise<PublishedChart | null> {
  const existing = (await listSpecs(client, H, workspaceId, datasetId, analysisId)).find((s) => s.origin === 'user' && s.title === spec.title);
  let id = existing && (await retireDriftedChart(client, H, workspaceId, datasetId, existing, spec, dryRun)) ? null : existing?.id ?? null;
  if (!id) {
    if (dryRun) { log(`would create chart "${spec.title}" (${spec.templateId}) on dataset ${datasetId}`); return null; }
    const body = { templateId: spec.templateId, templateVersion: '1.0.0', bindings: spec.bindings, params: spec.params, filters: spec.filters, combinator: 'AND', title: spec.title, viewAnalysisId: analysisId };
    const created = must(await client.as<{ id: string; origin: string }>(SERVICE_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates`, body, H), `creating chart "${spec.title}"`);
    if (created.origin !== 'user') throw new Error(`chart "${spec.title}" was created with origin "${created.origin}", expected "user"`);
    id = created.id;
    log(`created chart ${id} "${spec.title}"`);
  }
  const back = must(await client.as<SpecRow>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates/${id}`, undefined, H), `reading chart ${id}`);
  if (back.origin !== 'user' || back.templateId !== spec.templateId) throw new Error(`chart ${id} read back as ${back.origin}/${back.templateId}, expected user/${spec.templateId}`);
  const render = await client.as<unknown>(SERVICE_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/dataviews/${id}/render`, { snapshotId }, H);
  if (!render.ok) log(`WARNING chart ${id} "${spec.title}" did not render (status ${render.status}): ${JSON.stringify(render.body).slice(0, 200)}`);
  return { id, title: spec.title, templateId: spec.templateId, datasetId, snapshotId, renderStatus: render.status };
}

const canon = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort()) : x));

/** A same-titled spec whose bindings/filters/params no longer match what this
 *  step would create is retired by renaming (the spec stays — an older evidence
 *  version still cites it, and the platform's provenance is append-only) and
 *  the caller creates the current one. Returns true when it was retired. */
async function retireDriftedChart(client: RestClient, H: Record<string, string>, workspaceId: string, datasetId: string, existing: SpecRow, spec: ChartSpec, dryRun: boolean): Promise<boolean> {
  const live = must(await client.as<SpecRow>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates/${existing.id}`, undefined, H), `reading chart ${existing.id}`);
  const same = live.templateId === spec.templateId && canon(live.bindings) === canon(spec.bindings) && canon(live.filters) === canon(spec.filters) && canon(live.params) === canon(spec.params);
  if (same) return false;
  if (dryRun) { log(`would retire chart ${existing.id} "${spec.title}" (bindings/filters/params drifted) and recreate it`); return true; }
  const retired = `${spec.title} (superseded ${new Date().toISOString().slice(0, 10)})`;
  must(await client.as(SERVICE_HANDLE, 'PATCH', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates/${existing.id}/title`, { title: retired }, H), `retiring chart ${existing.id}`);
  log(`retired chart ${existing.id} → "${retired}" (bindings/filters/params drifted)`);
  return true;
}

/** The cohort's own filter snapshot — the rule-derived snapshot's parent when
 *  it carries the same effective filters, else any filter snapshot that does. */
function cohortSnapshot(s: Snap, all: Snap[]): Snap | null {
  const want = cohortFiltersOf(s).map(filterKey).sort().join('|');
  const parent = all.find((x) => x.id === s.parentSnapshotId);
  if (parent && cohortFiltersOf(parent).map(filterKey).sort().join('|') === want) return parent;
  return all.find((x) => x.origin === 'filter' && cohortFiltersOf(x).map(filterKey).sort().join('|') === want) ?? null;
}

async function statisticalCharts(client: RestClient, H: Record<string, string>, t: Trace, q: QuestionTrace, cfg: QuestionConfig, s: Snap, all: Snap[], rr: RuleRun, cohort: string, levels: PairedLevels, dryRun: boolean): Promise<PublishedChart[]> {
  const analysisId = q.viewAnalysisId as string;
  const n = typeof rr.rows[0]?.nPairs === 'number' ? (rr.rows[0].nPairs as number) : null;
  const charts: PublishedChart[] = [];
  // 1. ranked effect size per gene, on the result table (24 rows, no filters — renders identically everywhere)
  if (rr.columns.includes(RANKED_CHART.featureColumn) && rr.columns.includes(RANKED_CHART.valueColumn)) {
    const ranked = await ensureChart(client, H, t.workspaceId, s.datasetId, analysisId, s.id, {
      templateId: 'bar_horizontal_v1',
      bindings: { y: { column_id: colId(RANKED_CHART.featureColumn) }, x: { column_id: colId(RANKED_CHART.valueColumn) } },
      params: { sort_by: 'value', sort_order: 'desc', topK: Math.max(rr.rows.length, 20) },
      filters: [],
      title: rankedChartTitle(q.id, rr.operationId, cohort, n, levels.levelFrom, levels.levelTo),
    }, dryRun);
    if (ranked) charts.push(ranked);
  } else log(`${q.id}: rule run ${rr.id} has no ${RANKED_CHART.featureColumn}/${RANKED_CHART.valueColumn} columns — no ranked chart`);
  // 2. the measured value per focus gene, on the cohort's source slice (filters = cohort + focus genes; `in` is what the dataset query accepts for a list)
  const cohortSnap = cohortSnapshot(s, all);
  if (!cohortSnap) { log(`${q.id}: no filter snapshot matches ${scopeOf(s)} — no source-slice chart`); return charts; }
  const slice = await ensureChart(client, H, t.workspaceId, q.datasetId, analysisId, cohortSnap.id, {
    templateId: 'bar_grouped_v1',
    bindings: { x: { column_id: colId(SLICE_CHART.xColumn) }, y: { column_id: colId(SLICE_CHART.yColumn) }, color: { column_id: colId(SLICE_CHART.colorColumn) } },
    // `cohort` is ignored by the renderer; it is here because the render cache key (bio-compute
    // `compute_instance_id`) hashes dataset + template + bindings + params but NOT `filters`, so the
    // responder and non-responder slices — identical but for their filters — would share one cached
    // render and the second cohort would be shown the first cohort's bars.
    params: { topK: Math.max(cfg.focusGenes.length, 20), barmode: 'group', cohort },
    filters: [...cohortFiltersOf(s), { column: SLICE_CHART.xColumn, operator: 'in', value: [...cfg.focusGenes] }],
    title: sliceChartTitle(q.id, SLICE_CHART.valueLabel, cohort, levels.levelFrom, levels.levelTo),
  }, dryRun);
  if (slice) charts.push(slice);
  return charts;
}

/** QC evidences get a chart only when the platform already recommended one on the QC table. */
async function qcCharts(client: RestClient, H: Record<string, string>, t: Trace, q: QuestionTrace, s: Snap): Promise<PublishedChart[]> {
  const rec = (await listSpecs(client, H, t.workspaceId, s.datasetId, null)).find((x) => x.templateId === QC_RECOMMENDED_TEMPLATE);
  return rec ? [{ id: rec.id, title: rec.title ?? QC_RECOMMENDED_TEMPLATE, templateId: rec.templateId, datasetId: s.datasetId, snapshotId: s.id, renderStatus: null }] : [];
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

async function ensureOneEvidence(client: RestClient, H: Record<string, string>, t: Trace, q: PublishedTrace, cfg: QuestionConfig, s: Snap, all: Snap[], existing: EvidenceRow[], levels: PairedLevels, dryRun: boolean): Promise<PublishedRecord['evidences'][number] | null> {
  const rr = q.ruleRuns.find((r) => r.id === s.ruleRunId);
  if (!rr) { log(`${q.id}: snapshot ${s.id} cites rule run ${s.ruleRunId} the trace does not carry — skipped`); return null; }
  const cohort = cohortName(cohortFiltersOf(s), cfg);
  const charts = rr.kind === 'QC' ? await qcCharts(client, H, t, q, s) : await statisticalCharts(client, H, t, q, cfg, s, all, rr, cohort, levels, dryRun);
  const content = evidenceContent(q, cfg, s, rr, cohort, levels, charts);
  const link = (id: string) => `${FRONT_URL}/projects/${t.projectId}/view-analyses/${q.viewAnalysisId}/evidences/${id}`;
  const chartEntries = charts.map((c) => ({ chartArtifactId: c.id, snapshotId: c.snapshotId, datasetVersionId: c.datasetId }));
  const body = {
    chartEntries,
    title: content.title,
    text: content.text,
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
    const e = await ensureOneEvidence(client, H, t, q, cfg, s, all, existing, levels, dryRun);
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
  const onlyArg = argv.indexOf('--only');
  const only = onlyArg >= 0 ? new Set(argv[onlyArg + 1].split(',').map((s) => s.trim())) : null;
  const trace = JSON.parse(readFileSync(TRACE_PATH, 'utf8')) as Trace;
  const client = new RestClient({ baseUrl: BASE_URL, onCall: () => undefined });
  await ensureIdentities(client, process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local', process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin');
  const serviceUserId = must(await client.as<{ id: string }>(SERVICE_HANDLE, 'GET', '/api/v1/auth/me'), 'resolving service user').id;
  void CYTOTOXIC_FOCUS;
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
