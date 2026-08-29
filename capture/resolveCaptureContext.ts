import { RestClient } from '../staging/client/RestClient';
import { TENANT_FIXTURE } from '../staging/fixtures/tenantFixture';
import { ensureIdentities } from '../staging/identities/ensureIdentities';
import { ensureCapturePermissions } from './ensureCapturePermissions';
import { SERVICE_HANDLE } from '../staging/steps/context';
import { fetchExistingSpecs } from '../staging/steps/chartStaging';
import { fetchPublishedVersions } from '../staging/steps/interpretationsEvidenceStaging';
import { fetchSnapshots, findSnapshotByName } from '../staging/steps/snapshotStaging';
import { projectHeaders } from '../staging/steps/projectProvisioning';
import { resolveVerifyDeps } from '../staging/verify/deps';
import { findExistingDataset } from '../staging/steps/datasetIngestion';
import { findExistingAnalysis } from '../staging/steps/analysisFraming';
import { SUBJECT_DATASET_FILENAME } from '../staging/steps/subjectStaging';
import type { ProvisioningContext } from '../staging/steps/context';
import type { ExistingSpec } from '../staging/steps/chartStaging';
import type { SnapshotSummary } from '../staging/steps/snapshotStaging';

/**
 * REST-only resolution of every live id a master needs to navigate to and
 * assert against (FR19's "assert preconditions before the shutter"). Read-
 * only (GETs plus the same external-identity probes AXI-1378/1380 already
 * use) — capture never creates, mutates, or deletes anything (NFR3 applies
 * here just as it does to `verify`).
 *
 * Deliberately does NOT hard-code any of the ids the dev-epic-context's
 * per-story log records (`cf17e1ea`, `229924ad`, ...) — those are a point-
 * in-time snapshot from one staging run and go stale the moment the tenant
 * is rebuilt. Every id here is re-derived live, by name, the same pattern
 * `staging/verify/deps.ts` and every rule module already establishes.
 */
export interface Decision {
  id: string;
  label: string;
  status: string;
}

export interface EvidenceEntry {
  id: string;
  title: string;
}

export interface CaptureContext {
  client: RestClient;
  orgId: string;
  workspaceId: string;
  projectId: string;
  analysisId: string;
  deTableDatasetId: string;
  countMatrixDatasetId: string | undefined;
  charts: ExistingSpec[];
  snapshots: SnapshotSummary[];
  decisions: Decision[];
  evidence: EvidenceEntry[];
  publishedVersionId: string | undefined;
  hasFlowCytometryDataset: boolean;
  /** M10 (AXI-1368 FIX 3) — the dedicated view-analysis
   * `subjectStaging.ts` stages on its own small paired-timepoint dataset.
   * `undefined` when that step hasn't run yet (M10's own precondition
   * treats that as blocked, not a hard error — same "flag it, don't
   * fabricate" shape every other master's guard uses). */
  subjectAnalysisId: string | undefined;
  /** The internal thread's ACTUAL live `authorName` strings — not the
   *  fixture's cast display names. `authorName` is denormalized onto each
   *  comment at CREATE time (`comments.ts`/`snapshotComments.ts`: `raw.
   *  authorName`), and `applyCastNamesStep` (which PATCHes "Léa Fontaine"
   *  etc. onto the identities' profiles) runs LAST in the stage step graph
   *  — after comments are created. So a comment's stored `authorName` may
   *  still read the identity registry's placeholder ("Cast Bioinformatician"),
   *  never "Léa Fontaine", regardless of what the profile says today. M4
   *  asserts against these live values instead of assuming the fixture's
   *  wording, so it reflects what actually renders, not what "should". */
  internalThreadAuthorNames: string[];
}

export async function resolveCaptureContext(baseUrl: string, adminEmail: string, adminPassword: string): Promise<CaptureContext> {
  const client = new RestClient({ baseUrl });
  const identities = await ensureIdentities(client, adminEmail, adminPassword);
  await ensureCapturePermissions(client, identities.serviceRoleId);
  const ctx = newContext(client);
  const deps = await resolveVerifyDeps(ctx);
  if (!ctx.orgId) throw new Error('capture: resolveVerifyDeps did not populate ctx.orgId — cannot set the frontend workspace-selection localStorage keys without it');
  const [charts, snapshots, decisions, evidence, publishedVersions, internalThreadAuthorNames, subjectAnalysisId] = await Promise.all([
    fetchAllCharts(ctx, deps),
    fetchSnapshots(ctx, deps.workspaceId, deps.analysisId),
    fetchDecisions(ctx, deps.workspaceId, deps.analysisId),
    fetchEvidence(ctx, deps.analysisId, deps.workspaceId),
    fetchPublishedVersions(ctx, deps.workspaceId, deps.analysisId),
    fetchInternalThreadAuthorNames(ctx, deps.workspaceId, deps.analysisId),
    resolveSubjectAnalysisId(ctx, deps.workspaceId, deps.projectId),
  ]);
  return {
    client,
    orgId: ctx.orgId,
    workspaceId: deps.workspaceId,
    projectId: deps.projectId,
    analysisId: deps.analysisId,
    deTableDatasetId: deps.deTableDatasetId,
    countMatrixDatasetId: deps.datasetIdByRole.get('count_matrix'),
    charts,
    snapshots,
    decisions,
    evidence,
    publishedVersionId: publishedVersions[0]?.id,
    hasFlowCytometryDataset: hasFlowCytometryDataset(),
    internalThreadAuthorNames,
    subjectAnalysisId,
  };
}

function newContext(client: RestClient): ProvisioningContext {
  return { client, fixture: TENANT_FIXTURE, serviceUserId: '', workspaceIdByFixtureName: new Map(), touched: [] };
}

/** M10 — the subject-paired-timepoint dataset/analysis are staged OUTSIDE
 *  `content.datasets[]` (see `subjectStaging.ts`'s module doc), so they're
 *  resolved the same by-name way but independently of `resolveVerifyDeps`. */
async function resolveSubjectAnalysisId(ctx: ProvisioningContext, workspaceId: string, projectId: string): Promise<string | undefined> {
  const dataset = await findExistingDataset(ctx, workspaceId, SUBJECT_DATASET_FILENAME);
  if (!dataset) return undefined;
  const analysis = await findExistingAnalysis(ctx, workspaceId, projectId, dataset.id);
  return analysis?.id;
}

async function fetchAllCharts(ctx: ProvisioningContext, deps: { workspaceId: string; analysisId: string; datasetIdByRole: Map<string, string> }): Promise<ExistingSpec[]> {
  const perDataset = await Promise.all([...deps.datasetIdByRole.values()].map((id) => fetchExistingSpecs(ctx, deps.workspaceId, id, deps.analysisId)));
  return perDataset.flat();
}

async function fetchDecisions(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<Decision[]> {
  const res = await ctx.client.as<{ data: Decision[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/workspaces/${workspaceId}/decisions?viewAnalysisId=${analysisId}&limit=50`,
    undefined,
    projectHeaders(workspaceId),
  );
  if (!res.ok) throw new Error(`capture: fetching interpretations failed (status ${res.status})`);
  return res.body?.data ?? [];
}

interface RawEvidence {
  id: string;
  currentVersion?: { title: string | null } | null;
}

async function fetchEvidence(ctx: ProvisioningContext, analysisId: string, workspaceId: string): Promise<EvidenceEntry[]> {
  const res = await ctx.client.as<{ data: RawEvidence[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/view-analyses/${analysisId}/evidences?page=1&limit=50`,
    undefined,
    projectHeaders(workspaceId),
  );
  if (!res.ok) throw new Error(`capture: fetching evidence failed (status ${res.status})`);
  return (res.body?.data ?? []).flatMap((raw) => (raw.currentVersion?.title ? [{ id: raw.id, title: raw.currentVersion.title }] : []));
}

interface InternalComment {
  authorName: string;
}

async function fetchInternalThreadAuthorNames(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<string[]> {
  const res = await ctx.client.as<{ comments: InternalComment[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/snapshot-comments?anchorType=view_analysis&anchorId=${analysisId}`,
    undefined,
    projectHeaders(workspaceId),
  );
  if (!res.ok) throw new Error(`capture: fetching the internal discussion thread failed (status ${res.status})`);
  const names = (res.body?.comments ?? []).map((c) => c.authorName).filter((n): n is string => !!n && n.trim().length > 0);
  return [...new Set(names)];
}

/**
 * Pure — M12 (flow cytometry) structural blocker check. `DataRequirement`
 * (`staging/fixtures/types.ts`) is a CLOSED union of `'de_table' |
 * 'count_matrix' | 'stratified_de_table'` — there is no flow-cytometry role
 * anywhere in the fixture's type system, so no run of `stage` can ever
 * produce one. This answers OQ4 (dev-epic-context) structurally rather than
 * by a live probe: the fixture format itself cannot represent the data M12
 * needs, so a live "not found" check would only ever restate this.
 */
export function hasFlowCytometryDataset(): boolean {
  return TENANT_FIXTURE.content.datasets.some((d) => (d.role as string) === 'flow_cytometry');
}

/** Pure — the M5 target: the one interpretation Capture Spec §9/EC4 wants
 *  captured (approved, cites evidence, states the weak-separation finding
 *  is the finding). Exported for unit testing without a live decisions list. */
export function findApprovedInterpretation(decisions: Decision[]): Decision | undefined {
  return decisions.find((d) => d.status === 'approved');
}
