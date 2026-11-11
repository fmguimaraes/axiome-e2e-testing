import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2483 (epic AXI-2455; SI-010 gateway, SI-019 glossary) — SECURITY: the glossary
 * term-update route takes its target from the route params, never from the body.
 *
 * Before this story `PATCH /workspaces/:workspaceId/glossary/terms/:id` took an inline
 * body type (metatype `Object`, so the gateway ValidationPipe skipped it) and built
 * `{ id, workspaceId, ...body, performedBy }`. A body `id` / `workspaceId` overrode the
 * route params after `WorkspaceGuard` had checked membership of the ROUTE workspace, and
 * the organization-service scopes the update on the forwarded `workspaceId`: a member of
 * workspace A could rename any term of workspace B (IDOR). On `main` before the fix
 * AXI-2483.1 fails: the forged PATCH answers 200 and the victim's label changes.
 *
 * Both workspaces are throwaway fixtures; no seeded tenant is touched.
 *
 * Manual-E2E: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md § AXI-2483.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-010', '@SI-019'] };
const SETUP_TIMEOUT_MS = 2 * 60_000;

interface Term {
  id: string;
  label: string;
  version: number;
}

/** The attacker's world: workspace A, with `attacker` as its only non-admin editor. */
let attackerWorld: PrivateProjectsWorld;
let attacker: Actor;
/** The victim's world: workspace B, owning the term under attack. */
let victimWorld: PrivateProjectsWorld;
let victimTerm: Term;
let categoryId: string;

async function ok(res: APIResponse, what: string): Promise<any> {
  expect(res.ok(), `${what} -> ${res.status()}: ${await res.text()}`).toBe(true);
  return res.json();
}

function inVictimWs(path: string): string {
  return apiUrl(`/api/v1/workspaces/${victimWorld.workspaceId}/glossary${path}`);
}

function victimHeaders(): Record<string, string> {
  return { 'X-Workspace-Id': victimWorld.workspaceId };
}

async function readVictimTerm(admin: APIRequestContext): Promise<Term> {
  const res = await admin.get(inVictimWs(`/terms/${victimTerm.id}`), { headers: victimHeaders() });
  return ok(res, 'read victim term');
}

/** A 400 from the whitelist, naming the refused property. */
async function expectRefusedField(res: APIResponse, field: string): Promise<void> {
  const text = await res.text();
  expect(res.status(), text).toBe(400);
  expect(text).toContain(`property ${field} should not exist`);
}

test.describe('AXI-2483 — glossary term update: the route params win over the body', () => {
  // Serial: .2 moves the version that .1 and .3 assert unchanged.
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    test.setTimeout(SETUP_TIMEOUT_MS); // hooks are governed by setTimeout, never describe.configure
    attackerWorld = await PrivateProjectsWorld.create();
    attacker = await attackerWorld.actor('glossary-attacker');
    await attackerWorld.addMember(attacker, 'editor');

    victimWorld = await PrivateProjectsWorld.create();
    const admin = victimWorld.admin;
    const category = await ok(
      await admin.post(inVictimWs('/categories'), {
        data: { name: `AXI-2483 victim category ${randomUUID().slice(0, 8)}` },
        headers: victimHeaders(),
      }),
      'create victim category',
    );
    categoryId = category.id;
    victimTerm = await ok(
      await admin.post(inVictimWs('/terms'), {
        data: {
          categoryId,
          label: 'AXI-2483 victim label',
          columnName: `axi2483_victim_${randomUUID().slice(0, 8)}`,
        },
        headers: victimHeaders(),
      }),
      'create victim term',
    );
  });

  test.afterAll(async () => {
    if (victimTerm && victimWorld) {
      await victimWorld.admin
        .delete(inVictimWs(`/terms/${victimTerm.id}`), { headers: victimHeaders() })
        .catch(() => undefined);
    }
    await attackerWorld?.dispose();
    await victimWorld?.dispose();
  });

  test("AXI-2483.1: a body id/workspaceId naming another workspace's term is refused 400 and that term is unchanged", TAGS, async () => {
    // Arrange — the attacker routes the PATCH through its OWN workspace (passes WorkspaceGuard)
    const before = await readVictimTerm(victimWorld.admin);
    const route = apiUrl(`/api/v1/workspaces/${attackerWorld.workspaceId}/glossary/terms/${randomUUID()}`);
    const forged = `forged-by-attacker-${randomUUID().slice(0, 8)}`;
    const attempts: Array<[Record<string, unknown>, string]> = [
      [{ id: victimTerm.id, workspaceId: victimWorld.workspaceId, label: forged }, 'id'],
      [{ id: victimTerm.id, label: forged }, 'id'],
      [{ workspaceId: victimWorld.workspaceId, label: forged }, 'workspaceId'],
    ];

    // Act + Assert — every forged target is refused by the whitelist
    for (const [data, field] of attempts) {
      await expectRefusedField(await attacker.api.patch(route, { data }), field);
    }

    // Assert — the victim's term was not touched
    const after = await readVictimTerm(victimWorld.admin);
    expect(after.label).toBe(before.label);
    expect(after.version).toBe(before.version);
  });

  test('AXI-2483.2: an honest term update on its own route is unchanged', TAGS, async () => {
    // Arrange
    const before = await readVictimTerm(victimWorld.admin);
    const label = `AXI-2483 honest ${randomUUID().slice(0, 8)}`;

    // Act
    const res = await victimWorld.admin.patch(inVictimWs(`/terms/${victimTerm.id}`), {
      data: { label, description: 'updated by AXI-2483.2', unit: 'mg/L' },
      headers: victimHeaders(),
    });

    // Assert
    const updated = await ok(res, 'honest update');
    expect(updated.label).toBe(label);
    expect(updated.version).toBe(before.version + 1);
  });

  test('AXI-2483.3: a forged performedBy is refused 400 and the term is unchanged', TAGS, async () => {
    // Arrange
    const before = await readVictimTerm(victimWorld.admin);

    // Act
    const res = await victimWorld.admin.patch(inVictimWs(`/terms/${victimTerm.id}`), {
      data: { label: `forged-actor-${randomUUID().slice(0, 8)}`, performedBy: randomUUID() },
      headers: victimHeaders(),
    });

    // Assert
    await expectRefusedField(res, 'performedBy');
    const after = await readVictimTerm(victimWorld.admin);
    expect(after.label).toBe(before.label);
    expect(after.version).toBe(before.version);
  });
});
