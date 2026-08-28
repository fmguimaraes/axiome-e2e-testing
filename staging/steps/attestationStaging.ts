import { SERVICE_HANDLE, recordTouched } from './context';
import { requireWorkspaceId, requireProjectId, findExistingDataset } from './datasetIngestion';
import { requireDatasetId } from './analysisFraming';
import { requireAnalysisId } from './chartStaging';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { Step } from './types';

/**
 * FR14-adjacent (Capture Spec §14, AXI-1379) — computes the dataset quality
 * passport and the analysis-level quality attestation, both real REST
 * actions (`POST /api/v1/passports/compute`, `POST /api/v1/attestations/
 * compute`, `apps/gateway/src/proxy/attestations.controller.ts`). Neither
 * has a dedicated FR/AC number in the feature doc (same shape as thresholds
 * in AXI-1376 — see that story's "NO DEDICATED FR/AC" note); they exist to
 * back the co-branded sponsor export's provenance/badge content and to
 * supply the `attestation_computed` governance event this story stages.
 *
 * ARTIFACT-TYPE FINDING: `AttestationsService.resolveDatasetRef` only reads
 * `artifactType` to special-case `'evidence'` (resolve the dataset via an
 * evidence citation) — for any other value it trusts an explicitly-passed
 * `datasetId` outright (confirmed by reading `attestations.service.ts`
 * `resolveDatasetRef`). There is no closed `artifactType` enum enforced
 * server-side, so `'view_analysis'` (attesting the analysis itself, against
 * its bound dataset) is a real, honest choice, not a guess at a hidden
 * constraint.
 *
 * Idempotent (NFR1): a passport is looked up by (datasetId, projectId)
 * before computing (the backend itself also upserts on that key, so a
 * duplicate compute is harmless, but the toolkit still avoids the extra
 * call); an attestation is looked up by (artifactId, projectId) via
 * `FIND_ATTESTATION_BY_ARTIFACT` before computing — the backend attestation
 * table is append-only-versioned (confirmed: `attestationVersion` increments
 * per compute, same "no unique constraint" shape AXI-1377 found on
 * `PublishedViewAnalysisVersion`), so re-running this step without the guard
 * would mint a new version every time.
 */
export const ensureAttestationStep: Step<ProvisioningContext> = {
  id: 'ensure-attestation',
  dependsOn: ['ensure-interpretations-evidence-publish'],
  async run(ctx) {
    const content = ctx.fixture.content;
    const primary = content.datasets.find((d) => d.role === 'de_table');
    if (!primary) return;
    const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
    const datasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
    const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, datasetId);
    await ensurePassport(ctx, workspaceId, datasetId, projectId);
    await ensureAttestation(ctx, workspaceId, analysisId, datasetId, projectId);
  },
};

// ─── Passport ───────────────────────────────────────────────────────────

/**
 * ROUTE-PATH FINDING: the dev-epic-context's route table shorthand
 * ("`/passports/compute` for the dataset passport") reads as a top-level
 * path but is not one — `AttestationsProxyController` is
 * `@Controller({path: 'attestations', version: '1'})`, and `@Post(
 * 'passports/compute')`/`@Get('passports/:datasetId/:projectId')` are
 * declared INSIDE it, so the real routes nest under the same prefix as
 * `/attestations/compute`: `/api/v1/attestations/passports/compute` and
 * `/api/v1/attestations/passports/:datasetId/:projectId`. Confirmed live —
 * a bare `/api/v1/passports/...` 404s ("Cannot POST /api/v1/passports/
 * compute"), the nested path 401s pre-auth (route matched) and 201s
 * authenticated.
 */
const PASSPORT_BASE = '/api/v1/attestations/passports';

async function ensurePassport(ctx: ProvisioningContext, workspaceId: string, datasetId: string, projectId: string): Promise<void> {
  const existing = await ctx.client.as(SERVICE_HANDLE, 'GET', `${PASSPORT_BASE}/${datasetId}/${projectId}`, undefined, projectHeaders(workspaceId));
  if (existing.ok) return;
  await computePassport(ctx, workspaceId, datasetId, projectId);
}

async function computePassport(ctx: ProvisioningContext, workspaceId: string, datasetId: string, projectId: string): Promise<void> {
  const res = await ctx.client.as<{ id: string }>(SERVICE_HANDLE, 'POST', `${PASSPORT_BASE}/compute`, { datasetId, projectId }, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`computing dataset quality passport for ${datasetId} failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'passport', name: `passport:${datasetId}`, id: res.body.id, action: 'created' });
}

// ─── Attestation ────────────────────────────────────────────────────────

const ATTESTATION_ARTIFACT_TYPE = 'view_analysis';

async function ensureAttestation(ctx: ProvisioningContext, workspaceId: string, analysisId: string, datasetId: string, projectId: string): Promise<void> {
  const existing = await findExistingAttestation(ctx, workspaceId, analysisId, projectId);
  if (existing) return;
  await computeAttestation(ctx, workspaceId, analysisId, datasetId, projectId);
}

async function findExistingAttestation(ctx: ProvisioningContext, workspaceId: string, analysisId: string, projectId: string): Promise<{ id: string } | undefined> {
  const res = await ctx.client.as<{ id: string }>(SERVICE_HANDLE, 'GET', `/api/v1/attestations/artifact/${analysisId}/${projectId}`, undefined, projectHeaders(workspaceId));
  return res.ok ? res.body : undefined;
}

async function computeAttestation(ctx: ProvisioningContext, workspaceId: string, analysisId: string, datasetId: string, projectId: string): Promise<void> {
  const body = buildAttestationComputeBody(analysisId, datasetId, projectId);
  const res = await ctx.client.as<{ id: string }>(SERVICE_HANDLE, 'POST', '/api/v1/attestations/compute', body, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`computing quality attestation for analysis ${analysisId} failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'attestation', name: `attestation:${analysisId}`, id: res.body.id, action: 'created' });
}

/** Exported for unit testing — pure, no network. See the module doc's
 *  ARTIFACT-TYPE FINDING for why `'view_analysis'` is a real, honest choice
 *  rather than a guessed constraint. */
export function buildAttestationComputeBody(analysisId: string, datasetId: string, projectId: string): { artifactId: string; artifactType: string; datasetId: string; projectId: string } {
  return { artifactId: analysisId, artifactType: ATTESTATION_ARTIFACT_TYPE, datasetId, projectId };
}

/** Exported for reuse by `sponsorExportStaging.ts` and
 *  `governanceEventsStaging.ts` — both need the same (workspace, project,
 *  dataset, analysis) resolution this step already does. */
export async function resolveAttestationDeps(ctx: ProvisioningContext): Promise<{ workspaceId: string; projectId: string; datasetId: string; analysisId: string } | undefined> {
  const primary = ctx.fixture.content.datasets.find((d) => d.role === 'de_table');
  if (!primary) return undefined;
  const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
  const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
  const datasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
  const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, datasetId);
  return { workspaceId, projectId, datasetId, analysisId };
}
