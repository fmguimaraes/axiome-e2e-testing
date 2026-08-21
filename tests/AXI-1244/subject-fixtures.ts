import { APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * Data fixtures for the AXI-1319 subject CSV download spec (FR41 / AC25).
 *
 * The download endpoints are workspace-membership + `subject:read` gated, so the
 * spec cannot assert against ambient seed data — it provisions its own
 * self-contained workspace through the same public API a user would, then drives
 * the download. This mirrors the auth fixture's register-on-demand determinism
 * (AXI-1264): each run stands up a fresh, uniquely-named workspace, so there is
 * no residue dependence between runs (NFR3).
 *
 * The schema deliberately carries one column of every export-relevant category:
 * two `clinical`, one `analysis`, and one `biological` — the last proving FR41's
 * rule that the export is clinical+analysis only (biological is excluded), the
 * same materialization promotion uses.
 */

/** The exact export header for the fixture schema: subject_id + timepoint +
 *  timestamp + the two clinical keys + the analysis key. `bmi` (biological) is
 *  absent by design (FR41). */
export const EXPORT_HEADER =
  'subject_id,timepoint,timestamp,age_at_enrollment,treatment_arm,clinician_notes';

const SCHEMA_COLUMNS = [
  { key: 'age_at_enrollment', label: 'Age at enrollment', type: 'number', category: 'clinical', required: true, unit: 'years', min: 18, max: 120 },
  { key: 'treatment_arm', label: 'Treatment arm', type: 'enum', category: 'clinical', required: true, enumValues: ['A', 'B'] },
  { key: 'clinician_notes', label: 'Clinician notes', type: 'text', category: 'analysis', required: false },
  { key: 'bmi', label: 'BMI', type: 'number', category: 'biological', required: false },
];

export interface SubjectFixture {
  id: string;
  code: string;
}

export interface SubjectDownloadFixture {
  /** Workspace with a published schema + subjects/rows — the download subject. */
  schemaWorkspaceId: string;
  /** Workspace with NO published schema — drives the FR41 400 path. */
  plainWorkspaceId: string;
  orgId: string;
  adminUserId: string;
  /** SUBJ-0001, two timepoints (Baseline + Week 4). */
  subjectA: SubjectFixture;
  /** SUBJ-0002, one timepoint — proves "download all" aggregates every subject. */
  subjectB: SubjectFixture;
}

/** POST/PUT helper that fails loudly with the server body so a provisioning
 *  fault is never mistaken for a product defect. */
async function send(
  api: APIRequestContext,
  method: 'post' | 'put' | 'get',
  path: string,
  workspaceId: string | null,
  body?: unknown,
): Promise<any> {
  const headers = workspaceId ? { 'X-Workspace-Id': workspaceId } : undefined;
  const res = await api[method](apiUrl(path), { headers, data: body as any });
  if (!res.ok()) {
    throw new Error(`fixture ${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  return res.json();
}

function idOf(entity: { id: string }): string {
  return entity.id;
}

/**
 * A request context carrying a role's bearer token on every call (workspace
 * scoping is added per-request via `X-Workspace-Id`). The `admin` role holds
 * `subject:read` in its own workspaces; the `user` role is a non-member of the
 * fixture workspace and therefore has no access — the deny-by-default negative.
 * The caller disposes the returned context.
 */
export async function newRoleRequestContext(roleName: 'admin' | 'user'): Promise<APIRequestContext> {
  const bootstrap = await apiRequest.newContext();
  const role = ROLES.find((r) => r.name === roleName);
  if (!role) throw new Error(`role ${roleName} missing from ROLES registry`);
  const tokens = await ensureAuthTokens(bootstrap, role);
  await bootstrap.dispose();
  return apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
  });
}

/** Authenticate as the seed admin and return a context that carries the bearer
 *  token on every request (workspace scoping is added per-call). */
async function adminApiContext(): Promise<{ api: APIRequestContext; userId: string; orgId: string }> {
  const bootstrap = await apiRequest.newContext();
  const admin = ROLES.find((r) => r.name === 'admin');
  if (!admin) throw new Error('admin role missing from ROLES registry');
  const tokens = await ensureAuthTokens(bootstrap, admin);
  await bootstrap.dispose();

  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  const me = await send(api, 'get', '/api/v1/auth/me', null);
  const orgs = await send(api, 'get', '/api/v1/organizations', null);
  const orgId = orgs?.data?.[0]?.id;
  if (!orgId) throw new Error('no organization available to own the fixture workspace');
  return { api, userId: me.id, orgId };
}

async function createWorkspace(
  api: APIRequestContext,
  orgId: string,
  adminUserId: string,
  label: string,
): Promise<string> {
  const ws = await send(api, 'post', '/api/v1/workspaces', null, {
    name: `E2E ${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    description: 'AXI-1319 subject CSV download E2E fixture',
    type: 'internal',
    ownerOrganizationId: orgId,
    createdBy: adminUserId,
  });
  return idOf(ws);
}

async function publishSchema(api: APIRequestContext, ws: string): Promise<void> {
  await send(api, 'put', `/api/v1/workspaces/${ws}/subject-schema/draft`, ws, {
    expectedDraftVersion: 0,
    columns: SCHEMA_COLUMNS,
  });
  await send(api, 'post', `/api/v1/workspaces/${ws}/subject-schema/publish`, ws, {
    reason: 'AXI-1319 E2E baseline schema',
    expectedDraftVersion: 1,
  });
}

async function createTimepoint(api: APIRequestContext, ws: string, name: string, ordinal: number): Promise<string> {
  return idOf(await send(api, 'post', `/api/v1/workspaces/${ws}/subject-timepoints`, ws, {
    name,
    ordinal,
    reason: 'AXI-1319 E2E timepoint',
  }));
}

async function createSubject(api: APIRequestContext, ws: string, code: string): Promise<SubjectFixture> {
  const subject = await send(api, 'post', `/api/v1/workspaces/${ws}/subjects`, ws, {
    code,
    reason: 'AXI-1319 E2E subject',
  });
  return { id: idOf(subject), code };
}

async function putRow(
  api: APIRequestContext,
  ws: string,
  subjectId: string,
  timepointId: string,
  cells: Record<string, { state: string; value?: unknown }>,
): Promise<void> {
  await send(api, 'put', `/api/v1/workspaces/${ws}/subjects/${subjectId}/rows/${timepointId}`, ws, {
    reason: 'AXI-1319 E2E row',
    expectedVersion: 0,
    cells,
  });
}

/**
 * Stand up the full download fixture: a schema-enabled workspace with two
 * subjects (one with two timepoints, one with a single row) plus a bare
 * schema-less workspace for the 400 path. Returns every id the spec asserts on.
 */
export async function provisionSubjectDownloadFixture(): Promise<SubjectDownloadFixture> {
  const { api, userId, orgId } = await adminApiContext();
  try {
    const schemaWorkspaceId = await createWorkspace(api, orgId, userId, 'subject-dl');
    await publishSchema(api, schemaWorkspaceId);
    const baseline = await createTimepoint(api, schemaWorkspaceId, 'Baseline', 1);
    const week4 = await createTimepoint(api, schemaWorkspaceId, 'Week 4', 2);

    const subjectA = await createSubject(api, schemaWorkspaceId, 'SUBJ-0001');
    await putRow(api, schemaWorkspaceId, subjectA.id, baseline, {
      age_at_enrollment: { state: 'present', value: 54 },
      treatment_arm: { state: 'present', value: 'A' },
      clinician_notes: { state: 'not_applicable' },
      bmi: { state: 'present', value: 24.1 },
    });
    await putRow(api, schemaWorkspaceId, subjectA.id, week4, {
      age_at_enrollment: { state: 'present', value: 55 },
      treatment_arm: { state: 'present', value: 'B' },
      clinician_notes: { state: 'not_yet_collected' },
      bmi: { state: 'missing_unknown' },
    });

    const subjectB = await createSubject(api, schemaWorkspaceId, 'SUBJ-0002');
    await putRow(api, schemaWorkspaceId, subjectB.id, baseline, {
      age_at_enrollment: { state: 'present', value: 40 },
      treatment_arm: { state: 'present', value: 'A' },
      clinician_notes: { state: 'present', value: 'stable' },
      bmi: { state: 'present', value: 22.0 },
    });

    const plainWorkspaceId = await createWorkspace(api, orgId, userId, 'subject-plain');

    return { schemaWorkspaceId, plainWorkspaceId, orgId, adminUserId: userId, subjectA, subjectB };
  } finally {
    await api.dispose();
  }
}
