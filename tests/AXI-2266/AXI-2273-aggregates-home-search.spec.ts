import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  access,
  uploadCsvDataset,
  listedProjectIds,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2273 (epic AXI-2266 — FR7, FR8; AC6): home, overview and the activity
 * feed must intersect every project-spanning query with the caller's
 * accessible-project set (`ProjectAccessPredicate.callerProjectIds`), and a
 * project-scoped overview read must ask the SAME predicate `findOne` already
 * asks — not workspace membership alone.
 *
 * These scenarios drive the full stack through the gateway (as every
 * Playwright spec does). See
 * axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md § AXI-2273.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-013', '@SI-018'] };

let world: PrivateProjectsWorld;
let owner: Actor;
let member: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await world.actor('owner');
  member = await world.actor('member');
  await world.addMember(owner, 'editor');
  await world.addMember(member, 'editor');
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  await world?.dispose();
});

async function newPrivateProjectWithDataset(): Promise<string> {
  const res = await owner.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2273 ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  expect((await access.visibility(owner, id, 'private')).status()).toBe(200);

  const datasetId = await uploadCsvDataset(world, owner);
  const linkRes = await owner.api.post(apiUrl(`/api/v1/projects/${id}/datasets`), {
    data: { datasetId },
  });
  expect(linkRes.status()).toBe(201);
  return id;
}

async function mentionComment(a: Actor, projectId: string, analysisId: string, mentionUserId: string) {
  return a.api.post(apiUrl(`/api/v1/mention-comments/projects/${projectId}/analyses/${analysisId}`), {
    data: {
      bodyJson: {
        schemaVersion: 1,
        nodes: [{ t: 'text', v: 'AXI-2273 mention fixture' }, { t: 'mention', userId: mentionUserId }],
      },
    },
  });
}

async function defaultAnalysisId(a: Actor, projectId: string): Promise<string> {
  const res = await a.api.get(apiUrl(`/api/v1/view-analyses?projectId=${projectId}&limit=5`));
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data?.length).toBeGreaterThan(0);
  return body.data[0].id;
}

// AXI-2273 bounce #1 regression fixture — a snapshot to cite from an
// Interpretation (DecisionDraft), so the overview's
// `tiles.interpretiveGovernance.interpretationsByValidityState` tile has a
// real private-project row to exclude/include.
async function defaultBaselineSnapshotId(a: Actor, projectId: string): Promise<string> {
  const analysisId = await defaultAnalysisId(a, projectId);
  const res = await a.api.get(
    apiUrl(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=5`),
  );
  expect(res.status()).toBe(200);
  const body = await res.json();
  const list = Array.isArray(body) ? body : body.data ?? body._list ?? [];
  expect(list.length).toBeGreaterThan(0);
  return list[0].id;
}

async function createInterpretationDraft(
  a: Actor,
  workspaceId: string,
  projectId: string,
  snapshotId: string,
) {
  return a.api.post(apiUrl(`/api/v1/workspaces/${workspaceId}/decisions`), {
    data: {
      label: `AXI-2273 B2 interpretive-governance fixture ${Date.now()}`,
      type: 'biomarker_threshold',
      projectId,
      context: { intendedUse: 'AXI-2273 E2E fixture' },
      evidenceLinks: [],
      evidenceValues: [
        { metric: 'axi_2273_e2e', value: 1, unit: 'count', sourceSnapshotId: snapshotId },
      ],
    },
  });
}

// A new DecisionDraft is created in `draft` status, which
// `summarizeInterpretationStatuses` buckets as `unclassified` (it is not yet
// `approved`/`reviewed`/`valid`/`deprecated`/`invalidated`/`abandoned`).
function unclassifiedCount(overviewBody: any): number {
  return (
    overviewBody?.tiles?.interpretiveGovernance?.interpretationsByValidityState?.unclassified ?? 0
  );
}

test.describe('AXI-2273 — aggregates I: home, overview, activity feed, search', TAGS, () => {
  test('AC6 — B1: Home summary/events/metrics omit a private project with no grant, until granted', async () => {
    // Arrange
    const projectId = await newPrivateProjectWithDataset();

    // Act / Assert — denied before a grant
    const summaryBefore = await member.api.get(apiUrl('/api/v1/home/summary'));
    expect(summaryBefore.status()).toBe(200);
    const summaryBeforeIds = (await summaryBefore.json()).projects?.map((p: { id: string }) => p.id) ?? [];
    expect(summaryBeforeIds).not.toContain(projectId);

    const metricsBefore = await member.api.get(apiUrl('/api/v1/home/metrics'));
    expect(metricsBefore.status()).toBe(200);

    // Act — grant access
    const grantRes = await access.grant(owner, projectId, member.userId, 'editor');
    expect(grantRes.status()).toBe(201);

    // Assert — now visible
    const summaryAfter = await member.api.get(apiUrl('/api/v1/home/summary'));
    const summaryAfterIds = (await summaryAfter.json()).projects?.map((p: { id: string }) => p.id) ?? [];
    expect(summaryAfterIds).toContain(projectId);
  });

  test('AC6 — B2: Workspace Overview project summary table AND the interpretive-governance tile omit a private project with no grant, until granted', async () => {
    // Arrange — the caller-independent baseline, taken BEFORE the private
    // project/decision exist, so the exclusion assertion below is a real
    // delta rather than an assumption that the workspace starts empty.
    const baseline = await member.api.get(
      apiUrl(`/api/v1/overview/workspaces/${world.workspaceId}?range=7d`),
    );
    expect(baseline.status()).toBe(200);
    const baselineUnclassified = unclassifiedCount(await baseline.json());

    const projectId = await newPrivateProjectWithDataset();

    // AXI-2273 bounce #1 regression fixture: an Interpretation (DecisionDraft)
    // scoped to the private project, citing that project's own baseline
    // snapshot — the exact kind of row
    // `OverviewMetricsService.summarizeInterpretations` groups by state.
    const snapshotId = await defaultBaselineSnapshotId(owner, projectId);
    const draftRes = await createInterpretationDraft(owner, world.workspaceId, projectId, snapshotId);
    expect(draftRes.status()).toBe(201);

    // Act
    const before = await member.api.get(
      apiUrl(`/api/v1/overview/workspaces/${world.workspaceId}?range=7d`),
    );

    // Assert — summaryTable (the previously-verified half)
    expect(before.status()).toBe(200);
    const beforeBody = await before.json();
    const beforeIds = beforeBody.summaryTable?.map((r: { projectId: string }) => r.projectId) ?? [];
    expect(beforeIds).not.toContain(projectId);

    // Assert — the interpretive-governance tile (bounce #1: this was dead —
    // `computeInterpretiveGovernanceTiles`'s `allowedProjectIds` arg was never
    // forwarded by any production caller, so this count leaked the private
    // project's draft before the fix).
    expect(unclassifiedCount(beforeBody)).toBe(baselineUnclassified);

    // Act — grant then retry
    expect((await access.grant(owner, projectId, member.userId, 'editor')).status()).toBe(201);
    const after = await member.api.get(
      apiUrl(`/api/v1/overview/workspaces/${world.workspaceId}?range=7d`),
    );
    const afterBody = await after.json();

    // Assert — both tiles now include the newly-granted project
    const afterIds = afterBody.summaryTable?.map((r: { projectId: string }) => r.projectId) ?? [];
    expect(afterIds).toContain(projectId);
    expect(unclassifiedCount(afterBody)).toBe(baselineUnclassified + 1);
  });

  test('AC6 — B3: a project-scoped Overview read 404s for a non-grantee member, like the by-id guard', async () => {
    // Arrange
    const projectId = await newPrivateProjectWithDataset();

    // Act
    const res = await member.api.get(apiUrl(`/api/v1/overview/projects/${projectId}?range=7d`));

    // Assert
    expect(res.status()).toBe(404);

    // Act — grant then retry
    expect((await access.grant(owner, projectId, member.userId, 'editor')).status()).toBe(201);
    const res2 = await member.api.get(apiUrl(`/api/v1/overview/projects/${projectId}?range=7d`));

    // Assert
    expect(res2.status()).toBe(200);
  });

  test('AC6 — B4: a mention notification on a private project is withheld from a non-grantee, then delivered once granted', async () => {
    // Arrange
    const projectId = await newPrivateProjectWithDataset();
    const analysisId = await defaultAnalysisId(owner, projectId);
    const commentRes = await mentionComment(owner, projectId, analysisId, member.userId);
    expect(commentRes.status()).toBe(201);

    // Act
    const before = await member.api.get(apiUrl('/api/v1/notifications?limit=50'));

    // Assert
    expect(before.status()).toBe(200);
    const beforeBody = await before.json();
    expect(
      (beforeBody.items ?? []).some((n: { body?: string }) =>
        JSON.stringify(n).includes('AXI-2273 mention fixture'),
      ),
    ).toBe(false);

    // Act — grant then author a second mention, retry
    expect((await access.grant(owner, projectId, member.userId, 'editor')).status()).toBe(201);
    const commentRes2 = await mentionComment(owner, projectId, analysisId, member.userId);
    expect(commentRes2.status()).toBe(201);
    const after = await member.api.get(apiUrl('/api/v1/notifications?limit=50'));

    // Assert
    const afterBody = await after.json();
    expect(
      (afterBody.items ?? []).some((n: { body?: string }) =>
        JSON.stringify(n).includes('AXI-2273 mention fixture'),
      ),
    ).toBe(true);
  });

  test('AC6 — B5: the AllProjects search filter excludes a private project with no grant, until granted (regression guard)', async () => {
    // Arrange
    const token = `axi2273search${Date.now()}`;
    const res = await owner.api.post(apiUrl('/api/v1/projects'), {
      data: { name: `E2E ${token}`, workspaceId: world.workspaceId },
    });
    expect(res.status()).toBe(201);
    const { id: projectId } = await res.json();
    expect((await access.visibility(owner, projectId, 'private')).status()).toBe(200);

    // Act / Assert — before grant
    const before = await listedProjectIds(member, `?search=${token}&workspaceId=${world.workspaceId}`);
    expect(before).not.toContain(projectId);

    // Act — grant then retry
    expect((await access.grant(owner, projectId, member.userId, 'editor')).status()).toBe(201);
    const after = await listedProjectIds(member, `?search=${token}&workspaceId=${world.workspaceId}`);

    // Assert
    expect(after).toContain(projectId);
  });
});
