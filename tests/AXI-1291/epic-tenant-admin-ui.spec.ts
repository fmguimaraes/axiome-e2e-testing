import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';

/**
 * AXI-1291 — Tenant Registry admin UI (epic acceptance, browser).
 * manual-e2e/AXI-1291-*.md — @SI-010 @SI-031 @SI-043.
 *
 * Uses the default admin `storageState` (AXI-1264) — no explicit `test.use`.
 * `/tenants` and `/tenants/new` are gated on `user?.userType === 'admin'`
 * (`Tenants.tsx`/`TenantCreate.tsx`), which the admin fixture satisfies. Seeds
 * one organization through the API so the create form has a real
 * `organizationId` to submit; the tenant id is unique per run.
 */
test.describe.configure({ mode: 'serial', timeout: 90_000 });

let api: Api;
let orgId: string;
let tenantId: string;

test.beforeAll(async () => {
  api = await adminApi();
  const org = await api.post('/api/v1/organizations', {
    name: `AXI-1291 UI org ${Date.now()}`,
    type: 'biotech',
  });
  expect(org.status, `create UI org: ${JSON.stringify(org.body)}`).toBeLessThan(300);
  orgId = org.body.id;
  tenantId = `e2e-1291-ui-${Date.now()}`;
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test('AC5 — the tenants list renders the registry (heading and table/empty state)', async ({ page }) => {
  await page.goto('/tenants');
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  await expect(page.getByRole('table').or(page.getByText(/No tenants/))).toBeVisible();
});

test('FR2 AC5 — registering a tenant through the form lands on its detail page', async ({ page }) => {
  await page.goto('/tenants/new');
  await page.locator('#tenantId').fill(tenantId);
  await page.locator('#organizationId').fill(orgId);
  await page.locator('#displayName').fill('AXI-1291 UI tenant');
  await page.locator('#residency').selectOption('eu-west-3');
  await page.getByRole('button', { name: 'Register tenant' }).click();

  await expect(page).toHaveURL(new RegExp(`/tenants/${tenantId}$`));
  await expect(page.getByRole('heading', { name: 'AXI-1291 UI tenant' })).toBeVisible();
  // Scoped to the status badge, not `getByText('Provisioning')` — the detail
  // page also carries a "Provisioning" FIELD LABEL (infra-pointer completeness)
  // unrelated to lifecycle status, and an unscoped text match would be ambiguous.
  await expect(page.locator('.rounded-full', { hasText: 'Provisioning' })).toBeVisible();
});

test('FR6 AC6 — suspend then reactivate the tenant from its detail page', async ({ page }) => {
  // Created `provisioning`; the suspend control only renders for `active`
  // (`canSuspend`), and the UI's own edit form carries no status control by
  // design (status changes only through the FR6 revocation control) — activate
  // via the API first so the UI flow under test is purely the suspend/reactivate
  // toggle itself.
  const activate = await api.patch(`/api/v1/tenants/${tenantId}`, { status: 'active' });
  expect(activate.status, `activate: ${JSON.stringify(activate.body)}`).toBeLessThan(300);

  await page.goto(`/tenants/${tenantId}`);
  await expect(page.getByRole('button', { name: 'Suspend tenant' })).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Suspend tenant' }).click();
  await expect(page.getByRole('button', { name: 'Reactivate tenant' })).toBeVisible();
  await expect(page.getByText('Suspended', { exact: true })).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Reactivate tenant' }).click();
  await expect(page.getByRole('button', { name: 'Suspend tenant' })).toBeVisible();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
});
