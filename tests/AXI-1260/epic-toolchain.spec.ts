import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { storageStateFor } from '../../config/roles';
import { lintSpecs } from '../../scripts/lint-specs';

/**
 * Epic cross-story flow (AXI-1270 — AC17). `epic-*.spec.ts` is the Workflow-5
 * naming for flows no single story owns. This one exercises the toolchain
 * end-to-end across stories: the scaffold (AXI-1261) + environment targeting
 * (AXI-1262) + auth fixtures (AXI-1264) together let an authenticated browser
 * reach the app, and the binding linter (AXI-1265) holds over the whole suite.
 */
const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test.describe('epic — E2E toolchain integration', () => {
  test('AC17 — an admin session reaches the authenticated app shell', async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page).toHaveTitle(/Axiome/i);
  });

  test.describe('as the non-admin role', () => {
    test.use({ storageState: storageStateFor('user') });
    test('AC17 — a non-admin session also reaches the app across stories', async ({ page }) => {
      await page.goto('/');
      await expect(page).not.toHaveURL(/\/login/);
    });
  });

  test('AC17 — the whole suite complies with the binding conventions', () => {
    expect(lintSpecs(testsDir).filter((v) => v.severity === 'error')).toEqual([]);
  });
});
