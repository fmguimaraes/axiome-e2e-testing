import { expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, WorkspaceRoleName } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2429 (epic AXI-2422 — Analysis Template Library, story H — FR38, FR43; AC12, EC10; SI-011,
 * SI-010). Scenario doc: `axiome-docs/manual-e2e/AXI-2422-Analysis-Template-Library.md` § AXI-2429 (H1).
 *
 * `template:write` is the ONE permission a template write is gated on (`TemplateWriteGuard`, a
 * deny-by-default permission check — the role tier is never read). This story ships no template
 * CRUD route (AXI-2430 mounts the guard on it), so the observable HTTP behaviour today is WHO the
 * server resolves the permission for: `GET /api/v1/workspace-permissions/me` answers the SAME set
 * `WorkspacePermissionGuard` enforces with. Admin holds it; Viewer and Editor do not.
 *
 * Self-provisioned: a fresh fixture workspace the platform admin leaves; one throwaway member per
 * role. Needs the AXI-2429 backend (legacy `ROLE_PERMISSIONS` + seed step 16) — against a stack
 * still running main's code the Admin assertion is red by construction.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 120_000 });

let world: PrivateProjectsWorld;
const members: Partial<Record<WorkspaceRoleName, Actor>> = {};

async function myPermissions(actor: Actor): Promise<string[]> {
  const res = await actor.api.get(apiUrl('/api/v1/workspace-permissions/me'));
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.workspaceId).toBe(world.workspaceId);
  return body.permissions;
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  for (const role of ['admin', 'editor', 'viewer'] as const) {
    members[role] = await world.actor(`axi2429-${role}`);
    await world.addMember(members[role]!, role);
  }
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2429 — template:write governance', { tag: ['@SI-011', '@SI-010'] }, () => {
  test('AC12 AXI-2429.H1a a workspace Admin resolves template:write', async () => {
    // Act
    const permissions = await myPermissions(members.admin!);
    // Assert
    expect(permissions).toContain('template:write');
  });

  test('AC12 EC10 AXI-2429.H1b Editor and Viewer do not resolve template:write (deny-by-default)', async () => {
    // Act / Assert
    for (const role of ['editor', 'viewer'] as const) {
      const permissions = await myPermissions(members[role]!);
      expect(permissions, `${role} must not hold template:write`).not.toContain('template:write');
    }
  });
});
