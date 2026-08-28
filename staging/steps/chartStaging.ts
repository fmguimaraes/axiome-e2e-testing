import { SERVICE_HANDLE, recordTouched } from './context';
import { requireWorkspaceId, requireProjectId } from './datasetIngestion';
import { findExistingAnalysis, requireDatasetId } from './analysisFraming';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { ChartSpecFixture } from '../fixtures/types';
import type { Step } from './types';

/**
 * FR8/FR23/AC6/AC7 (AXI-1374, Capture Spec §6.1-6.3) — stages the six
 * user-created charts on the AXI-1373 analysis (`cf17e1ea`, dataset
 * `94b0bd10`). Every chart this step creates gets `origin: 'user'` by
 * CONSTRUCTION — `CandidatesService.persistUserSpec` hard-codes
 * `origin: 'user'` on every spec the create route persists
 * (`apps/organization-service/src/candidates/candidates.service.ts:348`) —
 * there is no "auto" code path this step could accidentally take (FR8).
 * Scoping every chart's `viewAnalysisId` to this analysis, rather than
 * leaving it dataset-wide, is what makes "the six charts" a well-defined
 * set for AC6's count check instead of "every user chart ever created on
 * this dataset".
 *
 * Deliberately never calls `visualizations/generate` or `candidates/
 * regenerate` (Capture Spec §6.1's "kill the auto cross-product" — the
 * dev-epic-context's standing rule for this whole epic).
 *
 * FR16/AC6 ("no auto candidate visible") — this step CANNOT delete a
 * pre-existing `origin: 'auto'` spec even if one existed:
 * `CandidatesService.deleteUserSpec` explicitly refuses to delete anything
 * but a user-origin spec (line ~357), and NFR3 forbids reaching around that
 * over Prisma. So this step's contribution to AC6 is verification, not
 * mitigation: it logs and records how many auto-origin specs are visible on
 * this dataset (§`reportAutoCandidateVisibility`). The actual mitigation is
 * the frontend fix (SI-033, `axiome-front/src/lib/charts/originFilter.ts`)
 * — the gallery's Origin filter is now an addressable deep-link
 * (`?chartOrigin=user`), so a capture can force the User-created view
 * regardless of what else exists on the dataset, without a click.
 */
export const ensureChartsStep: Step<ProvisioningContext> = {
  id: 'ensure-charts',
  dependsOn: ['ensure-analysis-framing'],
  async run(ctx) {
    const content = ctx.fixture.content;
    const dataset = content.dataset;
    if (!dataset || content.chartSpecs.length === 0) return;
    const workspaceId = requireWorkspaceId(ctx, dataset.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, dataset.projectName);
    const datasetId = await requireDatasetId(ctx, workspaceId, dataset.originalFilename);
    const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, datasetId);

    const existing = await fetchExistingSpecs(ctx, workspaceId, datasetId, analysisId);
    for (const spec of content.chartSpecs) await ensureOneChart(ctx, workspaceId, datasetId, analysisId, spec, existing);
    await reportAutoCandidateVisibility(ctx, workspaceId, datasetId);
  },
};

/**
 * FR8/AC5 — charts 5-6 (Capture Spec §6.2 #5/#6) need PER-SAMPLE expression
 * (a count matrix + sample metadata: `riaz_de/CountData.BMS038.txt` +
 * `SampleTableCorrected.9.19.16.csv`), not the ingested DE-TABLE dataset
 * (`94b0bd10`) — the DE table (gene, baseMean, log2FoldChange, lfcSE,
 * pvalue, padj) has exactly one row per gene, already collapsed across
 * samples; there is no per-sample column to group by response or timepoint.
 *
 * The count matrix is NOT ingested anywhere in this tenant. Ingesting it
 * would mean a SECOND dataset version bound to this analysis, which is
 * exactly what AC5 (AXI-1372, "one dataset version backs every chart in the
 * tenant") forbids without a deliberate, reviewed decision to widen that
 * choice — not something this story does unilaterally. Default false:
 * charts 5-6 stay withheld until a future story either (a) ingests the
 * count matrix as a second, AC5-reviewed dataset, or (b) the product
 * decision is made to ship 4 charts. See the AXI-1374 design-note Jira
 * comment for the full writeup and recommendation.
 */
export const COUNT_MATRIX_INGESTED = false;

export const COUNT_MATRIX_WITHHELD_REASON =
  'requires per-sample expression (count matrix + sample metadata) — not present in the ingested DE-table ' +
  'dataset (94b0bd10); ingesting a second dataset would violate AC5\'s single-dataset-version rule without a ' +
  'deliberate, reviewed decision to widen it (see AXI-1374 design note)';

interface ExistingSpec {
  id: string;
  title: string | null;
  origin: 'auto' | 'user';
}

/** Exported for unit testing (NFR1 idempotency / FR9-shaped truth guard) —
 *  pure, no network. */
export function isChartStageable(spec: ChartSpecFixture): boolean {
  return spec.dataRequirement === 'de_table' || COUNT_MATRIX_INGESTED;
}

/** Exported for unit testing — pure, no network. A chart is already staged
 *  when a USER-origin spec with the exact same title already exists; title
 *  is the one piece of chart "wording" FR6 treats as content, so it is also
 *  the natural re-run identity (same shape as `alreadyStaged` for
 *  assumptions, keyed on text instead of a category+author pair). */
export function alreadyStagedChart(existing: ExistingSpec[], spec: ChartSpecFixture): boolean {
  return existing.some((e) => e.origin === 'user' && e.title === spec.title);
}

/** Exported for unit testing — pure mapping from fixture to the create
 *  request body, no network. */
export function toCreateBody(spec: ChartSpecFixture, viewAnalysisId: string): Record<string, unknown> {
  return {
    templateId: spec.templateId,
    templateVersion: spec.templateVersion,
    bindings: spec.bindings,
    params: spec.params ?? {},
    filters: spec.filters ?? [],
    combinator: spec.combinator,
    columnCombinators: spec.columnCombinators,
    title: spec.title,
    viewAnalysisId,
  };
}

async function requireAnalysisId(ctx: ProvisioningContext, workspaceId: string, projectId: string, datasetId: string): Promise<string> {
  const analysis = await findExistingAnalysis(ctx, workspaceId, projectId, datasetId);
  if (!analysis) throw new Error(`view-analysis not found for dataset ${datasetId} — ensure-analysis-framing must run first`);
  return analysis.id;
}

async function fetchExistingSpecs(ctx: ProvisioningContext, workspaceId: string, datasetId: string, analysisId: string): Promise<ExistingSpec[]> {
  const res = await ctx.client.as<{ data: ExistingSpec[] } | ExistingSpec[]>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates?viewAnalysisId=${analysisId}`,
    undefined,
    projectHeaders(workspaceId),
  );
  const body = res.body;
  return Array.isArray(body) ? body : (body?.data ?? []);
}

async function ensureOneChart(
  ctx: ProvisioningContext,
  workspaceId: string,
  datasetId: string,
  analysisId: string,
  spec: ChartSpecFixture,
  existing: ExistingSpec[],
): Promise<void> {
  if (!isChartStageable(spec)) return logWithheldChart(ctx, spec);
  if (alreadyStagedChart(existing, spec)) {
    recordTouched(ctx, { kind: 'chart', name: spec.title, id: 'n/a', action: 'reused' });
    return;
  }
  await createChart(ctx, workspaceId, datasetId, analysisId, spec);
}

function logWithheldChart(ctx: ProvisioningContext, spec: ChartSpecFixture): void {
  console.log(`[staging] withheld chart "${spec.title}" — ${COUNT_MATRIX_WITHHELD_REASON}`);
  recordTouched(ctx, { kind: 'chart', name: spec.title, id: 'n/a', action: 'withheld' });
}

async function createChart(
  ctx: ProvisioningContext,
  workspaceId: string,
  datasetId: string,
  analysisId: string,
  spec: ChartSpecFixture,
): Promise<void> {
  const res = await ctx.client.as<{ id: string; origin: string }>(
    SERVICE_HANDLE,
    'POST',
    `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates`,
    toCreateBody(spec, analysisId),
    projectHeaders(workspaceId),
  );
  if (!res.ok || !res.body) throw new Error(`creating chart "${spec.title}" failed (status ${res.status})`);
  if (res.body.origin !== 'user') {
    // Defensive — see the module doc: persistUserSpec always sets 'user'.
    // A mismatch here means the backend contract changed under us; fail
    // loudly rather than silently shipping an AC6 violation.
    throw new Error(`chart "${spec.title}" was created with origin "${res.body.origin}", expected "user" (AC6)`);
  }
  recordTouched(ctx, { kind: 'chart', name: spec.title, id: res.body.id, action: 'created' });
}

/**
 * FR16/AC6 verification (see module doc) — reports how many `origin:'auto'`
 * specs exist on this dataset. Logged (NFR7) and recorded as a `touched`
 * entry so the story report can cite the live count without re-reading
 * console output; does not throw; a live 404/empty result reads as zero.
 */
async function reportAutoCandidateVisibility(ctx: ProvisioningContext, workspaceId: string, datasetId: string): Promise<void> {
  const res = await ctx.client.as<{ data: ExistingSpec[] } | ExistingSpec[]>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates`,
    undefined,
    projectHeaders(workspaceId),
  );
  const body = res.body;
  const all = Array.isArray(body) ? body : (body?.data ?? []);
  const autoCount = all.filter((s) => s.origin === 'auto').length;
  console.log(`[staging] AC6 check: ${autoCount} origin:'auto' spec(s) exist on dataset ${datasetId} (mitigated at capture via ?chartOrigin=user)`);
  recordTouched(ctx, { kind: 'chart', name: 'auto-candidate-count', id: String(autoCount), action: autoCount === 0 ? 'reused' : 'linked' });
}
