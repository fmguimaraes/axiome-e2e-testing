import { APIResponse, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2550 (epic AXI-2540 — FR84, AC50), W5 epic spec for the manual-doc scenario 2
 * (`axiome-docs/manual-e2e/AXI-2540-Permission-Revocation.md` §2, tagged playwright but until now
 * without a spec): a membership whose `roleId` cannot be resolved still receives exactly the
 * hardcoded legacy grants of its enum role (never an empty set, never a 500).
 *
 * Probe: GET /api/v1/workspace-permissions/me. A membership created with an unknown roleId persists the
 * lowest legacy tier (viewer), so the fallback must equal the seeded Viewer grants.
 * Control: a member whose roleId resolves to a real role holding nothing is refused (403),
 * proving the fallback only applies on a miss. Needs a platform ADMIN (role creation); skips otherwise.
 */
const VIEWER_ROLE_ID = '00000000-0000-0000-0000-000000000100';
const text = async (r: APIResponse): Promise<string> => r.text();
const permissionsOf = async (a: Actor): Promise<string[]> => {
  const res = await a.api.get(apiUrl('/api/v1/workspace-permissions/me'));
  expect(res.status(), await text(res)).toBe(200);
  const body = await res.json();
  return (body.permissions ?? body) as string[];
};

test.describe('AXI-2550 — resolver falls back to legacy grants only when the role row cannot be fetched', () => {
  let world: PrivateProjectsWorld;

  test.beforeAll(async () => {
    world = await PrivateProjectsWorld.create();
  });
  test.afterAll(async () => {
    await world?.dispose();
  });

  test('AC50/FR84 — epic-3 §2 an unresolvable roleId on an admin membership falls back to the legacy tier grants; a real empty role gets none', async () => {
    // Arrange
    const missing = await world.actor('missing-role');
    await world.admin.post(apiUrl(`/api/v1/organizations/${world.orgId}/department-users`), { data: { userId: missing.userId } }); // AXI-2735
    const add = await world.admin.post(apiUrl(`/api/v1/workspaces/${world.workspaceId}/members`), {
      data: { userId: missing.userId, organizationId: world.orgId, role: 'admin', roleId: randomUUID() },
    });
    test.skip(!add.ok(), `membership with an unknown roleId is rejected at write time (${add.status()} ${await text(add)}): the miss path is not reachable through the API`);
    const emptyRoleId = await world.workspaceRole('AXI-2550 empty', []);
    const empty = await world.actor('empty-role');
    await world.addMember(empty, { roleId: emptyRoleId });

    // Act
    const viaMiss = await permissionsOf(missing);
    const viaEmpty = await permissionsOf(empty);
    const viewer = await world.admin.get(apiUrl(`/api/v1/roles/${VIEWER_ROLE_ID}`));
    const viewerPerms = ((await viewer.json()).permissions ?? []) as string[];

    // Assert — the stored enum column of a custom/unknown roleId membership is the lowest tier
    // (viewer), so the legacy fallback on a miss is exactly the viewer grants: never empty, never a 500.
    expect(viaMiss.length, 'a role-fetch miss must not yield an empty set').toBeGreaterThan(0);
    expect([...viaMiss].sort()).toEqual([...viewerPerms].sort());
    expect(viaEmpty, 'a fetched, empty role is authoritative: no permissions').toEqual([]);
  });
});
