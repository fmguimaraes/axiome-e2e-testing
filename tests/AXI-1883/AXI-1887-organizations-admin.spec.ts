import { test, expect, request, type APIRequestContext } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';
import { ROLES } from '../../config/roles';

/**
 * AXI-1887 (epic AXI-1883 UI/UX Hardening) — Organizations admin: search,
 * pagination, page size, add-user (FR7-FR10, AC4, AC5, edge EC5).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md` §4-5.
 * Tags: @SI-031 (front admin UI).
 *
 * AC5 ("Add user" on `/organizations/:id`) has NO scenario here: this story's
 * investigation reproduced the reported crash directly on `/organizations/:id`
 * and `/organizations/:id/add-user` — "Maximum update depth exceeded" in
 * `<Layout>`/`TopMenu.tsx:85`, before the Add User page's own content ever
 * mounts. That crash is owned by story AXI-1885 (the single-org
 * auto-select/clear effect reading a `organizations.filter(...)` array rebuilt
 * every render). No defect was found inside `OrganizationAddUser.tsx` itself.
 * See the scenario doc's §9 run note.
 */

const admin = ROLES.find((r) => r.name === 'admin')!;

async function createFixtureOrg(api: APIRequestContext, name: string): Promise<string> {
  const login = await api.post(`${API_BASE_URL}/api/v1/auth/login`, {
    data: { email: admin.email, password: admin.password },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const { accessToken } = await login.json();

  const created = await api.post(`${API_BASE_URL}/api/v1/organizations`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { name, type: 'biotech' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return (await created.json()).id as string;
}

test.describe('AXI-1887 - Organizations admin search, pagination, page size @SI-031', () => {
  test.describe.configure({ timeout: 60_000 });

  let api: APIRequestContext;
  let fixtureName: string;

  test.beforeAll(async () => {
    api = await request.newContext();
    fixtureName = `AXI-1887 Search Probe ${Date.now().toString(36)}`;
    await createFixtureOrg(api, fixtureName);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  const searchBox = (page: import('@playwright/test').Page) =>
    page.getByPlaceholder('Filter or search (3 character minimum)');

  test('AC4 - search returns the matching organization row', async ({ page }) => {
    await page.goto('/organizations');
    await expect(searchBox(page)).toBeVisible();

    await searchBox(page).fill(fixtureName);
    await expect(page.getByText(fixtureName, { exact: true })).toBeVisible();
    // Regression guard: a search result must never navigate the admin away
    // from the list (see the AXI-1887 defect this story fixed).
    await expect(page).toHaveURL(/\/organizations$/);
  });

  test('AC4 EC5 - a search narrowing to exactly one result does not navigate away, and clearing it restores the full list', async ({ page }) => {
    await page.goto('/organizations');
    await expect(searchBox(page)).toBeVisible();

    // The fixture org's full generated name is unique in the fixture set, so
    // this search narrows to exactly one row — the exact condition that used
    // to trigger TopMenu's single-org auto-select effect and navigate away.
    await searchBox(page).fill(fixtureName);
    await expect(page.getByText(fixtureName, { exact: true })).toBeVisible();
    await expect(searchBox(page)).toHaveValue(fixtureName);
    await expect(page).toHaveURL(/\/organizations$/);

    await searchBox(page).fill('');
    await expect(page.getByText(/Showing \d+ to \d+ of \d+/)).toBeVisible();
  });

  test('AC4 - pagination renders above the table and the page-size selector changes the page size', async ({ page }) => {
    await page.goto('/organizations');
    await expect(searchBox(page)).toBeVisible();

    const summary = page.getByText(/Showing \d+ to \d+ of \d+/);
    await expect(summary).toBeVisible();

    const searchBoxBox = await searchBox(page).boundingBox();
    const summaryBox = await summary.boundingBox();
    const table = page.getByTestId('organizations-table');
    const tableBox = await table.boundingBox();

    expect(searchBoxBox).toBeTruthy();
    expect(summaryBox).toBeTruthy();
    expect(tableBox).toBeTruthy();
    // Pagination/page-size bar sits between the search bar and the table (FR8).
    expect(summaryBox!.y).toBeGreaterThan(searchBoxBox!.y);
    expect(summaryBox!.y).toBeLessThan(tableBox!.y);

    const initialSummaryText = (await summary.textContent()) ?? '';
    const total = Number(initialSummaryText.match(/of (\d+)/)?.[1] ?? '0');
    const expectedUpperBound = Math.min(50, total);

    const pageSizeSelect = page.locator('label', { hasText: 'Rows per page' }).locator('select');
    await expect(pageSizeSelect).toBeVisible();
    await pageSizeSelect.selectOption('50');
    await expect(page.getByText(new RegExp(`Showing 1 to ${expectedUpperBound} of \\d+`))).toBeVisible();
  });
});
