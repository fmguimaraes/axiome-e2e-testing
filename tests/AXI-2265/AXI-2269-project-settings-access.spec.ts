import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access } from './private-projects-fixtures';
import { UiActor, signInAs, uiActor } from './AXI-2269-helpers';

/**
 * AXI-2269 (epic AXI-2265 — Private Projects): Project Settings -> Access tab.
 * AC11 (FR17): an authorized user adds a member through a picker that lists only
 * workspace members, and the grant is created. Scenario doc:
 * manual-e2e/AXI-2265-Private-Projects.md ("AXI-2269" section).
 *
 * AUTHORED, NOT RUN (no stack available when written) — run before W5.
 */

test.use({ storageState: { cookies: [], origins: [] } });

let world: PrivateProjectsWorld;
let owner: UiActor;
let member: UiActor;
let plain: UiActor;
let outsider: UiActor;
let projectId: string;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await uiActor('owner', world.workspaceId);
  member = await uiActor('member', world.workspaceId);
  plain = await uiActor('plain', world.workspaceId);
  outsider = await uiActor('outsider', world.workspaceId);
  await world.addMember(owner, 'editor');
  await world.addMember(member, 'editor');
  await world.addMember(plain, 'editor');
  await world.leaveWorkspace();
  const res = await owner.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2269 ${Date.now()}`, workspaceId: world.workspaceId },
  });
  projectId = (await res.json()).id;
});

test.afterAll(async () => {
  for (const a of [owner, member, plain, outsider]) await a?.api.dispose();
  await world?.dispose();
});

test.describe('Project Settings -> Access', () => {
  test('AC11 owner makes the project private and adds a workspace member via the picker @SI-031', async ({ page }) => {
    await signInAs(page, owner, world.workspaceId);
    await page.goto(`/projects/${projectId}/settings`);
    await expect(page.getByTestId('project-settings-access-tab')).toBeVisible();
    await page.getByTestId('visibility-toggle').click();
    await expect(page.getByTestId('visibility-state')).toHaveText('Private');

    const picker = page.getByTestId('add-grant-picker');
    const options = await picker.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(options).toContain(member.userId);
    expect(options).not.toContain(outsider.userId);
    expect(options).not.toContain(owner.userId);

    await picker.selectOption(member.userId);
    await page.getByTestId('add-grant-submit').click();
    await expect(page.getByTestId(`grant-row-${member.userId}`)).toBeVisible();
    const body = await (await access.list(owner, projectId)).json();
    expect(body.grants.map((g: { userId: string }) => g.userId)).toContain(member.userId);
  });

  test('AC11 revoking removes the row and returns the member to the picker @SI-031', async ({ page }) => {
    await signInAs(page, owner, world.workspaceId);
    await page.goto(`/projects/${projectId}/settings`);
    await page.getByTestId(`revoke-grant-${member.userId}`).click();
    await expect(page.getByTestId(`grant-row-${member.userId}`)).toHaveCount(0);
    await expect(page.getByTestId('add-grant-picker').locator(`option[value="${member.userId}"]`)).toHaveCount(1);
  });

  test('AC11 switching to public shows existing grants as dormant @SI-031', async ({ page }) => {
    await access.grant(owner, projectId, member.userId);
    await signInAs(page, owner, world.workspaceId);
    await page.goto(`/projects/${projectId}/settings`);
    await page.getByTestId('visibility-toggle').click();
    await expect(page.getByTestId('visibility-state')).toHaveText('Public');
    await expect(page.getByTestId('grants-dormant-banner')).toBeVisible();
    await expect(page.getByTestId(`grant-dormant-${member.userId}`)).toBeVisible();
  });

  test('AC11 a member without authority sees the forbidden state, no controls @SI-031', async ({ page }) => {
    await signInAs(page, plain, world.workspaceId);
    await page.goto(`/projects/${projectId}/settings`);
    await expect(page.getByTestId('access-forbidden')).toBeVisible();
    await expect(page.getByTestId('visibility-toggle')).toHaveCount(0);
    await expect(page.getByTestId('add-grant-picker')).toHaveCount(0);
  });
});
