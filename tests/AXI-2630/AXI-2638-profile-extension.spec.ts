import { expect, test, type APIResponse } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, type Actor } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2638 (epic AXI-2630 — Investigator On Shared Principles New Path; FR22-FR25, L3) —
 * a caller holding `mapping:confirm_binding` (AXI-1221, FR44 — design note §13 flag F2) can
 * append a project-scoped canonical field to the project's own semantic-profile extension
 * through the data spec, in any project kind (FR22). The field is namespaced
 * `project.<projectId>.<key>` so it can never shadow a platform field (FR24); a
 * shape/namespace/shadow violation is refused with no partial write (FR23), and the field is
 * versioned with author + time (FR25). The right is deliberately NOT held by the Investigator
 * (review round 1 bounce, BLOCKING 2) — FR22's Investigator use is an owner decision still
 * pending, same treatment as L6/L13, and is not settled by widening a permission here.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2630-Profile-Extension.md` § AXI-2638
 * (4.1, 4.2, 4.3, 5.1, 5.2).
 *
 * E2E CONTRACT — every route REAL on the gateway: sign-in, fixture workspace, throwaway
 * WORKSPACE roles holding exactly the rights a scenario needs, a project with its workspace's
 * default semantic profile. No double.
 *
 * NOTE (owner absent, overnight run; updated at review round 1 bounce): authored against the
 * real gateway/org-service contract
 * (`apps/gateway/src/proxy/semantic-profiles.controller.ts#addExtension`,
 * `apps/organization-service/src/semantic-profiles/semantic-profiles.message.controller.ts#addExtension`)
 * — same shape as AXI-2532's API-only pattern. It was **not executed** in this session (round 1
 * or round 2): no stack serves this story's branch (`wt-up.sh` is blocked for a story-developer
 * subagent per standing owner-decision-owed note; the shared demo stack on :3000/:5173 serves
 * `main`, not this branch). Run it the first time against a stack built from this branch
 * (`npx playwright test tests/AXI-2630/AXI-2638-*`) before merge.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let world: PrivateProjectsWorld;
let editor: Actor;
const actors: Record<string, Actor> = {};
const RIGHT_SETS: Record<string, string[]> = {
  reader: ['project:read', 'sap:read'],
  binder: ['project:read', 'sap:read', 'mapping:confirm_binding'],
};

async function newProject(label: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2638 ${label} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (res.json() as Promise<{ id: string }>).then((b) => b.id);
}

async function expectRefusedFor(res: APIResponse, permission: string, what: string): Promise<void> {
  const text = await res.text();
  expect(res.status(), `${what}: ${text}`).toBe(403);
  expect(text, what).toContain(permission);
}

interface SemanticContract { profile: { id: string; configVersion?: string }; canonicalFields: string[] }

async function contractOf(a: Actor, projectId: string): Promise<SemanticContract> {
  const res = await a.api.get(apiUrl(`/api/v1/projects/${projectId}/semantic-contract`));
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  await world.addMember(editor, 'editor');
  for (const [label, permissions] of Object.entries(RIGHT_SETS)) {
    const roleId = await world.workspaceRole(`AXI-2638 ${label}`, permissions);
    actors[label] = await world.actor(label);
    await world.addMember(actors[label], { roleId });
  }
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  for (const a of [editor, ...Object.values(actors)]) await a?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2638 per-project semantic-profile extension @SI-014 @SI-032', () => {
  test('AXI-2638.1 AC19 mapping:confirm_binding appends a namespaced field; it is folded into the project contract @SI-014', async () => {
    // Arrange
    const projectId = await newProject('extend');
    const before = await contractOf(editor, projectId);

    // Act
    const res = await actors.binder.api.post(apiUrl(`/api/v1/semantic-profiles/projects/${projectId}/extensions`), {
      data: { packs: [{ registry_id: `canonical_fields.project.${projectId}.v1`, fields: [`project.${projectId}.custom_titer`] }] },
    });

    // Assert
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.revision).toBe(1);
    expect(body.canonicalFields).toContain(`project.${projectId}.custom_titer`);
    expect(body.configVersion).not.toBe(before.profile.configVersion);

    const after = await contractOf(editor, projectId);
    expect(after.canonicalFields).toContain(`project.${projectId}.custom_titer`);
  });

  test('AXI-2638.2 AC19/FR25 adding a second field never drops the first — the server accumulates, the caller sends only the new field @SI-014', async () => {
    // Arrange
    const projectId = await newProject('revise');
    await actors.binder.api.post(apiUrl(`/api/v1/semantic-profiles/projects/${projectId}/extensions`), {
      data: { packs: [{ registry_id: `canonical_fields.project.${projectId}.v1`, fields: [`project.${projectId}.field_one`] }] },
    });

    // Act — sends ONLY the new field, restating nothing from revision 1 (review round 1 bounce,
    // BLOCKING 1: a client that restated only the new field used to silently drop the first).
    const res = await actors.binder.api.post(apiUrl(`/api/v1/semantic-profiles/projects/${projectId}/extensions`), {
      data: { packs: [{ registry_id: `canonical_fields.project.${projectId}.v2`, fields: [`project.${projectId}.field_two`] }] },
    });

    // Assert
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    expect(body.revision).toBe(2);
    expect(body.canonicalFields).toEqual(expect.arrayContaining([`project.${projectId}.field_one`, `project.${projectId}.field_two`]));

    const after = await contractOf(editor, projectId);
    expect(after.canonicalFields).toEqual(expect.arrayContaining([`project.${projectId}.field_one`, `project.${projectId}.field_two`]));
  });

  test('AXI-2638.3 AC20 an extension naming a platform field is refused; the platform field is unchanged @SI-014', async () => {
    // Arrange
    const projectId = await newProject('shadow');
    const before = await contractOf(editor, projectId);

    // Act — names `arm`, a platform canonical field of the default profile, with no project namespace
    const res = await actors.binder.api.post(apiUrl(`/api/v1/semantic-profiles/projects/${projectId}/extensions`), {
      data: { packs: [{ registry_id: `canonical_fields.project.${projectId}.v1`, fields: ['arm'] }] },
    });

    // Assert
    expect(res.status(), await res.text()).toBe(400);
    const after = await contractOf(editor, projectId);
    expect(after.canonicalFields).toEqual(before.canonicalFields);
  });

  test('AXI-2638.4 AC19 without mapping:confirm_binding the write is refused naming the right; sap:read alone cannot write @SI-014', async () => {
    // Arrange
    const projectId = await newProject('denied');

    // Act
    const res = await actors.reader.api.post(apiUrl(`/api/v1/semantic-profiles/projects/${projectId}/extensions`), {
      data: { packs: [{ registry_id: `canonical_fields.project.${projectId}.v1`, fields: [`project.${projectId}.denied_field`] }] },
    });

    // Assert
    await expectRefusedFor(res, 'mapping:confirm_binding', 'POST extensions with sap:read only');
  });
});
