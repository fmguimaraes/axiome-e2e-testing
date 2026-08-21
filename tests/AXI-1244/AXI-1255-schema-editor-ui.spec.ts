import { test, expect, APIRequestContext, Page } from '@playwright/test';
import {
  adminContext,
  createWorkspace,
  roleTokens,
  seedBrowserSession,
} from './subject-fixtures';

/**
 * AXI-1255 — subject schema editor UI & JSON view (FR2, FR3, AC1;
 * manual-e2e §4.4 and §5.7).
 *
 * Drives the column editor at `/subjects/schema` against a freshly provisioned,
 * schema-less workspace (per test, self-contained — NFR3). Covers the FR2
 * type-dependent field surface (unit/min/max only for `number`, enum-values only
 * for `enum`), the FR5 free-text advisory mirror, the FR3 read-only Editor/JSON
 * toggle, and the AC1 draft → publish lifecycle (Save draft ⇒ Draft v1 persists
 * across reload; Publish requires a non-empty reason ⇒ Active v1). The browser is
 * authenticated by injecting fresh admin tokens before `goto` (seedBrowserSession,
 * AXI-1264) — never the shared, expiry-prone storageState.
 */

let adminApi: APIRequestContext;
let orgId: string;
let adminUserId: string;
let adminTokens: { accessToken: string; refreshToken: string };

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  orgId = ctx.orgId;
  adminUserId = ctx.userId;
  adminTokens = await roleTokens('admin');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** Provision a fresh schema-less workspace this run owns. */
function freshWorkspace(): Promise<string> {
  return createWorkspace(adminApi, orgId, adminUserId, 'schema-editor');
}

/** Point the authenticated SPA at `ws` and open the schema editor. */
async function openSchema(page: Page, ws: string): Promise<void> {
  await seedBrowserSession(page, adminTokens, ws, orgId);
  await page.goto('/subjects/schema');
  await expect(page.getByRole('heading', { name: /Subject schema/ })).toBeVisible();
}

/** Add one column and set its type/category via the row's two selects (the only
 *  comboboxes on this page). Leaves key/label to the caller. */
async function addColumn(page: Page, type: string, category = 'Clinical'): Promise<void> {
  await page.getByRole('button', { name: 'Add column' }).click();
  await page.getByRole('combobox').nth(0).selectOption({ label: type });
  await page.getByRole('combobox').nth(1).selectOption({ label: category });
}

const keyInput = (page: Page) => page.getByPlaceholder('e.g. age_at_enrollment');
const labelInput = (page: Page) => page.getByPlaceholder('e.g. Age at enrollment');

test.describe('AXI-1255 — schema editor UI & JSON view (FR2/FR3/AC1)', () => {
  // ─── FR2: type-dependent field surface ─────────────────────────────

  test('FR2 — a new column exposes key/label/type/category/required; number reveals unit/min/max, enum reveals values, neither leaks to other types', async ({ page }) => {
    const ws = await freshWorkspace();
    await openSchema(page, ws);

    // Add column: the FR2 identity block is present.
    await page.getByRole('button', { name: 'Add column' }).click();
    await expect(keyInput(page)).toBeVisible();
    await expect(labelInput(page)).toBeVisible();
    await expect(page.getByRole('combobox')).toHaveCount(2); // type + category
    await expect(page.getByRole('checkbox', { name: 'Required' })).toBeVisible();

    // Default type is text → no unit/min/max, no enum editor.
    await expect(page.getByPlaceholder('e.g. years')).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await expect(page.getByPlaceholder('e.g. A, B')).toHaveCount(0);

    // Number → unit + min + max appear; enum editor stays hidden.
    await page.getByRole('combobox').nth(0).selectOption({ label: 'Number' });
    await expect(page.getByPlaceholder('e.g. years')).toBeVisible();
    await expect(page.getByRole('spinbutton')).toHaveCount(2); // min + max
    await expect(page.getByPlaceholder('e.g. A, B')).toHaveCount(0);

    // Enum → values editor appears; unit/min/max vanish.
    await page.getByRole('combobox').nth(0).selectOption({ label: 'Enum' });
    await expect(page.getByPlaceholder('e.g. A, B')).toBeVisible();
    await expect(page.getByPlaceholder('e.g. years')).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(0);

    // Text → all type-specific fields hidden again.
    await page.getByRole('combobox').nth(0).selectOption({ label: 'Text' });
    await expect(page.getByPlaceholder('e.g. A, B')).toHaveCount(0);
    await expect(page.getByPlaceholder('e.g. years')).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
  });

  // ─── FR5 mirror: free-text advisory ────────────────────────────────

  test('FR2 — a free-text column shows the inline advisory warning (FR5 mirror, non-blocking)', async ({ page }) => {
    const ws = await freshWorkspace();
    await openSchema(page, ws);

    // A default (text) column immediately earns the advisory.
    await page.getByRole('button', { name: 'Add column' }).click();
    await keyInput(page).fill('clinician_notes');
    await expect(
      page.getByText(/may capture identifying information; prefer a typed or enum column/),
    ).toBeVisible();

    // Switching to a typed column clears it (advisory is text-only).
    await page.getByRole('combobox').nth(0).selectOption({ label: 'Number' });
    await expect(
      page.getByText(/may capture identifying information/),
    ).toHaveCount(0);
  });

  // ─── FR3: read-only JSON view ──────────────────────────────────────

  test('FR3 — the Editor/JSON toggle shows a read-only JSON rendering of the draft columns', async ({ page }) => {
    const ws = await freshWorkspace();
    await openSchema(page, ws);

    await addColumn(page, 'Number');
    await keyInput(page).fill('age_at_enrollment');
    await labelInput(page).fill('Age at enrollment');

    // Switch to JSON: the draft columns render as JSON, with no editing affordances.
    await page.getByRole('button', { name: 'JSON' }).click();
    await expect(page.getByText('Draft (as edited)')).toBeVisible();
    await expect(page.getByText('No published version yet')).toBeVisible();
    await expect(page.getByText(/"key": "age_at_enrollment"/)).toBeVisible();
    // Read-only: no inputs/textareas and no Add column button in this view (FR3).
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('combobox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add column' })).toHaveCount(0);

    // Toggling back restores the editable column.
    await page.getByRole('button', { name: 'Editor', exact: true }).click();
    await expect(keyInput(page)).toHaveValue('age_at_enrollment');
  });

  // ─── AC1: draft → publish lifecycle ────────────────────────────────

  test('AC1 — Save draft shows Draft v1 and persists across a reload', async ({ page }) => {
    const ws = await freshWorkspace();
    await openSchema(page, ws);
    // Empty workspace: no published version and no draft yet.
    await expect(page.getByText('No published version', { exact: true })).toBeVisible();
    await expect(page.getByText('No draft', { exact: true })).toBeVisible();

    await addColumn(page, 'Number');
    await keyInput(page).fill('age_at_enrollment');
    await labelInput(page).fill('Age at enrollment');

    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft v1', { exact: true })).toBeVisible();

    // The draft survives a full reload (server-persisted, not local state).
    await page.reload();
    await expect(page.getByRole('heading', { name: /Subject schema/ })).toBeVisible();
    await expect(page.getByText('Draft v1', { exact: true })).toBeVisible();
    await expect(keyInput(page)).toHaveValue('age_at_enrollment');
  });

  test('AC1 — Publish requires a non-empty reason (empty/whitespace blocked) and then shows Active v1', async ({ page }) => {
    const ws = await freshWorkspace();
    await openSchema(page, ws);

    // A saved draft is the pre-condition for publishing.
    await addColumn(page, 'Number');
    await keyInput(page).fill('age_at_enrollment');
    await labelInput(page).fill('Age at enrollment');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByText('Draft v1', { exact: true })).toBeVisible();

    // Open the publish panel; the confirm is gated on a non-empty reason.
    await page.getByRole('button', { name: 'Publish' }).click();
    const reason = page.getByPlaceholder('Why is this version being published?');
    await expect(reason).toBeVisible();
    const confirm = page.getByRole('button', { name: 'Publish version' });

    await expect(confirm).toBeDisabled(); // empty
    await reason.fill('   ');
    await expect(confirm).toBeDisabled(); // whitespace-only trims to empty
    await reason.fill('Initial schema for pilot cohort');
    await expect(confirm).toBeEnabled();

    await confirm.click();
    // The version indicator walks to Active v1 with no open draft (AC1).
    await expect(page.getByText('Active v1', { exact: true })).toBeVisible();
    await expect(page.getByText('No draft', { exact: true })).toBeVisible();
  });
});
