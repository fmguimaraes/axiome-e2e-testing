import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, access } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2288 (epic AXI-2266 — FR8/FR14/FR15): graph-slice / decision-draft
 * by-id and write routes used to ask only `TenantScopeService` (workspace
 * membership) — NECESSARY but not SUFFICIENT once a project can be
 * `private`. A workspace member with no grant on the resource's project
 * could still read/update/delete a graph slice, or read/update/transition a
 * decision draft. This story layers the SAME `ProjectAccessPredicate` every
 * other by-id surface in this epic asks (AXI-2272/AXI-2275) onto those
 * routes, plus the `AccessibleProjectIdsService` intersection on the
 * decision-drafts `FIND_ALL` listing.
 *
 * Attacker model throughout: a genuine WORKSPACE MEMBER (editor role) with
 * NO personal grant and no `manage_access` on the private project — never a
 * total stranger (outsider refusal is already covered elsewhere in this
 * epic, e.g. AXI-2272 A4).
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md
 * § "AXI-2288 — Graph-slice / decision-draft by-id gaps" (D1–D5).
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-013', '@SI-016'] };

let world: PrivateProjectsWorld;
let owner: Actor;
let member: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await world.actor('owner');
  member = await world.actor('member');
  await world.addMember(owner, 'editor');
  // A real workspace member — can authenticate, list, and (where its own
  // workspace role allows) write — but is never granted on the private
  // project created below.
  await world.addMember(member, 'editor');
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  await world?.dispose();
});

async function newPrivateProject(name: string): Promise<string> {
  const res = await owner.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = await res.json();
  expect((await access.visibility(owner, id, 'private')).status()).toBe(200);
  return id;
}

async function newGraphSlice(projectId: string): Promise<string> {
  const res = await owner.api.post(apiUrl('/api/v1/graph-slices'), {
    data: { projectId, nodeIds: [], edgeIds: [] },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = await res.json();
  return id;
}

async function newDecisionDraft(projectId: string): Promise<string> {
  const res = await owner.api.post(
    apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions`),
    {
      data: {
        projectId,
        label: `E2E AXI-2288 decision ${Date.now()}`,
        type: 'threshold',
        context: { intendedUse: 'RUO' },
        evidenceLinks: [],
        // No real snapshot is needed for this access-control probe: the
        // Rule Family gate (`assertCitedRulesUsableOrRefuse`) resolves zero
        // cited rule runs for a sourceSnapshotId that names no RuleRun and
        // no-ops, which is exactly the behavior a decision with no rule
        // citation at all already relies on.
        evidenceValues: [
          { metric: 'e2e_probe', value: 1, sourceSnapshotId: crypto.randomUUID() },
        ],
      },
    },
  );
  expect(res.status(), await res.text()).toBe(201);
  const { id } = await res.json();
  return id;
}

test.describe('AXI-2288 — graph-slice by-id routes deny a non-grantee workspace member', TAGS, () => {
  test('D1: FIND_ONE/UPDATE/DELETE all refuse with the same 404 a missing slice would give', async () => {
    // Arrange
    const projectId = await newPrivateProject('E2E AXI-2288 slice');
    const sliceId = await newGraphSlice(projectId);

    // Act / Assert — FIND_ONE
    const readRes = await member.api.get(apiUrl(`/api/v1/graph-slices/${sliceId}`));
    expect(readRes.status()).toBe(404);
    expect((await readRes.json()).message).toBe('Graph slice not found');

    // Act / Assert — UPDATE (write)
    const updateRes = await member.api.patch(apiUrl(`/api/v1/graph-slices/${sliceId}`), {
      data: { label: 'attacker-write' },
    });
    expect(updateRes.status()).toBe(404);
    expect((await updateRes.json()).message).toBe('Graph slice not found');

    // Act / Assert — DELETE (write)
    const deleteRes = await member.api.delete(apiUrl(`/api/v1/graph-slices/${sliceId}`));
    expect(deleteRes.status()).toBe(404);
    expect((await deleteRes.json()).message).toBe('Graph slice not found');

    // The slice is still intact — owner can still read it.
    expect((await owner.api.get(apiUrl(`/api/v1/graph-slices/${sliceId}`))).status()).toBe(200);
  });

  test('D2: a grant on the project restores all three routes for the same member', async () => {
    // Arrange
    const projectId = await newPrivateProject('E2E AXI-2288 slice grant');
    const sliceId = await newGraphSlice(projectId);
    expect((await access.grant(owner, projectId, member.userId, 'editor')).status()).toBe(201);

    // Act / Assert
    expect((await member.api.get(apiUrl(`/api/v1/graph-slices/${sliceId}`))).status()).toBe(200);
    expect(
      (
        await member.api.patch(apiUrl(`/api/v1/graph-slices/${sliceId}`), {
          data: { label: 'grantee-write' },
        })
      ).status(),
    ).toBe(200);
    expect((await member.api.delete(apiUrl(`/api/v1/graph-slices/${sliceId}`))).status()).toBe(204);
  });
});

test.describe('AXI-2288 — decision-draft by-id routes deny a non-grantee workspace member', TAGS, () => {
  test('D3: FIND_ONE/UPDATE/TRANSITION_STATUS all refuse with the same 404 a missing decision would give', async () => {
    // Arrange
    const projectId = await newPrivateProject('E2E AXI-2288 decision');
    const draftId = await newDecisionDraft(projectId);

    // Act / Assert — FIND_ONE
    const readRes = await member.api.get(
      apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${draftId}`),
    );
    expect(readRes.status()).toBe(404);
    expect((await readRes.json()).message).toBe('Decision not found');

    // Act / Assert — UPDATE (write)
    const updateRes = await member.api.patch(
      apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${draftId}`),
      { data: { label: 'attacker-write' } },
    );
    expect(updateRes.status()).toBe(404);
    expect((await updateRes.json()).message).toBe('Decision not found');

    // Act / Assert — TRANSITION_STATUS (write)
    const transitionRes = await member.api.post(
      apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${draftId}/transition`),
      { data: { targetStatus: 'deprecated' } },
    );
    expect(transitionRes.status()).toBe(404);
    expect((await transitionRes.json()).message).toBe('Decision not found');

    // The draft is still intact — owner can still read it.
    expect(
      (
        await owner.api.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${draftId}`))
      ).status(),
    ).toBe(200);
  });

  test('D4: a grant on the project restores all three routes for the same member', async () => {
    // Arrange
    const projectId = await newPrivateProject('E2E AXI-2288 decision grant');
    const draftId = await newDecisionDraft(projectId);
    expect((await access.grant(owner, projectId, member.userId, 'editor')).status()).toBe(201);

    // Act / Assert
    expect(
      (
        await member.api.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${draftId}`))
      ).status(),
    ).toBe(200);
    expect(
      (
        await member.api.patch(apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${draftId}`), {
          data: { label: 'grantee-write' },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await member.api.post(
          apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${draftId}/transition`),
          { data: { targetStatus: 'deprecated' } },
        )
      ).status(),
    ).toBe(200);
  });
});

test.describe('AXI-2288 — decision-drafts FIND_ALL listing excludes an inaccessible project', TAGS, () => {
  test('D5: a decision scoped to a private project the member cannot access is absent from the workspace listing', async () => {
    // Arrange
    const projectId = await newPrivateProject('E2E AXI-2288 listing');
    const draftId = await newDecisionDraft(projectId);

    // Act — list every decision in the shared workspace as the non-grantee member
    const listRes = await member.api.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions`));
    expect(listRes.status()).toBe(200);
    const { data } = await listRes.json();
    const listedIds = (data ?? []).map((d: { id: string }) => d.id);

    // Assert — excluded for the non-grantee...
    expect(listedIds).not.toContain(draftId);

    // ...and present once the owner's own listing is checked (never a false
    // negative from a query that excludes everything).
    const ownerListRes = await owner.api.get(
      apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions`),
    );
    const ownerListed = ((await ownerListRes.json()).data ?? []).map((d: { id: string }) => d.id);
    expect(ownerListed).toContain(draftId);

    // ...and reappears for the SAME member the moment a grant is issued.
    expect((await access.grant(owner, projectId, member.userId, 'editor')).status()).toBe(201);
    const afterGrantRes = await member.api.get(
      apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions`),
    );
    const afterGrantIds = ((await afterGrantRes.json()).data ?? []).map((d: { id: string }) => d.id);
    expect(afterGrantIds).toContain(draftId);
  });
});
