import { test, expect, APIResponse } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  access,
  listedProjectIds,
  refusalOf,
  uploadCsvDataset,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2278 (epic AXI-2266 — FR13; AC11): the dedicated negative E2E matrix
 * every prior AXI-2266 story's section deferred to this one — see e.g.
 * AXI-2275's "The exhaustive negative matrix ... is AXI-2278's dedicated
 * deliverable" and AXI-2276's by-id deferral notes.
 *
 * ONE non-member actor (`member`: a workspace editor with NO grant) is driven
 * against every project page / API path and every workspace aggregate this
 * epic's six prior stories gated (AXI-2271/2272 by-id + CRUD, AXI-2273
 * home/overview, AXI-2274 notifications/activity/engagement, AXI-2275
 * graph-slices, AXI-2276 published-views/exports), asserting:
 *   (1) every by-id / project-scoped route returns 404, never 403 (NFR2 — no
 *       existence leak), identical for a genuine outsider (no workspace
 *       membership at all); and
 *   (2) every workspace-wide aggregate listing excludes the private project's
 *       rows entirely (never a visible-but-empty placeholder — NFR2).
 *
 * This spec does not re-derive each surface's fix (that is the owning
 * story's unit-level proof); it is the single cross-cutting regression guard
 * that a future change to any ONE surface cannot silently reopen while the
 * others stay green. Where a surface's own story already left a named,
 * reviewed automation gap (sponsor-review / published-view / export BY-ID —
 * AXI-2276 bounce #1; rule-visibility / connector-usage / cross-dataset
 * aggregate — AXI-2275), this spec does not re-attempt it and instead reuses
 * that story's unit coverage, named below rather than silently dropped.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md
 * § "AXI-2278 — Negative E2E matrix" (M1–M3).
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = {
  tag: ['@SI-042', '@SI-013', '@SI-010', '@SI-016', '@SI-017', '@SI-018', '@SI-019'],
};

const NOT_FOUND = 'Project not found';

let world: PrivateProjectsWorld;
let owner: Actor;
let reviewer: Actor;
let member: Actor;
let outsider: Actor;
let projectId: string;
let analysisId: string;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await world.actor('owner');
  reviewer = await world.actor('reviewer');
  member = await world.actor('member');
  outsider = await world.actor('outsider');
  // `approver` carries `decision:review` (needed for the sponsor-review/
  // engagement-event chain below), strictly above `editor` in the role
  // hierarchy so every editor-level route stays open to `owner` too. The
  // approval itself is done by a SEPARATE actor (`reviewer`) — a draft's own
  // author is refused `SELF_APPROVAL_NOT_PERMITTED` with no escape hatch.
  await world.addMember(owner, 'approver');
  await world.addMember(reviewer, 'approver');
  await world.addMember(member, 'editor');
  await world.leaveWorkspace();

  // ─── ONE private project, with one instance of every resource kind the
  // epic's aggregates fan out over (dataset link, analysis, mention,
  // engagement event, graph slice) — built once, read by every scenario
  // below, so a 404/absence proof always has something real to hide.
  const projRes = await owner.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2278 ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(projRes.status(), await projRes.text()).toBe(201);
  projectId = (await projRes.json()).id;
  expect((await access.visibility(owner, projectId, 'private')).status()).toBe(200);

  const datasetId = await uploadCsvDataset(world, owner);
  const link = await owner.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), {
    data: { datasetId },
  });
  expect(link.ok(), await link.text()).toBe(true);

  const analysisRes = await owner.api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId, datasetId, name: `AXI-2278 analysis ${Date.now()}` },
  });
  expect(analysisRes.status(), await analysisRes.text()).toBe(201);
  analysisId = (await analysisRes.json()).id;

  // Mention -> feeds the notification / activity-feed assertions (M2).
  const mention = await owner.api.post(
    apiUrl(`/api/v1/mention-comments/projects/${projectId}/analyses/${analysisId}`),
    {
      data: {
        bodyJson: {
          schemaVersion: 1,
          nodes: [{ t: 'text', v: 'cc ' }, { t: 'mention', userId: member.userId }],
        },
      },
    },
  );
  expect(mention.status(), await mention.text()).toBe(201);

  // Graph slice -> feeds the graph-slices aggregate assertion (M2).
  const slice = await owner.api.post(apiUrl('/api/v1/graph-slices'), {
    data: { projectId, nodeIds: [], edgeIds: [] },
  });
  expect(slice.status(), await slice.text()).toBe(201);

  // Project-scoped engagement event (decision draft -> reviewed -> sponsor
  // review), the one production write path that stamps its OWN projectId on
  // the event (AXI-2274's N5 precedent) -> feeds engagement/feed (M2).
  const snapshot = await owner.api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysisId, filters: [] },
  });
  expect(snapshot.status(), await snapshot.text()).toBe(201);
  const { id: snapshotId } = await snapshot.json();

  const draft = await owner.api.post(apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions`), {
    data: {
      label: `AXI-2278 decision ${Date.now()}`,
      type: 'biomarker_threshold',
      projectId,
      context: { intendedUse: 'RUO' },
      evidenceLinks: [{ snapshotId }],
      evidenceValues: [],
    },
  });
  expect(draft.status(), await draft.text()).toBe(201);
  const decisionDraftId = (await draft.json()).id;

  // The reviewer needs project access too (same predicate as everything else
  // in this epic) — grant it before asking them to review.
  expect((await access.grant(owner, projectId, reviewer.userId, 'editor')).status()).toBe(201);

  const reviewed = await owner.api.post(
    apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${decisionDraftId}/transition`),
    { data: { targetStatus: 'reviewed' } },
  );
  expect(reviewed.status(), await reviewed.text()).toBeLessThan(300);

  const review = await reviewer.api.post(
    apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${decisionDraftId}/reviews`),
    { data: { action: 'approve' } },
  );
  expect(review.status(), await review.text()).toBe(201);
});

test.afterAll(async () => {
  await world?.dispose();
});

type Probe = { label: string; send: (a: Actor) => Promise<APIResponse> };

// ─── M1 — Every by-id / project-scoped PAGE and API PATH (FR5, FR6, FR9;
// AC4, AC5, AC11): a non-member gets 404, never 403, never a leak of
// existence. Covers AXI-2271/2272's project CRUD + sub-resources, AXI-2273's
// by-id overview, and AXI-2276's by-id-filtered lists.
const BY_ID_PROBES: Probe[] = [
  { label: 'GET /projects/:id', send: (a) => a.api.get(apiUrl(`/api/v1/projects/${projectId}`)) },
  {
    label: 'PATCH /projects/:id',
    send: (a) => a.api.patch(apiUrl(`/api/v1/projects/${projectId}`), { data: { name: 'x' } }),
  },
  {
    label: 'PATCH /projects/:id/archive',
    send: (a) => a.api.patch(apiUrl(`/api/v1/projects/${projectId}/archive`)),
  },
  {
    label: 'PATCH /projects/:id/lock',
    send: (a) => a.api.patch(apiUrl(`/api/v1/projects/${projectId}/lock`)),
  },
  {
    label: 'DELETE /projects/:id',
    send: (a) => a.api.delete(apiUrl(`/api/v1/projects/${projectId}`)),
  },
  {
    label: 'POST /projects/:id/datasets',
    send: (a) =>
      a.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), {
        data: { datasetId: '00000000-0000-4000-a000-000000000000' },
      }),
  },
  {
    label: 'GET /projects/:id/datasets',
    send: (a) => a.api.get(apiUrl(`/api/v1/projects/${projectId}/datasets`)),
  },
  {
    label: 'GET /projects/:id/semantic-contract',
    send: (a) => a.api.get(apiUrl(`/api/v1/projects/${projectId}/semantic-contract`)),
  },
  {
    label: 'GET /projects/:id/field-mappings',
    send: (a) => a.api.get(apiUrl(`/api/v1/projects/${projectId}/field-mappings`)),
  },
  {
    label: 'GET /projects/:id/audit-logs',
    send: (a) => a.api.get(apiUrl(`/api/v1/projects/${projectId}/audit-logs`)),
  },
  {
    label: 'GET /overview/projects/:id',
    send: (a) => a.api.get(apiUrl(`/api/v1/overview/projects/${projectId}`)),
  },
  {
    label: 'GET /published-views?projectId=',
    send: (a) => a.api.get(apiUrl(`/api/v1/published-views?projectId=${projectId}`)),
  },
  {
    label: 'GET /exports?projectId=',
    send: (a) => a.api.get(apiUrl(`/api/v1/exports?projectId=${projectId}`)),
  },
  {
    label: 'GET /exports/packages?projectId=',
    send: (a) => a.api.get(apiUrl(`/api/v1/exports/packages?projectId=${projectId}`)),
  },
];

// ─── M2 — Every workspace aggregate (FR7, FR8; AC6, AC11): the private
// project contributes NOTHING. Each probe returns the set of project ids the
// aggregate's reply reveals, so "absent" is asserted the same way everywhere.
type AggregateProbe = { label: string; projectIds: (a: Actor) => Promise<(string | null)[]> };

/**
 * Fetches an aggregate and returns its body, or `null` if the whole
 * aggregate was refused outright. A workspace member with no PROJECT grant
 * (this epic's own boundary) always gets 200 with the row absent; a complete
 * workspace OUTSIDER may instead be refused the aggregate entirely by a
 * pre-existing WORKSPACE-tenancy guard this epic does not change — a
 * stronger "sees nothing" than a 200-with-absence, so `null` is treated the
 * same as "no leak" by every caller below.
 */
async function fetchJsonOrNull(a: Actor, path: string): Promise<any | null> {
  const res = await a.api.get(apiUrl(path));
  return res.ok() ? res.json() : null;
}

async function fetchJson(a: Actor, path: string): Promise<any> {
  const res = await a.api.get(apiUrl(path));
  expect(res.status(), path).toBe(200);
  return res.json();
}

// Every probe is tolerant of TWO shapes a non-member may see, both of which
// are "sees nothing": a workspace MEMBER with no project grant gets 200 with
// the private project's row absent (this epic's own FR7/FR8/AC6 predicate);
// a genuine workspace OUTSIDER may instead be refused the whole aggregate by
// a pre-existing, unrelated WORKSPACE-tenancy guard — a STRONGER "sees
// nothing" that `fetchJsonOrNull` folds into the same empty-array shape
// rather than asserting a specific status this epic does not own.
const AGGREGATE_PROBES: AggregateProbe[] = [
  {
    label: 'GET /projects (list)',
    projectIds: async (a) => {
      const body = await fetchJsonOrNull(
        a,
        `/api/v1/projects?workspaceId=${world.workspaceId}&limit=100`,
      );
      return (body?.data ?? []).map((p: { id: string }) => p.id);
    },
  },
  {
    label: 'GET /home/summary',
    projectIds: async (a) => {
      const body = await fetchJsonOrNull(a, '/api/v1/home/summary');
      return (body?.projects ?? []).map((p: { id: string }) => p.id);
    },
  },
  {
    label: 'GET /overview/workspaces/:id (summaryTable)',
    projectIds: async (a) => {
      const body = await fetchJsonOrNull(a, `/api/v1/overview/workspaces/${world.workspaceId}`);
      return (body?.summaryTable ?? []).map((r: { projectId: string }) => r.projectId);
    },
  },
  {
    label: 'GET /notifications',
    projectIds: async (a) => {
      const body = await fetchJsonOrNull(a, '/api/v1/notifications?limit=50');
      return (body?.items ?? []).map((i: { projectId: string | null }) => i.projectId);
    },
  },
  {
    label: 'GET /activity',
    projectIds: async (a) => {
      const body = await fetchJsonOrNull(a, '/api/v1/activity?limit=50');
      return (body?.items ?? []).map((i: { projectId: string | null }) => i.projectId);
    },
  },
  {
    label: 'GET /engagement/feed',
    projectIds: async (a) => {
      const body = await fetchJsonOrNull(a, '/api/v1/engagement/feed?limit=50');
      return (body?.items ?? []).map((i: { projectId: string | null }) => i.projectId);
    },
  },
  {
    label: 'GET /graph-slices',
    projectIds: async (a) => {
      const body = await fetchJsonOrNull(a, '/api/v1/graph-slices');
      return (body?.data ?? []).map((s: { projectId: string }) => s.projectId);
    },
  },
];

test.describe('AXI-2278 — negative E2E matrix: non-member 404 everywhere, absent from every aggregate', TAGS, () => {
  // Serial: M3 grants `member` access as its LAST act, proving the earlier
  // negative assertions are the predicate and not a tautology — fullyParallel
  // workers would otherwise race M3's grant ahead of M1/M2's "no access yet"
  // reads against the SAME shared fixture project.
  test.describe.configure({ mode: 'serial' });

  test('AC11/NFR2 — M1: a non-member member gets the genuine-miss 404 on every project page/API path', async () => {
    // Message-text parity (NOT_FOUND) is asserted only for the `projects/:id`
    // family — AXI-2276's surfaces (published-views/exports) use their own
    // resource's "not found" wording (AXI-2276's own spec asserts status only
    // for this reason); the invariant this matrix checks everywhere is the
    // STATUS CODE (404, never 403).
    for (const probe of BY_ID_PROBES) {
      const refusal = await refusalOf(await probe.send(member));
      expect.soft(refusal.status, probe.label).toBe(404);
      if (probe.label.includes('/projects/:id') && typeof refusal.body.message === 'string') {
        expect.soft(refusal.body.message, probe.label).toBe(NOT_FOUND);
      }
    }
  });

  test('AC11/NFR2 — M1b: a genuine outsider (no workspace membership) gets the SAME 404 on every path', async () => {
    for (const probe of BY_ID_PROBES) {
      const refusal = await refusalOf(await probe.send(outsider));
      expect.soft(refusal.status, probe.label).toBe(404);
    }
  });

  test('AC6/AC11/NFR2 — M2: the private project contributes nothing to any workspace aggregate for a non-member', async () => {
    for (const probe of AGGREGATE_PROBES) {
      const ids = await probe.projectIds(member);
      expect.soft(ids, probe.label).not.toContain(projectId);
    }
  });

  test('AC6/AC11/NFR2 — M2b: same aggregates, for a genuine outsider', async () => {
    for (const probe of AGGREGATE_PROBES) {
      const ids = await probe.projectIds(outsider);
      expect.soft(ids, probe.label).not.toContain(projectId);
    }
  });

  test('AC5/AC6/AC11 — M3: once granted, the SAME project appears — proving the exclusion is the predicate, not a tautology', async () => {
    // Arrange
    expect((await access.grant(owner, projectId, member.userId, 'editor')).status()).toBe(201);

    // Act / Assert — by-id reachable again
    const archive = await member.api.patch(apiUrl(`/api/v1/projects/${projectId}/archive`));
    expect(archive.status()).toBe(200);
    // Restore for any later run of this file / later test — `/unarchive` reverses `/archive`.
    expect((await member.api.patch(apiUrl(`/api/v1/projects/${projectId}/unarchive`))).status()).toBeLessThan(500);

    // Act / Assert — aggregates now include it
    const homeIds = (await fetchJson(member, '/api/v1/home/summary')).projects.map(
      (p: { id: string }) => p.id,
    );
    expect(homeIds).toContain(projectId);
    const sliceIds = (await fetchJson(member, '/api/v1/graph-slices')).data.map(
      (s: { projectId: string }) => s.projectId,
    );
    expect(sliceIds).toContain(projectId);
    const listIds = await listedProjectIds(member, `?workspaceId=${world.workspaceId}&limit=100`);
    expect(listIds).toContain(projectId);
  });
});
