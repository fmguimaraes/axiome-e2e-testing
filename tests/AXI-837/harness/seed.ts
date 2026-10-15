import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as apiRequest, type Page } from '@playwright/test';
import { adminApi, type Api, workspaceHeader, sleep } from '../../AXI-1400/harness/api';
import { ensureAuthTokens, type AuthTokens } from '../../../config/auth';
import { ROLES } from '../../../config/roles';

/**
 * AXI-846 (epic AXI-837) — seed harness for the DE Standard Inspection
 * auto-offer/clone + decision-citation UI.
 *
 * Every tenant (org/workspace/project/dataset) is created FRESH and uniquely
 * named per run (`uniq()`) rather than reusing AXI-1640's shared evidence-
 * registry tenant: the offer banner's `existing_saved_view` branch depends on
 * there being NO prior SavedView over this exact (workspace, project,
 * datasetVersion) triple, so sharing a tenant across specs/runs would make
 * the offer flaky by construction. The DE fixture (`de_small.csv`) is reused
 * read-only from AXI-1640's fixtures directory rather than duplicated.
 */

const DE_FIXTURE_PATH = join(process.cwd(), 'tests', 'AXI-1640', 'fixtures', 'de_small.csv');
const INGEST_TIMEOUT_MS = 90_000;

export interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  /** Same id serves as both `datasetId` (view-analysis creation) and
   *  `dataset_version_id` (DE evidence registration) — the platform's own
   *  dual use of this identifier, mirrored from the AXI-1640 harness. */
  datasetId: string;
  headers: Record<string, string>;
}

function uniq(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function waitDatasetReady(api: Api, workspaceId: string, headers: Record<string, string>, datasetId: string): Promise<string> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await api.get(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`, headers);
    const status = d.body?.latestIngestion?.status;
    if (status === 'ready') return datasetId;
    if (status === 'failed') throw new Error(`ingestion of de_small.csv failed`);
    await sleep(2_000);
  }
  throw new Error('ingestion of de_small.csv timed out');
}

/** Fresh org + workspace + project + ingested DE dataset, unique per call. */
export async function ensureFreshTenant(api: Api): Promise<Tenant> {
  const suffix = uniq();
  const org = await api.post('/api/v1/organizations', { name: `AXI-846 E2E Org ${suffix}`, type: 'biotech' });
  const orgId: string = org.body.id;
  const ws = await api.post('/api/v1/workspaces', { name: `AXI-846 E2E Workspace ${suffix}`, type: 'internal', ownerOrganizationId: orgId });
  const workspaceId: string = ws.body.id;
  const headers = workspaceHeader(workspaceId);
  const proj = await api.post('/api/v1/projects', { name: `AXI-846 E2E Project ${suffix}`, workspaceId }, headers);
  const projectId: string = proj.body.id;

  const bytes = readFileSync(DE_FIXTURE_PATH);
  const init = await api.post(`/api/v1/workspaces/${workspaceId}/datasets`, {
    organizationId: orgId, originalFilename: 'de_small.csv', contentType: 'text/csv',
  }, headers);
  const datasetId: string = init.body.dataset.id;
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`presigned PUT of de_small.csv failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/finalize`, undefined, headers);
  if (fin.status >= 300) throw new Error(`dataset finalize failed (${fin.status})`);
  await waitDatasetReady(api, workspaceId, headers, datasetId);

  return { orgId, workspaceId, projectId, datasetId, headers };
}

/**
 * Register (draft) DE evidence over the tenant's dataset — enough to
 * DE-fingerprint it for the offer endpoint (FR34). The column schema is
 * auto-derived server-side from the ingested CSV's profiled columns
 * (`gene_id`/`log2FoldChange`/`padj`/`baseMean`), so none is sent explicitly.
 */
export async function registerDeEvidence(api: Api, t: Tenant): Promise<string> {
  const res = await api.post('/api/v1/de-evidence-references/register-existing', {
    workspace_id: t.workspaceId,
    project_id: t.projectId,
    dataset_version_id: t.datasetId,
    declared_tool: 'DESeq2',
    declared_contrast: `treated vs control ${uniq()}`,
    declared_direction: { numerator_label: 'treated', denominator_label: 'control' },
    corruption_flags: [],
  }, t.headers);
  if (res.status >= 300) throw new Error(`register-existing failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.evidence.evidence_id;
}

export interface Analysis {
  analysisId: string;
  snapshotId: string;
}

/** A plain ViewAnalysis + its initial (unfiltered) snapshot over the tenant's dataset. */
export async function ensureViewAnalysis(api: Api, t: Tenant): Promise<Analysis> {
  const va = await api.post('/api/v1/view-analyses', { projectId: t.projectId, datasetId: t.datasetId, name: `AXI-846 E2E Analysis ${uniq()}` }, t.headers);
  if (va.status >= 300) throw new Error(`create view analysis failed (${va.status}): ${JSON.stringify(va.body)}`);
  const analysisId: string = va.body.id;
  const snap = await api.post('/api/v1/view-analyses/snapshots', { viewAnalysisId: analysisId, filters: [] }, t.headers);
  if (snap.status >= 300) throw new Error(`create snapshot failed (${snap.status}): ${JSON.stringify(snap.body)}`);
  return { analysisId, snapshotId: snap.body.id };
}

export interface DecisionDraftSeed {
  id: string;
  label: string;
}

/** A decision draft citing the analysis's own snapshot, so the page's `viewAnalysisId`-scoped list finds it. */
export async function createDecisionDraft(api: Api, t: Tenant, analysis: Analysis): Promise<DecisionDraftSeed> {
  const label = `AXI-846 E2E Decision ${uniq()}`;
  const res = await api.post(`/api/v1/workspaces/${t.workspaceId}/decisions`, {
    label,
    type: 'biomarker_threshold',
    projectId: t.projectId,
    context: { intendedUse: 'RUO' },
    evidenceLinks: [{ snapshotId: analysis.snapshotId }],
    evidenceValues: [],
  }, t.headers);
  if (res.status >= 300) throw new Error(`create decision draft failed (${res.status}): ${JSON.stringify(res.body)}`);
  return { id: res.body.id, label };
}

// ── Browser priming (AXI-1717's `primeWorkspace` recipe) ───────────────────

const BROWSER_REAUTH_INTERVAL_MS = 8 * 60 * 1000;
let browserAuthMintedAt = Date.now();
let refreshingBrowserAuth: Promise<AuthTokens> | null = null;

async function freshBrowserAuthTokens(): Promise<AuthTokens> {
  if (!refreshingBrowserAuth) {
    refreshingBrowserAuth = (async () => {
      const bootstrap = await apiRequest.newContext();
      const role = ROLES.find((r) => r.name === 'admin');
      if (!role) throw new Error('admin role missing from ROLES registry');
      const tokens = await ensureAuthTokens(bootstrap, role);
      await bootstrap.dispose();
      return tokens;
    })().finally(() => { refreshingBrowserAuth = null; });
  }
  return refreshingBrowserAuth;
}

/** Sets the active workspace/org in localStorage and (re-)mints a fresh auth session for the browser tab. */
export async function primeWorkspace(page: Page, t: Tenant): Promise<void> {
  await page.addInitScript(([ws, org]) => {
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-top-org', org);
  }, [t.workspaceId, t.orgId] as const);

  if (Date.now() - browserAuthMintedAt >= BROWSER_REAUTH_INTERVAL_MS) {
    const tokens = await freshBrowserAuthTokens();
    browserAuthMintedAt = Date.now();
    await page.addInitScript(([access, refresh]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
    }, [tokens.accessToken, tokens.refreshToken] as const);
  }
}

export { adminApi, type Api };
