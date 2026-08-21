import { APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * Shared provisioning library for the AXI-1244 Subject Management E2E specs.
 *
 * The subject endpoints are workspace-membership + capability gated, so specs
 * cannot lean on ambient seed data — each stands up its own self-contained
 * workspace through the same public API a user would (register-on-demand
 * determinism, AXI-1264/NFR3). This module exposes composable primitives
 * (`adminContext`, `send`, and the workspace/schema/timepoint/subject/row
 * builders); story specs import them read-only and compose the exact shape each
 * scenario needs. It is deliberately never edited per-story so parallel spec
 * authoring never collides on it.
 */

// ── Schema fixture ────────────────────────────────────────────────────
// One column of every export-relevant category: two `clinical`, one
// `analysis`, one `biological` (the last proves biological columns are excluded
// from the promotion/export shape — FR41/FR23).
export const SCHEMA_COLUMNS = [
  { key: 'age_at_enrollment', label: 'Age at enrollment', type: 'number', category: 'clinical', required: true, unit: 'years', min: 18, max: 120 },
  { key: 'treatment_arm', label: 'Treatment arm', type: 'enum', category: 'clinical', required: true, enumValues: ['A', 'B'] },
  { key: 'clinician_notes', label: 'Clinician notes', type: 'text', category: 'analysis', required: false },
  { key: 'bmi', label: 'BMI', type: 'number', category: 'biological', required: false },
];

/** The export/promotion header for {@link SCHEMA_COLUMNS}: subject_id + timepoint
 *  + timestamp + the two clinical keys + the analysis key (biological excluded). */
export const EXPORT_HEADER =
  'subject_id,timepoint,timestamp,age_at_enrollment,treatment_arm,clinician_notes';

export interface SubjectFixture {
  id: string;
  code: string;
}

// ── Low-level request helper ─────────────────────────────────────────

/**
 * Issue an authenticated request, optionally workspace-scoped, and fail loudly
 * with the server body so a provisioning fault is never mistaken for a product
 * defect. Use directly for any endpoint the builders below do not wrap
 * (draft-only saves, validate, corrections, tombstone, audit reads, members…).
 */
export async function send(
  api: APIRequestContext,
  method: 'post' | 'put' | 'patch' | 'delete' | 'get',
  path: string,
  workspaceId: string | null,
  body?: unknown,
): Promise<any> {
  const headers = workspaceId ? { 'X-Workspace-Id': workspaceId } : undefined;
  const res = await api[method](apiUrl(path), { headers, data: body as any });
  if (!res.ok()) {
    throw new Error(`fixture ${method.toUpperCase()} ${path} → ${res.status()}: ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── Auth contexts ────────────────────────────────────────────────────

/**
 * A request context carrying a role's bearer token on every call (workspace
 * scoping is added per-request via `X-Workspace-Id`). The `admin` role is a
 * member (with the full `subject:*` bundle) of the workspaces it creates; the
 * `user` role is a non-member of any fixture workspace — the deny-by-default
 * negative. The caller disposes the returned context.
 */
// Log in at most ONCE per role per worker process. The whole AXI-1244 suite
// provisions heavily and would otherwise fire dozens of concurrent /auth/login
// calls and trip the login rate limit (100/60s); a run finishes well inside a
// token's lifetime, so caching the tokens for the run is safe and keeps the
// suite comfortably under the limit at any worker count.
const tokenCache: Partial<Record<'admin' | 'user', Promise<{ accessToken: string; refreshToken: string }>>> = {};

function cachedTokens(roleName: 'admin' | 'user'): Promise<{ accessToken: string; refreshToken: string }> {
  if (!tokenCache[roleName]) {
    tokenCache[roleName] = (async () => {
      const bootstrap = await apiRequest.newContext();
      const role = ROLES.find((r) => r.name === roleName);
      if (!role) throw new Error(`role ${roleName} missing from ROLES registry`);
      const tokens = await ensureAuthTokens(bootstrap, role);
      await bootstrap.dispose();
      return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    })();
  }
  return tokenCache[roleName]!;
}

export async function newRoleRequestContext(roleName: 'admin' | 'user'): Promise<APIRequestContext> {
  const tokens = await cachedTokens(roleName);
  return apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
  });
}

/**
 * Fresh access/refresh tokens for a role, obtained at call time. UI specs inject
 * these into `localStorage` via `page.addInitScript` (the keys the app reads:
 * `access_token` / `refresh_token`) so the browser session never depends on the
 * shared, possibly-expired `storageState` file (AXI-1264) or on refresh-token
 * rotation racing across parallel workers. This is the canonical browser-auth
 * pattern for these specs.
 */
export async function roleTokens(roleName: 'admin' | 'user'): Promise<{ accessToken: string; refreshToken: string }> {
  return cachedTokens(roleName);
}

/** Seed a page (before app scripts run) with fresh auth tokens and the active
 *  workspace/org, so `goto` lands authenticated on the right workspace. */
export async function seedBrowserSession(
  page: import('@playwright/test').Page,
  tokens: { accessToken: string; refreshToken: string },
  workspaceId: string,
  orgId: string,
): Promise<void> {
  await page.addInitScript(
    ([access, refresh, ws, org]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [tokens.accessToken, tokens.refreshToken, workspaceId, orgId] as const,
  );
}

/**
 * Authenticate as the seed admin and return a bearer-token context plus the
 * identity/org needed to own a fixture workspace. The caller disposes `api`.
 */
let adminIdentity: { userId: string; orgId: string } | undefined;

export async function adminContext(): Promise<{ api: APIRequestContext; userId: string; orgId: string }> {
  const api = await newRoleRequestContext('admin');
  if (!adminIdentity) {
    const me = await send(api, 'get', '/api/v1/auth/me', null);
    const orgs = await send(api, 'get', '/api/v1/organizations', null);
    const orgId = orgs?.data?.[0]?.id;
    if (!orgId) throw new Error('no organization available to own the fixture workspace');
    adminIdentity = { userId: me.id, orgId };
  }
  return { api, ...adminIdentity };
}

// ── Provisioning builders ────────────────────────────────────────────

function uniqueLabel(label: string): string {
  return `E2E ${label} ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Create a workspace owned by `orgId`; the creator becomes a member holding the
 *  seeded `subject:*` bundle. Returns the workspace id. */
export async function createWorkspace(
  api: APIRequestContext,
  orgId: string,
  adminUserId: string,
  label: string,
): Promise<string> {
  const ws = await send(api, 'post', '/api/v1/workspaces', null, {
    name: uniqueLabel(label),
    description: 'AXI-1244 Subject Management E2E fixture',
    type: 'internal',
    ownerOrganizationId: orgId,
    createdBy: adminUserId,
  });
  return ws.id;
}

/** Save a draft and publish it in one step; returns nothing (GET the schema to
 *  read the active version). Pass custom `columns` to exercise other shapes. */
export async function publishSchema(
  api: APIRequestContext,
  ws: string,
  columns: unknown[] = SCHEMA_COLUMNS,
  reason = 'AXI-1244 E2E baseline schema',
): Promise<void> {
  await send(api, 'put', `/api/v1/workspaces/${ws}/subject-schema/draft`, ws, {
    expectedDraftVersion: 0,
    columns,
  });
  await send(api, 'post', `/api/v1/workspaces/${ws}/subject-schema/publish`, ws, {
    reason,
    expectedDraftVersion: 1,
  });
}

export async function createTimepoint(
  api: APIRequestContext,
  ws: string,
  name: string,
  ordinal: number,
): Promise<string> {
  const tp = await send(api, 'post', `/api/v1/workspaces/${ws}/subject-timepoints`, ws, {
    name,
    ordinal,
    reason: 'AXI-1244 E2E timepoint',
  });
  return tp.id;
}

export async function createSubject(api: APIRequestContext, ws: string, code: string): Promise<SubjectFixture> {
  const subject = await send(api, 'post', `/api/v1/workspaces/${ws}/subjects`, ws, {
    code,
    reason: 'AXI-1244 E2E subject',
  });
  return { id: subject.id, code };
}

/** Upsert a subject/timepoint row. `expectedVersion` 0 creates; a non-zero value
 *  is the optimistic-concurrency token for a correction. */
export async function putRow(
  api: APIRequestContext,
  ws: string,
  subjectId: string,
  timepointId: string,
  cells: Record<string, { state: string; value?: unknown }>,
  expectedVersion = 0,
  reason = 'AXI-1244 E2E row',
): Promise<any> {
  return send(api, 'put', `/api/v1/workspaces/${ws}/subjects/${subjectId}/rows/${timepointId}`, ws, {
    reason,
    expectedVersion,
    cells,
  });
}

// ── Composite fixture for the CSV-download spec (AXI-1319) ────────────

export interface SubjectDownloadFixture {
  schemaWorkspaceId: string;
  plainWorkspaceId: string;
  orgId: string;
  adminUserId: string;
  subjectA: SubjectFixture;
  subjectB: SubjectFixture;
}

/**
 * Stand up the download fixture: a schema-enabled workspace with two subjects
 * (one across two timepoints, one with a single row) plus a bare schema-less
 * workspace for the 400 path. Returns every id the spec asserts on.
 */
export async function provisionSubjectDownloadFixture(): Promise<SubjectDownloadFixture> {
  const { api, userId, orgId } = await adminContext();
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
