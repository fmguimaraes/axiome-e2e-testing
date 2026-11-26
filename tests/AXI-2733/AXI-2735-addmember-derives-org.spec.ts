import { test, expect, APIRequestContext } from '@playwright/test';
import {
  roleContext,
  send,
  attempt,
  whoAmI,
  createOrganization,
  createUserInOrg,
  createWorkspace,
} from '../AXI-1425/collaboration-fixtures';

/**
 * AXI-2735 (epic AXI-2733, area S2) — `POST /workspaces/:id/members` derives the
 * invitee's organization from the user's OWN organization membership (FR9,
 * AC2, BUG-2). Manual-e2e: `axiome-docs/manual-e2e/AXI-2733-Investigator-SAP-Follow-Ups.md`
 * § AXI-2735. Self-contained: the admin provisions fresh organizations, users and
 * a workspace through the public API; no seeded data is mutated. The collaborator
 * group needs a platform admin (see below).
 *
 * Status is asserted as "not 2xx" plus the unchanged member list: domain errors
 * from the organization-service can surface at the gateway as 400 or 500.
 */

let admin: APIRequestContext;
let adminId: string;
let orgOwner: string;
let orgStranger: string;
let orgCollab: string;
let ws: string;
let ownerUser: { id: string; email: string };
let strangerUser: { id: string; email: string };
let collabUser: { id: string; email: string };

const wsHeaders = () => ({ 'X-Workspace-Id': ws });

async function members(): Promise<Array<{ userId: string; organizationId: string }>> {
  const body = await send(admin, 'get', `/api/v1/workspaces/${ws}`, undefined, { headers: wsHeaders() });
  return body.members ?? [];
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  admin = await roleContext('admin');
  adminId = await whoAmI(admin);
  orgOwner = await createOrganization(admin, adminId);
  orgStranger = await createOrganization(admin, adminId);
  orgCollab = await createOrganization(admin, adminId);
  // The other-org users are created BEFORE the owner workspace exists: a
  // non-platform-admin creator's new users inherit every organization the
  // creator reaches (BUG-6/B5, AXI-2734), and creating the workspace makes the
  // creator reach the owner org. Created first, they can never land in it.
  strangerUser = await createUserInOrg(admin, orgStranger);
  collabUser = await createUserInOrg(admin, orgCollab);
  ws = await createWorkspace(admin, orgOwner, adminId);
  ownerUser = await createUserInOrg(admin, orgOwner);
});

test.afterAll(async () => {
  await admin?.dispose();
});

test('AXI-2735 AC2 — a stranger-org user posted under the OWNER organization is refused and not added @SI-013 @SI-010', async () => {
  // Arrange — the BUG-2 repro: the body names the owner org for a user of a non-collaborating org.
  const before = await members();

  // Act
  const res = await attempt(
    admin,
    'post',
    `/api/v1/workspaces/${ws}/members`,
    { userId: strangerUser.id, organizationId: orgOwner, role: 'viewer' },
    wsHeaders(),
  );

  // Assert
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
  const after = await members();
  expect(after.map((m) => m.userId)).not.toContain(strangerUser.id);
  expect(after).toHaveLength(before.length);
});

test('AXI-2735 FR9 — a stranger-org user with no organizationId in the body is refused @SI-013', async () => {
  // Act
  const res = await attempt(
    admin,
    'post',
    `/api/v1/workspaces/${ws}/members`,
    { userId: strangerUser.id, role: 'viewer' },
    wsHeaders(),
  );

  // Assert
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
  expect((await members()).map((m) => m.userId)).not.toContain(strangerUser.id);
});

test('AXI-2735 FR9 — an owner-org user added without organizationId is recorded under the owner org @SI-013 @SI-010', async () => {
  // Act
  await send(admin, 'post', `/api/v1/workspaces/${ws}/members`, { userId: ownerUser.id, role: 'viewer' }, {
    headers: wsHeaders(),
  });

  // Assert
  const row = (await members()).find((m) => m.userId === ownerUser.id);
  expect(row?.organizationId).toBe(orgOwner);
});

/**
 * Collaborator scenarios: accepting a collaboration needs the actor in scope of
 * the ADDRESSEE organization, i.e. a platform admin (`E2E_ADMIN_EMAIL` /
 * `E2E_ADMIN_PASSWORD` of a role-ADMIN account), as in AXI-1428.
 */
test.describe('with an ACTIVE owner-collaborator link', () => {
  test.beforeAll(async () => {
    const link = await send(admin, 'post', `/api/v1/organizations/${orgOwner}/collaborations`, {
      targetOrganizationId: orgCollab,
    });
    await send(admin, 'post', `/api/v1/organizations/${orgCollab}/collaborations/${link.id}/respond`, { accept: true });
  });

  test('AXI-2735 AC2 — a stranger-org user posted under an ACTIVE collaborator organization is refused @SI-013', async () => {
    // Act
    const res = await attempt(
      admin,
      'post',
      `/api/v1/workspaces/${ws}/members`,
      { userId: strangerUser.id, organizationId: orgCollab, role: 'viewer' },
      wsHeaders(),
    );

    // Assert
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect((await members()).map((m) => m.userId)).not.toContain(strangerUser.id);
  });

  test('AXI-2735 FR8 EC6 — a collaborator-org user is admitted and recorded under THEIR organization, never the owner org @SI-013', async () => {
    // Act — the body names the user's real organization (what the invite page sends).
    await send(
      admin,
      'post',
      `/api/v1/workspaces/${ws}/members`,
      { userId: collabUser.id, organizationId: orgCollab, role: 'viewer' },
      { headers: wsHeaders() },
    );

    // Assert
    const row = (await members()).find((m) => m.userId === collabUser.id);
    expect(row?.organizationId).toBe(orgCollab);
  });
});
