import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, access } from './private-projects-fixtures';

/**
 * AXI-2267 (epic AXI-2265 — Private Projects): the visibility & grant model and
 * the access-management API, driven through the gateway. API-level by design —
 * the Access tab is AXI-2269 and the list/findOne/guard enforcement is AXI-2268,
 * so this spec asserts what AXI-2267 owns: default visibility, who may manage,
 * the stored grants, the refusals, and the audit rows.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2265-Private-Projects.md (§4.1–4.6, §5.1–5.3).
 */

const FORBIDDEN = 'Project owner, workspace admin or project:manage_access required';
const NOT_A_MEMBER = "Grant target must be a member of the project's workspace";

test.use({ storageState: { cookies: [], origins: [] } });

let world: PrivateProjectsWorld;
let owner: Actor;
let admin: Actor;
let manager: Actor;
let member: Actor;
let outsider: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  const managerRole = await world.workspaceRole('manager', ['project:manage_access']);
  owner = await world.actor('owner');
  admin = await world.actor('admin');
  manager = await world.actor('manager');
  member = await world.actor('member');
  outsider = await world.actor('outsider');
  await world.addMember(owner, 'editor');
  await world.addMember(admin, 'admin');
  await world.addMember(manager, { roleId: managerRole });
  await world.addMember(member, 'editor');
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  await world?.dispose();
});

async function newProject(): Promise<string> {
  const res = await owner.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2267 ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status()).toBe(201);
  const project = await res.json();
  return project.id;
}

async function auditActions(projectId: string): Promise<Array<Record<string, any>>> {
  const res = await access.auditLogs(owner, projectId);
  expect(res.ok()).toBe(true);
  return res.json();
}

test.describe('AXI-2267 access management', { tag: ['@SI-013', '@SI-010'] }, () => {
  test('AC1 — a new project is public with no grants', async () => {
    const id = await newProject();

    const project = await (await owner.api.get(apiUrl(`/api/v1/projects/${id}`))).json();
    expect(project.visibility).toBe('public');

    const state = await (await access.list(owner, id)).json();
    expect(state).toMatchObject({ projectId: id, visibility: 'public', grantsActive: false, grants: [] });
  });

  test('AC4 — the owner makes the project private and grants a member at editor, audited', async () => {
    const id = await newProject();

    const changed = await access.visibility(owner, id, 'private');
    expect(changed.status()).toBe(200);
    expect(await changed.json()).toMatchObject({ visibility: 'private', grantsActive: true });

    const granted = await access.grant(owner, id, member.userId);
    expect(granted.status()).toBe(201);
    expect(await granted.json()).toMatchObject({
      userId: member.userId,
      level: 'editor',
      grantedBy: owner.userId,
    });

    const logs = await auditActions(id);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'visibility_changed', performedBy: owner.userId }),
        expect.objectContaining({
          action: 'access_granted',
          performedBy: owner.userId,
          changes: expect.objectContaining({ userId: { old: null, new: member.userId } }),
        }),
      ]),
    );
  });

  test('AC4 — only the editor level can be granted in this release', async () => {
    const id = await newProject();

    const res = await access.grant(owner, id, member.userId, 'viewer');

    expect(res.status()).toBe(400);
    expect((await (await access.list(owner, id)).json()).grants).toEqual([]);
  });

  test('AC5 — a grant to a non-member is rejected and confers no membership', async () => {
    const id = await newProject();

    const res = await access.grant(owner, id, outsider.userId);
    expect(res.status()).toBe(400);
    expect(await res.text()).toContain(NOT_A_MEMBER);

    expect((await (await access.list(owner, id)).json()).grants).toEqual([]);
    const stillOutside = await outsider.api.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}`));
    expect(stillOutside.status()).toBe(404);
    const logs = await auditActions(id);
    expect(logs.some((l) => l.action === 'access_granted')).toBe(false);
  });

  test('AC6 — a member without authority is refused: 403 on a public project, 404 on a private one', async () => {
    const id = await newProject();

    for (const res of [
      await access.list(member, id),
      await access.visibility(member, id, 'private'),
      await access.grant(member, id, member.userId),
      await access.revoke(member, id, member.userId),
    ]) {
      expect(res.status()).toBe(403);
      expect(await res.text()).toContain(FORBIDDEN);
    }
    expect((await (await access.list(owner, id)).json()).visibility).toBe('public');

    await access.visibility(owner, id, 'private');
    const hidden = await access.list(member, id);
    expect(hidden.status()).toBe(404);
    expect(await hidden.text()).toContain('Project not found');
  });

  test(
    'AC6 — a project:manage_access holder can manage access',
    { tag: ['@SI-011', '@SI-001'] },
    async () => {
      const id = await newProject();

      expect((await access.list(manager, id)).status()).toBe(200);
      expect((await access.grant(manager, id, member.userId)).status()).toBe(201);
      expect((await access.revoke(manager, id, member.userId)).status()).toBe(204);
    },
  );

  test('AC7 — revoking a grant is audited and leaves workspace membership intact', async () => {
    const id = await newProject();
    await access.visibility(owner, id, 'private');
    await access.grant(owner, id, member.userId);

    const res = await access.revoke(owner, id, member.userId);
    expect(res.status()).toBe(204);

    expect((await (await access.list(owner, id)).json()).grants).toEqual([]);
    const logs = await auditActions(id);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'access_revoked',
          performedBy: owner.userId,
          changes: expect.objectContaining({ userId: { old: member.userId, new: null } }),
        }),
      ]),
    );
    const stillMember = await member.api.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}`));
    expect(stillMember.status()).toBe(200);
  });

  test('AC8 — with every grant revoked, the owner and a workspace admin still manage the project', async () => {
    const id = await newProject();
    await access.visibility(owner, id, 'private');
    await access.grant(owner, id, member.userId);
    await access.revoke(owner, id, member.userId);

    expect((await access.list(owner, id)).status()).toBe(200);
    expect((await owner.api.get(apiUrl(`/api/v1/projects/${id}`))).status()).toBe(200);
    expect((await access.list(admin, id)).status()).toBe(200);
    expect((await admin.api.get(apiUrl(`/api/v1/projects/${id}`))).status()).toBe(200);
    expect((await access.grant(admin, id, member.userId)).status()).toBe(201);
    expect((await access.revoke(admin, id, member.userId)).status()).toBe(204);
  });

  test('AC9 — private to public keeps the grants stored but dormant, and back re-activates them', async () => {
    const id = await newProject();
    await access.visibility(owner, id, 'private');
    const grant = await (await access.grant(owner, id, member.userId)).json();

    const toPublic = await (await access.visibility(owner, id, 'public')).json();
    expect(toPublic).toMatchObject({ visibility: 'public', grantsActive: false });
    expect(toPublic.grants.map((g: { id: string }) => g.id)).toEqual([grant.id]);

    const back = await (await access.visibility(owner, id, 'private')).json();
    expect(back).toMatchObject({ visibility: 'private', grantsActive: true });
    expect(back.grants.map((g: { id: string }) => g.id)).toEqual([grant.id]);
  });
});
