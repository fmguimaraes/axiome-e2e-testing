import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  access,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2271 (epic AXI-2266 — Project Access Enforcement): a grant's effective
 * capability is min(grant level, workspace role) on every project-scoped
 * write route, and a grant's level can be changed (re-grant) with an audit
 * trail. API-level by design — the level selector itself is a thin UI wrapper
 * around the SAME grant endpoint exercised here (AXI-2271 front-end change).
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md
 * § "AXI-2271 — Viewer/editor segregation on write routes + level selector" (A1-A3).
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-013', '@SI-010'] };

let world: PrivateProjectsWorld;
let owner: Actor;
let viewerGrantee: Actor;
let editorGrantee: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await world.actor('owner');
  viewerGrantee = await world.actor('viewer-grantee');
  editorGrantee = await world.actor('editor-grantee');
  await world.addMember(owner, 'editor');
  // Plain members — no `project:manage_access`, no elevated role. Any
  // segregation observed below comes from the GRANT level, not the role.
  await world.addMember(viewerGrantee, 'editor');
  await world.addMember(editorGrantee, 'editor');
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  await world?.dispose();
});

async function newPrivateProject(): Promise<string> {
  const res = await owner.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2271 ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  expect((await access.visibility(owner, id, 'private')).status()).toBe(200);
  return id;
}

test.describe('AXI-2271 — viewer/editor segregation on write routes + level selector', TAGS, () => {
  test('AC1 — A1: a viewer grant denies every write regardless of workspace role', async () => {
    // Arrange
    const projectId = await newPrivateProject();
    expect((await access.grant(owner, projectId, viewerGrantee.userId, 'viewer')).status()).toBe(201);

    // Act
    const read = await viewerGrantee.api.get(apiUrl(`/api/v1/projects/${projectId}`));
    const write = await viewerGrantee.api.patch(apiUrl(`/api/v1/projects/${projectId}`), {
      data: { name: 'viewer attempted rename' },
    });

    // Assert — read admitted, write refused 403 (not 404 — the caller IS seen, just capped)
    expect(read.status()).toBe(200);
    expect(write.status()).toBe(403);
  });

  test('AC2 — A2: an editor grant is bounded only by workspace role, never the grant itself', async () => {
    // Arrange
    const projectId = await newPrivateProject();
    expect((await access.grant(owner, projectId, editorGrantee.userId, 'editor')).status()).toBe(201);

    // Act
    const write = await editorGrantee.api.patch(apiUrl(`/api/v1/projects/${projectId}`), {
      data: { name: 'editor attempted rename' },
    });

    // Assert
    expect(write.status()).toBe(200);
  });

  test('AC3 — A3: re-granting at a new level changes it and is audited (level selector contract)', async () => {
    // Arrange
    const projectId = await newPrivateProject();
    expect((await access.grant(owner, projectId, viewerGrantee.userId, 'viewer')).status()).toBe(201);
    const deniedWhileViewer = await viewerGrantee.api.patch(apiUrl(`/api/v1/projects/${projectId}`), {
      data: { name: 'still viewer' },
    });
    expect(deniedWhileViewer.status()).toBe(403);

    // Act — the level selector re-calls the SAME grant endpoint with a new level
    const regrant = await access.grant(owner, projectId, viewerGrantee.userId, 'editor');
    expect(regrant.status()).toBe(201);
    const admittedAfterChange = await viewerGrantee.api.patch(apiUrl(`/api/v1/projects/${projectId}`), {
      data: { name: 'now editor' },
    });

    // Assert — write now admitted, the stored level reflects the change, and the
    // change is audited (never a silent no-op re-grant)
    expect(admittedAfterChange.status()).toBe(200);
    const state = await (await access.list(owner, projectId)).json();
    const row = state.grants.find((g: { userId: string }) => g.userId === viewerGrantee.userId);
    expect(row?.level).toBe('editor');
    const logs = await (await access.auditLogs(owner, projectId)).json();
    const entries = Array.isArray(logs) ? logs : logs?.data ?? [];
    expect(
      entries.some((e: { action: string; changes?: { userId?: { new?: string } } }) =>
        e.action === 'access_level_changed' && e.changes?.userId?.new === viewerGrantee.userId),
    ).toBe(true);
  });
});
