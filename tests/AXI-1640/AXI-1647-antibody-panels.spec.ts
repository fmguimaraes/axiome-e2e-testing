import { test, expect } from '@playwright/test';
import { request as apiRequest } from '@playwright/test';
import { arrange, disposeArranged, ensureViewerMember, openSession, type Arranged } from './harness/session';
import { roleTokens } from '../AXI-1244/subject-fixtures';
import { apiUrl } from '../../config/env';
import { asList } from '../AXI-1400/harness/api';
import { uniq, deletePanelsByName } from './harness/seed';

/**
 * AXI-1650 (FR23, AC11) automating AXI-1647 (Antibody panels inventory page, SI-032)
 * — replaces AXI-886 Part E-892's hand-sent inventory messages with the real page.
 * Scenarios E2E-1640-E1..E5.
 */
test.use({ storageState: { cookies: [], origins: [] } });

let ctx: Arranged;
const PAGE = '/inventories/antibody-panels';
const made: string[] = [];

test.beforeAll(async () => {
  ctx = await arrange();
  await ensureViewerMember(ctx.api, ctx.t);
});
test.afterAll(async () => {
  if (!ctx) return;
  for (const name of made) await deletePanelsByName(ctx.api, ctx.t, name).catch(() => undefined);
  await disposeArranged(ctx);
});

/** Server-truth read of how many panels carry `name` (owner client). */
async function panelCount(name: string): Promise<number> {
  const res = await ctx.api.get(`/api/v1/workspaces/${ctx.t.workspaceId}/inventories/antibody-panels?limit=100`, ctx.t.headers);
  return asList(res.body).filter((p: any) => p.panel_name === name).length;
}

async function createViaUi(page: import('@playwright/test').Page, name: string, version: string) {
  await page.getByTestId('antibody-panels-create').click();
  await expect(page.getByTestId('antibody-panel-modal')).toBeVisible();
  await page.getByTestId('antibody-panel-name-input').fill(name);
  await page.getByTestId('antibody-panel-version-input').fill(version);
  await page.getByTestId('antibody-panel-markers-input').fill('CD3, FITC, UCHT1\nCD8, PE');
  await page.getByTestId('antibody-panel-notes-input').fill('e2e panel');
  await page.getByTestId('antibody-panel-submit').click();
}

test('AC7 @SI-032 — E2E-1640-E1: a workspace admin creates a panel and sees it listed with its marker count', async ({ page }) => {
  const name = `E2E panel ${uniq()}`;
  made.push(name);
  await openSession(page, 'owner', ctx.t);
  await page.goto(PAGE);
  await expect(page.getByTestId('antibody-panels-page')).toBeVisible();

  await createViaUi(page, name, 'v1');
  await expect(page.getByTestId('antibody-panel-modal')).toHaveCount(0);
  const row = page.locator(`[data-testid="antibody-panel-row"][data-panel-name="${name}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('v1');
  await expect(row).toContainText('2'); // two markers
  await expect(row).toContainText('e2e panel');
  // Server truth, not local state.
  expect(await panelCount(name)).toBe(1);
});

test('AC7 @SI-032 — E2E-1640-E2: creating a duplicate name+version shows the conflict inline and keeps the form open', async ({ page }) => {
  const name = `E2E dup ${uniq()}`;
  made.push(name);
  await openSession(page, 'owner', ctx.t);
  await page.goto(PAGE);
  await createViaUi(page, name, 'v1');
  await expect(page.getByTestId('antibody-panel-modal')).toHaveCount(0);

  await createViaUi(page, name, 'v1');
  const err = page.getByTestId('antibody-panel-server-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText(/already exists/i);
  await expect(page.getByTestId('antibody-panel-modal')).toBeVisible();
  // A different version of the same name is allowed.
  await page.getByTestId('antibody-panel-version-input').fill('v2');
  await page.getByTestId('antibody-panel-submit').click();
  await expect(page.getByTestId('antibody-panel-modal')).toHaveCount(0);
  await expect(page.locator(`[data-testid="antibody-panel-row"][data-panel-name="${name}"]`)).toHaveCount(2);
});

test('AC7 @SI-032 — E2E-1640-E3: client-side validation blocks an empty name and a malformed gate JSON', async ({ page }) => {
  await openSession(page, 'owner', ctx.t);
  await page.goto(PAGE);
  await page.getByTestId('antibody-panels-create').click();
  await page.getByTestId('antibody-panel-submit').click();
  await expect(page.getByTestId('antibody-panel-error-panelName')).toBeVisible();
  await page.getByTestId('antibody-panel-name-input').fill(`E2E bad ${uniq()}`);
  await page.getByTestId('antibody-panel-gate-input').fill('{oops');
  await page.getByTestId('antibody-panel-submit').click();
  await expect(page.getByTestId('antibody-panel-error-parentGateHierarchyText')).toContainText(/not valid JSON/i);
  await expect(page.getByTestId('antibody-panel-modal')).toBeVisible();
});

test('AC7 @SI-032 — E2E-1640-E4: delete asks for confirmation; cancel keeps the panel', async ({ page }) => {
  const name = `E2E keep ${uniq()}`;
  made.push(name);
  await openSession(page, 'owner', ctx.t);
  await page.goto(PAGE);
  await createViaUi(page, name, 'v1');
  const row = page.locator(`[data-testid="antibody-panel-row"][data-panel-name="${name}"]`);
  await expect(row).toBeVisible();

  await row.getByTestId('antibody-panel-delete').click();
  await expect(page.getByTestId('antibody-panel-delete-dialog')).toContainText(name);
  await page.getByTestId('antibody-panel-delete-dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('antibody-panel-delete-dialog')).toHaveCount(0);
  await expect(row).toBeVisible();
  expect(await panelCount(name)).toBe(1);
});

test('AC7 @SI-032 — E2E-1640-E4b: confirming the delete removes the panel and closes the dialog without an error', async ({ page }) => {
  const name = `E2E del ${uniq()}`;
  made.push(name);
  await openSession(page, 'owner', ctx.t);
  await page.goto(PAGE);
  await createViaUi(page, name, 'v1');
  const row = page.locator(`[data-testid="antibody-panel-row"][data-panel-name="${name}"]`);
  await expect(row).toBeVisible();

  await row.getByTestId('antibody-panel-delete').click();
  await page.getByTestId('antibody-panel-delete-confirm').click();
  await expect(page.getByTestId('antibody-panel-delete-error')).toHaveCount(0);
  await expect(page.getByTestId('antibody-panel-delete-dialog')).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(await panelCount(name)).toBe(0);
});

test('AC7 AC10 @SI-032 — E2E-1640-E5: a non-admin workspace member sees the list but no write controls, and the API refuses their writes', async ({ page }) => {
  const name = `E2E ro ${uniq()}`;
  made.push(name);
  // Arrange a panel as the workspace admin.
  const seeded = await ctx.api.post(`/api/v1/workspaces/${ctx.t.workspaceId}/inventories/antibody-panels`, { panel_name: name, panel_version: 'v1' }, ctx.t.headers);
  expect(seeded.status).toBeLessThan(300);

  await openSession(page, 'viewer', ctx.t);
  await page.goto(PAGE);
  await expect(page.locator(`[data-testid="antibody-panel-row"][data-panel-name="${name}"]`)).toBeVisible();
  await expect(page.getByTestId('antibody-panels-create')).toHaveCount(0);
  await expect(page.getByTestId('antibody-panel-delete')).toHaveCount(0);

  // Server-side enforcement, independent of the hidden controls.
  const tokens = await roleTokens('user');
  const viewerApi = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}`, ...ctx.t.headers } });
  try {
    const res = await viewerApi.post(apiUrl(`/api/v1/workspaces/${ctx.t.workspaceId}/inventories/antibody-panels`), {
      data: { panel_name: `E2E forbidden ${uniq()}` },
    });
    expect(res.status()).toBe(403);
  } finally {
    await viewerApi.dispose();
  }
});
