import { test, expect } from "@playwright/test";
import { apiUrl } from "../../config/env";
import {
  Actor,
  PrivateProjectsWorld,
  access,
} from "../AXI-2265/private-projects-fixtures";

/**
 * AXI-2275 (epic AXI-2266 — FR8, AC6; SI-016 Provenance graph & knowledge
 * graph): a workspace-wide aggregate (here, the graph-slices listing) must
 * intersect its project-spanning query with the caller's accessible-project
 * set — the SAME `ProjectAccessPredicate` interpretation AXI-2268 already
 * applies to the project list/picker/findOne, reused via
 * `AccessibleProjectIdsService` rather than re-derived.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md
 * § "AXI-2275 — Graph, provenance, cross-dataset, rule surfaces" (A1–A3).
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ["@SI-016", "@SI-017"] };

let world: PrivateProjectsWorld;
let owner: Actor;
let member: Actor;
let grantee: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await world.actor("owner");
  member = await world.actor("member");
  grantee = await world.actor("grantee");
  await world.addMember(owner, "editor");
  await world.addMember(member, "editor");
  await world.addMember(grantee, "editor");
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  await world?.dispose();
});

async function newPrivateProjectWithSlice(): Promise<{
  projectId: string;
  sliceId: string;
}> {
  const project = await owner.api.post(apiUrl("/api/v1/projects"), {
    data: {
      name: `E2E AXI-2275 ${Date.now()}`,
      workspaceId: world.workspaceId,
    },
  });
  expect(project.status()).toBe(201);
  const { id: projectId } = await project.json();
  expect(
    (await access.visibility(owner, projectId, "private")).status(),
  ).toBe(200);

  const slice = await owner.api.post(apiUrl("/api/v1/graph-slices"), {
    data: { projectId, nodeIds: [], edgeIds: [] },
  });
  expect(slice.status(), await slice.text()).toBe(201);
  const { id: sliceId } = await slice.json();
  return { projectId, sliceId };
}

async function listedSliceIds(actor: Actor, query = ""): Promise<string[]> {
  const res = await actor.api.get(apiUrl(`/api/v1/graph-slices${query}`));
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return (body?.data ?? []).map((s: { id: string }) => s.id);
}

test.describe("AXI-2275 — graph slices intersect the accessible-project set", TAGS, () => {
  test("AC6 — A1: a graph slice in a private project is excluded from a non-grantee's listing", async () => {
    // Arrange
    const { sliceId } = await newPrivateProjectWithSlice();

    // Act / Assert — non-grantee member sees nothing
    expect(await listedSliceIds(member)).not.toContain(sliceId);

    // Owner still sees it
    expect(await listedSliceIds(owner)).toContain(sliceId);
  });

  test("AC6 — A2: a grant restores the slice to the listing; revocation withdraws it again", async () => {
    // Arrange
    const { projectId, sliceId } = await newPrivateProjectWithSlice();
    expect(
      (await access.grant(owner, projectId, grantee.userId)).status(),
    ).toBe(201);

    // Act / Assert — grantee now sees it
    expect(await listedSliceIds(grantee)).toContain(sliceId);

    // Revoke
    expect(
      (await access.revoke(owner, projectId, grantee.userId)).status(),
    ).toBe(204);

    // Assert — excluded again, on the very next request
    expect(await listedSliceIds(grantee)).not.toContain(sliceId);
  });

  test("AC6 — A3: filtering by a private projectId a member cannot access returns an empty page, not a leak", async () => {
    // Arrange
    const { projectId } = await newPrivateProjectWithSlice();

    // Act
    const res = await member.api.get(
      apiUrl(`/api/v1/graph-slices?projectId=${projectId}`),
    );

    // Assert
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});
