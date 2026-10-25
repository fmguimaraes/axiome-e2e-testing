import { test, expect, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, neverCreatedProjectId } from './private-projects-fixtures';
import { UiActor, signInAs, uiActor } from './AXI-2269-helpers';

/**
 * AXI-2270 (epic AXI-2265 — Private Projects): frontend not-found handling.
 * AC3 (FR18): a non-grantee who deep-links to a private project's pages gets the standard
 * "Project Not Found" state, indistinguishable from a never-created id. Also AC2/AC7 at UI
 * level and NFR7 (visibility notice). Scenario doc: manual-e2e/AXI-2265-Private-Projects.md
 * ("AXI-2270" section).
 *
 * AUTHORED, NOT RUN (no stack available when written) — run before W5.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-030', '@SI-031', '@SI-042'] };
const PAGES = ['', '/settings', '/edit', '/overview', '/dashboards', '/cohorts', '/data-explorer', '/view-analyses'];

let world: PrivateProjectsWorld;
let owner: UiActor;
let grantee: UiActor;
let stranger: UiActor;
let projectId: string;
let projectName: string;

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  owner = await uiActor('owner', world.workspaceId);
  grantee = await uiActor('grantee', world.workspaceId);
  stranger = await uiActor('stranger', world.workspaceId);
  await world.addMember(owner, 'editor');
  await world.addMember(grantee, 'editor');
  await world.addMember(stranger, 'editor');
  await world.leaveWorkspace();
  projectName = `E2E AXI-2270 ${Date.now()}`;
  const res = await owner.api.post(apiUrl('/api/v1/projects'), { data: { name: projectName, workspaceId: world.workspaceId } });
  projectId = (await res.json()).id;
  await access.visibility(owner, projectId, 'private');
  await access.grant(owner, projectId, grantee.userId);
});

test.afterAll(async () => {
  for (const a of [owner, grantee, stranger]) await a?.api.dispose();
  await world?.dispose();
});

async function notFoundText(page: Page, path: string): Promise<string> {
  await page.goto(path);
  const state = page.getByTestId('project-not-found');
  await expect(state).toBeVisible();
  return (await state.innerText()).trim();
}

test.describe.configure({ mode: 'serial' });

test.describe('AXI-2270 — frontend not-found handling', TAGS, () => {
  test('AC3 — non-grantee deep links to every project page see the standard not-found state, identical to a never-created id', async ({ page }) => {
    await signInAs(page, stranger, world.workspaceId);
    const reference = await notFoundText(page, `/projects/${neverCreatedProjectId()}`);
    for (const suffix of PAGES) {
      const text = await notFoundText(page, `/projects/${projectId}${suffix}`);
      expect(text, `page ${suffix || '/'}`).toBe(reference);
      await expect(page.getByTestId('project-settings-loading')).toHaveCount(0);
      await expect(page.getByTestId('project-retry')).toHaveCount(0);
    }
  });

  test('AC3 — the not-found state never reveals that the project exists or is private', async ({ page }) => {
    await signInAs(page, stranger, world.workspaceId);
    await page.goto(`/projects/${projectId}/settings`);
    await expect(page.getByTestId('project-not-found')).toBeVisible();
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('private');
    expect(body).not.toContain(projectName.toLowerCase());
    await expect(page.getByTestId('visibility-toggle')).toHaveCount(0);
  });

  test('AC3 — a 503 from the access check offers a retry, not the not-found state', async ({ page }) => {
    await signInAs(page, grantee, world.workspaceId);
    const matcher = new RegExp(`/api/v1/projects/${projectId}$`);
    await page.route(matcher, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, statusCode: 503, message: 'Project access could not be verified right now. Please retry.' }),
      }));
    await page.goto(`/projects/${projectId}/settings`);
    await expect(page.getByTestId('project-retry')).toBeVisible();
    await expect(page.getByTestId('project-not-found')).toHaveCount(0);
    await page.unroute(matcher);
    await page.getByTestId('project-retry-button').click();
    await expect(page.getByTestId('project-settings-page')).toBeVisible();
  });

  test('AC4 — a grantee opens the private project pages (no not-found state)', async ({ page }) => {
    await signInAs(page, grantee, world.workspaceId);
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByText(projectName).first()).toBeVisible();
    await expect(page.getByTestId('project-not-found')).toHaveCount(0);
  });

  test('AC2 — the private project is absent from the non-grantee project list in the UI', async ({ page }) => {
    await signInAs(page, stranger, world.workspaceId);
    await page.goto('/projects');
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.getByText(projectName)).toHaveCount(0);
  });

  test('NFR7 — the access tab states that private projects are visibility, not confidentiality', async ({ page }) => {
    await signInAs(page, owner, world.workspaceId);
    await page.goto(`/projects/${projectId}/settings`);
    await expect(page.getByTestId('visibility-limitation-notice')).toContainText('visibility, not confidentiality');
  });

  test('AC7 — after revocation the former grantee deep link renders the not-found state', async ({ page }) => {
    await access.revoke(owner, projectId, grantee.userId);
    await signInAs(page, grantee, world.workspaceId);
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId('project-not-found')).toBeVisible();
  });
});
