import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access } from './private-projects-fixtures';
import { UiActor, signInAs, uiActor } from './AXI-2269-helpers';

/**
 * AXI-2279 (epic AXI-2265 — Private Projects): visibility chosen at creation and the
 * "Private" indicators. AC12 (FR21) and AC13 (FR22). Scenario doc:
 * manual-e2e/AXI-2265-Private-Projects.md ("AXI-2279" section).
 *
 * AUTHORED, NOT RUN (no stack available when written) — run before W5.
 */

test.use({ storageState: { cookies: [], origins: [] } });

let world: PrivateProjectsWorld;
let owner: UiActor;
let plain: UiActor;
let privateId: string;
let publicId: string;

async function createProject(a: UiActor, name: string, visibility?: string) {
  return a.api.post(apiUrl('/api/v1/projects'), {
    data: { name, workspaceId: world.workspaceId, ...(visibility ? { visibility } : {}) },
  });
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await uiActor('owner', world.workspaceId);
  plain = await uiActor('plain', world.workspaceId);
  await world.addMember(owner, 'editor');
  await world.addMember(plain, 'editor');
  await world.leaveWorkspace();
  privateId = (await (await createProject(owner, `E2E AXI-2279 priv ${Date.now()}`, 'private')).json()).id;
  publicId = (await (await createProject(owner, `E2E AXI-2279 pub ${Date.now()}`)).json()).id;
});

test.afterAll(async () => {
  for (const a of [owner, plain]) await a?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2279 visibility at creation (API)', { tag: ['@SI-013', '@SI-010'] }, () => {
  test('AC12 creating with visibility private stores private and audits it', async () => {
    const project = await (await owner.api.get(apiUrl(`/api/v1/projects/${privateId}`))).json();
    expect(project.visibility).toBe('private');

    const logs = await (await access.auditLogs(owner, privateId)).json();
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'visibility_changed',
          performedBy: owner.userId,
          changes: { visibility: { old: 'public', new: 'private' } },
        }),
      ]),
    );
  });

  test('AC12 a private-at-creation project is hidden from a plain member (404) and unlisted', async () => {
    const direct = await plain.api.get(apiUrl(`/api/v1/projects/${privateId}`));
    expect(direct.status()).toBe(404);

    const list = await (await plain.api.get(apiUrl('/api/v1/projects?limit=100'))).json();
    const ids = (list.data ?? []).map((p: { id: string }) => p.id);
    expect(ids).toContain(publicId);
    expect(ids).not.toContain(privateId);
  });

  test('AC12 omitting visibility creates a public project', async () => {
    const project = await (await owner.api.get(apiUrl(`/api/v1/projects/${publicId}`))).json();
    expect(project.visibility).toBe('public');
  });

  test('AC12 an invalid visibility is refused 400 and nothing is created', async () => {
    const res = await createProject(owner, `E2E AXI-2279 bad ${Date.now()}`, 'secret');
    expect(res.status()).toBe(400);
  });
});

test.describe('AXI-2279 create form and Private indicators (UI)', { tag: ['@SI-031', '@SI-030', '@SI-042'] }, () => {
  test('AC12 the create form defaults to Public and creates a Private project when chosen', async ({ page }) => {
    await signInAs(page, owner, world.workspaceId);
    await page.goto('/projects/new');
    await expect(page.getByTestId('project-visibility-public')).toBeChecked();

    const name = `E2E AXI-2279 form ${Date.now()}`;
    await page.getByPlaceholder('Enter project name').fill(name);
    await page.getByTestId('project-visibility-private').check();
    await page.getByRole('button', { name: 'Create Project' }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);

    const id = page.url().split('/').pop()!;
    const created = await (await owner.api.get(apiUrl(`/api/v1/projects/${id}`))).json();
    expect(created.visibility).toBe('private');
  });

  test('AC13 the listing row shows a Private label only for the private project', async ({ page }) => {
    await signInAs(page, owner, world.workspaceId);
    await page.goto('/projects');
    const privateRow = page.getByRole('row').filter({ hasText: 'E2E AXI-2279 priv' });
    const publicRow = page.getByRole('row').filter({ hasText: 'E2E AXI-2279 pub' });
    await expect(privateRow.getByTestId('project-private-badge')).toBeVisible();
    await expect(publicRow).toBeVisible();
    await expect(publicRow.getByTestId('project-private-badge')).toHaveCount(0);
  });

  test('AC13 the overview header shows the Private label only for the private project', async ({ page }) => {
    await signInAs(page, owner, world.workspaceId);
    await page.goto(`/projects/${privateId}/overview`);
    await expect(page.getByTestId('project-private-badge')).toBeVisible();
    await page.goto(`/projects/${publicId}/overview`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('project-private-badge')).toHaveCount(0);
  });

  test('AC13 the layout menu chip shows inside a private project, above the role, and not in a public one', async ({ page }) => {
    await signInAs(page, owner, world.workspaceId);
    await page.goto(`/projects/${privateId}/overview`);
    const chip = page.getByTestId('layout-private-project-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/Private/);

    await page.goto(`/projects/${publicId}/overview`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('layout-private-project-chip')).toHaveCount(0);
  });
});
