import { SERVICE_HANDLE, recordTouched } from './context';
import { requireWorkspaceId, requireProjectId, findExistingDataset } from './datasetIngestion';
import { findExistingAnalysis, requireDatasetId } from './analysisFraming';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { ChartSpecFixture, DataRequirement, DatasetFixture } from '../fixtures/types';
import type { Step } from './types';

/**
 * FR8/FR23/AC6/AC7 (AXI-1374, Capture Spec §6.1-6.3) — stages the six
 * user-created charts on the AXI-1373 analysis (`cf17e1ea`). Every chart
 * this step creates gets `origin: 'user'` by CONSTRUCTION —
 * `CandidatesService.persistUserSpec` hard-codes `origin: 'user'` on every
 * spec the create route persists
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
 * CHARTS 5-6 / SECOND DATASET (AC5 amended, AXI-1374): charts 1-4 bind
 * `dataRequirement: 'de_table'`; charts 5-6 bind `'count_matrix'`, backed by
 * the second dataset AXI-1374 ingests (see `datasetIngestion.ts`,
 * `tenantFixture.ts`'s `content.datasets`). `isChartStageable` checks LIVE
 * platform state — which dataset roles are actually ingested and
 * `available` — not a hard-coded constant (see its doc).
 *
 * A chart's `datasetVersionId` (URL path) is the dataset it was CREATED on;
 * its `viewAnalysisId` (body field) is independent — `persistUserSpec`
 * never cross-checks the two (confirmed against
 * `candidates.service.ts:336-358`). That is what lets charts 5-6 be created
 * on the count-matrix dataset while still carrying this analysis's id, and
 * it is also this design's one disclosed limitation:
 *
 * KNOWN GAP (frontend, not fixed here — SI-044 is REST-only, no product
 * change): `axiome-front`'s analysis page derives its chart gallery's
 * `:datasetId` solely from the view-analysis's OWN `datasetId` field (or a
 * snapshot in ITS OWN lineage) — `ProjectViewAnalysisDetail.tsx:1742`,
 * `DatasetVisualizations.tsx:319,637`. It never looks at a candidate's own
 * `datasetVersionId`. So charts 5-6, though genuinely tagged
 * `viewAnalysisId: cf17e1ea` and verifiable via
 * `GET .../datasets/<count-matrix-id>/candidates?viewAnalysisId=cf17e1ea`,
 * will NOT appear merged into analysis `cf17e1ea`'s own page today — they
 * render on the count-matrix dataset's OWN standalone gallery at
 * `/datasets/<count-matrix-id>/visualizations` instead. This is a real,
 * disclosed integration gap for a future story to close (frontend change,
 * out of SI-044's scope), not something this step can or should paper over.
 *
 * FR16/AC6 ("no auto candidate visible") — this step CANNOT delete a
 * pre-existing `origin: 'auto'` spec even if one existed:
 * `CandidatesService.deleteUserSpec` explicitly refuses to delete anything
 * but a user-origin spec (line ~357), and NFR3 forbids reaching around that
 * over Prisma. So this step's contribution to AC6 is verification, not
 * mitigation: it logs and records how many auto-origin specs are visible on
 * each dataset (`reportAutoCandidateVisibility`). The actual mitigation is
 * the frontend fix (SI-033, `axiome-front/src/lib/charts/originFilter.ts`)
 * — the gallery's Origin filter is now an addressable deep-link
 * (`?chartOrigin=user`).
 */
export const ensureChartsStep: Step<ProvisioningContext> = {
  id: 'ensure-charts',
  dependsOn: ['ensure-analysis-framing'],
  async run(ctx) {
    const content = ctx.fixture.content;
    const primary = content.datasets.find((d) => d.role === 'de_table');
    if (!primary || content.chartSpecs.length === 0) return;
    const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
    const primaryDatasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
    const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, primaryDatasetId);

    const datasetIdByRole = await resolveAvailableDatasetIds(ctx, workspaceId, content.datasets);
    const existing = await fetchAllExistingSpecs(ctx, workspaceId, datasetIdByRole, analysisId);
    for (const spec of content.chartSpecs) await ensureOneChart(ctx, workspaceId, datasetIdByRole, analysisId, spec, existing);
    await reportAutoCandidateVisibility(ctx, workspaceId, [...datasetIdByRole.values()]);
  },
};

interface ExistingSpec {
  id: string;
  title: string | null;
  origin: 'auto' | 'user';
}

/**
 * Exported for unit testing (NFR1 idempotency / FR9-shaped truth guard) —
 * pure, no network. `availableRoles` is the caller's LIVE snapshot of which
 * dataset roles are actually ingested and available (see
 * `resolveAvailableDatasetIds`) — the guard reflects real platform state,
 * not a fixture wish or a hard-coded constant.
 */
export function isChartStageable(spec: ChartSpecFixture, availableRoles: ReadonlySet<DataRequirement>): boolean {
  return availableRoles.has(spec.dataRequirement);
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

/** Live check (not fixture-declared, not a constant) — a dataset role is
 *  "available" only once its fixture-named dataset is actually ingested and
 *  `available` on the platform. Backs `isChartStageable`'s real-state guard. */
async function resolveAvailableDatasetIds(
  ctx: ProvisioningContext,
  workspaceId: string,
  datasets: DatasetFixture[],
): Promise<Map<DataRequirement, string>> {
  const map = new Map<DataRequirement, string>();
  for (const dataset of datasets) {
    const found = await findExistingDataset(ctx, workspaceId, dataset.originalFilename);
    if (found && found.availability === 'available') map.set(dataset.role, found.id);
  }
  return map;
}

async function fetchAllExistingSpecs(
  ctx: ProvisioningContext,
  workspaceId: string,
  datasetIdByRole: Map<DataRequirement, string>,
  analysisId: string,
): Promise<ExistingSpec[]> {
  const perDataset = await Promise.all([...datasetIdByRole.values()].map((id) => fetchExistingSpecs(ctx, workspaceId, id, analysisId)));
  return perDataset.flat();
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
  datasetIdByRole: Map<DataRequirement, string>,
  analysisId: string,
  spec: ChartSpecFixture,
  existing: ExistingSpec[],
): Promise<void> {
  const availableRoles = new Set(datasetIdByRole.keys());
  if (!isChartStageable(spec, availableRoles)) return logWithheldChart(ctx, spec);
  if (alreadyStagedChart(existing, spec)) {
    recordTouched(ctx, { kind: 'chart', name: spec.title, id: 'n/a', action: 'reused' });
    return;
  }
  const datasetId = datasetIdByRole.get(spec.dataRequirement);
  if (!datasetId) throw new Error(`chart "${spec.title}" passed the stageable guard but no dataset id resolved for "${spec.dataRequirement}"`);
  await createChart(ctx, workspaceId, datasetId, analysisId, spec);
}

function logWithheldChart(ctx: ProvisioningContext, spec: ChartSpecFixture): void {
  const reason = `requires the "${spec.dataRequirement}" dataset, which is not ingested/available in this tenant yet`;
  console.log(`[staging] withheld chart "${spec.title}" — ${reason}`);
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
 * specs exist on each dataset this tenant carries. Logged (NFR7) and
 * recorded as a `touched` entry so the story report can cite the live count
 * without re-reading console output; does not throw; a live 404/empty
 * result reads as zero.
 */
async function reportAutoCandidateVisibility(ctx: ProvisioningContext, workspaceId: string, datasetIds: string[]): Promise<void> {
  for (const datasetId of datasetIds) await reportAutoCandidateVisibilityForDataset(ctx, workspaceId, datasetId);
}

async function reportAutoCandidateVisibilityForDataset(ctx: ProvisioningContext, workspaceId: string, datasetId: string): Promise<void> {
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
  recordTouched(ctx, { kind: 'chart', name: `auto-candidate-count:${datasetId}`, id: String(autoCount), action: autoCount === 0 ? 'reused' : 'linked' });
}
