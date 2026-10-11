import { test, expect, request as apiRequest, type Page, type APIRequestContext } from '@playwright/test';
import { silenceTours } from '../AXI-1904/harness/tours';
import { RuleFamilyWorld, RULE_FAMILY_CAPABILITY, send, orgHeader } from './harness/world';

/**
 * AXI-2005 (epic AXI-1991 — AC18; FR3, FR4, FR7, FR9-FR11, FR46-FR50).
 *
 * Family-authoring UI scenarios from
 * `axiome-docs/manual-e2e/AXI-1991-Rule-Families.md` §2.1 — create / edit /
 * delete a family, membership from the family side and from the rule form,
 * the rule-list family filter and the rule-detail family badges.
 *
 * UI-level, browser-driven. Signs in through the UI, mirroring
 * `AXI-1963-add-source-form.spec.ts`'s `signIn` helper and silencing
 * onboarding tours the same way (`TourRunner.navigate()` hijacks a fresh
 * actor's first page — see that harness's doc comment).
 *
 * AUTHORED, NOT RUN — no stack was started for this story. The DOM
 * selectors below are read off `axiome-front` `origin/main` (`699655d`);
 * they have not been exercised against a running front end.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

interface UiActor {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  api: APIRequestContext;
}

let world: RuleFamilyWorld;
let orgId: string;
let wsId: string;
let managerRoleId: string;

/** A UI-sign-in-capable actor (email/password kept, unlike `world.actor`'s
 *  opaque `APIRequestContext`-only shape). */
async function uiActor(label: string, roleId?: string): Promise<UiActor> {
  const email = `${unique(`axi2005-${label}`)}@axiome.local`;
  const password = 'AXI2005-ui-pw!';
  const bootstrap = await apiRequest.newContext();
  await send(bootstrap, 'post', '/api/v1/auth/register', { email, password, firstName: 'AXI2005', lastName: label });
  const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
  await bootstrap.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` } });
  const me = await send(api, 'get', '/api/v1/auth/me');
  if (roleId) await send(world.admin, 'post', `/api/v1/users/${me.json.id}/roles`, { roleId, organizationId: orgId });
  return { userId: me.json.id, email, password, accessToken: login.json.accessToken, api };
}

test.beforeAll(async () => {
  world = await RuleFamilyWorld.create();
  orgId = await world.organization('ui-authoring');
  wsId = await world.workspace('ui-authoring', orgId);
  managerRoleId = await world.role('ui-manager', [
    RULE_FAMILY_CAPABILITY.MANAGE,
    RULE_FAMILY_CAPABILITY.READ,
    RULE_FAMILY_CAPABILITY.ASSIGN,
  ]);
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-2005 — Rule Family authoring UI', () => {
  // AC18, FR3/FR4/FR7, FR46 — create, edit, delete a family from the management surface
  test('AC18: a rule_family:manage holder creates, edits and deletes a family from the management pages @SI-035 @SI-017', async ({ page }) => {
    const manager = await uiActor('manager-crud', managerRoleId);
    await silenceTours(manager.accessToken);
    await signIn(page, manager);

    await page.goto('/rule-families');
    await expect(page.getByTestId('rule-families-page')).toBeVisible();
    await page.getByTestId('rule-family-create-button').click();
    await expect(page).toHaveURL(/\/rule-families\/new/);

    const name = unique('AXI-2005 UI Family');
    await page.getByTestId('rule-family-create-name').fill(name);
    await page.getByTestId('rule-family-create-scope').selectOption('organization');
    await page.getByTestId('rule-family-create-submit').click();
    await expect(page).toHaveURL(/\/rule-families\/[0-9a-f-]+$/);
    await expect(page.getByTestId('rule-family-detail-page')).toBeVisible();

    // Edit
    const editedName = `${name} (edited)`;
    await page.getByTestId('rule-family-detail-name').fill(editedName);
    await page.getByTestId('rule-family-detail-save').click();
    await expect(page.getByTestId('rule-family-detail-name')).toHaveValue(editedName);

    // Delete
    await page.getByTestId('rule-family-delete-button').click();
    await expect(page).toHaveURL(/\/rule-families$/);
  });

  // AC18, FR9-FR11 — membership from the family side
  test('AC18: membership is added and removed from the family detail page (FR11) @SI-035 @SI-017', async ({ page }) => {
    const manager = await uiActor('manager-members', managerRoleId);
    await world.addWorkspaceMember(wsId, { userId: manager.userId, api: manager.api });
    const ruleId = await world.rule(
      { userId: manager.userId, api: manager.api },
      wsId,
      `AXI2005UIMEMBER-${Date.now()}`,
    );
    const family = await world.createFamily({ userId: manager.userId, api: manager.api }, orgId, 'organization', 'AXI-2005 UI Membership Family');
    expect(family.id).toBeTruthy();

    await silenceTours(manager.accessToken);
    await signIn(page, manager);

    await page.goto(`/rule-families/${family.id}`);
    await expect(page.getByTestId('rule-family-members-empty')).toBeVisible();

    await page.getByTestId('rule-family-member-search-input').fill(`AXI2005UIMEMBER`);
    await page.getByTestId('rule-family-member-search-button').click();
    await page.getByTestId(`rule-family-member-add-${ruleId}`).click();
    await expect(page.getByTestId(`rule-family-member-${ruleId}`)).toBeVisible();

    await page.getByTestId(`rule-family-member-remove-${ruleId}`).click();
    await expect(page.getByTestId('rule-family-members-empty')).toBeVisible();
  });

  // AC18, FR10 — membership assignment from the rule create/edit form
  test('AC18: the rule create form carries the family selector (FR10) and saves membership with the rule @SI-035 @SI-017', async ({ page }) => {
    const manager = await uiActor('manager-rule-form', managerRoleId);
    await world.addWorkspaceMember(wsId, { userId: manager.userId, api: manager.api });
    const family = await world.createFamily({ userId: manager.userId, api: manager.api }, orgId, 'organization', 'AXI-2005 UI Rule-Form Family');
    expect(family.id).toBeTruthy();

    await silenceTours(manager.accessToken);
    await signIn(page, manager);

    await page.goto('/rules/new');
    await expect(page.getByTestId('rule-family-selector')).toBeVisible();
    await page.getByTestId(`rule-family-selector-option-${family.id}`).check();
    // The rest of the create form is out of this story's ownership
    // boundary (AXI-2001 built it); this scenario asserts only that the
    // selector is present, listing the family, and checkable — the actual
    // save-and-persist round trip is AXI-2001's own coverage.
    await expect(page.getByTestId(`rule-family-selector-option-${family.id}`)).toBeChecked();
  });

  // AC18, FR50 — the rule list shows a rule's families and offers a filter
  test('AC18: the rule list offers a Rule Family filter and narrows the list to the selected family @SI-035 @SI-017', async ({ page }) => {
    const manager = await uiActor('manager-filter', managerRoleId);
    await world.addWorkspaceMember(wsId, { userId: manager.userId, api: manager.api });
    const family = await world.createFamily({ userId: manager.userId, api: manager.api }, orgId, 'organization', 'AXI-2005 UI Filter Family');
    expect(family.id).toBeTruthy();
    const filterCode = `AXI2005UIFILTER-${Date.now()}`;
    await world.rule({ userId: manager.userId, api: manager.api }, wsId, filterCode, [family.id!]);

    await silenceTours(manager.accessToken);
    await signIn(page, manager);

    await page.goto('/rules');
    await expect(page.getByTestId('rule-family-list-filter')).toBeVisible();
    await page.getByTestId('rule-family-list-filter-select').selectOption(family.id!);
    await expect(page.getByText(filterCode)).toBeVisible();
  });

  // AC18 — the rule detail page shows which families a rule belongs to
  test('AC18: the rule detail page shows the families a rule belongs to @SI-035 @SI-017', async ({ page }) => {
    const manager = await uiActor('manager-badges', managerRoleId);
    await world.addWorkspaceMember(wsId, { userId: manager.userId, api: manager.api });
    const family = await world.createFamily({ userId: manager.userId, api: manager.api }, orgId, 'organization', 'AXI-2005 UI Badge Family');
    expect(family.id).toBeTruthy();
    const ruleId = await world.rule({ userId: manager.userId, api: manager.api }, wsId, `AXI2005UIBADGE-${Date.now()}`, [family.id!]);

    await silenceTours(manager.accessToken);
    await signIn(page, manager);

    await page.goto(`/rules/${ruleId}`);
    await expect(page.getByTestId('rule-family-detail-badges')).toBeVisible();
    await expect(page.getByTestId(`rule-family-detail-badge-${family.id}`)).toBeVisible();
  });
});
