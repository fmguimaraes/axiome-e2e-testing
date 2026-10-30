import { randomUUID } from 'crypto';
import { APIResponse, expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  access,
  refusalOf,
  uploadCsvDataset,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2353 (epic AXI-2308 — FR5, FR10) — a published version is readable only
 * from its own workspace and by a caller with access to its project.
 *
 * Origin: the AXI-2324 B1 check reproduced an Investigator in workspace Mag4
 * reading a Riaz published version by id (200 on `published-versions/:id` and
 * `.../sponsor-content`). The gateway forwarded only the id.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2353 §1–§3. Fully self-provisioned: two fresh workspaces created by the
 * platform admin (who then leaves both), throwaway self-registered actors, and
 * — in workspace B — one public and one private project, each with a CSV
 * dataset, a view analysis and ONE published version, all through the API
 * (`POST /view-analyses/publish` with no evidence versions). Nothing seeded or
 * shared is read or mutated.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-010', '@SI-017'] };
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const NOT_FOUND = 'Published version not found';

interface Published {
  projectId: string;
  analysisId: string;
  versionId: string;
}

let worldA: PrivateProjectsWorld;
let worldB: PrivateProjectsWorld;
let owner: Actor;
let reviewer: Actor;
let investigatorB: Actor;
let memberNoAccess: Actor;
let investigatorA: Actor;
let editorA: Actor;
let pub: Published;
let priv: Published;

async function body(res: APIResponse, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok()) throw new Error(`AXI-2353 fixture ${what} -> ${res.status()}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function publishedIn(visibility: 'public' | 'private'): Promise<Published> {
  const project = await body(
    await owner.api.post(apiUrl('/api/v1/projects'), {
      data: { name: `E2E AXI-2353 ${visibility} ${Date.now()}`, workspaceId: worldB.workspaceId },
    }),
    'create project',
  );
  if (visibility === 'private') {
    expect((await access.visibility(owner, project.id, 'private')).status()).toBe(200);
  }
  const datasetId = await uploadCsvDataset(worldB, owner);
  const analysis = await body(
    await owner.api.post(apiUrl('/api/v1/view-analyses'), {
      data: { projectId: project.id, datasetId, name: `E2E AXI-2353 ${visibility} analysis` },
    }),
    'create analysis',
  );
  const version = await body(
    await owner.api.post(apiUrl('/api/v1/view-analyses/publish'), {
      data: { viewAnalysisId: analysis.id, evidenceVersionIds: [] },
    }),
    'publish',
  );
  return { projectId: project.id, analysisId: analysis.id, versionId: version.id };
}

/** The four published-version READ routes, keyed by what they read. */
const READS: Array<{ label: string; path: (p: Published) => string; pathFor: (id: string) => string }> = [
  {
    label: 'GET published-versions/:id',
    path: (p) => `/api/v1/view-analyses/published-versions/${p.versionId}`,
    pathFor: (id) => `/api/v1/view-analyses/published-versions/${id}`,
  },
  {
    label: 'GET published-versions/:id/sponsor-content',
    path: (p) => `/api/v1/view-analyses/published-versions/${p.versionId}/sponsor-content`,
    pathFor: (id) => `/api/v1/view-analyses/published-versions/${id}/sponsor-content`,
  },
  {
    label: 'GET published-versions/:id/decisions',
    path: (p) => `/api/v1/view-analyses/published-versions/${p.versionId}/decisions`,
    pathFor: (id) => `/api/v1/view-analyses/published-versions/${id}/decisions`,
  },
  {
    label: 'GET :viewAnalysisId/published-versions',
    path: (p) => `/api/v1/view-analyses/${p.analysisId}/published-versions`,
    pathFor: (id) => `/api/v1/view-analyses/${id}/published-versions`,
  },
];

function headers(workspaceId: string) {
  return { headers: { 'X-Workspace-Id': workspaceId } };
}

/** Same call, same actor, on an id that never existed — the genuine-miss reference. */
async function expectIndistinguishableFromMiss(
  a: Actor,
  read: (typeof READS)[number],
  target: Published,
  workspaceId: string,
): Promise<void> {
  const real = await refusalOf(await a.api.get(apiUrl(read.path(target)), headers(workspaceId)));
  const miss = await refusalOf(await a.api.get(apiUrl(read.pathFor(randomUUID())), headers(workspaceId)));
  expect(real.status, `${read.label}: ${JSON.stringify(real.body)}`).toBe(404);
  expect(real.body, `${read.label} must not differ from a never-created id`).toEqual(miss.body);
  expect(JSON.stringify(real.body)).not.toContain(target.versionId);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
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

  investigatorA = await worldA.actor('investigator-a');
  editorA = await worldA.actor('editor-a');
  await worldA.addMember(investigatorA, { roleId: INVESTIGATOR_ROLE_ID });
  await worldA.addMember(editorA, 'editor');

  await worldB.leaveWorkspace();
  await worldA.leaveWorkspace();

  pub = await publishedIn('public');
  priv = await publishedIn('private');
  expect((await access.grant(owner, priv.projectId, reviewer.userId, 'viewer')).status()).toBe(201);
});

test.afterAll(async () => {
  await worldA?.dispose();
  await worldB?.dispose();
});

test.describe('AXI-2353 — published-version reads are scoped to workspace and project', TAGS, () => {
  test('AXI-2353.1 AC1 — a member of another workspace gets 404 on every published-version read, with its own header', async () => {
    for (const read of READS) {
      await expectIndistinguishableFromMiss(investigatorA, read, pub, worldA.workspaceId);
    }
    const one = await investigatorA.api.get(apiUrl(READS[0].path(pub)), headers(worldA.workspaceId));
    expect((await one.json()).message).toBe(NOT_FOUND);
  });

  test("AXI-2353.1 AC1 — with the OTHER workspace's header the answer is still 404 and equal to a miss", async () => {
    for (const read of READS) {
      const real = await refusalOf(await investigatorA.api.get(apiUrl(read.path(pub)), headers(worldB.workspaceId)));
      const miss = await refusalOf(
        await investigatorA.api.get(apiUrl(read.pathFor(randomUUID())), headers(worldB.workspaceId)),
      );
      expect(real.status, read.label).toBe(404);
      expect(real.body).toEqual(miss.body);
    }
  });

  test("AXI-2353.1 AC1 — an editor of another workspace cannot unpublish B's version (404), and it stays published", async () => {
    const res = await editorA.api.patch(
      apiUrl(`/api/v1/view-analyses/published-versions/${pub.versionId}/unpublish`),
      headers(worldA.workspaceId),
    );
    const miss = await editorA.api.patch(
      apiUrl(`/api/v1/view-analyses/published-versions/${randomUUID()}/unpublish`),
      headers(worldA.workspaceId),
    );
    expect(res.status()).toBe(404);
    expect((await refusalOf(res)).body).toEqual((await refusalOf(miss)).body);

    const still = await body(
      await owner.api.get(apiUrl(READS[0].path(pub)), headers(worldB.workspaceId)),
      'owner reads version',
    );
    expect(still.status).toBe('published');
  });

  test('AXI-2353.2 AC2 — an owning-workspace member without access to the private project gets the same 404', async () => {
    for (const read of READS) {
      await expectIndistinguishableFromMiss(memberNoAccess, read, priv, worldB.workspaceId);
    }
  });

  test('AXI-2353.2 AC2 — the same member still reads the PUBLIC project version (200)', async () => {
    const res = await memberNoAccess.api.get(apiUrl(READS[0].path(pub)), headers(worldB.workspaceId));
    expect(res.status()).toBe(200);
    expect((await res.json()).id).toBe(pub.versionId);
  });

  test('AXI-2353.3 AC3 — a Reviewer with access reads the private version and its sponsor content (200)', async () => {
    const version = await body(
      await reviewer.api.get(apiUrl(READS[0].path(priv)), headers(worldB.workspaceId)),
      'reviewer reads version',
    );
    expect(version).toMatchObject({ id: priv.versionId, status: 'published', viewAnalysisId: priv.analysisId });

    const content = await body(
      await reviewer.api.get(apiUrl(READS[1].path(priv)), headers(worldB.workspaceId)),
      'reviewer reads sponsor content',
    );
    expect(content.publishedVersion?.id).toBe(priv.versionId);

    const list = await body(
      await reviewer.api.get(apiUrl(READS[3].path(priv)), headers(worldB.workspaceId)),
      'reviewer lists versions',
    );
    expect((list.data ?? []).map((v: { id: string }) => v.id)).toContain(priv.versionId);

    const decisions = await reviewer.api.get(apiUrl(READS[2].path(priv)), headers(worldB.workspaceId));
    expect(decisions.status()).toBe(200);
  });

  test("AXI-2353.3 AC3 — an Investigator of the owning workspace reads the public version as today (200)", async () => {
    const version = await body(
      await investigatorB.api.get(apiUrl(READS[0].path(pub)), headers(worldB.workspaceId)),
      'investigator reads version',
    );
    expect(version).toMatchObject({ id: pub.versionId, status: 'published' });
    const content = await body(
      await investigatorB.api.get(apiUrl(READS[1].path(pub)), headers(worldB.workspaceId)),
      'investigator reads sponsor content',
    );
    expect(content.publishedVersion?.id).toBe(pub.versionId);
  });
});
