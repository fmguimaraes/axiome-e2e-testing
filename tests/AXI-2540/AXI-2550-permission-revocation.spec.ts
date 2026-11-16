import { APIResponse, expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2550 (epic AXI-2540 — FR84, AC50) — the permission resolver's
 * fallback-merge bug: before this story, the gateway UNIONED the hardcoded
 * legacy `ROLE_PERMISSIONS` fallback onto a role's REAL, successfully fetched
 * permission set, so unticking a right in the role editor had no effect — the
 * fallback kept re-granting it. The fix makes a fetched set (even empty)
 * authoritative, and invalidates the 60s resolver cache on role save so the
 * revocation is visible immediately, never after a stale-cache wait.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2540-Permission-Revocation.md` §1, §2.
 *
 * Probe route: `GET /api/v1/mapping/governance/metrics/summary`, gated on
 * EXACTLY `dictionary_growth:view` — a workspace-scoped read with no extra
 * dataset/project fixture required, which keeps this self-provisioned and
 * fast. A throwaway custom WORKSPACE role is created with exactly that
 * permission, assigned to a throwaway member, then edited to remove it.
 *
 * Self-provisioned (the PrivateProjectsWorld precedent, AXI-2267/AXI-2322):
 * a fresh fixture workspace, one throwaway custom role, one throwaway
 * self-registered member. No seeded or demo account is touched.
 */

const PERMISSION = 'dictionary_growth:view';

async function messageOf(res: APIResponse): Promise<string> {
  const text = await res.text();
  try {
    const body = JSON.parse(text);
    return Array.isArray(body?.message) ? body.message.join(' ') : String(body?.message ?? '');
  } catch {
    return text;
  }
}

async function getSummary(actor: Actor): Promise<APIResponse> {
  return actor.api.get(apiUrl('/api/v1/mapping/governance/metrics/summary'));
}

test.describe('AXI-2550 — permission resolver fallback + cache invalidation', () => {
  let world: PrivateProjectsWorld;
  let roleId: string;
  let member: Actor;

  test.beforeAll(async () => {
    world = await PrivateProjectsWorld.create();
    roleId = await world.workspaceRole('AXI-2550', [PERMISSION]);
    member = await world.actor('member');
    await world.addMember(member, { roleId });
  });

  test.afterAll(async () => {
    await world.dispose();
  });

  test('AC50/FR84 — a granted permission works, then unticking it in the role editor takes effect on the very next request (no 60s stale window)', async () => {
    // Sanity: the role genuinely holds the permission today.
    const granted = await getSummary(member);
    expect(granted.ok(), `expected 200 while granted: ${granted.status()} ${await messageOf(granted)}`).toBe(true);

    // Act — the "role editor save": PATCH the role with the permission removed.
    const patch = await world.admin.patch(apiUrl(`/api/v1/roles/${roleId}`), {
      data: { permissions: [] },
    });
    expect(patch.ok(), `role update failed: ${patch.status()} ${await messageOf(patch)}`).toBe(true);

    // Assert — refused immediately. Before AXI-2550 this request would still
    // succeed: the hardcoded fallback for a custom role with no matching
    // legacy enum resolves to nothing either way, so the regression this
    // asserts is specifically the CACHE: a stale 60s-old grant must not
    // survive a save. Retried briefly to absorb ordinary request latency,
    // never to wait out a cache TTL.
    await expect(async () => {
      const revoked = await getSummary(member);
      expect(revoked.status(), await messageOf(revoked)).toBe(403);
    }).toPass({ timeout: 5_000 });
  });

  test('AC50/FR84 — a role that still holds the permission keeps working (no over-revocation)', async () => {
    const stillGrantedRoleId = await world.workspaceRole('AXI-2550-control', [PERMISSION]);
    const controlMember = await world.actor('control-member');
    await world.addMember(controlMember, { roleId: stillGrantedRoleId });

    const res = await getSummary(controlMember);
    expect(res.ok(), `expected 200: ${res.status()} ${await messageOf(res)}`).toBe(true);
  });
});
