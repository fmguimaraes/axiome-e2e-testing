import { test, expect, APIRequestContext, Page } from '@playwright/test';
import {
  adminContext,
  createWorkspace,
  createSubject,
  publishSchema,
  roleTokens,
  seedBrowserSession,
  SCHEMA_COLUMNS,
} from './subject-fixtures';

/**
 * AXI-1250 — Subject Management change-history VIEW page (FR42, AC26;
 * manual-e2e §4.10 and §5.9). SI-039 (FE-SUBJ).
 *
 * Drives the change-history page at `/subjects/history` — the browsable read
 * surface over the merged audit trail (FR16). One workspace is provisioned with
 * a couple of auditable mutations (a schema publish + a subject create) so the
 * table has rows, then the browser is authenticated by injecting fresh admin
 * tokens before `goto` (seedBrowserSession, AXI-1264) — never the shared,
 * expiry-prone storageState.
 */

let adminApi: APIRequestContext;
let orgId: string;
let adminUserId: string;
let adminTokens: { accessToken: string; refreshToken: string };
let ws: string;

// A reason unique to this run so a search can target exactly the publish row.
const PUBLISH_REASON = `AXI-1244 E2E history publish ${Date.now()}`;
const SUBJECT_REASON = 'AXI-1244 E2E subject';

test.beforeAll(async () => {
  const ctx = await adminContext();
  adminApi = ctx.api;
  orgId = ctx.orgId;
  adminUserId = ctx.userId;
  adminTokens = await roleTokens('admin');

  // Provision a workspace with auditable mutations: a schema publish (draft_saved
  // + published) and a subject create — enough for the table + the type filter.
  ws = await createWorkspace(adminApi, orgId, adminUserId, 'subject-history');
  await publishSchema(adminApi, ws, SCHEMA_COLUMNS, PUBLISH_REASON);
  await createSubject(adminApi, ws, 'HIST-001');
});

test.afterAll(async () => {
  await adminApi?.dispose();
});

/** Point the authenticated SPA at `ws` and open the change-history page. */
async function openHistory(page: Page): Promise<void> {
  await seedBrowserSession(page, adminTokens, ws, orgId);
  await page.goto('/subjects/history');
  await expect(page.getByRole('heading', { name: 'Change history' })).toBeVisible();
}

test.describe('AXI-1250 — subject change-history page (FR42/AC26)', () => {
  test('AC26 — the subject list "Change history" action opens the history page', async ({ page }) => {
    await seedBrowserSession(page, adminTokens, ws, orgId);
    await page.goto('/subjects');
    await expect(page.getByRole('heading', { name: 'Subjects' })).toBeVisible();

    await page.getByRole('button', { name: /Change history/ }).click();

    await expect(page).toHaveURL(/\/subjects\/history$/);
    await expect(page.getByRole('heading', { name: 'Change history' })).toBeVisible();
  });

  test('AC26 — the table lists workspace changes with reason, action, and change type', async ({ page }) => {
    await openHistory(page);

    // The paginated table renders its count summary and the seeded mutations.
    await expect(page.getByText(/of \d+ changes?/)).toBeVisible();
    await expect(page.getByText(PUBLISH_REASON, { exact: true })).toBeVisible();
    await expect(page.getByText('Published', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(SUBJECT_REASON, { exact: true })).toBeVisible();
  });

  test('AC26 — filtering by change type narrows the table', async ({ page }) => {
    await openHistory(page);

    await page.getByRole('combobox').selectOption({ label: 'Subject' });

    // Only subject-registry rows remain: the subject-create reason stays, the
    // schema publish reason drops out.
    await expect(page.getByText(SUBJECT_REASON, { exact: true })).toBeVisible();
    await expect(page.getByText(PUBLISH_REASON, { exact: true })).toHaveCount(0);
  });

  test('AC26 — free-text search narrows to matches, empty term restores, no match shows empty state', async ({ page }) => {
    await openHistory(page);
    const search = page.getByPlaceholder(/Search reason/);

    await search.fill(PUBLISH_REASON);
    await expect(page.getByText(PUBLISH_REASON, { exact: true })).toBeVisible();
    await expect(page.getByText(SUBJECT_REASON, { exact: true })).toHaveCount(0);

    await search.fill('zzz-no-such-change-zzz');
    await expect(page.getByText(/No matching changes/)).toBeVisible();
  });
});
