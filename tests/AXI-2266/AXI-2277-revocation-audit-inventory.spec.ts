import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, access } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2277 (epic AXI-2266 — FR10, FR11, FR12, FR14, FR15; NFR3-NFR7; AC7-AC10, AC12):
 * revocation latency, admin-override audit and the FR14/FR15 inventory. See
 * axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md § AXI-2277 for the
 * full scenario table (C1-C4) and why C3/C4 are `manual`.
 *
 * Only C1 (AC7 — revocation latency) and C2 (AC8 — admin-override audit) have a
 * request/response an API client can assert; C3 (AC9 — denial-log content) asserts
 * server stdout, not an HTTP response, and C4 (AC10/AC12 — the inventory + threat
 * model themselves) is a documentation/structural-proof deliverable — neither has a
 * Playwright-automatable surface, consistent with every other `manual` scenario in
 * this epic's doc.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-011', '@SI-013'] };

let world: PrivateProjectsWorld;
let owner: Actor;
let manager: Actor;
let member: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  const managerRole = await world.workspaceRole('manager-2277', ['project:manage_access']);
  owner = await world.actor('owner');
  manager = await world.actor('manager');
  member = await world.actor('member');
  await world.addMember(owner, 'editor');
  await world.addMember(manager, { roleId: managerRole });
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
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  expect((await access.visibility(owner, id, 'private')).status()).toBe(200);
  return id;
}

test.describe('AXI-2277 — revocation latency, admin-override audit', TAGS, () => {
  test('AC7 — C1: a revoked grant denies on the very next request, no delay', async () => {
    // Arrange
    const projectId = await newPrivateProject('E2E AXI-2277 revoke');
    expect((await access.grant(owner, projectId, member.userId, 'editor')).status()).toBe(201);
    expect((await member.api.get(apiUrl(`/api/v1/projects/${projectId}`))).status()).toBe(200);

    // Act
    const revokeRes = await access.revoke(owner, projectId, member.userId);
    expect(revokeRes.status()).toBe(200);
    const afterRevoke = await member.api.get(apiUrl(`/api/v1/projects/${projectId}`));

    // Assert
    expect(afterRevoke.status()).toBe(404);
    const body = await afterRevoke.json();
    expect(body.message).toBe('Project not found');
  });

  test('AC8 — C2: an admin-override read of a private project is audited distinctly from a grant', async () => {
    // Arrange
    const projectId = await newPrivateProject('E2E AXI-2277 override');

    // Act — manager holds workspace project:manage_access but no personal grant on P
    const overrideRead = await manager.api.get(apiUrl(`/api/v1/projects/${projectId}`));
    expect(overrideRead.status()).toBe(200);
    const auditRes = await access.auditLogs(owner, projectId);
    expect(auditRes.status()).toBe(200);
    const overrideLogs = await auditRes.json();

    // Assert — an admin_override_access row attributed to manager exists
    const overrideEntry = overrideLogs.find(
      (entry: { action: string; performedBy: string }) =>
        entry.action === 'admin_override_access' && entry.performedBy === manager.userId,
    );
    expect(overrideEntry).toBeTruthy();

    // Act 2 — once manager holds a real grant, a subsequent read is not an override
    expect((await access.grant(owner, projectId, manager.userId, 'editor')).status()).toBe(201);
    const grantedRead = await manager.api.get(apiUrl(`/api/v1/projects/${projectId}`));
    expect(grantedRead.status()).toBe(200);
    const auditRes2 = await access.auditLogs(owner, projectId);
    const afterGrantLogs = await auditRes2.json();

    // Assert — exactly one admin_override_access row for manager (from before the grant),
    // not a second one created by the post-grant read.
    const overrideCount = afterGrantLogs.filter(
      (entry: { action: string; performedBy: string }) =>
        entry.action === 'admin_override_access' && entry.performedBy === manager.userId,
    ).length;
    expect(overrideCount).toBe(1);
  });
});
