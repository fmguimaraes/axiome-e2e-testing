import { test, expect, APIRequestContext } from '@playwright/test';
import {
  roleContext,
  send,
  attempt,
  whoAmI,
  createOrganization,
  createUserInOrg,
  createWorkspace,
  inviteCandidates,
} from './collaboration-fixtures';

/**
 * AXI-1428 — cross-org invite candidate inheritance + add-member guard
 * (manual-e2e §4.3, §4.4, §5.4). A workspace owned by Org A can invite Org B's
 * users only while an ACTIVE A↔B collaboration exists; the add endpoint itself
 * enforces it (not just the candidate list). Self-contained via the platform
 * admin, which bypasses org scope + the permission.
 */

let admin: APIRequestContext;
let adminId: string;
let orgA: string;
let orgB: string;
let wsA: string;
let userB: { id: string; email: string };
let collabId: string;

async function activateCollaboration(): Promise<string> {
  const link = await send(admin, 'post', `/api/v1/organizations/${orgA}/collaborations`, { targetOrganizationId: orgB });
  await send(admin, 'post', `/api/v1/organizations/${orgB}/collaborations/${link.id}/respond`, { accept: true });
  return link.id;
}

test.beforeAll(async () => {
  admin = await roleContext('admin');
  adminId = await whoAmI(admin);
  orgA = await createOrganization(admin, adminId);
  orgB = await createOrganization(admin, adminId);
  wsA = await createWorkspace(admin, orgA, adminId);
  userB = await createUserInOrg(admin, orgB);
});

test.afterAll(async () => {
  await admin?.dispose();
});

test('NFR2 — with no collaboration, Org B users are NOT invite candidates for an Org A workspace', async () => {
  const candidates = await inviteCandidates(admin, wsA);
  expect(candidates.map((u: any) => u.id)).not.toContain(userB.id);
});

test('NFR2 — with no collaboration, adding an Org B user does not add them', async () => {
  await attempt(
    admin,
    'post',
    `/api/v1/workspaces/${wsA}/members`,
    { userId: userB.id, organizationId: orgB, role: 'viewer' },
    { 'X-Workspace-Id': wsA },
  );
  const ws = await send(admin, 'get', `/api/v1/workspaces/${wsA}`, undefined, { headers: { 'X-Workspace-Id': wsA } });
  expect(ws.members.map((m: any) => m.userId)).not.toContain(userB.id);
});

test('FR5 FR7 — once active, an Org B user appears as a candidate and can be added', async () => {
  collabId = await activateCollaboration();

  const candidates = await inviteCandidates(admin, wsA);
  expect(candidates.map((u: any) => u.id)).toContain(userB.id);

  const updated = await send(
    admin,
    'post',
    `/api/v1/workspaces/${wsA}/members`,
    { userId: userB.id, organizationId: orgB, role: 'viewer' },
    { headers: { 'X-Workspace-Id': wsA } },
  );
  expect(updated.members.map((m: any) => m.userId)).toContain(userB.id);
});

test('FR4 — revoking removes future candidacy but keeps existing members', async () => {
  await send(admin, 'delete', `/api/v1/organizations/${orgA}/collaborations/${collabId}`);

  // A second, not-yet-member Org B user is no longer a candidate…
  const userB2 = await createUserInOrg(admin, orgB);
  const candidates = await inviteCandidates(admin, wsA);
  expect(candidates.map((u: any) => u.id)).not.toContain(userB2.id);

  // …but the already-added member remains a member of the workspace.
  const ws = await send(admin, 'get', `/api/v1/workspaces/${wsA}`, undefined, { headers: { 'X-Workspace-Id': wsA } });
  expect(ws.members.map((m: any) => m.userId)).toContain(userB.id);
});
