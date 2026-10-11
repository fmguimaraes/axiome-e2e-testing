import { test, expect, request as apiRequest, type Page, type APIRequestContext } from '@playwright/test';
import { silenceTours } from '../AXI-1904/harness/tours';
import { RuleFamilyWorld, RULE_FAMILY_CAPABILITY, send, orgHeader } from './harness/world';

/**
 * AXI-2029 (epic AXI-1991 — AC18, SI-035/SI-017; three UI debt corrections
 * AXI-2028 left for this story's own E2E pass, per the Developer Epic
 * Context's "what the next story should know").
 *
 * All three are pure-function-backed UI behaviours, each already pinned at
 * unit level; this spec drives the SAME contract end to end through the
 * browser (selectors read off `axiome-front` `origin/main`, `fe919b8`):
 *
 *   (a) **Duplicate family name on create.** `rule-family.service.ts
 *       #translateUniqueViolation` answers a name collision with a plain
 *       409 and the verbatim message
 *       `` `A family named "${name}" already exists in this scope` ``;
 *       `ruleFamilyFormErrors.ts#isDuplicateFamilyNameError` (409) anchors
 *       it to `rule-family-create-name-error`, never the page-level
 *       `rule-family-create-error` banner.
 *   (b) **Delete confirmation text + description clearing.**
 *       `RuleFamilyDetail.tsx` calls `window.confirm
 *       (describeFamilyDeleteConfirmation(family.name))` before deleting,
 *       and sends `description: description.trim() || null` — an emptied
 *       field is an explicit `null`, never an omitted key.
 *   (c) **RuleEdit's minimal-touch save.** `familySelection.ts
 *       #resolveFamilyIdsForSubmit` returns `{}` (no `familyIds` key at
 *       all) whenever the selector's working set is unchanged from the
 *       rule's own families — even for a caller who HOLDS
 *       `rule_family:assign` — so a save that never touches the Rule
 *       Families field never re-authorizes the rule's existing membership
 *       against the caller's own capability.
 *
 *   (d) **Read-only rendering for a `rule_family:read`-only caller (bounce
 *       #1, B3).** `RuleFamilySelector.tsx` resolves `hasAssign` from the
 *       server-advised capability answer BEFORE deciding which reads to
 *       attempt (never guessing by calling the ASSIGN-gated read and
 *       catching its 403): without `rule_family:assign` it passes
 *       `Promise.resolve([])` as the "assignable" list instead of calling
 *       `GET /rule-family-membership/assignable-families` at all, so EVERY
 *       family the rule already belongs to lands in
 *       `familySelection.ts#buildFamilySelectionItems`'s `manageable: false`
 *       branch and renders `rule-family-selector-readonly-<id>`, never a
 *       checkbox and never an error.
 *
 * **Bounce #2 (B3) — opening `RuleEdit.tsx` at all needs its OWN two
 * permissions, orthogonal to every `rule_family:*` capability above.**
 * `RuleEdit.tsx` line ~50: `canUpdate = isAdmin || (!!roleId &&
 * hasPermission(roleId, 'rule:update'))`; without it, line ~171 renders an
 * "Access Denied" screen and the Rule Families section is never reached.
 * Independently of that: `RuleEdit` loads the rule via `fetchRules()` (the
 * LIST route, not a by-id fetch) and reads it back with `getRuleById(id)` —
 * `RulesService.findAll`'s `buildVisibilityWhere` (axiome-back
 * `apps/organization-service/src/rules/rule-visibility.service.ts`) ANDs the
 * workspace/project/org arms with `this.hasRead(caller)` (`rule:read`,
 * resolved server-side from the caller's ASSIGNED-ROLE permission union —
 * `RuleAccessResolverService`, 60s cache — the SAME assigned-role table this
 * harness's `world.role()`/`POST /users/:id/roles` writes, not a different
 * one) — without `rule:read` the rule is simply absent from the fetched
 * list and `getRuleById` returns `undefined`, rendering "Rule Not Found"
 * BEFORE `canUpdate` is ever consulted. So every actor that opens
 * `/rules/:id/edit` in this file needs BOTH `rule:read` and `rule:update`,
 * on top of whatever `rule_family:*` capability the row under test needs —
 * `managerRoleId` (test (c), "minimal-touch") and `readOnlyRoleId` (test (d))
 * below now carry both; `rule_family:assign` stays deliberately absent from
 * `readOnlyRoleId` (and present on `managerRoleId`), since that capability
 * alone governs the family-selector half under test, not page access.
 *
 * AUTHORED, NOT RUN — no stack was started for this story.
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
let managerRoleId: string;
let readOnlyRoleId: string;

async function uiActor(label: string, roleId?: string): Promise<UiActor> {
  const email = `${unique(`axi2029ui-${label}`)}@axiome.local`;
  const password = 'AXI2029-ui-pw!';
  const bootstrap = await apiRequest.newContext();
  await send(bootstrap, 'post', '/api/v1/auth/register', { email, password, firstName: 'AXI2029', lastName: label });
  const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
  await bootstrap.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` } });
  const me = await send(api, 'get', '/api/v1/auth/me');
  if (roleId) await send(world.admin, 'post', `/api/v1/users/${me.json.id}/roles`, { roleId, organizationId: orgId });
  return { userId: me.json.id, email, password, accessToken: login.json.accessToken, api };
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  world = await RuleFamilyWorld.create();
  orgId = await world.organization('ui-corrections');
  // B3 (bounce #2): 'rule:read'/'rule:update' are the generic RuleEdit page
  // gates (never `rule_family:*`) — every actor that opens `/rules/:id/edit`
  // below needs both, on top of its own `rule_family:*` row-under-test grant.
  managerRoleId = await world.role('ui-corrections-manager', [
    RULE_FAMILY_CAPABILITY.MANAGE,
    RULE_FAMILY_CAPABILITY.READ,
    RULE_FAMILY_CAPABILITY.ASSIGN,
    'rule:read',
    'rule:update',
  ]);
  // B3 (bounce #1/#2): `rule_family:read` WITHOUT `rule_family:assign` — the
  // capability split `RuleFamilySelector.tsx` resolves `hasAssign`/`hasRead`
  // against — PLUS `rule:read`/`rule:update` so the actor can open
  // `/rules/:id/edit` at all (see the file's own doc comment).
  readOnlyRoleId = await world.role('ui-corrections-read-only', [
    RULE_FAMILY_CAPABILITY.READ,
    'rule:read',
    'rule:update',
  ]);
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await world.dispose();
});

test.describe('AXI-2029 — Rule Family UI corrections (AXI-2028 debt)', () => {
  test.describe.configure({ timeout: 180_000 });

  test(
    "AC18: creating a family with a name already used in the SAME scope anchors the server's verbatim 409 message to the Name field, never the page banner @SI-035 @SI-017",
    async ({ page }) => {
      const manager = await uiActor('dup-name', managerRoleId);
      const name = unique('AXI-2029 Duplicate Family');
      const existing = await world.createFamily({ userId: manager.userId, api: manager.api }, orgId, 'organization', name);
      expect(existing.id, `seeding the first family: ${JSON.stringify(existing)}`).toBeTruthy();
      // `unique()` always suffixes the name — read back the EXACT stored
      // name so the UI create below collides on the identical string.
      const created = await send(manager.api, 'get', `/api/v1/rule-families/${existing.id}`, undefined, orgHeader(orgId));
      const exactName: string = created.json.name;

      await silenceTours(manager.accessToken);
      await signIn(page, manager);
      await page.goto('/rule-families/new');
      await page.getByTestId('rule-family-create-name').fill(exactName);
      await page.getByTestId('rule-family-create-submit').click();

      const nameError = page.getByTestId('rule-family-create-name-error');
      await expect(nameError).toBeVisible();
      await expect(nameError).toHaveText(`A family named "${exactName}" already exists in this scope`);
      await expect(page.getByTestId('rule-family-create-error')).toHaveCount(0);
    },
  );

  test(
    'AC18: clearing the description sends an explicit null, and delete asks for confirmation naming the EXACT FR7 consequence before removing the family @SI-035 @SI-017',
    async ({ page }) => {
      const manager = await uiActor('desc-clear', managerRoleId);
      const name = unique('AXI-2029 Description Clear Family');
      const created = await world.createFamily({ userId: manager.userId, api: manager.api }, orgId, 'organization', name);
      expect(created.id, `seeding the family: ${JSON.stringify(created)}`).toBeTruthy();
      // Seed a non-empty description directly through the edit route the
      // page itself calls, so there is something for the UI to clear.
      const patched = await send(
        manager.api,
        'patch',
        `/api/v1/rule-families/${created.id}`,
        { description: 'AXI-2029 fixture description' },
        orgHeader(orgId),
      );
      expect(patched.status, `seeding a description: ${JSON.stringify(patched.json)}`).toBeLessThan(300);

      await silenceTours(manager.accessToken);
      await signIn(page, manager);
      await page.goto(`/rule-families/${created.id}`);
      await expect(page.getByTestId('rule-family-detail-description')).toHaveValue('AXI-2029 fixture description');

      let patchBody: any = null;
      await page.route(`**/api/v1/rule-families/${created.id}`, async (route) => {
        if (route.request().method() === 'PATCH') {
          patchBody = route.request().postDataJSON();
        }
        await route.continue();
      });

      await page.getByTestId('rule-family-detail-description').fill('');
      await page.getByTestId('rule-family-detail-save').click();
      await expect.poll(() => patchBody).not.toBeNull();
      expect(patchBody.description, JSON.stringify(patchBody)).toBeNull();

      // Delete: the window.confirm dialog carries the EXACT FR7 sentence —
      // accept it and confirm the family is actually gone.
      page.once('dialog', async (dialog) => {
        expect(dialog.message()).toBe(
          `Delete the Rule Family "${name}"? It will stop authorizing every project that uses it ` +
            `— by default or by an explicit addition — and no rule will be usable through it in any ` +
            `project anymore. Its member rules keep their membership record; only the family itself is removed.`,
        );
        await dialog.accept();
      });
      await page.getByTestId('rule-family-delete-button').click();
      await expect(page).toHaveURL(/\/rule-families$/);

      const stillReadable = await send(world.admin, 'get', `/api/v1/rule-families/${created.id}`, undefined, orgHeader(orgId));
      expect(stillReadable.json.deletedAt, `family must be soft-deleted: ${JSON.stringify(stillReadable.json)}`).toBeTruthy();
    },
  );

  test(
    "AC18: saving a rule edit that never touches Rule Families omits familyIds from the PATCH body entirely, even for a caller holding rule_family:assign @SI-035 @SI-017",
    async ({ page }) => {
      const manager = await uiActor('minimal-touch', managerRoleId);
      const workspaceId = await world.workspace('minimal-touch', orgId);
      await world.addWorkspaceMember(workspaceId, { userId: manager.userId, api: manager.api });
      const family = await world.createFamily({ userId: manager.userId, api: manager.api }, orgId, 'organization', 'AXI-2029 Minimal-Touch Family');
      expect(family.id, `family create: ${JSON.stringify(family)}`).toBeTruthy();
      const ruleId = await world.rule(
        { userId: manager.userId, api: manager.api },
        workspaceId,
        `AXI2029MINTOUCH-${Date.now()}`,
        [family.id!],
      );

      await silenceTours(manager.accessToken);
      await signIn(page, manager);

      let patchBody: any = null;
      let sawPatch = false;
      await page.route(`**/api/v1/rules/${ruleId}`, async (route) => {
        if (route.request().method() === 'PATCH') {
          sawPatch = true;
          patchBody = route.request().postDataJSON();
        }
        await route.continue();
      });

      await page.goto(`/rules/${ruleId}/edit`);
      // Touch an UNRELATED field only — the Rule Families selector is left
      // exactly as loaded, selected family included.
      await page.getByLabel(/question/i).fill('AXI-2029 minimal-touch edit question');
      await page.getByRole('button', { name: /save changes/i }).click();
      await expect.poll(() => sawPatch).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(patchBody ?? {}, 'familyIds'), JSON.stringify(patchBody)).toBe(false);

      // The rule's family membership itself is provably untouched.
      const stillMember = await send(manager.api, 'get', `/api/v1/rule-family-membership/rules/${ruleId}`, undefined, orgHeader(orgId));
      expect(
        (stillMember.json?.families ?? []).some((f: any) => f.id === family.id),
        JSON.stringify(stillMember.json),
      ).toBe(true);
    },
  );

  test(
    'AC18/FR41: a rule_family:read-only caller (no rule_family:assign) sees the rule form\'s Rule Families as read-only, with no error and no call to assignable-families @SI-035 @SI-017',
    async ({ page }) => {
      const owner = await uiActor('readonly-owner', managerRoleId);
      const workspaceId = await world.workspace('readonly-render', orgId);
      await world.addWorkspaceMember(workspaceId, { userId: owner.userId, api: owner.api });
      const family = await world.createFamily({ userId: owner.userId, api: owner.api }, orgId, 'organization', 'AXI-2029 Read-Only Render Family');
      expect(family.id, `family create: ${JSON.stringify(family)}`).toBeTruthy();
      const ruleId = await world.rule(
        { userId: owner.userId, api: owner.api },
        workspaceId,
        `AXI2029READONLY-${Date.now()}`,
        [family.id!],
      );

      // The viewer holds rule_family:read ONLY — no manage/assign — plus
      // workspace membership so the rule itself is readable.
      const viewer = await uiActor('readonly-viewer', readOnlyRoleId);
      await world.addWorkspaceMember(workspaceId, { userId: viewer.userId, api: viewer.api });

      let assignableFamiliesCalled = false;
      await page.route('**/api/v1/rule-family-membership/assignable-families**', async (route) => {
        assignableFamiliesCalled = true;
        await route.continue();
      });

      await silenceTours(viewer.accessToken);
      await signIn(page, viewer);
      await page.goto(`/rules/${ruleId}/edit`);

      const selector = page.getByTestId('rule-family-selector');
      await expect(selector).toBeVisible();
      await expect(page.getByTestId(`rule-family-selector-readonly-${family.id}`)).toBeVisible();
      await expect(page.getByTestId(`rule-family-selector-option-${family.id}`)).toHaveCount(0);
      await expect(page.getByTestId('rule-family-selector-error')).toHaveCount(0);
      expect(assignableFamiliesCalled, 'assignable-families must never be requested without rule_family:assign').toBe(false);
    },
  );
});
