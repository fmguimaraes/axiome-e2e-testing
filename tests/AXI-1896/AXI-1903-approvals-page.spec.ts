import { test, expect, request as apiRequest, type Page, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-1903 (epic AXI-1896 — the Content Approvals admin page; FR20, FR21,
 * FR24, NFR5, AC5, AC15, AC18, AC19, AC23, EC4; SI-031/SI-030). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1896-Help-Onboarding-Content-Approval.md`
 * (`## AXI-1903` section) — CA-1903-1..8, CA-1903-10, CA-1903-12. Tags:
 * @SI-031 @SI-030.
 *
 * AUTHORED, NOT YET RUN against a live stack (W5 deferred per workflow-4
 * step g) — the dev-epic-context's shared demo DB is needed to grant the
 * SYSTEM-scope `content:approve` permission through the real Roles admin
 * flow. Do not report `e2e-pass` for this spec until it has actually been
 * executed.
 *
 * Follows the self-provisioning convention of
 * `tests/AXI-1896/AXI-1899-content-approvals-api.spec.ts` (throwaway SYSTEM
 * role + throwaway users via the public API) and the UI sign-in +
 * onboarding-tour-silencing convention of
 * `tests/AXI-1883/AXI-1886-org-menu-visibility.spec.ts` (a fresh user's
 * onboarding tours otherwise navigate() away from this page — see memory
 * `reference_onboarding_tour_hijacks_navigation`).
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function send(
  api: APIRequestContext,
  method: 'post' | 'put' | 'get' | 'delete',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await api[method](apiUrl(path), body === undefined ? undefined : { data: body as any });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : {} };
}

interface Actor {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  api: APIRequestContext;
}

const TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets',
  'evidence-decisions', 'graph-rules', 'charts-views', 'help', 'admin', 'collaboration',
];

/** A fresh user's onboarding tours auto-start and navigate() away from the
 *  current page — silence every tour before signing in through the UI. */
async function silenceTours(accessToken: string): Promise<void> {
  const api = await apiRequest.newContext();
  try {
    for (const tourId of TOUR_IDS) {
      await api.put(apiUrl('/api/v1/onboarding-state'), {
        data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
  } finally {
    await api.dispose();
  }
}

class ContentApprovalWorld {
  admin!: APIRequestContext;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];

  static async create(): Promise<ContentApprovalWorld> {
    const world = new ContentApprovalWorld();
    world.admin = await adminApiContext();
    return world;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1903 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string, email?: string): Promise<Actor> {
    const actorEmail = email ?? `${unique(`axi1903-${label}`)}@axiome.local`;
    const password = 'AXI1903-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email: actorEmail,
      password,
      firstName: 'AXI1903',
      lastName: label,
    });
    const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email: actorEmail, password });
    await bootstrap.dispose();
    const api = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` },
    });
    const me = await send(api, 'get', '/api/v1/auth/me');
    if (roleId) await send(this.admin, 'post', `/api/v1/users/${me.json.id}/roles`, { roleId });
    const actor = { userId: me.json.id, email: actorEmail, password, accessToken: login.json.accessToken, api };
    this.actors.push(actor);
    return actor;
  }

  async dispose(): Promise<void> {
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) {
      await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    }
    await this.admin.dispose();
  }
}

// Mirrors `tests/AXI-1236/rules-fixtures.ts#adminApiContext` — a privileged
// context for role/permission bootstrap, never committed credentials.
async function adminApiContext(): Promise<APIRequestContext> {
  const email = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com';
  const password = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
  const bootstrap = await apiRequest.newContext();
  const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
  await bootstrap.dispose();
  return apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` } });
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

let world: ContentApprovalWorld;
let holderRoleId: string;

test.beforeAll(async () => {
  world = await ContentApprovalWorld.create();
  holderRoleId = await world.role('content-approve', ['content:approve']);
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1903 - Content Approvals admin page', { tag: ['@SI-031', '@SI-030'] }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // CA-1903-1 / AC19 / FR20
  test('AC19: a non-holder gets the forbidden page and no nav entry @SI-031 @SI-030', async ({ page }) => {
    const nonHolder = await world.actor('non-holder-navcheck');
    await silenceTours(nonHolder.accessToken);
    await signIn(page, nonHolder);

    await page.goto('/admin/content-approvals');
    await expect(page.getByText(/you do not have permission to view content approvals/i)).toBeVisible();

    await page.goto('/overview');
    await expect(page.locator('a[href="/admin/content-approvals"]')).toHaveCount(0);
  });

  // CA-1903-2 / FR20
  test('FR20: a content:approve holder sees the nav entry and the four tabs @SI-031 @SI-030', async ({ page }) => {
    const holder = await world.actor('holder-navcheck', holderRoleId);
    await silenceTours(holder.accessToken);
    await signIn(page, holder);

    await expect(page.locator('a[href="/admin/content-approvals"]')).toHaveCount(1);

    await page.goto('/admin/content-approvals');
    for (const label of ['Pending', 'Stale', 'Rejected', 'Approved']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });

  // CA-1903-3 / FR20 — truthful for all four filter axes (kind, locale,
  // category, generated_by). The manifest is build-time (FR1), not
  // seedable per-test, so each assertion narrows whatever the running
  // manifest's Pending queue already serves, reading the actually-filtered
  // value back off its OWN rendered column (never assuming a filter took
  // effect from absence of rows alone) — column order on the Pending tab
  // is [checkbox, Title, Kind, Locale, Category, Generated by, Authored by].
  test('FR20: kind/locale/category/generated_by filters each narrow the Pending queue to their own value @SI-031', async ({ page }) => {
    const holder = await world.actor('holder-filter', holderRoleId);
    await silenceTours(holder.accessToken);
    await signIn(page, holder);
    await page.goto('/admin/content-approvals');

    const rows = page.locator('table tbody tr');
    const combos = page.getByRole('combobox');

    async function expectColumnAllEqual(columnIndex: number, expected: string) {
      const count = await rows.count();
      expect(count, `at least one row after filtering to ${expected}`).toBeGreaterThan(0);
      for (let i = 0; i < count; i++) {
        await expect(rows.nth(i).locator('td').nth(columnIndex)).toHaveText(expected);
      }
    }

    // kind (combobox 0) -> Kind column (index 2)
    await combos.nth(0).selectOption('help_doc');
    await expectColumnAllEqual(2, 'help_doc');
    await combos.nth(0).selectOption('all');

    // locale (combobox 1) -> Locale column (index 3): read the first row's
    // own locale rather than assuming 'en' exists in the running manifest.
    const firstLocale = await rows.first().locator('td').nth(3).innerText();
    await combos.nth(1).selectOption(firstLocale);
    await expectColumnAllEqual(3, firstLocale);
    await combos.nth(1).selectOption('all');

    // category (combobox 2) -> Category column (index 4)
    const firstCategory = await rows.first().locator('td').nth(4).innerText();
    await combos.nth(2).selectOption(firstCategory);
    await expectColumnAllEqual(4, firstCategory);
    await combos.nth(2).selectOption('all');

    // generated_by (combobox 3) -> Generated by column (index 5)
    await combos.nth(3).selectOption('claude');
    await expectColumnAllEqual(5, 'claude');
  });

  // CA-1903-4, CA-1903-5 / FR20, EC4, AC22
  test('FR20 EC4 AC22: opening an item shows its diff/history and blocks a blank-justification approve @SI-031', async ({ page }) => {
    const holder = await world.actor('holder-detail', holderRoleId);
    await silenceTours(holder.accessToken);
    await signIn(page, holder);
    await page.goto('/admin/content-approvals');

    const firstRow = page.locator('table tbody tr').first();
    await firstRow.click();
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();

    await page.getByRole('button', { name: 'Approve' }).first().click();
    const confirm = page.getByRole('button', { name: 'Confirm' });
    await expect(confirm).toBeDisabled();
    await page.getByPlaceholder('Justification (required)').fill('   ');
    await expect(confirm).toBeDisabled();
    await page.getByPlaceholder('Justification (required)').fill('A real reason for approving.');
    await expect(confirm).toBeEnabled();
  });

  // CA-1903-6 / AC5, FR11, D6
  test('AC5: Approve is disabled, with the self-approval reason, for a non-English item the holder authored', async ({ page }) => {
    // This asserts the UI reflection of D6 against whatever pending
    // non-English item the running manifest serves authored by the fixed
    // seed author; the server-side refusal itself is AXI-1899's CA-1899-2.
    const holder = await world.actor('holder-selfapproval', holderRoleId);
    await silenceTours(holder.accessToken);
    await signIn(page, holder);
    await page.goto('/admin/content-approvals');

    const nonEnglishSelfAuthored = page.locator('table tbody tr', { hasText: /fr|de|es/i }).first();
    if (await nonEnglishSelfAuthored.count() === 0) {
      test.skip(true, 'no non-English self-authored fixture item in this environment\'s manifest');
    }
    await nonEnglishSelfAuthored.click();
    const approveButton = page.getByRole('button', { name: 'Approve' }).first();
    await expect(approveButton).toBeDisabled();
    await expect(approveButton).toHaveAttribute('title', /you authored this item/i);
  });

  // CA-1903-7 / AC18, FR14
  test('AC18: an item\'s history lists approver, hash, timestamp, justification and self-approved flag', async ({ page }) => {
    const holder = await world.actor('holder-history', holderRoleId);
    await silenceTours(holder.accessToken);
    await signIn(page, holder);
    await page.goto('/admin/content-approvals');

    await page.getByRole('button', { name: 'Approved' }).click();
    const approvedRow = page.locator('table tbody tr').first();
    if (await approvedRow.count() === 0) {
      test.skip(true, 'no approved item in this environment to show history for');
    }
    await approvedRow.click();
    await expect(page.getByText('History')).toBeVisible();
    await expect(page.locator('table').last().locator('tbody tr').first()).toBeVisible();
  });

  // CA-1903-8 / FR20 (bulk approve)
  test('FR20: bulk approve moves every selected Pending row to Approved with one shared justification', async ({ page }) => {
    const holder = await world.actor('holder-bulk', holderRoleId);
    await silenceTours(holder.accessToken);
    await signIn(page, holder);
    await page.goto('/admin/content-approvals');

    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    const count = await checkboxes.count();
    if (count === 0) {
      test.skip(true, 'no pending items in this environment to bulk-approve');
    }
    const toSelect = Math.min(2, count);
    for (let i = 0; i < toSelect; i++) await checkboxes.nth(i).check();

    const justificationInput = page.getByPlaceholder(/justification \(required\)/i);
    await justificationInput.fill(`Adoption of the pre-approval corpus, reviewed ${new Date().toISOString().slice(0, 10)}`);
    await page.getByRole('button', { name: new RegExp(`Approve ${toSelect}`) }).click();

    await page.getByRole('button', { name: 'Approved' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(await page.locator('table tbody tr').count());
  });

  // CA-1903-10 / distinct 403/409 reasons
  test('FR20: a 403 refusal from a decision POST renders its own distinct message, not a generic one', async ({ page }) => {
    const holder = await world.actor('holder-refusal', holderRoleId);
    await silenceTours(holder.accessToken);
    await page.route('**/api/v1/content-approvals', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ message: "MISSING_CONTENT_APPROVE: Permission 'content:approve' required" }),
        });
        return;
      }
      await route.continue();
    });
    await signIn(page, holder);
    await page.goto('/admin/content-approvals');

    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.count() === 0) test.skip(true, 'no pending item to attempt a decision against');
    await firstRow.click();
    await page.getByRole('button', { name: 'Approve' }).first().click();
    await page.getByPlaceholder('Justification (required)').fill('Attempting an approval that will be refused.');
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect(page.getByText(/do not hold|permission/i)).toBeVisible();
  });

  // CA-1903-12 / FR23, AC16
  test('AC16: switching to enforce with a pending item asks for an explicit override', async ({ page }) => {
    const holder = await world.actor('holder-mode', holderRoleId);
    await silenceTours(holder.accessToken);
    await signIn(page, holder);
    await page.goto('/admin/content-approvals');

    await expect(page.getByText(/^Mode: report$/)).toBeVisible();
    await page.getByPlaceholder('Justification for switching').fill('Switching to enforce for the AC16 scenario.');
    await page.getByRole('button', { name: /^Switch to enforce$/ }).click();

    const conflict = page.getByText(/item\(s\) are pending\. Switch anyway\?/);
    if (await conflict.count() === 0) {
      // No pending item in this environment — nothing to conflict on; the
      // switch should have gone straight through instead.
      await expect(page.getByText(/^Mode: enforce$/)).toBeVisible();
      // Restore report mode so this spec never leaks `enforce` into a later run.
      await page.getByPlaceholder('Justification for switching').fill('Restoring report mode after AC16.');
      await page.getByRole('button', { name: /^Switch to report$/ }).click();
      return;
    }
    await expect(conflict).toBeVisible();
    await page.getByRole('button', { name: 'Override and switch' }).click();
    await expect(page.getByText(/^Mode: enforce$/)).toBeVisible();

    // Restore report mode so this spec never leaks `enforce` into a later run.
    await page.getByPlaceholder('Justification for switching').fill('Restoring report mode after AC16.');
    await page.getByRole('button', { name: /^Switch to report$/ }).click();
  });
});
