import { test, expect, APIResponse } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, access } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2276 (epic AXI-2266 — FR9; AC6): the sponsor-review, published-view and
 * export surfaces are keyed by `decisionDraftId` / their own `projectId` /
 * snapshot-and-published-version chains — NONE of them carry a `projects/:id`
 * URL segment, so none of them were covered by the gateway's
 * `ProjectAccessGuard`. This story confines each of them to the SAME
 * `ProjectAccessPredicate` (AXI-2265) via a new `ProjectScopedAccessService`
 * wrapper.
 *
 * This spec exercises the two surfaces whose project-filtered LIST route
 * needs no fixture data beyond a project (`findAll` asserts accessibility
 * BEFORE querying, so the check fires even against zero rows): published
 * views and exports/export-packages. Sponsor-review and single-export/
 * published-view by-id confinement are covered at the unit level
 * (`sponsor-reviews.service.spec.ts`, `published-views.service.spec.ts`,
 * `exports.service.spec.ts`) — see
 * axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md § AXI-2276
 * for the full scenario list and the honest-automation note.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-018', '@SI-016'] };

let world: PrivateProjectsWorld;
let owner: Actor;
let member: Actor;
let outsider: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await world.actor('owner');
  member = await world.actor('member');
  outsider = await world.actor('outsider');
  await world.addMember(owner, 'editor');
  await world.addMember(member, 'editor');
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  await world?.dispose();
});

async function newPrivateProject(): Promise<string> {
  const res = await owner.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2276 ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  expect((await access.visibility(owner, id, 'private')).status()).toBe(200);
  return id;
}

type Probe = { label: string; send: (a: Actor, projectId: string) => Promise<APIResponse> };

const PROJECT_FILTERED_LIST_PROBES: Probe[] = [
  {
    label: 'GET /published-views?projectId=',
    send: (a, id) => a.api.get(apiUrl(`/api/v1/published-views?projectId=${id}`)),
  },
  {
    label: 'GET /exports?projectId=',
    send: (a, id) => a.api.get(apiUrl(`/api/v1/exports?projectId=${id}`)),
  },
  {
    label: 'GET /exports/packages?projectId=',
    send: (a, id) => a.api.get(apiUrl(`/api/v1/exports/packages?projectId=${id}`)),
  },
];

test.describe('AXI-2276 — sponsor-review/published-view/export confinement', TAGS, () => {
  test('AC6 — A6: a non-grantee member is refused every project-filtered list with the genuine-miss 404', async () => {
    // Arrange
    const projectId = await newPrivateProject();

    // Act / Assert
    for (const probe of PROJECT_FILTERED_LIST_PROBES) {
      const res = await probe.send(member, projectId);
      expect.soft(res.status(), probe.label).toBe(404);
    }
  });

  test('AC6 — A6b: an outsider (no workspace membership) gets the same 404 on every list', async () => {
    // Arrange
    const projectId = await newPrivateProject();

    // Act / Assert
    for (const probe of PROJECT_FILTERED_LIST_PROBES) {
      const res = await probe.send(outsider, projectId);
      expect.soft(res.status(), probe.label).toBe(404);
    }
  });

  test('AC6 — A7: a grantee reaches every project-filtered list once granted (even with zero rows)', async () => {
    // Arrange
    const projectId = await newPrivateProject();
    const grantee = await world.actor('grantee-2276');
    await world.addMember(grantee, 'editor');
    expect((await access.grant(owner, projectId, grantee.userId, 'editor')).status()).toBe(201);

    // Act / Assert
    for (const probe of PROJECT_FILTERED_LIST_PROBES) {
      const res = await probe.send(grantee, projectId);
      expect.soft(res.status(), probe.label).toBe(200);
    }
  });
});
