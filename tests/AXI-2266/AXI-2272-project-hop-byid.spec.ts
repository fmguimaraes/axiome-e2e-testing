import { test, expect, APIResponse } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  access,
  listedProjectIds,
  refusalOf,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2272 (epic AXI-2266 — FR5, FR6; NFR1, NFR2; AC4, AC5): the by-id
 * MUTATION / sub-resource handlers on `ProjectsMessageController` now ask the
 * SAME `ProjectAccessPredicate` `findOne`/`findAll` already ask, not tenancy
 * alone — closing the gap where the ownership-check layer inside
 * organization-service only checked workspace membership, and the full
 * visibility+grants predicate was enforced ONLY by the gateway's
 * `ProjectAccessGuard` at the edge.
 *
 * These scenarios drive the full stack through the gateway (as every
 * Playwright spec does), so they are a regression guard over the end-to-end
 * behaviour (still correctly denies/allows) rather than a reproduction of the
 * fixed defect itself — the gap this story closes is only observable from
 * INSIDE organization-service (a caller that reaches the RPC without the
 * gateway in front of it), which is covered at the unit level
 * (`projects.message.controller.spec.ts`, `UT-ORG-2272-01..07`). See
 * axiome-docs/manual-e2e/AXI-2266-Project-Access-Enforcement.md § AXI-2272.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const NOT_FOUND = 'Project not found';
const TAGS = { tag: ['@SI-013', '@SI-010'] };

let world: PrivateProjectsWorld;
let owner: Actor;
let admin: Actor;
let manager: Actor;
let member: Actor;
let outsider: Actor;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  const managerRole = await world.workspaceRole('manager-2272', [
    'project:manage_access',
  ]);
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

async function newPrivateProject(): Promise<string> {
  const res = await owner.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2272 ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  expect((await access.visibility(owner, id, 'private')).status()).toBe(200);
  return id;
}

type Probe = { label: string; send: (a: Actor, id: string) => Promise<APIResponse> };

const MUTATION_PROBES: Probe[] = [
  {
    label: 'PATCH /projects/:id',
    send: (a, id) => a.api.patch(apiUrl(`/api/v1/projects/${id}`), { data: { name: 'x' } }),
  },
  {
    label: 'PATCH /projects/:id/archive',
    send: (a, id) => a.api.patch(apiUrl(`/api/v1/projects/${id}/archive`)),
  },
  {
    label: 'PATCH /projects/:id/lock',
    send: (a, id) => a.api.patch(apiUrl(`/api/v1/projects/${id}/lock`)),
  },
  {
    label: 'GET /projects/:id/datasets',
    send: (a, id) => a.api.get(apiUrl(`/api/v1/projects/${id}/datasets`)),
  },
  {
    label: 'GET /projects/:id/semantic-contract',
    send: (a, id) => a.api.get(apiUrl(`/api/v1/projects/${id}/semantic-contract`)),
  },
  {
    label: 'GET /projects/:id/audit-logs',
    send: (a, id) => a.api.get(apiUrl(`/api/v1/projects/${id}/audit-logs`)),
  },
];

test.describe('AXI-2272 — project hop in the by-id ownership check', TAGS, () => {
  test('AC4 — A4: a non-grantee member is refused every mutation/sub-resource route with the genuine-miss 404', async () => {
    // Arrange
    const projectId = await newPrivateProject();

    // Act / Assert
    for (const probe of MUTATION_PROBES) {
      const refusal = await refusalOf(await probe.send(member, projectId));
      expect.soft(refusal.status, probe.label).toBe(404);
      expect.soft(refusal.body.message, probe.label).toBe(NOT_FOUND);
    }
  });

  test('AC4 — A4b: an outsider (no workspace membership) gets the same 404 on every route', async () => {
    // Arrange
    const projectId = await newPrivateProject();

    // Act / Assert
    for (const probe of MUTATION_PROBES) {
      const refusal = await refusalOf(await probe.send(outsider, projectId));
      expect.soft(refusal.status, probe.label).toBe(404);
      expect.soft(refusal.body.message, probe.label).toBe(NOT_FOUND);
    }
  });

  test('AC5 — A5: a grantee reaches the same mutation/sub-resource routes once granted', async () => {
    // Arrange
    const projectId = await newPrivateProject();
    const grantee = await world.actor('grantee-2272');
    await world.addMember(grantee, 'editor');
    expect((await access.grant(owner, projectId, grantee.userId, 'editor')).status()).toBe(201);

    // Act
    const archiveRes = await grantee.api.patch(apiUrl(`/api/v1/projects/${projectId}/archive`));
    const contractRes = await grantee.api.get(
      apiUrl(`/api/v1/projects/${projectId}/semantic-contract`),
    );

    // Assert
    expect(archiveRes.status()).toBe(200);
    expect(contractRes.status()).toBe(200);
  });

  test('AC5 — A5b: a project:manage_access holder (no personal grant) reaches the audit-log route', async () => {
    // Arrange
    const projectId = await newPrivateProject();

    // Act
    const res = await manager.api.get(apiUrl(`/api/v1/projects/${projectId}/audit-logs`));

    // Assert
    expect(res.status()).toBe(200);
  });

  test('AC5 — A5c: a workspace admin with no grant reaches the mutation routes', async () => {
    // Arrange
    const projectId = await newPrivateProject();

    // Act
    const res = await admin.api.patch(apiUrl(`/api/v1/projects/${projectId}/lock`));

    // Assert
    expect(res.status()).toBe(200);
    // Restore: unlock so later probes in this file see an active project.
    expect((await admin.api.patch(apiUrl(`/api/v1/projects/${projectId}/unlock`))).status()).toBe(
      200,
    );
  });

  test('sanity: the private project is still invisible from the member\'s own project list', async () => {
    // Arrange
    const projectId = await newPrivateProject();

    // Act
    const ids = await listedProjectIds(member, `?workspaceId=${world.workspaceId}&limit=100`);

    // Assert
    expect(ids).not.toContain(projectId);
  });
});
