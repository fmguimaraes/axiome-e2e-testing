import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_HANDLE, recordTouched } from './context';
import { requireWorkspaceId, requireProjectId } from './datasetIngestion';
import { requireDatasetId } from './analysisFraming';
import { requireAnalysisId } from './chartStaging';
import { fetchPublishedVersions } from './interpretationsEvidenceStaging';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { Step } from './types';

/**
 * Capture Spec §14, EC11 (AXI-1379) — the co-branded sponsor export: an org
 * logo (a FICTIONAL, plainly-invented sponsor mark — see
 * `fixtures/assets/sponsor-logo-meridian-oncology.svg`'s header comment and
 * the AXI-1379 design note for the EC11 rationale), the sponsor PDF package
 * (`POST /api/v1/exports/sponsor`), and its preview HTML (`GET .../sponsor/
 * :publishedVersionId/preview`), verified to carry a legible provenance
 * stamp.
 *
 * LOGO UPLOAD: the same 3-call shape `datasetIngestion.ts` already
 * established for dataset bytes — initiate (presigned S3 PUT URL) -> PUT the
 * bytes directly to storage -> finalize (`organizations.service.ts`
 * `initiateLogoUpload`/`finalizeLogoUpload`, confirmed by reading the
 * source). The PUT bypasses `RestClient` for the same reason
 * `datasetIngestion.ts`'s does — a presigned URL is self-authenticating and
 * not a gateway route (NFR2/NFR3 govern the gateway surface only).
 *
 * SPONSOR EXPORT IS SELF-CACHING: `SponsorExportService.createSponsorExport`
 * already reuses a `completed` export for the same `publishedVersionId`
 * unless `skipCache` is set (confirmed by reading `sponsor-export.service.ts`
 * `findExistingCompletedExport`), so the create call itself is idempotent
 * (NFR1) with no extra find-or-create check needed here. Rendering is async
 * (`setImmediate`), so this step polls the package list (bounded, EC7-style,
 * non-fatal on timeout — the preview HTML below does not depend on the PDF
 * job finishing).
 *
 * PROVENANCE STAMP (EC11/"legible provenance stamp"): confirmed by reading
 * `sponsor-report-template.service.ts` `renderProvenance` — the "Provenance
 * Stamp" block carries Published Version ID / View Analysis ID / Version /
 * Published At / Evidence Sections / Decisions / Exported At. The "figure"
 * is the chart image grid; co-branding is the org logo + "Shared by {org}
 * via Axiome" line (`org-branding.ts`). LIVE FINDING: `SponsorDecision.
 * evidenceValues` is always `[]` (no staging step populates it), so
 * `renderEvidenceValues`'s table never renders — the "threshold" is legible
 * instead via the cited chart's own title/evidence prose (Capture Spec §8's
 * chart is titled "...FDR < 0.05, |log2FC| >= 1"), confirmed by dumping a
 * live preview and finding `log2FC`/`padj` present. See
 * `assertProvenanceStampLegible`'s doc for the corrected marker set.
 */
export const ensureSponsorExportStep: Step<ProvisioningContext> = {
  id: 'ensure-sponsor-export',
  dependsOn: ['ensure-interpretations-evidence-publish'],
  async run(ctx) {
    const content = ctx.fixture.content;
    const primary = content.datasets.find((d) => d.role === 'de_table');
    if (!primary) return;
    const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
    const datasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
    const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, datasetId);
    await ensureOrgLogo(ctx);
    const publishedVersionId = await requirePublishedVersionId(ctx, workspaceId, analysisId);
    await ensureSponsorExportPackage(ctx, workspaceId, publishedVersionId);
    await fetchAndVerifyPreview(ctx, workspaceId, publishedVersionId);
  },
};

async function requirePublishedVersionId(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<string> {
  const published = await fetchPublishedVersions(ctx, workspaceId, analysisId);
  if (published.length === 0) throw new Error(`analysis ${analysisId} has no published version yet — ensure-interpretations-evidence-publish must run first`);
  return published[0].id;
}

// ─── Org logo (EC11, fictional mark) ───────────────────────────────────

const LOGO_ASSET_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'assets', 'sponsor-logo-meridian-oncology.svg');
const LOGO_FILENAME = 'sponsor-logo-meridian-oncology.svg';
const LOGO_CONTENT_TYPE = 'image/svg+xml';

/**
 * IDEMPOTENCY FINDING (live, this story): the tenant's org already carried a
 * STRAY pre-existing logo (a leftover `.png` artifact, same class of
 * pre-existing leaked content AXI-1371's §2.1 rename step deals with for
 * names) before this step ever ran. A bare "skip if any logo exists" check
 * would leave that unrelated asset in place and never apply the EC11
 * fictional mark at all — worse for EC11 than uploading our own, since an
 * unknown pre-existing image's provenance is unverified. The presigned GET
 * URL's path segment carries the real S3 key (confirmed live:
 * `.../logo/<uuid>.png?X-Amz-...`), so this checks the file EXTENSION rather
 * than mere presence — converges once our `.svg` is in place, replaces
 * anything else (`finalizeLogoUpload` already deletes the prior object).
 */
async function ensureOrgLogo(ctx: ProvisioningContext): Promise<void> {
  if (!ctx.orgId) throw new Error('organization id not resolved on context — ensure-organization must run first');
  const existing = await ctx.client.as<{ logoUrl: string | null }>(SERVICE_HANDLE, 'GET', `/api/v1/organizations/${ctx.orgId}/logo`);
  if (isOurFictionalLogo(existing.body?.logoUrl)) return;
  await uploadOrgLogo(ctx, ctx.orgId);
}

/** Exported for unit testing — pure, no network. */
export function isOurFictionalLogo(logoUrl: string | null | undefined): boolean {
  if (!logoUrl) return false;
  const path = logoUrl.split('?')[0];
  return path.toLowerCase().endsWith('.svg');
}

async function uploadOrgLogo(ctx: ProvisioningContext, orgId: string): Promise<void> {
  const bytes = readFileSync(LOGO_ASSET_PATH);
  const { s3Key, presignedUrl } = await initiateLogoUpload(ctx, orgId);
  await putLogoBytes(presignedUrl, bytes);
  await finalizeLogoUpload(ctx, orgId, s3Key);
  recordTouched(ctx, { kind: 'logo', name: 'Meridian Oncology (fictional, EC11)', id: s3Key, action: 'created' });
}

async function initiateLogoUpload(ctx: ProvisioningContext, orgId: string): Promise<{ s3Key: string; presignedUrl: string }> {
  const body = { filename: LOGO_FILENAME, contentType: LOGO_CONTENT_TYPE };
  const res = await ctx.client.as<{ s3Key: string; presignedUrl: string }>(SERVICE_HANDLE, 'POST', `/api/v1/organizations/${orgId}/logo/upload-url`, body);
  if (!res.ok || !res.body) throw new Error(`initiating org logo upload failed (status ${res.status})`);
  return res.body;
}

/** Bypasses `RestClient` on purpose — see the module doc's LOGO UPLOAD note. */
async function putLogoBytes(presignedUrl: string, bytes: Buffer): Promise<void> {
  const res = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': LOGO_CONTENT_TYPE }, body: new Uint8Array(bytes) });
  console.log(`[staging] ${new Date().toISOString()} PUT <presigned-s3-url> -> ${res.status} (as service, org logo)`);
  if (!res.ok) throw new Error(`S3 upload of org logo bytes failed (status ${res.status})`);
}

async function finalizeLogoUpload(ctx: ProvisioningContext, orgId: string, s3Key: string): Promise<void> {
  const res = await ctx.client.as(SERVICE_HANDLE, 'POST', `/api/v1/organizations/${orgId}/logo/finalize`, { s3Key });
  if (!res.ok) throw new Error(`finalizing org logo upload failed (status ${res.status})`);
}

// ─── Sponsor export package + preview ──────────────────────────────────

interface ExportPackageSummary {
  id: string;
  publishedVersionId: string | null;
  packageType: string;
  status: string;
}

async function ensureSponsorExportPackage(ctx: ProvisioningContext, workspaceId: string, publishedVersionId: string): Promise<void> {
  const res = await ctx.client.as<{ id: string; status: string }>(SERVICE_HANDLE, 'POST', '/api/v1/exports/sponsor', { publishedVersionId }, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`creating sponsor export for published version ${publishedVersionId} failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'sponsor-export', name: `sponsor-export:${publishedVersionId}`, id: res.body.id, action: res.body.status === 'completed' ? 'reused' : 'created' });
  await waitForExportPackage(ctx, workspaceId, res.body.id);
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60000;

/** EC7-style bounded, non-fatal poll — mirrors `datasetIngestion.ts`'s
 *  `waitForIngestion`. Not required for the preview HTML (rendered
 *  synchronously, see `fetchAndVerifyPreview`), only for the PDF package's
 *  own terminal status to be real when this step's `touched` log reports it. */
async function waitForExportPackage(ctx: ProvisioningContext, workspaceId: string, packageId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await fetchPackageStatus(ctx, workspaceId, packageId);
    if (status === 'completed' || status === 'failed') return;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function fetchPackageStatus(ctx: ProvisioningContext, workspaceId: string, packageId: string): Promise<string | undefined> {
  const res = await ctx.client.as<{ data: ExportPackageSummary[] } | ExportPackageSummary[]>(SERVICE_HANDLE, 'GET', '/api/v1/exports/packages', undefined, projectHeaders(workspaceId));
  const list = Array.isArray(res.body) ? res.body : (res.body?.data ?? []);
  return list.find((p) => p.id === packageId)?.status;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SponsorPreview {
  html: string;
  publishedVersionId: string;
  analysisName: string;
  versionNumber: number;
}

async function fetchAndVerifyPreview(ctx: ProvisioningContext, workspaceId: string, publishedVersionId: string): Promise<void> {
  const res = await ctx.client.as<SponsorPreview>(SERVICE_HANDLE, 'GET', `/api/v1/exports/sponsor/${publishedVersionId}/preview?renderMode=sponsor`, undefined, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`fetching sponsor export preview for ${publishedVersionId} failed (status ${res.status})`);
  assertProvenanceStampLegible(res.body.html);
  recordTouched(ctx, { kind: 'sponsor-export', name: 'preview-verified', id: publishedVersionId, action: 'linked' });
}

/** Exported for unit testing — pure, no network. Checks the EC11 "figure +
 *  threshold + author + stamp" claim against the real template output
 *  (`sponsor-report-template.service.ts`).
 *
 * LIVE FINDING: `SponsorDecision.evidenceValues` is always `[]` — no
 * staging step (this one included) ever populates it, so
 * `renderEvidenceValues`'s "Evidence Values" table never actually renders
 * (confirmed by reading it: `if (values.length === 0) return '';`) —
 * checking for that literal heading against the real tenant would always
 * fail, not because anything is broken but because the assumption was wrong.
 * The threshold figures ARE legible in the real output — via the cited
 * chart's own title/evidence text (Capture Spec §8's chart is literally
 * titled "...FDR < 0.05, |log2FC| >= 1", and the evidence prose repeats the
 * cutoff) — confirmed live by dumping the preview HTML and grepping for
 * `log2FC`/`padj`, both present. `requiredProvenanceMarkers` checks for
 * either, not the empty table. */
export function assertProvenanceStampLegible(html: string): void {
  const missing = requiredProvenanceMarkers(html);
  if (missing.length > 0) throw new Error(`sponsor export preview is missing legible provenance markers: ${missing.join(', ')}`);
}

/** Exported for unit testing — pure, no network. */
export function requiredProvenanceMarkers(html: string): string[] {
  const missing: string[] = [];
  if (!html.includes('Provenance Stamp')) missing.push('Provenance Stamp (stamp)');
  if (!html.includes('Shared by')) missing.push('Shared by ... via Axiome (co-branding/author)');
  if (!html.includes('<img')) missing.push('chart figure image');
  if (!html.includes('log2FC') && !html.includes('padj')) missing.push('threshold figures (log2FC/padj)');
  return missing;
}
