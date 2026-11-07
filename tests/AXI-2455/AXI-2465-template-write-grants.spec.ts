import { expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { catalogApi, Reply, uniqueTemplateId } from '../AXI-2422/harness/catalog-api';

/**
 * AXI-2465 (epic AXI-2455; TPL FR43, AC12, AC27; SI-011, SI-041). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2465.
 *
 * Seed step 16 (`axiome-back/scripts/seed_workspace_roles.sql`) adds `template:write` to the
 * seeded Admin role RECORD (`user_svc.roles` ...0104), bringing it into line with
 * `ROLE_PERMISSIONS[admin]`. It does NOT change who can author templates: the gateway resolver
 * returns `seeded ∪ permissionsForRole(role)`, so an Admin member already passes
 * `TemplateWriteGuard` through the legacy fallback with or without step 16.
 *
 * A1 is therefore the proof of the seed: it reads the seeded role records through
 * `GET /api/v1/roles/:id` (Admin holds `template:write`; Viewer, Sponsor Viewer, Editor, Approver
 * and Investigator do not). A2 is a guard regression check only (Admin 201, Viewer 403) and
 * would pass on a database without step 16. Self-provisioned fixture workspace; any template
 * created is soft-deleted in `finally`.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 120_000 });

const ADMIN_ROLE_ID = '00000000-0000-0000-0000-000000000104';
const NON_ADMIN_ROLE_IDS = {
  Viewer: '00000000-0000-0000-0000-000000000100',
  'Sponsor Viewer': '00000000-0000-0000-0000-000000000101',
  Editor: '00000000-0000-0000-0000-000000000102',
  Approver: '00000000-0000-0000-0000-000000000103',
  Investigator: '00000000-0000-0000-0000-000000000105',
} as const;

test.describe('AXI-2465 — seed step 16 template:write grants', { tag: ['@SI-011', '@SI-041'] }, () => {
  test('AC12 AC27 AXI-2465.A1 the seeded Admin role record holds template:write, no other seeded role does', async () => {
    // Arrange
    const world = await PrivateProjectsWorld.create();
    try {
      // Act
      const admin = await world.admin.get(apiUrl(`/api/v1/roles/${ADMIN_ROLE_ID}`));
      const others = await Promise.all(
        Object.entries(NON_ADMIN_ROLE_IDS).map(async ([label, id]) => ({
          label,
          res: await world.admin.get(apiUrl(`/api/v1/roles/${id}`)),
        })),
      );
      // Assert
      expect(admin.status()).toBe(200);
      const adminBody = await admin.json();
      expect(adminBody.name).toBe('Admin');
      expect(adminBody.permissions, 'seed step 16 not applied: Admin role record lacks template:write').toContain(
        'template:write',
      );
      for (const { label, res } of others) {
        expect(res.status(), `GET role ${label}`).toBe(200);
        const body = await res.json();
        expect(body.permissions, `seeded ${label} role must not hold template:write`).not.toContain('template:write');
      }
    } finally {
      await world.dispose();
    }
  });

  test('AC12 AXI-2465.A2 guard regression check: an Admin member can author a template, a Viewer is refused', async () => {
    // Not proof of the seed: Admin passes TemplateWriteGuard through the legacy role fallback
    // (ROLE_PERMISSIONS[admin]) with or without step 16.
    // Arrange
    const world = await PrivateProjectsWorld.create();
    let created: Reply | undefined;
    let refused: Reply | undefined;
    let admin: Actor | undefined;
    try {
      admin = await world.actor('axi2465-admin');
      const viewer = await world.actor('axi2465-viewer');
      await world.addMember(admin, 'admin');
      await world.addMember(viewer, 'viewer');
      await world.leaveWorkspace();
      // Act
      created = await catalogApi(admin.api).create({
        templateId: uniqueTemplateId('a2'),
        label: 'E2E AXI-2465 a2',
        scope: 'workspace',
      });
      refused = await catalogApi(viewer.api).create({
        templateId: uniqueTemplateId('a2-viewer'),
        label: 'E2E AXI-2465 a2 viewer',
        scope: 'workspace',
      });
      // Assert
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    } finally {
      // Both removed through the workspace Admin (a Viewer cannot delete even a template it wrongly created).
      for (const reply of [created, refused]) {
        if (admin && reply?.status === 201) await catalogApi(admin.api).remove(reply.body.id).catch(() => undefined);
      }
      await world.dispose();
    }
  });
});
