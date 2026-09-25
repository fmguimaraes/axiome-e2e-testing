import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Api } from '../../AXI-1400/harness/api';
import { sleep, workspaceHeader, asList } from '../../AXI-1400/harness/api';
import { apiUrl } from '../../../config/env';

/**
 * AXI-1650 (epic AXI-1640) — REST seeding for the evidence-registry validation
 * surfaces. The front end has NO Finalize action (declare -> finalize is a
 * backend flow), so a supersede-able FINALIZED DE evidence is created here
 * through the same gateway routes the platform exposes:
 *   POST /de-evidence-references/register-existing  (draft v1)
 *   POST /de-evidence-references/:id/finalize       (immutable)
 *
 * Every entity is additive and uniquely named per run (`uniq()`), so specs never
 * depend on residue and never mutate pre-existing data.
 */

export const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-1640', 'fixtures');
export const DE_FIXTURE = 'de_small.csv';

export const NAMES = {
  org: 'AXI-1650 Evidence Registry Org',
  workspace: 'AXI-1650 Evidence Registry Validation',
  project: 'AXI-1650 Evidence Registry Project',
};

export interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  datasetId: string;
  headers: Record<string, string>;
}

/** Short unique suffix so repeated runs never collide on names / type ids. */
export function uniq(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function findByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: any) => x.name === name)?.id;
}

async function ensureOrgAndWorkspace(api: Api): Promise<{ orgId: string; workspaceId: string }> {
  const orgId =
    (await findByName(api, '/api/v1/organizations', NAMES.org)) ??
    (await api.post('/api/v1/organizations', { name: NAMES.org, type: 'biotech' })).body.id;
  let workspaceId = await findByName(api, '/api/v1/workspaces', NAMES.workspace);
  if (!workspaceId) {
    const res = await api.post('/api/v1/workspaces', {
      name: NAMES.workspace, type: 'internal', ownerOrganizationId: orgId,
    });
    workspaceId = res.body.id;
  }
  return { orgId, workspaceId: workspaceId! };
}

async function ensureProject(api: Api, workspaceId: string, headers: Record<string, string>): Promise<string> {
  const projects = await api.get(`/api/v1/projects?workspaceId=${workspaceId}&limit=100`, headers);
  const found = asList(projects.body).find((p: any) => p.name === NAMES.project)?.id;
  if (found) return found;
  const res = await api.post('/api/v1/projects', { name: NAMES.project, workspaceId }, headers);
  return res.body.id;
}

const INGEST_TIMEOUT_MS = 90_000;

async function ingestFixture(
  api: Api, orgId: string, workspaceId: string, headers: Record<string, string>, filename: string,
): Promise<string> {
  const existing = await api.get(`/api/v1/workspaces/${workspaceId}/datasets?search=${encodeURIComponent(filename)}`, headers);
  const prior = asList(existing.body).find((d: any) => d.originalFilename === filename && d.availability === 'available');
  const waitReady = async (datasetId: string) => {
    const deadline = Date.now() + INGEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const d = await api.get(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`, headers);
      const status = d.body?.latestIngestion?.status;
      if (status === 'ready') return datasetId;
      if (status === 'failed') throw new Error(`ingestion of ${filename} failed`);
      await sleep(2_000);
    }
    throw new Error(`ingestion of ${filename} timed out`);
  };
  if (prior) return waitReady(prior.id);

  const bytes = readFileSync(join(FIXTURES_DIR, filename));
  const init = await api.post(`/api/v1/workspaces/${workspaceId}/datasets`, {
    organizationId: orgId, originalFilename: filename, contentType: 'text/csv',
  }, headers);
  const datasetId = init.body.dataset.id;
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`presigned PUT of ${filename} failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/finalize`, undefined, headers);
  if (fin.status >= 300) throw new Error(`dataset finalize ${filename} failed (${fin.status})`);
  return waitReady(datasetId);
}

/** Idempotent org + workspace + project + ingested DE dataset. */
export async function ensureTenant(api: Api): Promise<Tenant> {
  const { orgId, workspaceId } = await ensureOrgAndWorkspace(api);
  const headers = workspaceHeader(workspaceId);
  const projectId = await ensureProject(api, workspaceId, headers);
  const datasetId = await ingestFixture(api, orgId, workspaceId, headers, DE_FIXTURE);
  return { orgId, workspaceId, projectId, datasetId, headers };
}

export interface DeEvidence {
  evidence_id: string;
  evidence_version: number;
  status: string;
  [k: string]: any;
}

export interface RegisterOpts {
  contrast?: string;
  flags?: string[];
}

/** Register (draft v1) a DE evidence over the ingested dataset. */
export async function registerDraftEvidence(api: Api, t: Tenant, opts: RegisterOpts = {}): Promise<DeEvidence> {
  const res = await api.post('/api/v1/de-evidence-references/register-existing', {
    workspace_id: t.workspaceId,
    project_id: t.projectId,
    dataset_version_id: t.datasetId,
    declared_tool: 'DESeq2',
    declared_contrast: opts.contrast ?? `treated vs control ${uniq()}`,
    declared_direction: { numerator_label: 'treated', denominator_label: 'control' },
    corruption_flags: opts.flags ?? [],
  }, t.headers);
  if (res.status >= 300) throw new Error(`register-existing failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body.evidence;
}

/** Finalize a draft evidence — the only way to a supersede-able version (no front-end Finalize). */
export async function finalizeEvidence(api: Api, t: Tenant, evidenceId: string): Promise<DeEvidence> {
  const res = await api.post(`/api/v1/de-evidence-references/${evidenceId}/finalize?project_id=${t.projectId}`, {}, t.headers);
  if (res.status >= 300) throw new Error(`finalize failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function seedFinalizedEvidence(api: Api, t: Tenant, opts: RegisterOpts = {}): Promise<DeEvidence> {
  const draft = await registerDraftEvidence(api, t, opts);
  return finalizeEvidence(api, t, draft.evidence_id);
}

/** Supersede over the API (used to build a chain fast when the UI path is not the SUT). */
export async function supersedeEvidence(
  api: Api, t: Tenant, priorId: string, contrast: string,
): Promise<{ new_evidence: DeEvidence }> {
  const res = await api.post(`/api/v1/de-evidence-references/${priorId}/supersede`, {
    project_id: t.projectId,
    prior_evidence_id: priorId,
    declared_tool: 'DESeq2',
    declared_contrast: contrast,
    declared_direction: { numerator_label: 'treated', denominator_label: 'control' },
    dataset_version_id: t.datasetId,
    corruption_flags: [],
  }, t.headers);
  if (res.status >= 300) throw new Error(`supersede failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function getEvidence(api: Api, t: Tenant, id: string): Promise<DeEvidence> {
  const res = await api.get(
    `/api/v1/de-evidence-references/${id}?workspace_id=${t.workspaceId}&project_id=${t.projectId}`, t.headers,
  );
  return res.body;
}

/** Evidence detail page path (the route AXI-1644 mounts). */
export function evidenceUrl(t: Tenant, evidenceId: string): string {
  return `/projects/${t.projectId}/evidence-references/${evidenceId}`;
}

// ── Registry / panels helpers (API side, for cleanup + arrangement) ──────────

export async function deleteEvidenceType(api: Api, typeId: string): Promise<number> {
  const res = await api.ctx.delete(apiUrl(`/api/v1/evidence-types/${typeId}`));
  return res.status();
}

export async function deletePanelsByName(api: Api, t: Tenant, name: string): Promise<void> {
  const list = await api.get(`/api/v1/workspaces/${t.workspaceId}/inventories/antibody-panels?limit=100`, t.headers);
  const rows: any[] = asList(list.body?.items ?? list.body);
  for (const p of rows.filter((r) => r.panel_name === name)) {
    await api.ctx.delete(apiUrl(`/api/v1/workspaces/${t.workspaceId}/inventories/antibody-panels/${p.id}`), { headers: t.headers });
  }
}

/**
 * Test-setup escape hatch for the ONE fixture the public API cannot make: a
 * LEGACY evidence row (declared_metadata NULL, i.e. written before AXI-889).
 * A single UPDATE on a row this run created.
 */
export function nullDeclaredMetadata(evidenceId: string): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) throw new Error('evidenceId must be a uuid');
  return psql(`UPDATE organization_svc.de_evidence_references SET declared_metadata = NULL WHERE id = '${evidenceId}'`);
}

// ── Synthetic evidence types ─────────────────────────────────────────────────

/** A minimal valid declaration field (user_input only, upload window). */
export function userInputField(field = 'declared_thing'): Record<string, unknown> {
  return {
    field, kind: 'enum', required: true, capture_window: 'upload',
    sources: [{ scope: 'user_input' }], resolution_order: ['user_input'],
    requires_user_confirmation: true,
  };
}

export function syntheticTypeBody(typeId: string, declarationForm: unknown[] = [userInputField()]): Record<string, unknown> {
  return {
    type_id: typeId,
    display_name: `E2E ${typeId}`,
    flow_template: 'single_step',
    schema: { required_roles: ['foo', 'bar'] },
    declaration_form: declarationForm,
    visualization_templates: ['test_chart'],
  };
}

/**
 * Register a synthetic type for ARRANGEMENT. `POST /evidence-types` cannot carry a
 * non-empty `declaration_form` today (product bug B1: the gateway's implicit-
 * conversion ValidationPipe flattens every form element to `[]` -> INVALID_FIELD),
 * so the type is registered with an empty form and the form is written straight
 * to the row. The UI-driven registration (E2E-1640-A2) still exercises the real route.
 */
export async function registerTypeViaApi(api: Api, body: Record<string, unknown>): Promise<void> {
  const form = (body.declaration_form as unknown[]) ?? [];
  const res = await api.post('/api/v1/evidence-types', { ...body, declaration_form: [] });
  if (res.status >= 300) throw new Error(`register evidence type failed (${res.status}): ${JSON.stringify(res.body)}`);
  if (form.length > 0) {
    const typeId = String(body.type_id);
    if (!/^[a-z0-9_]{1,64}$/.test(typeId)) throw new Error('typeId must be snake_case');
    const json = JSON.stringify(form);
    if (json.includes('$e2e$')) throw new Error('form json contains the quote tag');
    if (!psql(`UPDATE organization_svc.evidence_type_registrations SET declaration_form = $e2e$${json}$e2e$::jsonb WHERE type_id = '${typeId}'`)) {
      throw new Error('could not write declaration_form (local Postgres container unreachable)');
    }
  }
}

/** Run one statement on the local stack's Postgres (test setup only; never on data this run did not create). */
export function psql(sql: string): boolean {
  const container = process.env.E2E_PG_CONTAINER ?? 'axiome-localhost';
  const db = process.env.E2E_PG_DB ?? 'axiome';
  const user = process.env.E2E_PG_USER ?? 'axiome';
  try {
    execFileSync('docker', ['exec', container, 'psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Test-setup escape hatch: retag an evidence row this run created (the API always tags `rnaseq_de_table`). */
export function setEvidenceType(evidenceId: string, typeId: string): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) throw new Error('evidenceId must be a uuid');
  if (!/^[a-z0-9_]{1,64}$/.test(typeId)) throw new Error('typeId must be snake_case');
  return psql(`UPDATE organization_svc.de_evidence_references SET evidence_type = '${typeId}' WHERE id = '${evidenceId}'`);
}
