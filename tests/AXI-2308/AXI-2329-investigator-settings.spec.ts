import { randomUUID } from 'crypto';
import { Page, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from './harness/new-analysis';

/**
 * AXI-2329 (epic AXI-2308 — Platform Opening: Human Guided, FR36/AC28) — the
 * Investigator's ONE Settings entry: his org's default styling preset, nothing
 * else. No workspace creation, no project creation and no language setting
 * exist on `/investigator/settings`. The write goes through a dedicated route,
 * `PATCH /organizations/:id/styling`, opened for him beside the general
 * `PATCH /organizations/:id`, which stays denied (FR5).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2329. Self-provisioned actors inside a fresh fixture workspace; the
 * org itself is the admin's existing one (`PrivateProjectsWorld` convention) —
 * this spec creates its OWN disposable styling preset and restores the org's
 * `defaultStylingPresetId` to what it was before the run, in `afterAll`, so no
 * shared fixture is left mutated. Run with `--no-deps`.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const PASSWORD = 'AXI2329-e2e-pw!';

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let editor: Actor;
let presetId: string;
let presetName: string;
let originalDefaultStylingPresetId: string | null;
let projectId: string;

function unique(label: string): string {
  // Short — a long header email overlaps the nav (pre-existing InvestigatorShell
  // header layout, out of this story's scope) and intercepts pointer events.
  return `ax2329-${label}-${Date.now().toString(36)}`;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2329', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

async function getOrganization(): Promise<{ defaultStylingPresetId: string | null; name: string }> {
  const res = await world.admin.get(apiUrl(`/api/v1/organizations/${world.orgId}`));
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** Sign in through the UI, landing on `/investigator` with the fixture workspace active. */
async function signIn(page: Page): Promise<void> {
  await page.addInitScript(
    ([org, ws, p]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', p);
    },
    [world.orgId, world.workspaceId, projectId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
}

async function openSettings(page: Page): Promise<void> {
  await signIn(page);
  await gotoSettled(page, '/investigator');
  await page.getByTestId('investigator-nav-settings').click();
  await expect(page).toHaveURL(/\/investigator\/settings$/);
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  editor = await world.actor('editor');
  const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(editor, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);

  // The investigator shell lands on a study (org+workspace+project) before
  // rendering ANY nested route, Settings included — a project must exist.
  const projectRes = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2329 study ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(projectRes.status(), await projectRes.text()).toBe(201);
  projectId = (await projectRes.json()).id;

  // A disposable org-scoped preset to choose, and the org's CURRENT default — restored after.
  const before = await getOrganization();
  originalDefaultStylingPresetId = before.defaultStylingPresetId ?? null;
  presetName = unique('preset');
  const created = await world.admin.post(apiUrl('/api/v1/styling-presets'), {
    data: {
      name: presetName,
      organizationId: world.orgId,
      modes: { exploration: {}, publication: {} },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  presetId = (await created.json()).id;
});

test.afterAll(async () => {
  // Restore the org's default styling preset to what it was before this spec ran.
  await world.admin.patch(apiUrl(`/api/v1/organizations/${world.orgId}`), {
    data: { defaultStylingPresetId: originalDefaultStylingPresetId },
  });
  await world.admin.delete(apiUrl(`/api/v1/styling-presets/${presetId}`));
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2329 Investigator Settings: org visual style only @SI-066 @SI-030 @SI-010', () => {
  test('AC28 AXI-2329.2 his navigation offers Settings; the page offers org visual style only @SI-066', async ({ page }) => {
    // Act
    await openSettings(page);

    // Assert
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
    await expect(page.getByTestId('investigator-settings')).toBeVisible();
    await expect(page.getByTestId('investigator-settings-styling-select')).toBeVisible();
    const panel = page.getByTestId('investigator-settings');
    await expect(panel.getByText(/create.*workspace/i)).toHaveCount(0);
    await expect(panel.getByText(/create.*project/i)).toHaveCount(0);
    await expect(panel.getByText(/language/i)).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /create/i })).toHaveCount(0);
  });

  test('AC28 AXI-2329.3 he changes the preset; the org default updates for the team too @SI-066 @SI-030 @SI-010', async ({ page }) => {
    // Arrange
    await openSettings(page);

    // Act
    await page.getByTestId('investigator-settings-styling-select').selectOption(presetId);

    // Assert — persists and the team reads the same organization record
    await expect(page.getByTestId('investigator-settings-styling-select')).toHaveValue(presetId);
    await page.reload();
    await expect(page.getByTestId('investigator-settings-styling-select')).toHaveValue(presetId);
    const org = await getOrganization();
    expect(org.defaultStylingPresetId).toBe(presetId);
    const asEditor = await editor.api.get(apiUrl(`/api/v1/organizations/${world.orgId}`));
    expect((await asEditor.json()).defaultStylingPresetId).toBe(presetId);
  });

  test('AC28 AXI-2329.4 the general organization write stays denied; only the narrow styling route opens @SI-010', async () => {
    // Act
    const forgeAttempt = await investigator.api.patch(apiUrl(`/api/v1/organizations/${world.orgId}`), {
      data: { name: 'forged-by-investigator' },
    });
    const narrowWrite = await investigator.api.patch(apiUrl(`/api/v1/organizations/${world.orgId}/styling`), {
      data: { defaultStylingPresetId: presetId },
    });

    // Assert
    expect(forgeAttempt.status()).toBe(403);
    expect(narrowWrite.status()).toBe(200);
    expect((await narrowWrite.json()).defaultStylingPresetId).toBe(presetId);
    const org = await getOrganization();
    expect(org.name).not.toBe('forged-by-investigator');
  });
});
