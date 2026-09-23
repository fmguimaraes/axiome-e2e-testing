/**
 * AXI-1586 — the `userCharts[]` mechanism: additional, question-scoped
 * user-origin charts on a SOURCE dataset (PAIRED / WIDE / DE / DE_STRATA),
 * each bound to its own evidence with its own reading, on top of the
 * `origin: 'recommended'` chart(s) `publishRiazEvidence.ts` already selects
 * and binds (AXI-1553) — never a replacement for one. See the brief:
 * `../axiome-docs/demo/riaz-2017/Riaz-Chart-Enrichment-Brief.md` §1/§3.
 *
 * Idempotent: a spec is found-or-created by TITLE on its dataset (the export
 * labels by title, so titles are unique per dataset by construction) — and,
 * if found, REPLACED (delete + recreate) when its `params` no longer match
 * the plan's, since `/candidates` has no PATCH; a scope snapshot is
 * found-or-created by (datasetId, filters) on the analysis; an evidence is
 * found-or-created by title on the analysis and rebinds automatically
 * whenever its cited `chartArtifactId` changes. A second run of
 * `stage:riaz-publish` creates nothing new when nothing changed.
 */
import { RestClient } from '../client/RestClient';
import { must, asList } from '../rules/ensureRule';
import { SERVICE_HANDLE } from './context';
import type { CohortFilter } from './riazEvidenceText';

export type UserChartDatasetHandle = 'PAIRED' | 'WIDE' | 'DE' | 'DE_STRATA';

/** The source dataset behind each handle — see `Riaz-Chart-Enrichment-Brief.md` §1's table. */
export const USER_CHART_DATASET_FILES: Record<UserChartDatasetHandle, string> = {
  PAIRED: 'riaz2017_immune_paired_log2cpm_long.csv',
  WIDE: 'riaz2017_expression_by_response_timepoint_v2.csv',
  DE: 'riaz2017_de_pre_R_vs_NR.csv',
  DE_STRATA: 'riaz2017_stratified_de_by_prior_ipi.csv',
};

export interface UserChartInterpretation { label: string; text: string }

export interface UserChartPlan {
  /** discriminator for the render-cache workaround (`params.cohort`) and the evidence/spec title suffix — unique within a question. */
  key: string;
  templateId: string;
  templateVersion?: string;
  dataset: UserChartDatasetHandle;
  /** bio-compute filters, same shape as a snapshot's `filters` — [] for "whole dataset". */
  filters: CohortFilter[];
  /** role → column name (NOT `col_`-prefixed — this module adds that). */
  bindings: Record<string, string>;
  params?: Record<string, unknown>;
  title: string;
  /** the chart's reading — becomes the bound evidence's text. */
  reading: string;
  /** a second, non-exclusive reading of the SAME chart — becomes a second DecisionDraft citing the same evidence. */
  interpretation?: UserChartInterpretation;
}

export interface SpecRow { id: string; title: string | null; origin: string; templateId: string; params?: Record<string, unknown> | null }
interface SnapRow { id: string; datasetId: string; filters?: CohortFilter[] | null; origin: string }

export const filterKey = (f: CohortFilter): string => `${f.column} ${f.operator} ${Array.isArray(f.value) ? f.value.join('/') : String(f.value)}`;
export const sameFilterSet = (a: CohortFilter[], b: CohortFilter[]): boolean => {
  const ak = [...a].map(filterKey).sort(), bk = [...b].map(filterKey).sort();
  return ak.length === bk.length && ak.every((x, i) => x === bk[i]);
};

/** Params equality ignoring the render-cache `cohort` discriminator, which every spec carries regardless of the plan. */
export const sameChartParams = (a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean => {
  const normalize = (p: Record<string, unknown> | null | undefined) =>
    JSON.stringify(
      Object.entries(p ?? {})
        .filter(([k]) => k !== 'cohort')
        .sort(([x], [y]) => x.localeCompare(y)),
    );
  return normalize(a) === normalize(b);
};

async function listSnapshots(client: RestClient, H: Record<string, string>, analysisId: string): Promise<SnapRow[]> {
  return asList<SnapRow>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`, undefined, H), 'listing snapshots'));
}

async function listSpecs(client: RestClient, H: Record<string, string>, workspaceId: string, datasetId: string, analysisId: string): Promise<SpecRow[]> {
  return asList<SpecRow>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates?viewAnalysisId=${analysisId}`, undefined, H), 'listing candidates'));
}

/**
 * The snapshot carrying this chart's FULL scope on `datasetId`: found by
 * (datasetId, filters) among the analysis's own snapshots, else minted
 * (`POST /view-analyses/snapshots`, `origin: 'linked'` when `datasetId` is
 * not the analysis's own dataset — Operating Manual §4).
 */
export async function ensureScopeSnapshot(client: RestClient, H: Record<string, string>, analysisId: string, ownDatasetId: string, datasetId: string, filters: CohortFilter[], dryRun: boolean): Promise<string | null> {
  const found = (await listSnapshots(client, H, analysisId)).find((s) => s.datasetId === datasetId && sameFilterSet(s.filters ?? [], filters));
  if (found) return found.id;
  if (dryRun) return null;
  const body: Record<string, unknown> = { viewAnalysisId: analysisId, filters };
  if (datasetId !== ownDatasetId) { body.datasetId = datasetId; body.origin = 'linked'; }
  const created = must(await client.as<{ id: string }>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/snapshots', body, H), 'creating scope snapshot');
  return created.id;
}

export const toBindings = (bindings: Record<string, string>): Record<string, { column_id: string }> =>
  Object.fromEntries(Object.entries(bindings).map(([role, col]) => [role, { column_id: `col_${col}` }]));

/**
 * Find-or-create the plan's spec by TITLE on its dataset (AXI-1586 mechanic —
 * never by filters, the render cache ignores them). If a spec with this title
 * already exists but its params (e.g. `aggregation`) no longer match the
 * plan — the seed template's default drifted underneath it, or the plan was
 * edited — there is no PATCH on `/candidates` (Operating Manual §9), so the
 * stale spec is DELETEd and a replacement is created; the caller's
 * `ensureUserChartEvidence` rebinds automatically because the returned
 * spec's `id` differs from what the evidence's `chartEntries` cite.
 */
export async function ensureUserChartSpec(client: RestClient, H: Record<string, string>, workspaceId: string, datasetId: string, analysisId: string, qId: string, plan: UserChartPlan, dryRun: boolean): Promise<SpecRow | null> {
  const found = (await listSpecs(client, H, workspaceId, datasetId, analysisId)).find((s) => s.title === plan.title);
  const desiredParams = { ...(plan.params ?? {}), cohort: `${qId}:${plan.key}` };
  if (found && sameChartParams(found.params, desiredParams)) return found;
  if (dryRun) return found ?? null;
  if (found) await client.as<unknown>(SERVICE_HANDLE, 'DELETE', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates/${found.id}`, undefined, H);
  const body = {
    templateId: plan.templateId,
    templateVersion: plan.templateVersion ?? '1.0.0',
    bindings: toBindings(plan.bindings),
    params: desiredParams,
    filters: plan.filters,
    title: plan.title,
  };
  return must(await client.as<SpecRow>(SERVICE_HANDLE, 'POST', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates?viewAnalysisId=${analysisId}`, body, H), `creating user chart "${plan.title}"`);
}

// ── evidence ─────────────────────────────────────────────────────────────────

export interface EvidenceVersionRow { id: string; versionNumber?: number; title: string | null; text?: string | null; chartArtifactIds?: string[] }
export interface EvidenceRow { id: string; currentVersion?: EvidenceVersionRow }
export interface UserChartEvidence { id: string; versionId: string; versionNumber: number | null; title: string; text: string; snapshotId: string; link: string }

const sameIds = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Find-or-create/update the evidence for one `userCharts[]` plan — same shape as `publishRiazEvidence.ts`'s `ensureOneEvidence`, minus the rule-run citation (there is none: `kind: 'chart'`). */
export async function ensureUserChartEvidence(
  client: RestClient,
  H: Record<string, string>,
  viewAnalysisId: string,
  existing: readonly EvidenceRow[],
  spec: SpecRow,
  snapshotId: string,
  datasetId: string,
  plan: UserChartPlan,
  link: (id: string) => string,
  dryRun: boolean,
): Promise<UserChartEvidence | null> {
  const chartEntries = [{ chartArtifactId: spec.id, snapshotId, datasetVersionId: datasetId }];
  const body = { chartEntries, title: plan.title, text: plan.reading, kind: 'chart' as const };
  const found = existing.find((e) => e.currentVersion?.title === plan.title);
  const record = (e: EvidenceRow): UserChartEvidence => ({ id: e.id, versionId: e.currentVersion!.id, versionNumber: e.currentVersion!.versionNumber ?? null, title: plan.title, text: plan.reading, snapshotId, link: link(e.id) });
  if (found?.currentVersion) {
    const unchanged = found.currentVersion.text === plan.reading && sameIds(found.currentVersion.chartArtifactIds ?? [], [spec.id]);
    if (unchanged || dryRun) return record(found);
    must(await client.as<unknown>(SERVICE_HANDLE, 'PATCH', `/api/v1/view-analyses/evidences/${found.id}`, body, H), `updating user-chart evidence ${found.id}`);
    const after = must(await client.as<EvidenceRow>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/evidences/${found.id}`, undefined, H), `reading evidence ${found.id}`);
    return record(after);
  }
  if (dryRun) return null;
  const created = must(await client.as<EvidenceRow>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/evidences', { viewAnalysisId, ...body }, H), `creating user-chart evidence "${plan.title}"`);
  return record(created);
}
