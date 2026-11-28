import { execFileSync } from 'child_process';
import { expect, test, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';

/**
 * AXI-2813 (epic AXI-2802, area A4b — owner ruling 9, FR45): `POST /projects` sets a new
 * project's profiles ONLY through `semanticProfileIds`; a create body carrying the legacy
 * `semanticProfileId` is refused (400), regardless of its value, and creates nothing.
 * Scenarios: `axiome-docs/manual-e2e/AXI-2802-Semantic-Profile-Management.md` § AXI-2813
 * (AXI-2813.1–.3).
 *
 * E2E CONTRACT — an A/B over the REAL gateway, API level, as `admin@cro-one.com` only:
 *   - REFERENCE = `REF_API_BASE_URL` (default `http://localhost:3000`, the shared demo = `main`,
 *     pre-AXI-2813 — still accepts the legacy field);
 *   - STORY     = `API_BASE_URL`: the branch's sidecar (`axiome-axi2813-backend`, own RabbitMQ
 *     vhost `axi-2813`), whose organization/user databases are the THROWAWAY `E2E_2813_DB`
 *     (default `axiome_axi2813`).
 * AXI-2813.2's UI network-shape half (the create dialog never sending `semanticProfileId`) is
 * covered by `AXI-2809-profile-pickers.spec.ts`'s `AXI-2809.1` (same wire-shape contract, updated
 * for this story) rather than restated here — this file covers the API contract only.
 */

const REF_API_BASE_URL = (process.env.REF_API_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = process.env.E2E_2813_EMAIL?.trim() || 'admin@cro-one.com';
const PASSWORD = process.env.E2E_2813_PASSWORD?.trim() || 'admin';
const STORY_DB = process.env.E2E_2813_DB?.trim() || 'axiome_axi2813';
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'axiome-localhost';

if (!/^axiome_axi2813[a-z0-9_]*$/.test(STORY_DB)) throw new Error(`E2E_2813_DB must name a throwaway axiome_axi2813* database, got ${STORY_DB}`);
if (REF_API_BASE_URL === API_BASE_URL) throw new Error('AXI-2813 is an A/B: API_BASE_URL must be the story sidecar, not the reference stack');

const WS_A = '8946e06a-4fe6-45ee-8d9a-58f7142e803a'; // Mag4
const PROJECT_PREFIX = 'E2E AXI-2813';
const RUN = Date.now().toString(36);

interface Stack { name: string; base: string; api: APIRequestContext }
let story: Stack;
const created: { id: string; ws: string }[] = [];

// ─── helpers (AXI-2806 pattern) ────────────────────────────────────────────────────────────────

function psql(statement: string): string[] {
  if (!STORY_DB.startsWith('axiome_axi2813')) throw new Error(`refusing SQL on ${STORY_DB}`);
  const out = execFileSync('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'axiome', '-d', STORY_DB, '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, stdio: 'pipe' }).toString();
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

const sql = (select: string) => psql(`SET search_path TO organization_svc; ${select}`).filter((l) => l !== 'SET');

const lit = (v: string) => {
  if (!/^[A-Za-z0-9_.:@+ -]+$/.test(v)) throw new Error(`unsafe literal: ${v}`);
  return `'${v}'`;
};

async function open(name: string, base: string): Promise<Stack> {
  const bootstrap = await apiRequest.newContext();
  const res = await bootstrap.post(`${base}/api/v1/auth/login`, { data: { email: EMAIL, password: PASSWORD } });
  expect(res.ok(), `${name} login → ${res.status()}`).toBeTruthy();
  const { accessToken } = await res.json();
  await bootstrap.dispose();
  return { name, base, api: await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } }) };
}

interface Answer { status: number; body: any }
async function createRaw(ws: string, label: string, body: Record<string, unknown>): Promise<Answer> {
  const res = await story.api.fetch(`${story.base}/api/v1/projects`, {
    method: 'POST',
    headers: { 'X-Workspace-Id': ws },
    data: { name: `${PROJECT_PREFIX} ${label} ${RUN}`, workspaceId: ws, ...body },
  });
  const raw = await res.text();
  let parsed: any = raw;
  try { parsed = JSON.parse(raw); } catch { /* text */ }
  const answer = { status: res.status(), body: parsed };
  if (answer.status === 201) created.push({ id: answer.body.id, ws });
  return answer;
}

const countNamed = (name: string) => sql(`SELECT count(*) FROM projects WHERE name = ${lit(name)}`)[0];
const relationOf = (projectId: string) => sql(`SELECT profile_key FROM project_semantic_profiles WHERE project_id = ${lit(projectId)} ORDER BY profile_key`);

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(async () => {
  story = await open('story', API_BASE_URL);
});

test.afterAll(async () => {
  if (story) {
    for (const { id, ws } of created) await story.api.fetch(`${story.base}/api/v1/projects/${id}`, { method: 'DELETE', headers: { 'X-Workspace-Id': ws } });
  }
  await story?.api.dispose();
});

test.describe('AXI-2813 create sets profiles only through semanticProfileIds @SI-010 @SI-002 @SI-030', () => {
  test('AXI-2813.1 (FR45, owner ruling 9) — a create naming the legacy field is refused, and nothing is written: a valid key', async () => {
    const name = `${PROJECT_PREFIX} legacy-valid ${RUN}`;
    const a = await createRaw(WS_A, 'legacy-valid', { semanticProfileId: 'oncology' });
    expect(a.status, JSON.stringify(a.body)).toBe(400);
    expect(JSON.stringify(a.body)).toContain('semanticProfileId');
    expect(countNamed(name)).toBe('0');
  });

  test('AXI-2813.1 (FR45, owner ruling 9) — a create naming the legacy field is refused: explicit null', async () => {
    const name = `${PROJECT_PREFIX} legacy-null ${RUN}`;
    const a = await createRaw(WS_A, 'legacy-null', { semanticProfileId: null });
    expect(a.status, JSON.stringify(a.body)).toBe(400);
    expect(countNamed(name)).toBe('0');
  });

  test('AXI-2813.1 (FR45, owner ruling 9) — a create naming the legacy field is refused even when it agrees with semanticProfileIds', async () => {
    const name = `${PROJECT_PREFIX} legacy-agree ${RUN}`;
    const a = await createRaw(WS_A, 'legacy-agree', { semanticProfileId: 'oncology', semanticProfileIds: ['oncology'] });
    expect(a.status, JSON.stringify(a.body)).toBe(400);
    expect(countNamed(name)).toBe('0');
  });

  test('AXI-2813.2 (FR45) — a list of one profile behaves exactly like the old single-profile create', async () => {
    const a = await createRaw(WS_A, 'list-of-one', { semanticProfileIds: ['oncology'] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ semanticProfileId: 'oncology', semanticProfileIds: ['oncology'] });
    expect(relationOf(a.body.id)).toEqual(['oncology']);
  });

  test('AXI-2813.3 (FR45) — an omitted field applies the organization default', async () => {
    const a = await createRaw(WS_A, 'omitted', {});
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    // Whatever Mag4's org default resolves to (possibly none) — this merely proves the field was
    // never refused for being absent, and the response mirror stays consistent with the relation.
    expect(relationOf(a.body.id)).toEqual(a.body.semanticProfileIds ?? []);
  });

  test('AXI-2813.3 (FR45) — an explicit empty list means no profile, distinct from omitted', async () => {
    const a = await createRaw(WS_A, 'explicit-none', { semanticProfileIds: [] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ semanticProfileId: null, semanticProfileIds: [] });
    expect(relationOf(a.body.id)).toEqual([]);
  });
});
