import { existsSync, readFileSync } from 'node:fs';
import { SERVICE_HANDLE, recordTouched } from './context';
import { findExistingDataset, requireProjectId, requireWorkspaceId } from './datasetIngestion';
import { findExistingAnalysis } from './analysisFraming';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { Step } from './types';

/**
 * AXI-1368 FIX 3 (M10, Capture Spec "subject delta view", SI-044) — stages a
 * handful of Subjects with paired T1 (pre-therapy) / T2 (on-treatment)
 * checkpoint-gene expression so `SubjectCompleteView` has real Δ data to
 * render.
 *
 * CORRECTED PREMISE (found by re-reading the frontend, not by trusting the
 * capture harness's own prior investigation note): `SubjectCompleteView`
 * (`axiome-front/src/pages/SubjectCompleteView.tsx`) does NOT read the
 * Subject-Management REST domain (`/subjects`, `/subject-timepoints`,
 * `/subject-rows`, `/subject-panels` — AXI-1244/1245) at all. It calls
 * `POST /workspaces/:id/datasets/:datasetId/query` (the same route every
 * other gallery/table view uses) and pivots the rows client-side
 * (`lib/subjectView/mapToCards.ts`). "Wide format" needs only a resolvable
 * subject-id column (`subjectId`/`patientId`/...) plus >=2 remaining
 * columns, which become the timepoint columns
 * (`identifyTimepointColumns`) — so a small, ordinary CSV dataset, ingested
 * through the SAME upload path every other dataset in this tenant uses, is
 * sufficient. No Subject-Management route is called here; that domain is
 * real but unrelated to what this view reads (confirmed by source).
 *
 * Deliberately staged as its OWN dataset + view-analysis, OUTSIDE
 * `content.datasets[]`/`content.chartSpecs[]` — `checkDatasetsShareCorpus`
 * (AC5/§2.2) enforces "one corpus" over the FIXTURE-declared dataset list
 * only, so a second, unrelated analysis here does not need to share that
 * corpus and cannot trip that rule. It still lives in the same
 * workspace/project as the rest of the tenant.
 *
 * Values are INVENTED but plausible (NFR8/AC4): 6 synthetic subject codes
 * (`PT-01`..`PT-06`), 3 real checkpoint-gene symbols (PDCD1/CTLA4/TIGIT —
 * real, contextually correct for a nivolumab melanoma cohort), T1/T2
 * expression values authored by hand — no Jira keys, no "E2E", no real
 * patient identifiers. Source CSV:
 * `riaz_de/riaz2017_subject_paired_timepoints.csv`.
 */
/** Exported for reuse by `capture/resolveCaptureContext.ts` (M10) — the
 *  same by-name lookup pattern every other capture id resolves with. */
export const SUBJECT_DATASET_FILENAME = 'riaz2017_subject_paired_timepoints.csv';
export const SUBJECT_ANALYSIS_NAME = 'Does target checkpoint-gene expression change from pre-therapy (T1) to on-treatment (T2)?';
const FILENAME = SUBJECT_DATASET_FILENAME;
const ANALYSIS_NAME = SUBJECT_ANALYSIS_NAME;
const LOCAL_PATH_ENV = 'STAGING_RIAZ_SUBJECT_TIMEPOINTS_CSV_PATH';
const DEFAULT_LOCAL_PATH = '/home/felipe/dev/axiome/riaz_de/riaz2017_subject_paired_timepoints.csv';

export const ensureSubjectPairedTimepointsStep: Step<ProvisioningContext> = {
  id: 'ensure-subject-paired-timepoints',
  dependsOn: ['ensure-dataset'],
  async run(ctx) {
    const primary = ctx.fixture.content.datasets.find((d) => d.role === 'de_table');
    if (!primary) return;
    const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
    const datasetId = await ensureSubjectDataset(ctx, workspaceId);
    await ensureProjectLink(ctx, workspaceId, projectId, datasetId);
    await ensureAnalysis(ctx, workspaceId, projectId, datasetId);
  },
};

interface DatasetSummary {
  id: string;
  originalFilename: string;
  availability: string;
  latestIngestion?: { status: string } | null;
}

async function ensureSubjectDataset(ctx: ProvisioningContext, workspaceId: string): Promise<string> {
  const existing = await findExistingDataset(ctx, workspaceId, FILENAME);
  if (existing) {
    if (existing.availability !== 'available') {
      await finalizeDataset(ctx, workspaceId, existing.id);
      await waitForIngestion(ctx, workspaceId, existing.id);
    }
    recordTouched(ctx, { kind: 'dataset', name: FILENAME, id: existing.id, action: 'reused' });
    return existing.id;
  }

  const path = process.env[LOCAL_PATH_ENV]?.trim() || DEFAULT_LOCAL_PATH;
  if (!existsSync(path)) throw new Error(`subject-paired-timepoints CSV not found at "${path}" — set ${LOCAL_PATH_ENV} to its location`);
  const bytes = readFileSync(path);

  const initiate = await ctx.client.as<{ dataset: { id: string }; presignedUrl: string }>(
    SERVICE_HANDLE,
    'POST',
    `/api/v1/workspaces/${workspaceId}/datasets`,
    { organizationId: ctx.orgId, originalFilename: FILENAME, contentType: 'text/csv' },
    projectHeaders(workspaceId),
  );
  if (!initiate.ok || !initiate.body) throw new Error(`initiating upload of "${FILENAME}" failed (status ${initiate.status})`);
  const { id, presignedUrl } = { id: initiate.body.dataset.id, presignedUrl: initiate.body.presignedUrl };

  const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  console.log(`[staging] ${new Date().toISOString()} PUT <presigned-s3-url> -> ${put.status} (as service)`);
  if (!put.ok) throw new Error(`S3 upload of "${FILENAME}" failed (status ${put.status})`);

  await finalizeDataset(ctx, workspaceId, id);
  await waitForIngestion(ctx, workspaceId, id);
  recordTouched(ctx, { kind: 'dataset', name: FILENAME, id, action: 'created' });
  return id;
}

async function finalizeDataset(ctx: ProvisioningContext, workspaceId: string, datasetId: string): Promise<void> {
  const res = await ctx.client.as(
    SERVICE_HANDLE,
    'PATCH',
    `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/finalize`,
    undefined,
    projectHeaders(workspaceId),
  );
  if (!res.ok) throw new Error(`finalizing dataset ${datasetId} failed (status ${res.status})`);
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60000;

async function waitForIngestion(ctx: ProvisioningContext, workspaceId: string, datasetId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await ctx.client.as<DatasetSummary>(
      SERVICE_HANDLE,
      'GET',
      `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`,
      undefined,
      projectHeaders(workspaceId),
    );
    const status = res.body?.latestIngestion?.status;
    if (status === 'ready' || status === 'failed') return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function ensureProjectLink(ctx: ProvisioningContext, workspaceId: string, projectId: string, datasetId: string): Promise<void> {
  const res = await ctx.client.as<{ data: { datasetId: string }[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/projects/${projectId}/datasets`,
    undefined,
    projectHeaders(workspaceId),
  );
  const already = (res.body?.data ?? []).some((link) => link.datasetId === datasetId);
  if (already) return;
  const link = await ctx.client.as(SERVICE_HANDLE, 'POST', `/api/v1/projects/${projectId}/datasets`, { datasetId }, projectHeaders(workspaceId));
  if (!link.ok) throw new Error(`linking dataset ${datasetId} to project ${projectId} failed (status ${link.status})`);
  recordTouched(ctx, { kind: 'dataset', name: `link:${projectId}`, id: datasetId, action: 'linked' });
}

interface AnalysisSummary {
  id: string;
  name: string;
  datasetId: string;
}

async function ensureAnalysis(ctx: ProvisioningContext, workspaceId: string, projectId: string, datasetId: string): Promise<string> {
  const existing = (await findExistingAnalysis(ctx, workspaceId, projectId, datasetId)) as AnalysisSummary | undefined;
  if (existing) {
    recordTouched(ctx, { kind: 'analysis', name: existing.name, id: existing.id, action: 'reused' });
    return existing.id;
  }
  const res = await ctx.client.as<{ id: string }>(
    SERVICE_HANDLE,
    'POST',
    '/api/v1/view-analyses',
    { projectId, datasetId, name: ANALYSIS_NAME },
    projectHeaders(workspaceId),
  );
  if (!res.ok || !res.body) throw new Error(`creating view-analysis "${ANALYSIS_NAME}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'analysis', name: ANALYSIS_NAME, id: res.body.id, action: 'created' });
  return res.body.id;
}
