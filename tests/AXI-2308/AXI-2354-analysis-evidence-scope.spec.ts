import { randomUUID } from 'crypto';
import { APIResponse, expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  access,
  refusalOf,
  uploadCsvDataset,
} from '../AXI-2265/private-projects-fixtures';
import { frozenRenderPayload } from '../AXI-1233/harness/seed-axi1234';
import { silenceTours } from '../AXI-1904/harness/tours';

/**
 * AXI-2354 (epic AXI-2308 — FR5, FR10, D19 part 2) — an analysis and an
 * evidence (and its version history) are readable only from their own
 * workspace and by a caller with access to their project.
 *
 * Origin: the AXI-2353 review — `GET view-analyses/:id`,
 * `GET view-analyses/evidences/:evidenceId` and `.../versions` forwarded only
 * the id, so any member of any workspace read another workspace's content.
 * Follow-up (lead, 2026-10-30): the evidence LIST of an analysis
 * (`GET view-analyses/:viewAnalysisId/evidences`) had the same defect and is
 * scoped here too (§6).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2354 §1–§3. Fully self-provisioned (the AXI-2353 recipe): two fresh
 * workspaces created by the platform admin (who then leaves both), throwaway
 * self-registered actors, and — in workspace B — one public and one private
 * project, each with a CSV dataset, a view analysis, a snapshot, ONE evidence
 * (chart entry carrying a frozen render, so no bio-compute call) and one
 * published version, all through the API. Nothing seeded or shared is read or
 * mutated.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-010', '@SI-017'] };
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';

interface Content {
  projectId: string;
  analysisId: string;
  analysisName: string;
  evidenceId: string;
  evidenceTitle: string;
  versionId: string;
}

let worldA: PrivateProjectsWorld;
let worldB: PrivateProjectsWorld;
let owner: Actor;
let reviewer: Actor;
let investigatorB: Actor;
let memberNoAccess: Actor;
let investigatorA: Actor;
let uiReviewer: UiActor;
let pub: Content;
let priv: Content;

/** A Reviewer the BROWSER signs in as — same membership and grant as `reviewer`. */
interface UiActor extends Actor {
  email: string;
  password: string;
  accessToken: string;
}

async function uiActor(label: string): Promise<UiActor> {
  const email = `axi2354-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const password = 'AXI2354-e2e-pw!';
  const bootstrap = await apiRequest.newContext();
  await body(
    await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password, firstName: 'AXI2354', lastName: label } }),
    'register ui actor',
  );
  const tokens = await body(await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } }), 'login ui actor');
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}`, 'X-Workspace-Id': worldB.workspaceId },
  });
  const me = await body(await api.get(apiUrl('/api/v1/auth/me')), 'ui actor me');
  return { userId: me.id, api, email, password, accessToken: tokens.accessToken };
}

/** Sign in through the real login page, then ONE full load of `landing` with the study active (AXI-2324 recipe). */
async function signIn(page: Page, a: UiActor, projectId: string, landing: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(a.email);
  await page.locator('input[type="password"]').fill(a.password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.evaluate(([orgId, workspaceId, project]) => {
    localStorage.setItem('axiome-top-org', orgId as string);
    localStorage.setItem('axiome-active-workspace', workspaceId as string);
    localStorage.setItem('axiome-active-project', project as string);
  }, [worldB.orgId, worldB.workspaceId, projectId]);
  await page.goto(landing);
  await expect(page).not.toHaveURL(/\/login/);
}

async function body(res: APIResponse, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok()) throw new Error(`AXI-2354 fixture ${what} -> ${res.status()}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function post(path: string, data: unknown, what: string): Promise<any> {
  return body(await owner.api.post(apiUrl(path), { data }), what);
}

async function contentIn(visibility: 'public' | 'private'): Promise<Content> {
  const stamp = `${visibility} ${Date.now()}`;
  const project = await post('/api/v1/projects', { name: `E2E AXI-2354 ${stamp}`, workspaceId: worldB.workspaceId }, 'create project');
  if (visibility === 'private') {
    expect((await access.visibility(owner, project.id, 'private')).status()).toBe(200);
  }
  const datasetId = await uploadCsvDataset(worldB, owner);
  const analysisName = `E2E AXI-2354 ${stamp} analysis`;
  const analysis = await post('/api/v1/view-analyses', { projectId: project.id, datasetId, name: analysisName }, 'create analysis');
  const snapshot = await post('/api/v1/view-analyses/snapshots', { viewAnalysisId: analysis.id, filters: [] }, 'create snapshot');
  const specId = `spec-axi2354-${randomUUID()}`;
  const evidenceTitle = `E2E AXI-2354 ${stamp} evidence`;
  const evidence = await post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysis.id,
    title: evidenceTitle,
    createdBy: owner.userId,
    chartEntries: [{
      chartArtifactId: specId,
      snapshotId: snapshot.id,
      datasetVersionId: datasetId,
      frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: datasetId }),
    }],
  }, 'create evidence');
  const version = await post('/api/v1/view-analyses/publish', { viewAnalysisId: analysis.id, evidenceVersionIds: [] }, 'publish');
  return {
    projectId: project.id, analysisId: analysis.id, analysisName,
    evidenceId: evidence.id, evidenceTitle, versionId: version.id,
  };
}

/** The by-id READ routes in scope, keyed by what they read (READS[3] = the evidence list, added on the AXI-2354 follow-up). */
const READS: Array<{ label: string; path: (c: Content) => string; pathFor: (id: string) => string }> = [
  {
    label: 'GET view-analyses/:id',
    path: (c) => `/api/v1/view-analyses/${c.analysisId}`,
    pathFor: (id) => `/api/v1/view-analyses/${id}`,
  },
  {
    label: 'GET view-analyses/evidences/:evidenceId',
    path: (c) => `/api/v1/view-analyses/evidences/${c.evidenceId}`,
    pathFor: (id) => `/api/v1/view-analyses/evidences/${id}`,
  },
  {
    label: 'GET view-analyses/evidences/:evidenceId/versions',
    path: (c) => `/api/v1/view-analyses/evidences/${c.evidenceId}/versions`,
    pathFor: (id) => `/api/v1/view-analyses/evidences/${id}/versions`,
  },
  {
    label: 'GET view-analyses/:viewAnalysisId/evidences',
    path: (c) => `/api/v1/view-analyses/${c.analysisId}/evidences`,
    pathFor: (id) => `/api/v1/view-analyses/${id}/evidences`,
  },
];

function headers(workspaceId: string) {
  return { headers: { 'X-Workspace-Id': workspaceId } };
}

/** Same call, same actor, on an id that never existed — the genuine-miss reference. */
async function expectIndistinguishableFromMiss(
  a: Actor,
  read: (typeof READS)[number],
  target: Content,
  workspaceId: string,
): Promise<void> {
  const real = await refusalOf(await a.api.get(apiUrl(read.path(target)), headers(workspaceId)));
  const miss = await refusalOf(await a.api.get(apiUrl(read.pathFor(randomUUID())), headers(workspaceId)));
  expect(real.status, `${read.label}: ${JSON.stringify(real.body)}`).toBe(404);
  expect(real.body, `${read.label} must not differ from a never-created id`).toEqual(miss.body);
  const leaked = JSON.stringify(real.body);
  for (const secret of [target.analysisId, target.analysisName, target.evidenceId, target.evidenceTitle]) {
    expect(leaked).not.toContain(secret);
  }
}

async function readOk(a: Actor, path: string, what: string): Promise<any> {
  return body(await a.api.get(apiUrl(path), headers(worldB.workspaceId)), what);
}

/** The reads `EvidenceDetail.tsx` issues, in its order: evidence → analysis → versions. */
async function expectEvidenceDetailReads(a: Actor, c: Content): Promise<void> {
  const evidence = await readOk(a, READS[1].path(c), 'evidence');
  expect(evidence).toMatchObject({ id: c.evidenceId, viewAnalysisId: c.analysisId });
  const analysis = await readOk(a, READS[0].path(c), 'analysis');
  expect(analysis).toMatchObject({ id: c.analysisId, name: c.analysisName });
  const versions = await readOk(a, READS[2].path(c), 'evidence versions');
  expect(Array.isArray(versions) && versions.length).toBe(1);
  expect(versions[0].evidenceId).toBe(c.evidenceId);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  worldB = await PrivateProjectsWorld.create();
  worldA = await PrivateProjectsWorld.create();

  owner = await worldB.actor('owner');
  reviewer = await worldB.actor('reviewer');
  investigatorB = await worldB.actor('investigator-b');
  memberNoAccess = await worldB.actor('member-no-access');
  await worldB.addMember(owner, 'admin');
  await worldB.addMember(reviewer, 'sponsor_viewer' as never);
  await worldB.addMember(investigatorB, { roleId: INVESTIGATOR_ROLE_ID });
  await worldB.addMember(memberNoAccess, 'sponsor_viewer' as never);

  uiReviewer = await uiActor('ui-reviewer');
  await worldB.addMember(uiReviewer, 'sponsor_viewer' as never);
  await silenceTours(uiReviewer.accessToken);

  investigatorA = await worldA.actor('investigator-a');
  await worldA.addMember(investigatorA, { roleId: INVESTIGATOR_ROLE_ID });

  await worldB.leaveWorkspace();
  await worldA.leaveWorkspace();

  pub = await contentIn('public');
  priv = await contentIn('private');
  expect((await access.grant(owner, priv.projectId, reviewer.userId, 'viewer')).status()).toBe(201);
  expect((await access.grant(owner, priv.projectId, uiReviewer.userId, 'viewer')).status()).toBe(201);
});

test.afterAll(async () => {
  await uiReviewer?.api.dispose();
  await worldA?.dispose();
  await worldB?.dispose();
});

test.describe('AXI-2354 — analysis and evidence by-id reads are scoped to workspace and project', TAGS, () => {
  test('AXI-2354.1 AC1 — a member of another workspace gets 404 on the analysis, evidence, versions and evidence-list reads, with its own header', async () => {
    for (const read of READS) {
      await expectIndistinguishableFromMiss(investigatorA, read, pub, worldA.workspaceId);
    }
    const analysis = await investigatorA.api.get(apiUrl(READS[0].path(pub)), headers(worldA.workspaceId));
    expect((await analysis.json()).message).toBe('ViewAnalysis not found');
    const evidence = await investigatorA.api.get(apiUrl(READS[1].path(pub)), headers(worldA.workspaceId));
    expect((await evidence.json()).message).toBe('Evidence not found');
  });

  test("AXI-2354.1 AC1 — with the OTHER workspace's header the answer is still 404 and equal to a miss", async () => {
    for (const read of READS) {
      const real = await refusalOf(await investigatorA.api.get(apiUrl(read.path(pub)), headers(worldB.workspaceId)));
      const miss = await refusalOf(
        await investigatorA.api.get(apiUrl(read.pathFor(randomUUID())), headers(worldB.workspaceId)),
      );
      expect(real.status, read.label).toBe(404);
      expect(real.body).toEqual(miss.body);
    }
  });

  test('AXI-2354.2 AC2 — an owning-workspace member without access to the private project gets the same 404', async () => {
    for (const read of READS) {
      await expectIndistinguishableFromMiss(memberNoAccess, read, priv, worldB.workspaceId);
    }
  });

  test('AXI-2354.2 AC2 — the same member still reads the PUBLIC project analysis and evidence (200)', async () => {
    await expectEvidenceDetailReads(memberNoAccess, pub);
  });

  test("AXI-2354.3 AC3 — a Reviewer with access gets the evidence-detail reads on the private project (200)", async () => {
    await expectEvidenceDetailReads(reviewer, priv);
  });

  test("AXI-2354.3 AC3 — the review page's read (published version → its analysis) works for the Reviewer", async () => {
    const version = await readOk(reviewer, `/api/v1/view-analyses/published-versions/${priv.versionId}`, 'published version');
    expect(version.viewAnalysisId).toBe(priv.analysisId);
    const analysis = await readOk(reviewer, `/api/v1/view-analyses/${version.viewAnalysisId}`, 'analysis of the version');
    expect(analysis.id).toBe(priv.analysisId);
  });

  test('AXI-2354.3 AC3 — an Investigator of the owning workspace gets the evidence-detail reads as today (200)', async () => {
    await expectEvidenceDetailReads(investigatorB, pub);
  });

  test('AXI-2354.3 AC3 — the Reviewer opens the Evidence detail PAGE of the private project and it renders as today', async ({ page }) => {
    const seen: Array<{ key: string; status: number }> = [];
    page.on('response', (r) => {
      const m = r.url().match(/\/api\/v1(\/view-analyses\/[^?]*)/);
      if (m) seen.push({ key: `${r.request().method()} ${m[1]}`, status: r.status() });
    });

    await signIn(page, uiReviewer, priv.projectId,
      `/projects/${priv.projectId}/view-analyses/${priv.analysisId}/evidences/${priv.evidenceId}`);

    await expect(page.getByRole('heading', { level: 1, name: priv.evidenceTitle })).toBeVisible({ timeout: 30_000 });
    const status = (key: string) => seen.find((s) => s.key === key)?.status;
    expect(status(`GET /view-analyses/evidences/${priv.evidenceId}`)).toBe(200);
    expect(status(`GET /view-analyses/${priv.analysisId}`)).toBe(200);
    expect(seen.filter((s) => s.status === 404), JSON.stringify(seen)).toEqual([]);
  });

  test('AXI-2354.6 AC1 AC2 — the evidence LIST of an analysis: an outsider and a member without private access get the never-created-analysis 404', async () => {
    const list = READS[3];
    await expectIndistinguishableFromMiss(investigatorA, list, pub, worldA.workspaceId);
    await expectIndistinguishableFromMiss(investigatorA, list, pub, worldB.workspaceId);
    await expectIndistinguishableFromMiss(memberNoAccess, list, priv, worldB.workspaceId);
    const refused = await memberNoAccess.api.get(apiUrl(list.path(priv)), headers(worldB.workspaceId));
    expect((await refused.json()).message).toBe('ViewAnalysis not found');
  });

  test('AXI-2354.6 AC3 — readers with access still list the evidences (200, the evidence is there)', async () => {
    for (const [who, c] of [[reviewer, priv], [investigatorB, pub], [memberNoAccess, pub]] as const) {
      const page = await readOk(who, READS[3].path(c), 'evidence list');
      expect(page.data.map((e: { id: string }) => e.id)).toEqual([c.evidenceId]);
      expect(page.meta.total).toBe(1);
    }
  });
});
