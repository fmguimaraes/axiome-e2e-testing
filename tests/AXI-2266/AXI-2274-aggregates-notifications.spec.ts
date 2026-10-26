import { test, expect } from "@playwright/test";
import { apiUrl } from "../../config/env";
import {
  Actor,
  PrivateProjectsWorld,
  access,
  uploadCsvDataset,
} from "../AXI-2265/private-projects-fixtures";

/**
 * AXI-2274 (epic AXI-2266 — FR8, AC6): a mentioned recipient who is a
 * workspace member but holds no project grant must see NOTHING about a
 * private project in their notification list or activity feed — even though
 * the mention itself is persisted (same architecture as the pre-existing
 * NFR-SEC5 read-time gate). Once granted, the SAME mention becomes visible —
 * proving the exclusion is the project-access predicate, not a tautology.
 *
 * Digest emails (cron path only, N3) are covered by unit tests only (no public
 * HTTP trigger exists for the cron-driven digest path — see
 * `axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md`). Pilot KPI
 * is explicitly deferred (pre-existing workspace-unscoped aggregate, AXI-128/FR10 debt).
 *
 * N5 (added at review bounce #1, 2026-10-26) covers the HTTP-reachable
 * `GET /api/v1/engagement/feed` aggregate — a different surface inside the same
 * `engagement` module from N3's cron digest, and the one the bounce found ungated.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md
 * § "AXI-2274 — Aggregates II: notifications, digest, engagement, pilot KPI" (N1, N2, N5).
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ["@SI-019", "@SI-013"] };

let world: PrivateProjectsWorld;
let owner: Actor;
let member: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await world.actor("owner");
  member = await world.actor("member");
  // `approver` is a strict hierarchy upgrade over `editor` (WorkspaceRoleGuard
  // ROLE_HIERARCHY), so N1/N2's editor-level routes stay available to `owner`;
  // it is also the one seeded role carrying `decision:review` (needed by N5's
  // draft -> reviewed -> sponsor-review flow).
  await world.addMember(owner, "approver");
  await world.addMember(member, "editor");
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  await world?.dispose();
});

async function newPrivateProjectWithAnalysis(): Promise<{
  projectId: string;
  analysisId: string;
}> {
  const res = await owner.api.post(apiUrl("/api/v1/projects"), {
    data: { name: `E2E AXI-2274 ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status()).toBe(201);
  const { id: projectId } = await res.json();
  expect(
    (await access.visibility(owner, projectId, "private")).status(),
  ).toBe(200);

  const datasetId = await uploadCsvDataset(world, owner);
  const link = await owner.api.post(
    apiUrl(`/api/v1/projects/${projectId}/datasets`),
    { data: { datasetId } },
  );
  expect(link.ok(), await link.text()).toBe(true);

  const analysisRes = await owner.api.post(apiUrl("/api/v1/view-analyses"), {
    data: {
      projectId,
      datasetId,
      name: `AXI-2274 analysis ${Date.now()}`,
    },
  });
  expect(analysisRes.status(), await analysisRes.text()).toBe(201);
  const { id: analysisId } = await analysisRes.json();
  return { projectId, analysisId };
}

/** Owner mentions `member` on the analysis — the server-derived fan-out (NFR-SEC2). */
async function mentionMember(projectId: string, analysisId: string): Promise<void> {
  const res = await owner.api.post(
    apiUrl(`/api/v1/mention-comments/projects/${projectId}/analyses/${analysisId}`),
    {
      data: {
        bodyJson: {
          schemaVersion: 1,
          nodes: [
            { t: "text", v: "cc " },
            { t: "mention", userId: member.userId },
          ],
        },
      },
    },
  );
  expect(res.status(), await res.text()).toBe(201);
}

async function notificationProjectIds(a: Actor): Promise<string[]> {
  const res = await a.api.get(apiUrl("/api/v1/notifications?limit=50"));
  expect(res.status()).toBe(200);
  const body = await res.json();
  return (body.items ?? [])
    .map((i: { projectId: string | null }) => i.projectId)
    .filter((id: string | null): id is string => id !== null);
}

async function activityProjectIds(a: Actor): Promise<string[]> {
  const res = await a.api.get(apiUrl("/api/v1/activity?limit=50"));
  expect(res.status()).toBe(200);
  const body = await res.json();
  return (body.items ?? [])
    .map((i: { projectId: string | null }) => i.projectId)
    .filter((id: string | null): id is string => id !== null);
}

async function feedProjectIds(a: Actor, projectId?: string): Promise<string[]> {
  const query = projectId ? `?limit=50&projectId=${projectId}` : "?limit=50";
  const res = await a.api.get(apiUrl(`/api/v1/engagement/feed${query}`));
  expect(res.status()).toBe(200);
  const body = await res.json();
  return (body.items ?? [])
    .map((i: { projectId: string | null }) => i.projectId)
    .filter((id: string | null): id is string => id !== null);
}

/**
 * N5's event source: a `sponsor_review` engagement event is the one real
 * production write path that stamps the event's OWN `projectId` (every other
 * call site — comments, decision-draft lifecycle — emits workspace-scoped
 * events only, `projectId: undefined`). Drives the full chain a sponsor
 * review needs: decision draft (citing the analysis's own snapshot, scoped to
 * `projectId`) -> `reviewed` -> a sponsor review action.
 */
async function createProjectScopedEngagementEvent(
  projectId: string,
  analysisId: string,
): Promise<void> {
  const snapshot = await owner.api.post(apiUrl("/api/v1/view-analyses/snapshots"), {
    data: { viewAnalysisId: analysisId, filters: [] },
  });
  expect(snapshot.status(), await snapshot.text()).toBe(201);
  const { id: snapshotId } = await snapshot.json();

  const draft = await owner.api.post(
    apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions`),
    {
      data: {
        label: `AXI-2274 N5 decision ${Date.now()}`,
        type: "biomarker_threshold",
        projectId,
        context: { intendedUse: "RUO" },
        evidenceLinks: [{ snapshotId }],
        evidenceValues: [],
      },
    },
  );
  expect(draft.status(), await draft.text()).toBe(201);
  const { id: decisionDraftId } = await draft.json();

  const reviewed = await owner.api.post(
    apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${decisionDraftId}/transition`),
    { data: { targetStatus: "reviewed" } },
  );
  expect(reviewed.status(), await reviewed.text()).toBeLessThan(300);

  const review = await owner.api.post(
    apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${decisionDraftId}/reviews`),
    { data: { action: "approve" } },
  );
  expect(review.status(), await review.text()).toBe(201);
}

test.describe(
  "AXI-2274 — notifications & activity feed exclude a private project with no grant",
  TAGS,
  () => {
    test("AC6 — N1: a mention on a private project is hidden from the recipient's notification list until granted", async () => {
      // Arrange
      const { projectId, analysisId } = await newPrivateProjectWithAnalysis();
      await mentionMember(projectId, analysisId);

      // Act / Assert — not yet granted
      expect(await notificationProjectIds(member)).not.toContain(projectId);

      // Act — grant access
      expect(
        (await access.grant(owner, projectId, member.userId)).status(),
      ).toBe(201);

      // Assert — the SAME mention is now visible (proves it's the predicate, not a tautology)
      expect(await notificationProjectIds(member)).toContain(projectId);
    });

    test("AC6 — N2: the same mention is hidden from the activity feed until granted", async () => {
      // Arrange
      const { projectId, analysisId } = await newPrivateProjectWithAnalysis();
      await mentionMember(projectId, analysisId);

      // Act / Assert — not yet granted
      expect(await activityProjectIds(member)).not.toContain(projectId);

      // Act — grant access
      expect(
        (await access.grant(owner, projectId, member.userId)).status(),
      ).toBe(201);

      // Assert
      expect(await activityProjectIds(member)).toContain(projectId);
    });

    test("AC6/NFR1 — N5: GET /engagement/feed excludes a private project's event until granted (bounce #1)", async () => {
      // Arrange
      const { projectId, analysisId } = await newPrivateProjectWithAnalysis();
      await createProjectScopedEngagementEvent(projectId, analysisId);

      // Act / Assert — not yet granted: the event is invisible in the
      // unfiltered feed AND an explicit `?projectId=` query fails closed
      // (empty page, not a 403/500 that would itself confirm the project
      // exists).
      expect(await feedProjectIds(member)).not.toContain(projectId);
      expect(await feedProjectIds(member, projectId)).toEqual([]);

      // Act — grant access
      expect(
        (await access.grant(owner, projectId, member.userId)).status(),
      ).toBe(201);

      // Assert — the SAME event is now visible both unfiltered and via the
      // explicit projectId filter (proves it's the predicate, not a tautology)
      expect(await feedProjectIds(member)).toContain(projectId);
      expect(await feedProjectIds(member, projectId)).toContain(projectId);
    });
  },
);
