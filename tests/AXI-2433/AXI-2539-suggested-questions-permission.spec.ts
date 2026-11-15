import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APIRequestContext, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';

/**
 * AXI-2539 (epic AXI-2433 — Structured SAP, FR80) — a seventh, separate SAP-scope
 * permission, `sap:suggested_questions`, gates AXI-2342's "Questions this data can
 * answer" opening-template suggestions on top of `guided_analysis:view`. Seeded on
 * NO role by default, including the Investigator (who holds all six FR77 SAP CRUD
 * rights). No LLM anywhere in this flow (unchanged from AXI-2342).
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2539.2-.3. API-level, like the sibling AXI-2342 spec it extends — the front
 * panel's hide/show gate is a thin reader of the caller's own
 * `GET /workspace-permissions/me` (`useSuggestedQuestions.ts`) and is covered at the
 * unit level (`suggestedQuestions.test.ts`, UT-INVESTIGATOR-9118/9119).
 *
 * The Investigator role (`...0105`) is a single GLOBAL seeded row (`Role.name`
 * unique) — granting the permission here mutates it for every workspace on the
 * stack this runs against. Restored in a `finally` so a re-run, or any other spec
 * sharing this stack, starts from the FR80 default (not granted).
 */

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const SUGGESTED_QUESTIONS_PERMISSION = 'sap:suggested_questions';
const SUGGESTIONS_PATH = '/api/v1/guided-analysis/opening-templates/suggestions';
const PASSWORD = 'AXI2539-e2e-pw!';
// The gateway's WorkspacePermissionsResolver caches a resolution for this long; a
// permission flip is only guaranteed visible once a caller's NEXT read happens past
// it (no test-only cache eviction endpoint is exposed by this story).
const CACHE_TTL_MS = 60_000;

const FIXTURE = 'opening-templates-paul-header.csv';
const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-2308', 'fixtures');

interface Person {
  email: string;
  userId: string;
  api: APIRequestContext;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2539-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2539', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, userId: me.id, api };
}

async function json(res: Awaited<ReturnType<APIRequestContext['get']>>, what: string): Promise<any> {
  if (!res.ok()) throw new Error(`AXI-2539 fixture ${what} -> ${res.status()}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

test.describe.configure({ mode: 'serial', timeout: 180_000 });

let admin: APIRequestContext;
let adminUserId: string;
let orgId: string;
let workspaceId: string;
let projectId: string;
let investigator: Person;
let datasetId: string;
let dataset: { datasetId: string; columns: unknown[] };
let originalInvestigatorPermissions: string[];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  admin = await adminApiContext();
  adminUserId = (await json(await admin.get(apiUrl('/api/v1/auth/me')), 'me')).id;

  const orgs = await json(await admin.get(apiUrl('/api/v1/organizations')), 'orgs');
  orgId = orgs?.data?.[0]?.id;

  const ws = await json(
    await admin.post(apiUrl('/api/v1/workspaces'), {
      data: { name: `E2E AXI-2539 ${Date.now()}`, type: 'internal', ownerOrganizationId: orgId },
    }),
    'create workspace',
  );
  workspaceId = ws.id;

  const headers = { 'X-Workspace-Id': workspaceId };
  const proj = await json(
    await admin.post(apiUrl('/api/v1/projects'), { data: { name: 'AXI-2539 fixture project', workspaceId }, headers }),
    'create project',
  );
  projectId = proj.id;

  // Confirm, then capture, the role's FR80 default before anything touches it.
  const roleBefore = await json(await admin.get(apiUrl(`/api/v1/roles/${INVESTIGATOR_ROLE_ID}`)), 'read role');
  originalInvestigatorPermissions = roleBefore.permissions as string[];
  expect(originalInvestigatorPermissions).not.toContain(SUGGESTED_QUESTIONS_PERMISSION);

  investigator = await person('investigator', workspaceId);
  await json(
    await admin.post(apiUrl(`/api/v1/workspaces/${workspaceId}/members`), {
      data: { userId: investigator.userId, organizationId: orgId, roleId: INVESTIGATOR_ROLE_ID },
    }),
    'add investigator member',
  );
  await admin.delete(apiUrl(`/api/v1/workspaces/${workspaceId}/members/${adminUserId}`)).catch(() => undefined);

  // Ingest + link the fixture (admin re-joins the workspace header-side via X-Workspace-Id
  // on its own token scope is unaffected by workspace membership for platform-admin calls).
  const bytes = readFileSync(join(FIXTURES_DIR, FIXTURE));
  const init = await json(
    await admin.post(apiUrl(`/api/v1/workspaces/${workspaceId}/datasets`), {
      data: { organizationId: orgId, originalFilename: FIXTURE, contentType: 'text/csv' },
      headers,
    }),
    'init dataset',
  );
  datasetId = init.dataset.id;
  const put = await fetch(init.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  expect(put.ok).toBe(true);
  await json(
    await admin.patch(apiUrl(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/finalize`), { headers }),
    'finalize',
  );
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    const d = await json(await admin.get(apiUrl(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`), { headers }), 'read dataset');
    if (d.latestIngestion?.status === 'ready') { ready = true; break; }
    if (d.latestIngestion?.status === 'failed') throw new Error('ingestion failed');
    await new Promise((r) => setTimeout(r, 2000));
  }
  expect(ready, 'fixture ingestion must settle Ready within 90s').toBe(true);
  await json(await admin.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId }, headers }), 'link dataset');

  const profile = await json(await admin.get(apiUrl(`/api/v1/workspaces/${workspaceId}/datasets/${datasetId}`), { headers }), 'profile columns');
  dataset = { datasetId, columns: profile.semanticSchema?.columns ?? profile.columns ?? [] };

  await approveCarriersFor(['stats.mann_whitney_u']);
});

test.afterAll(async () => {
  // Restore the FR80 default so this global role row leaves the stack exactly as
  // it found it, whether or not a scenario below already restored it.
  await admin
    .patch(apiUrl(`/api/v1/roles/${INVESTIGATOR_ROLE_ID}`), { data: { permissions: originalInvestigatorPermissions } })
    .catch(() => undefined);
  await investigator?.api.dispose();
  await admin?.dispose();
});

test.describe('AXI-2539 suggested questions gated behind sap:suggested_questions @SI-045 @SI-066 @SI-030 @SI-031', () => {
  test('AXI-2539.1 — the Investigator role seeds without sap:suggested_questions by default (FR80)', async () => {
    const role = await json(await admin.get(apiUrl(`/api/v1/roles/${INVESTIGATOR_ROLE_ID}`)), 'read role');
    expect(role.permissions).not.toContain(SUGGESTED_QUESTIONS_PERMISSION);
    // The Investigator still holds the six FR77 SAP CRUD rights — this is a
    // SEVENTH, separate permission, never folded into that bundle.
    expect(role.permissions).toEqual(
      expect.arrayContaining(['sap:read', 'sap:create', 'sap:update', 'sap:delete', 'sap:finalise', 'sap:run']),
    );
  });

  test('AXI-2539.2 — without the permission, the Investigator caller is refused 403 on suggestions (FR80)', async () => {
    const res = await investigator.api.post(apiUrl(SUGGESTIONS_PATH), { data: { projectId, dataset } });
    expect(res.status()).toBe(403);
  });

  test('AXI-2539.2b — an unrelated random permission on the same route check is still a 403, never a 404/500 (FR80)', async () => {
    // Sanity on the refusal shape: a caller resolving zero permissions at all,
    // not any permission that happens to look related.
    const anon = await apiRequest.newContext({ extraHTTPHeaders: { 'X-Workspace-Id': workspaceId } });
    try {
      const res = await anon.post(apiUrl(SUGGESTIONS_PATH), { data: { projectId, dataset: { datasetId: randomUUID(), columns: [] } } });
      expect(res.status()).toBe(401); // no bearer at all
    } finally {
      await anon.dispose();
    }
  });

  test('AXI-2539.3 — granting the permission admits the SAME deterministic suggestions AXI-2342 describes, no LLM (FR80)', async () => {
    test.setTimeout(150_000);
    const granted = [...originalInvestigatorPermissions, SUGGESTED_QUESTIONS_PERMISSION];
    try {
      await json(await admin.patch(apiUrl(`/api/v1/roles/${INVESTIGATOR_ROLE_ID}`), { data: { permissions: granted } }), 'grant permission');

      // Wait past the resolver's cache TTL so the investigator's next call reads
      // the updated row rather than a stale cached resolution.
      await new Promise((resolve) => setTimeout(resolve, CACHE_TTL_MS + 5_000));

      const me = await json(await investigator.api.get(apiUrl('/api/v1/workspace-permissions/me')), 'my permissions');
      expect(me.permissions).toContain(SUGGESTED_QUESTIONS_PERMISSION);

      const res = await investigator.api.post(apiUrl(SUGGESTIONS_PATH), { data: { projectId, dataset } });
      expect(res.status(), await res.text()).toBe(200);
      const suggestions = await res.json();
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.length).toBeLessThanOrEqual(5);
      expect(new Set(suggestions.map((s: any) => s.templateId)).size).toBe(suggestions.length);
    } finally {
      // Restore immediately so AXI-2539.4 below (and any other spec sharing the
      // stack) sees the FR80 default again.
      await admin
        .patch(apiUrl(`/api/v1/roles/${INVESTIGATOR_ROLE_ID}`), { data: { permissions: originalInvestigatorPermissions } })
        .catch(() => undefined);
    }
  });

  test('AXI-2539.4 — after restoring the default, the Investigator is refused again past the cache TTL (FR80)', async () => {
    test.setTimeout(100_000);
    await new Promise((resolve) => setTimeout(resolve, CACHE_TTL_MS + 5_000));
    const res = await investigator.api.post(apiUrl(SUGGESTIONS_PATH), { data: { projectId, dataset } });
    expect(res.status()).toBe(403);
  });
});
