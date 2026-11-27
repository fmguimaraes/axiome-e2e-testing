import { APIRequestContext, expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2561 (epic AXI-2540 — advisory A1 on the AXI-2555 review, 2026-11-15):
 * `suggestedQuestionsInPlanEnabled()` was a hardcoded `return true` — turning the
 * Plan tab's "Suggested from your data" section off needed a code change and a
 * redeploy. This story makes it a per-workspace runtime setting stored on the SAME
 * `WorkspacePolicy` row `allowCrossOrgReuse`/`sponsorModeEnabled` already use, read
 * through a NEW, narrow, investigator-reachable endpoint
 * (`GET .../opening-templates/plan-suggestions-enabled`) because the existing admin
 * policy route is `InvestigatorDenyGuard`'d and the Plan tab renders for Investigators
 * too. Default stays `true` — no behaviour change today.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2540-Plan-Suggestions-Kill-Switch.md`.
 * API-level only, like the sibling AXI-2539/AXI-2550 specs this extends — the Plan
 * tab's own hide/show reaction to the flag is unit-tested
 * (`ProjectSapSuggestedQuestions.test.tsx` UT-FE-ADMIN-8554;
 * `suggestedInPlanFlag.test.ts` UT-FE-ADMIN-2561-001..004).
 *
 * Self-provisioned (the PrivateProjectsWorld/AXI-2267 precedent): fresh throwaway
 * workspaces per run, no dataset/project fixture needed — the endpoints touch only
 * `WorkspacePolicy`.
 */

const READ_PATH = '/api/v1/guided-analysis/opening-templates/plan-suggestions-enabled';

// sap:suggested_questions is seeded on NO role (AXI-2539 owner ruling) and a platform admin gets no
// workspace-role shortcut, so the read is made by a member of a throwaway role holding exactly it.
const readers = new Map<string, Actor>();
const worlds: PrivateProjectsWorld[] = [];

async function createWorkspace(_admin: APIRequestContext, _orgId: string, label: string): Promise<string> {
  const world = await PrivateProjectsWorld.create();
  worlds.push(world);
  const roleId = await world.workspaceRole(`AXI-2561 ${label}`, ['sap:suggested_questions', 'guided_analysis:view']);
  const reader = await world.actor(`reader-${label}`);
  await world.addMember(reader, { roleId });
  readers.set(world.workspaceId, reader);
  return world.workspaceId;
}

async function readEnabled(_admin: APIRequestContext, workspaceId: string): Promise<boolean> {
  const res = await readers.get(workspaceId)!.api.get(apiUrl(READ_PATH), { headers: { 'X-Workspace-Id': workspaceId } });
  expect(res.ok(), `read plan-suggestions-enabled: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

async function patchPolicy(admin: APIRequestContext, workspaceId: string, enabled: boolean): Promise<void> {
  const res = await admin.patch(apiUrl(`/api/v1/workspaces/${workspaceId}/policies`), {
    data: { suggestedQuestionsInPlanEnabled: enabled },
  });
  expect(res.ok(), `patch policy: ${res.status()} ${await res.text()}`).toBe(true);
  const body = await res.json();
  expect(body.suggestedQuestionsInPlanEnabled).toBe(enabled);
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let admin: APIRequestContext;
let orgId: string;
let workspaceId: string;
let siblingWorkspaceId: string;

test.beforeAll(async () => {
  admin = await adminApiContext();
  const orgs = await (await admin.get(apiUrl('/api/v1/organizations'))).json();
  orgId = orgs?.data?.[0]?.id;
  workspaceId = await createWorkspace(admin, orgId, 'primary');
  siblingWorkspaceId = await createWorkspace(admin, orgId, 'sibling');
});

test.afterAll(async () => {
  for (const w of worlds) await w.dispose();
  await admin?.dispose();
});

test.describe('AXI-2561 — per-workspace plan-suggestions runtime kill switch @SI-013 @SI-010 @SI-066 @SI-031', () => {
  test('AC25611 — AXI-2561.1 a never-configured workspace reads enabled by default', async () => {
    expect(await readEnabled(admin, workspaceId)).toBe(true);
  });

  test('AC25612 — AXI-2561.2 flipping the admin policy off is read back on the plan-suggestions endpoint', async () => {
    await patchPolicy(admin, workspaceId, false);
    expect(await readEnabled(admin, workspaceId)).toBe(false);

    const policy = await (
      await admin.get(apiUrl(`/api/v1/workspaces/${workspaceId}/policies`))
    ).json();
    expect(policy.suggestedQuestionsInPlanEnabled).toBe(false);
  });

  test('AC25613 — AXI-2561.3 flipping it back on restores the default read', async () => {
    await patchPolicy(admin, workspaceId, true);
    expect(await readEnabled(admin, workspaceId)).toBe(true);
  });

  test('AC25612 — AXI-2561.4 a sibling workspace never sees the first workspace\'s flag value (tenancy)', async () => {
    await patchPolicy(admin, workspaceId, false);
    expect(await readEnabled(admin, siblingWorkspaceId)).toBe(true);
    await patchPolicy(admin, workspaceId, true);
  });
});
