import { existsSync, readFileSync } from 'node:fs';
import { SERVICE_HANDLE, recordTouched } from './context';
import { listProjects, projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { DatasetFixture } from '../fixtures/types';
import type { Step } from './types';

/**
 * FR7/AC5 (AXI-1372) — ingest the single Riaz 2017 dataset version and bind
 * it to the analysis project (Capture Spec §2.2/§4). The real upload flow,
 * traced from `apps/organization-service/src/datasets/datasets.service.ts`:
 * initiate (presigned S3 PUT URL) -> PUT the bytes directly to S3 -> finalize
 * (computes `rawFileHash`/`fileHash`, auto-triggers ingestion) -> link to the
 * project. `finalizeUpload` already awaits its own auto-triggered ingestion
 * creation, so this step does NOT also call `POST .../ingestions` — doing so
 * would mint a second, redundant ingestion run and jeopardize NFR1. It DOES
 * wait for that ingestion to reach a terminal status before returning
 * (EC7's "await completion" principle, applied to ingestion the same way the
 * spec applies it to snapshot materialisation), so the row count this step
 * reports is real.
 *
 * Idempotent (NFR1): a second run finds the dataset by filename and reuses
 * it — no re-upload, no duplicate. The PUT to the presigned URL is the one
 * network call in this file that bypasses `RestClient` — a presigned S3 URL
 * is self-authenticating and is not a gateway route, so there is nothing for
 * the allow-list/token machinery to check (NFR2/NFR3 govern the GATEWAY
 * surface; this is the same direct-to-storage PUT a browser would make).
 */
export const ensureDatasetStep: Step<ProvisioningContext> = {
  id: 'ensure-dataset',
  dependsOn: ['ensure-workspaces'],
  async run(ctx) {
    const fixture = ctx.fixture.content.dataset;
    if (!fixture) return;
    const workspaceId = requireWorkspaceId(ctx, fixture.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, fixture.projectName);
    const datasetId = await ensureDataset(ctx, workspaceId, fixture);
    await ensureProjectLink(ctx, workspaceId, projectId, datasetId);
  },
};

const RIAZ_DE_CSV_PATH_ENV = 'STAGING_RIAZ_DE_CSV_PATH';
// The operator-machine default this epic's runbook expects (FR21) — override
// via STAGING_RIAZ_DE_CSV_PATH for any other layout. Same env-sourcing
// precedent as STAGING_ADMIN_EMAIL/PASSWORD (FR4): a real, usable default,
// never a credential.
const DEFAULT_RIAZ_DE_CSV_PATH = '/home/felipe/dev/axiome/riaz_de/riaz_pre_therapy_responders_vs_nonresponders.csv';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60000;

interface DatasetSummary {
  id: string;
  originalFilename: string;
  availability: string;
  latestIngestion?: { status: string; rowCount?: number | null } | null;
}

/** Exported for reuse by `analysisFraming.ts` (AXI-1373) — the analysis step
 *  needs the same fixture-name lookups this step already does. */
export function requireWorkspaceId(ctx: ProvisioningContext, workspaceName: string): string {
  const id = ctx.workspaceIdByFixtureName.get(workspaceName);
  if (!id) throw new Error(`workspace "${workspaceName}" not found in context — ensure-workspaces must run first`);
  return id;
}

export async function requireProjectId(ctx: ProvisioningContext, workspaceId: string, projectName: string): Promise<string> {
  const projects = await listProjects(ctx, workspaceId);
  const found = projects.find((p) => p.name === projectName);
  if (!found) throw new Error(`project "${projectName}" not found in workspace ${workspaceId} — ensure-workspaces must run first`);
  return found.id;
}

/** Find-or-create the dataset (NFR1). A found-but-incomplete prior attempt
 *  (uploaded but never finalized) is completed rather than re-uploaded. */
async function ensureDataset(ctx: ProvisioningContext, workspaceId: string, fixture: DatasetFixture): Promise<string> {
  const existing = await findExistingDataset(ctx, workspaceId, fixture.originalFilename);
  if (existing) return reuseDataset(ctx, workspaceId, existing);
  return createDataset(ctx, workspaceId, fixture);
}

/** Exported for reuse by `analysisFraming.ts` (AXI-1373) — resolving the
 *  bound dataset id by its declared filename, the same idempotent lookup
 *  this step uses before deciding to reuse vs. create. */
export async function findExistingDataset(ctx: ProvisioningContext, workspaceId: string, filename: string): Promise<DatasetSummary | undefined> {
  const res = await ctx.client.as<{ data: DatasetSummary[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/workspaces/${workspaceId}/datasets?search=${encodeURIComponent(filename)}`,
    undefined,
    projectHeaders(workspaceId),
  );
  return (res.body?.data ?? []).find((d) => d.originalFilename === filename);
}

async function reuseDataset(ctx: ProvisioningContext, workspaceId: string, existing: DatasetSummary): Promise<string> {
  if (existing.availability !== 'available') {
    await finalizeDataset(ctx, workspaceId, existing.id);
    await waitForIngestion(ctx, workspaceId, existing.id);
  }
  recordTouched(ctx, { kind: 'dataset', name: existing.originalFilename, id: existing.id, action: 'reused' });
  return existing.id;
}

async function createDataset(ctx: ProvisioningContext, workspaceId: string, fixture: DatasetFixture): Promise<string> {
  const bytes = readDatasetBytes();
  const { id, presignedUrl } = await initiateUpload(ctx, workspaceId, fixture);
  await uploadBytes(presignedUrl, bytes, fixture.contentType);
  await finalizeDataset(ctx, workspaceId, id);
  await waitForIngestion(ctx, workspaceId, id);
  recordTouched(ctx, { kind: 'dataset', name: fixture.originalFilename, id, action: 'created' });
  return id;
}

function readDatasetBytes(): Buffer {
  const path = process.env[RIAZ_DE_CSV_PATH_ENV]?.trim() || DEFAULT_RIAZ_DE_CSV_PATH;
  if (!existsSync(path)) {
    throw new Error(`Riaz DE table not found at "${path}" — set ${RIAZ_DE_CSV_PATH_ENV} to its location`);
  }
  return readFileSync(path);
}

async function initiateUpload(
  ctx: ProvisioningContext,
  workspaceId: string,
  fixture: DatasetFixture,
): Promise<{ id: string; presignedUrl: string }> {
  const res = await ctx.client.as<{ dataset: { id: string }; presignedUrl: string }>(
    SERVICE_HANDLE,
    'POST',
    `/api/v1/workspaces/${workspaceId}/datasets`,
    { organizationId: ctx.orgId, originalFilename: fixture.originalFilename, contentType: fixture.contentType },
    projectHeaders(workspaceId),
  );
  if (!res.ok || !res.body) throw new Error(`initiating upload of "${fixture.originalFilename}" failed (status ${res.status})`);
  return { id: res.body.dataset.id, presignedUrl: res.body.presignedUrl };
}

/** The one direct (non-RestClient) network call in this file — see the
 *  module doc for why a presigned S3 PUT is not a gateway/backdoor call. */
async function uploadBytes(presignedUrl: string, bytes: Buffer, contentType: string): Promise<void> {
  const res = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(bytes) });
  console.log(`[staging] ${new Date().toISOString()} PUT <presigned-s3-url> -> ${res.status} (as service)`);
  if (!res.ok) throw new Error(`S3 upload of dataset bytes failed (status ${res.status})`);
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

/** EC7-style await: finalize's auto-triggered ingestion is async, so poll for
 *  a terminal status (bounded) rather than reporting a row count that isn't
 *  real yet. A timeout is not fatal — it just means the caller sees whatever
 *  status is current at that point, same as the underlying finalize call. */
async function waitForIngestion(ctx: ProvisioningContext, workspaceId: string, datasetId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await fetchIngestionStatus(ctx, workspaceId, datasetId);
    if (status === 'ready' || status === 'failed') return;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function fetchIngestionStatus(ctx: ProvisioningContext, workspaceId: string, datasetId: string): Promise<string | undefined> {
  const dataset = await fetchDataset(ctx, workspaceId, datasetId);
  return dataset?.latestIngestion?.status;
}

export async function fetchDataset(ctx: ProvisioningContext, workspaceId: string, datasetId: string): Promise<DatasetSummary | undefined> {
  const res = await ctx.client.as<DatasetSummary>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`,
    undefined,
    projectHeaders(workspaceId),
  );
  return res.body;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `GET /api/v1/projects/:id/datasets` returns the raw `ProjectDatasetLink`
 * join rows — each row's OWN `id` is the link id, and the dataset it points
 * at is `datasetId` (confirmed live, AXI-1372). Checking `.id` here looked
 * plausible in a mocked test but is wrong against the real response shape:
 * it never matched, so every re-run created a second link row for the same
 * dataset — a real idempotency bug this file's own no-duplicate-link test
 * (`UT-DSI-002`) did not catch, because its FakeGateway modeled the response
 * as bare dataset objects instead of link rows. Caught only by running
 * `stage` twice against the live stack.
 */
async function projectHasDataset(ctx: ProvisioningContext, workspaceId: string, projectId: string, datasetId: string): Promise<boolean> {
  const res = await ctx.client.as<{ datasetId: string }[] | { data: { datasetId: string }[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/projects/${projectId}/datasets`,
    undefined,
    projectHeaders(workspaceId),
  );
  const list = Array.isArray(res.body) ? res.body : (res.body?.data ?? []);
  return list.some((link) => link.datasetId === datasetId);
}

async function ensureProjectLink(ctx: ProvisioningContext, workspaceId: string, projectId: string, datasetId: string): Promise<void> {
  if (await projectHasDataset(ctx, workspaceId, projectId, datasetId)) return;
  const res = await ctx.client.as(SERVICE_HANDLE, 'POST', `/api/v1/projects/${projectId}/datasets`, { datasetId }, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`linking dataset ${datasetId} to project ${projectId} failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'dataset', name: `link:${projectId}`, id: datasetId, action: 'linked' });
}
