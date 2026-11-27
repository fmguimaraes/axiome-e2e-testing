import { expect, test, type Page } from '@playwright/test';

/**
 * AXI-2455 W5 epic spec — converted from the manual scenario AXI-2532.7 (role editor shows the
 * SAP Management rows and no sap:write). Needs a platform ADMIN (the default login of the suite
 * when E2E_TEST_EMAIL/E2E_TEST_PASSWORD point at one). Skips for a non-admin.
 * The original text says "six rows"; the catalogue has since gained sap:review and per-question
 * rights, so this checks that the six CRUD rows exist and no sap:write row does.
 */
const SIX = ['View SAP', 'Create SAP draft', 'Edit SAP draft', 'Discard SAP draft', 'Finalise SAP', 'Run SAP'];

async function openRoleEditor(page: Page, roleName: string): Promise<void> {
  await page.goto('/roles');
  await page.getByPlaceholder('Search roles...').fill(roleName); // throwaway roles from other specs push it off page 1
  const row = page.locator('tr', { has: page.getByText(roleName, { exact: true }) }).first();
  await expect(row, `role ${roleName} listed`).toBeVisible();
  await row.getByRole('button').last().click();
  await page.getByRole('button', { name: 'Edit Role' }).click();
}

const checkboxOf = (page: Page, name: string) =>
  page.locator('label').filter({ has: page.getByText(name, { exact: true }) }).locator('input[type=checkbox]');

test.describe('AXI-2455 epic — role editor SAP rows (AXI-2532.7 converted) @SI-031', () => {
  test('epic-5 AXI-2532.7 Super Admin and Investigator show the six SAP rows ticked; no sap:write row', async ({ page }) => {
    const me = page.waitForResponse((r) => /\/api\/v1\/auth\/me$/.test(new URL(r.url()).pathname));
    await page.goto('/roles');
    const body = await (await me).json();
    test.skip(String(body.role).toUpperCase() !== 'ADMIN', 'needs a platform administrator');

    // /roles lists the organisation-level roles only (Super Admin, Investigator, ...). The fixed
    // WORKSPACE roles Editor/Viewer (manual step 3) are not listed there; AXI-2532.6 covers them by API.
    for (const roleName of ['Super Admin', 'Investigator']) {
      await openRoleEditor(page, roleName);
      for (const n of SIX) await expect(checkboxOf(page, n), `${roleName} ${n}`).toBeChecked();
      await expect(page.getByText('sap:write', { exact: false })).toHaveCount(0);
      await expect(page.getByText('Write SAP', { exact: true })).toHaveCount(0);
      await page.reload();
    }
  });
});
