import { SERVICE_HANDLE, recordTouched } from './context';
import { requireWorkspaceId, requireProjectId, findExistingDataset } from './datasetIngestion';
import { requireDatasetId } from './analysisFraming';
import { fetchExistingSpecs, requireAnalysisId } from './chartStaging';
import { fetchSnapshots, findSnapshotByName } from './snapshotStaging';
import { ensureMemberRole } from './workspaceMembership';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { ExistingSpec } from './chartStaging';
import type { SnapshotSummary } from './snapshotStaging';
import type {
  DataRequirement,
  DatasetFixture,
  EvidenceFixture,
  InterpretationCitation,
  InterpretationFixture,
} from '../fixtures/types';
import type { Step } from './types';

/**
 * FR12/AC11 (AXI-1377, Capture Spec §9) — stages 6 evidence records (mixed
 * kinds), 3 interpretations (= DecisionDrafts, see the dev-epic-context's
 * naming note), and publishes exactly one view, on the AXI-1373 analysis
 * (`cf17e1ea`). Depends on `ensure-snapshots` (evidence/interpretations cite
 * snapshots v1/v2) and `ensure-thresholds` (the "Significant DE" chart's
 * thresholds are what the cited chart is literally about).
 *
 * EVIDENCE-KIND FINDING: no `kind` enum exists on the backend `Evidence`
 * entity at all — see `EvidenceKind`'s doc in `fixtures/types.ts` for the
 * full investigation and the honest 3-way mapping this step actually stages
 * onto (`chartEntries` only / `citationContext.kind:'de'` only /
 * `chartEntries` + `parentEvidenceId`).
 *
 * CONTRACT-DRIFT FINDING (real backend bug, no fix here — SI-044 is
 * REST-only): the gateway's own declared `CreateEvidenceRequest` type
 * (`libs/contracts/src/view-analysis/view-analysis.patterns.ts`) has flat
 * `chartArtifactIds`/`snapshotIds` fields, but `ViewAnalysesService.
 * createEvidence()` actually destructures `chartEntries: ChartEntryDto[]`
 * (`create-evidence.dto.ts`) — the RPC handler forwards the gateway body
 * with `data as any`, so whatever shape the REST caller sends passes
 * straight through unchanged. Confirmed live: a `chartArtifactIds`/
 * `snapshotIds` body is silently accepted and produces an evidence version
 * with EMPTY `chartArtifactIds`/`snapshotIds` (the extra fields are just
 * ignored, no error) — only the `chartEntries` shape actually binds a
 * chart/snapshot/dataset. This step always sends `chartEntries`.
 *
 * SNAPSHOT-ID FINDING: the dev-epic-context's "AXI-1377 evidence may cite"
 * snapshot v2 id (`91c9f3d5`) is now STALE — AXI-1376's OQ6 follow-up
 * (commit `cce12b7`) superseded that row (renamed with a "(superseded...)"
 * suffix) and minted a NEW snapshot (version 3, live id `f63de7bf-...`)
 * under the canonical "Snapshot v2 — stratified..." name. This step always
 * resolves v2 by NAME via `findSnapshotByName` (never a hard-coded id), so
 * it is immune to this drift — but a future reader of the dev-epic-context
 * log should use the live snapshot list, not the AXI-1376 entry, for v2's id.
 *
 * PROVENANCE-FORK MECHANISM (AC11, confirmed live): `getProvenanceGraph`
 * materializes an `INFORMED` edge from each cited Evidence node to a
 * Decision node. Two interpretations both citing the SAME evidence by
 * `evidenceId` (not `snapshotId`) therefore gives that Evidence node 2
 * incoming edges — a real fork, not a straight line. The fixture wires this:
 * both the CN "weak separation" interpretation and the LF "model
 * calibration" interpretation cite the "Top discriminating genes" evidence.
 *
 * TAB-MEMBERSHIP FINDING: a decision counts toward THIS analysis's
 * Interpretations tab if EITHER an `evidenceLinks[].snapshotId` matches one
 * of the analysis's own snapshots OR an `evidenceLinks[].evidenceId` matches
 * one of the analysis's own evidence (`decision-drafts.service.ts
 * findAllByViewAnalysis`, raw-SQL JSONB `EXISTS` check, confirmed live) — so
 * an interpretation citing only a snapshot (no evidence) still counts toward
 * "Interpretations = 3", it just does not satisfy "citing evidence
 * explicitly" on its own. It also does NOT materialize a Decision
 * provenance-graph node under the current self-heal logic (which only
 * resolves nodes via `evidenceLinks[].evidenceId`) — a real, disclosed gap:
 * a snapshot-only-cited interpretation is counted on the tab but invisible
 * in the provenance graph. Logged here, not fixed (SI-044 is REST-only); it
 * does not block AC11 since the fork requirement is met independently by
 * the two evidence-citing interpretations.
 *
 * PUBLISH-SINGULARITY FINDING: `PublishedViewAnalysisVersion` has no unique
 * constraint on `viewAnalysisId` — the backend happily creates v1, v2, v3...
 * on repeat `publish` calls (an append-only versioned pattern). "Published =
 * 1" (AC11) is therefore a toolkit-enforced rule, not a backend one:
 * `ensurePublished` checks `GET .../published-versions` first and publishes
 * only when that list is empty.
 *
 * Idempotent (NFR1): evidence is matched by title, interpretations by label,
 * and publish is skipped once any published version exists.
 */
export const ensureInterpretationsEvidencePublishStep: Step<ProvisioningContext> = {
  id: 'ensure-interpretations-evidence-publish',
  dependsOn: ['ensure-snapshots', 'ensure-thresholds'],
  async run(ctx) {
    const content = ctx.fixture.content;
    const primary = content.datasets.find((d) => d.role === 'de_table');
    if (!primary || content.evidence.length === 0) return;
    const deps = await resolveDeps(ctx, primary, content.datasets);
    const evidenceIdByTitle = await ensureEvidence(ctx, deps, content.evidence);
    const decisionIds = await ensureInterpretations(ctx, deps, content.interpretations, evidenceIdByTitle);
    const evidenceVersionIds = [...evidenceIdByTitle.values()].map((e) => e.versionId);
    await ensurePublished(ctx, deps.workspaceId, deps.analysisId, evidenceVersionIds, decisionIds);
  },
};

// ─── Shared dependency resolution ──────────────────────────────────────────

interface StagingDeps {
  workspaceId: string;
  analysisId: string;
  deTableDatasetId: string;
  datasetIdByRole: Map<DataRequirement, string>;
  specs: ExistingSpec[];
  snapshots: SnapshotSummary[];
}

async function resolveDeps(ctx: ProvisioningContext, primary: DatasetFixture, datasets: DatasetFixture[]): Promise<StagingDeps> {
  const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
  const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
  const deTableDatasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
  const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, deTableDatasetId);
  const datasetIdByRole = await resolveDatasetIdsByRole(ctx, workspaceId, datasets);
  const specs = await fetchExistingSpecs(ctx, workspaceId, deTableDatasetId, analysisId);
  const snapshots = await fetchSnapshots(ctx, workspaceId, analysisId);
  return { workspaceId, analysisId, deTableDatasetId, datasetIdByRole, specs, snapshots };
}

async function resolveDatasetIdsByRole(ctx: ProvisioningContext, workspaceId: string, datasets: DatasetFixture[]): Promise<Map<DataRequirement, string>> {
  const map = new Map<DataRequirement, string>();
  for (const d of datasets) {
    const found = await findExistingDataset(ctx, workspaceId, d.originalFilename);
    if (found) map.set(d.role, found.id);
  }
  return map;
}

function requireDatasetIdForRole(deps: StagingDeps, role: DataRequirement): string {
  const id = deps.datasetIdByRole.get(role);
  if (!id) throw new Error(`no live dataset found for role "${role}" — ensure-dataset must run first`);
  return id;
}

// ─── Evidence (FR12/AC11, Capture Spec §9: "6, mixed kinds") ──────────────

interface ExistingEvidence {
  id: string;
  title: string;
  versionId: string;
}

interface RawEvidence {
  id: string;
  currentVersion?: { id: string; title: string | null };
}

async function fetchExistingEvidence(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<ExistingEvidence[]> {
  const res = await ctx.client.as<{ data: RawEvidence[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/view-analyses/${analysisId}/evidences?page=1&limit=50`,
    undefined,
    projectHeaders(workspaceId),
  );
  if (!res.ok) throw new Error(`listing existing evidence for analysis ${analysisId} failed (status ${res.status}) — refusing to treat this as "no existing evidence"`);
  return (res.body?.data ?? []).flatMap(toExistingEvidence);
}

function toExistingEvidence(raw: RawEvidence): ExistingEvidence[] {
  if (!raw.currentVersion?.title) return [];
  return [{ id: raw.id, title: raw.currentVersion.title, versionId: raw.currentVersion.id }];
}

async function ensureEvidence(ctx: ProvisioningContext, deps: StagingDeps, fixtures: EvidenceFixture[]): Promise<Map<string, ExistingEvidence>> {
  const existing = await fetchExistingEvidence(ctx, deps.workspaceId, deps.analysisId);
  const evidenceIdByTitle = new Map<string, ExistingEvidence>();
  for (const fixture of fixtures) await ensureOneEvidence(ctx, deps, evidenceIdByTitle, existing, fixture);
  return evidenceIdByTitle;
}

async function ensureOneEvidence(
  ctx: ProvisioningContext,
  deps: StagingDeps,
  evidenceIdByTitle: Map<string, ExistingEvidence>,
  existing: ExistingEvidence[],
  fixture: EvidenceFixture,
): Promise<void> {
  const found = existing.find((e) => e.title === fixture.title);
  if (found) {
    evidenceIdByTitle.set(fixture.title, found);
    return;
  }
  const body = await buildEvidenceBody(ctx, deps, evidenceIdByTitle, fixture);
  const created = await createEvidence(ctx, deps.workspaceId, body, fixture.title);
  evidenceIdByTitle.set(fixture.title, created);
}

async function buildEvidenceBody(
  ctx: ProvisioningContext,
  deps: StagingDeps,
  evidenceIdByTitle: Map<string, ExistingEvidence>,
  fixture: EvidenceFixture,
): Promise<Record<string, unknown>> {
  if (fixture.kind === 'statistical') return buildStatisticalEvidenceBody(ctx, deps, fixture);
  return buildChartBackedEvidenceBody(deps, evidenceIdByTitle, fixture);
}

function buildChartBackedEvidenceBody(
  deps: StagingDeps,
  evidenceIdByTitle: Map<string, ExistingEvidence>,
  fixture: Extract<EvidenceFixture, { kind: 'chart-derived' | 'computed' }>,
): Record<string, unknown> {
  const chart = deps.specs.find((s) => s.title === fixture.chartTitle);
  if (!chart) throw new Error(`evidence "${fixture.title}" targets chart "${fixture.chartTitle}", which is not staged — ensure-charts must run first`);
  const snapshot = findSnapshotByName(deps.snapshots, fixture.snapshotName);
  if (!snapshot) throw new Error(`evidence "${fixture.title}" targets snapshot "${fixture.snapshotName}", which is not staged`);
  const chartEntries = [{ chartArtifactId: chart.id, snapshotId: snapshot.id, datasetVersionId: deps.deTableDatasetId }];
  const base = { viewAnalysisId: deps.analysisId, chartEntries, title: fixture.title, text: fixture.text };
  if (fixture.kind !== 'computed') return base;
  return { ...base, parentEvidenceId: requireEvidenceId(evidenceIdByTitle, fixture.parentEvidenceTitle) };
}

function requireEvidenceId(evidenceIdByTitle: Map<string, ExistingEvidence>, title: string): string {
  const found = evidenceIdByTitle.get(title);
  if (!found) throw new Error(`evidence references undeclared/unstaged parent evidence "${title}" — declare it earlier in content.evidence`);
  return found.id;
}

async function createEvidence(ctx: ProvisioningContext, workspaceId: string, body: Record<string, unknown>, title: string): Promise<ExistingEvidence> {
  const res = await ctx.client.as<RawEvidence>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/evidences', body, projectHeaders(workspaceId));
  if (!res.ok || !res.body?.currentVersion) throw new Error(`staging evidence "${title}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'evidence', name: title, id: res.body.id, action: 'created' });
  return { id: res.body.id, title, versionId: res.body.currentVersion.id };
}

// ─── Statistical evidence: live-queried DE citation ────────────────────────

interface DatasetRow {
  gene: unknown;
}

async function buildStatisticalEvidenceBody(
  ctx: ProvisioningContext,
  deps: StagingDeps,
  fixture: Extract<EvidenceFixture, { kind: 'statistical' }>,
): Promise<Record<string, unknown>> {
  const datasetId = requireDatasetIdForRole(deps, fixture.datasetRole);
  const rows = await queryTopGeneRows(ctx, deps.workspaceId, datasetId, fixture.citedGeneCount, fixture.strataFilter);
  const version = await fetchDatasetVersion(ctx, deps.workspaceId, datasetId);
  const citationContext = buildDeCitationContext(datasetId, version, rows, fixture.strataFilter);
  return { viewAnalysisId: deps.analysisId, chartEntries: [], title: fixture.title, text: fixture.text, citationContext };
}

async function queryTopGeneRows(
  ctx: ProvisioningContext,
  workspaceId: string,
  datasetId: string,
  limit: number,
  strataFilter: { column: string; value: string } | undefined,
): Promise<DatasetRow[]> {
  const filters = strataFilter ? [{ column: strataFilter.column, operator: 'eq', value: strataFilter.value }] : [];
  const body = { filters, sort: { column: 'padj', direction: 'asc' }, limit, offset: 0 };
  const res = await ctx.client.as<{ rows: DatasetRow[] }>(SERVICE_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/query`, body, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`querying dataset ${datasetId} for evidence rows failed (status ${res.status})`);
  return res.body.rows;
}

async function fetchDatasetVersion(ctx: ProvisioningContext, workspaceId: string, datasetId: string): Promise<string> {
  const res = await ctx.client.as<{ version: number }>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`, undefined, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`fetching dataset ${datasetId} version failed (status ${res.status})`);
  return String(res.body.version);
}

/** Exported for unit testing — pure, no network. The `evidence_id`/
 *  `evidence_version` fields on `DECitedRow` are opaque, unvalidated strings
 *  server-side (confirmed against `de-citation.helpers.ts`'s
 *  `validateCitedRows` — it only checks presence, never resolves them
 *  against a real table) — using the dataset's own id/version here is an
 *  honest, real reference, not a fabricated one. */
export function buildDeCitationContext(
  datasetId: string,
  version: string,
  rows: DatasetRow[],
  strataFilter: { column: string; value: string } | undefined,
): Record<string, unknown> {
  return {
    kind: 'de',
    evidence_id: datasetId,
    cited_rows: rows.map((r) => citedRowFrom(datasetId, version, r)),
    view_state: buildViewState(rows.length, strataFilter),
    captured_at: new Date().toISOString(),
    captured_by: 'staging-toolkit',
  };
}

function citedRowFrom(datasetId: string, version: string, row: DatasetRow): Record<string, unknown> {
  const gene = String(row.gene);
  return { evidence_id: datasetId, evidence_version: version, row_id: gene, gene_identifier: gene };
}

function buildViewState(rowCount: number, strataFilter: { column: string; value: string } | undefined): Record<string, unknown> {
  const filters = strataFilter
    ? [{ column_id: strataFilter.column, operator: '=', value: strataFilter.value }]
    : [{ column_id: 'padj', operator: '<', value: 0.05 }];
  return {
    filters,
    ordering: { sort_specs: [{ column_id: 'padj', direction: 'asc' }], truncate_n: rowCount },
    visualization: { template_id: 'volcano_v1', bindings: { x: 'log2FoldChange', y: 'pvalue' } },
  };
}

// ─── Interpretations (= DecisionDrafts, FR12/AC11) ─────────────────────────

interface ExistingDecision {
  id: string;
  label: string;
  status: string;
}

const INTERPRETATION_WORKSPACE_ROLE = 'editor';

async function ensureInterpretations(
  ctx: ProvisioningContext,
  deps: StagingDeps,
  fixtures: InterpretationFixture[],
  evidenceIdByTitle: Map<string, ExistingEvidence>,
): Promise<string[]> {
  await grantAuthorAccess(ctx, deps.workspaceId, fixtures);
  const existing = await fetchExistingDecisions(ctx, deps.workspaceId, deps.analysisId);
  const ids: string[] = [];
  for (const fixture of fixtures) ids.push(await ensureOneInterpretation(ctx, deps, existing, evidenceIdByTitle, fixture));
  return ids;
}

async function grantAuthorAccess(ctx: ProvisioningContext, workspaceId: string, fixtures: InterpretationFixture[]): Promise<void> {
  const handles = new Set(fixtures.map((f) => f.authorHandle));
  for (const handle of handles) await ensureMemberRole(ctx, workspaceId, handle, INTERPRETATION_WORKSPACE_ROLE);
}

async function fetchExistingDecisions(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<ExistingDecision[]> {
  const res = await ctx.client.as<{ data: ExistingDecision[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/workspaces/${workspaceId}/decisions?viewAnalysisId=${analysisId}&limit=50`,
    undefined,
    projectHeaders(workspaceId),
  );
  if (!res.ok) {
    throw new Error(`fetchExistingDecisions failed (${res.status}) — refusing to default to empty (would duplicate interpretations on re-run)`);
  }
  return res.body?.data ?? [];
}

async function ensureOneInterpretation(
  ctx: ProvisioningContext,
  deps: StagingDeps,
  existing: ExistingDecision[],
  evidenceIdByTitle: Map<string, ExistingEvidence>,
  fixture: InterpretationFixture,
): Promise<string> {
  const found = existing.find((d) => d.label === fixture.label);
  const record = found ?? (await createDecision(ctx, deps, fixture, evidenceIdByTitle));
  await ensureTransitioned(ctx, deps.workspaceId, record.id, record.status, fixture.targetStatus);
  return record.id;
}

/** Exported for unit testing — pure, no network. */
export function resolveEvidenceLinks(
  citations: InterpretationCitation[],
  evidenceIdByTitle: Map<string, { id: string }>,
  snapshots: SnapshotSummary[],
): Record<string, string>[] {
  return citations.map((c) => resolveOneCitation(c, evidenceIdByTitle, snapshots));
}

function resolveOneCitation(citation: InterpretationCitation, evidenceIdByTitle: Map<string, { id: string }>, snapshots: SnapshotSummary[]): Record<string, string> {
  if (citation.evidenceTitle) {
    const ev = evidenceIdByTitle.get(citation.evidenceTitle);
    if (!ev) throw new Error(`citation references undeclared/unstaged evidence "${citation.evidenceTitle}"`);
    return { evidenceId: ev.id };
  }
  const snap = findSnapshotByName(snapshots, citation.snapshotName ?? '');
  if (!snap) throw new Error(`citation references undeclared/unstaged snapshot "${citation.snapshotName}"`);
  return { snapshotId: snap.id };
}

async function createDecision(
  ctx: ProvisioningContext,
  deps: StagingDeps,
  fixture: InterpretationFixture,
  evidenceIdByTitle: Map<string, ExistingEvidence>,
): Promise<ExistingDecision> {
  const evidenceLinks = resolveEvidenceLinks(fixture.citations, evidenceIdByTitle, deps.snapshots);
  const body = {
    label: fixture.label,
    type: fixture.type,
    confidence: fixture.confidence,
    context: { intendedUse: 'RUO' as const },
    evidenceLinks,
    evidenceValues: [],
  };
  const res = await ctx.client.as<ExistingDecision>(fixture.authorHandle, 'POST', `/api/v1/workspaces/${deps.workspaceId}/decisions`, body, projectHeaders(deps.workspaceId));
  if (!res.ok || !res.body) throw new Error(`staging interpretation "${fixture.label}" as "${fixture.authorHandle}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'interpretation', name: fixture.label, id: res.body.id, action: 'created' });
  return res.body;
}

/** Walks `draft -> reviewed[ -> approved]` one step at a time — the backend
 *  state machine only allows single-step transitions (`decision-drafts.
 *  service.ts`'s `ALLOWED_TRANSITIONS`). A no-op once `currentStatus`
 *  already matches or exceeds `targetStatus` (NFR1). */
async function ensureTransitioned(ctx: ProvisioningContext, workspaceId: string, decisionId: string, currentStatus: string, targetStatus: 'reviewed' | 'approved'): Promise<void> {
  let status = currentStatus;
  if (status === 'draft') {
    await transition(ctx, workspaceId, decisionId, 'reviewed');
    status = 'reviewed';
  }
  if (targetStatus === 'approved' && status === 'reviewed') await transition(ctx, workspaceId, decisionId, 'approved');
}

async function transition(ctx: ProvisioningContext, workspaceId: string, decisionId: string, targetStatus: string): Promise<void> {
  const res = await ctx.client.as(SERVICE_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/decisions/${decisionId}/transition`, { targetStatus }, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`transitioning interpretation ${decisionId} to "${targetStatus}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'interpretation', name: `transition:${targetStatus}`, id: decisionId, action: 'linked' });
}

// ─── Publish exactly one (FR12/AC11) ───────────────────────────────────────

async function ensurePublished(ctx: ProvisioningContext, workspaceId: string, analysisId: string, evidenceVersionIds: string[], decisionIds: string[]): Promise<void> {
  const existing = await fetchPublishedVersions(ctx, workspaceId, analysisId);
  if (existing.length > 0) return; // AC11/NFR1: never publish a second version
  await publish(ctx, workspaceId, analysisId, evidenceVersionIds, decisionIds);
}

/** Exported for reuse by `sponsorExportStaging.ts` (AXI-1379) — the sponsor
 *  export needs the same "the one published version" resolution this step
 *  already performs, by real live id rather than a hard-coded one. */
export async function fetchPublishedVersions(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<{ id: string }[]> {
  const res = await ctx.client.as<{ data: { id: string }[] }>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/published-versions`, undefined, projectHeaders(workspaceId));
  if (!res.ok) {
    throw new Error(`fetchPublishedVersions failed (${res.status}) — refusing to default to empty (would publish a duplicate version on re-run)`);
  }
  return res.body?.data ?? [];
}

async function publish(ctx: ProvisioningContext, workspaceId: string, analysisId: string, evidenceVersionIds: string[], decisionIds: string[]): Promise<void> {
  const body = { viewAnalysisId: analysisId, evidenceVersionIds, decisionIds };
  const res = await ctx.client.as<{ id: string }>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/publish', body, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`publishing analysis ${analysisId} failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'published-version', name: 'published', id: res.body.id, action: 'created' });
}
