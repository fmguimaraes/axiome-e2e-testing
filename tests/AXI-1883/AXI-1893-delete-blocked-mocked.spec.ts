import { test, expect, Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { testIdentityApi, TEST_IDENTITY_EMAIL, type Api } from './harness/api';
import { ensureTenant, createAnalysis, type Tenant } from './harness/seed';

/**
 * AXI-1893 (epic AXI-1883) — EC3's delete refusal, via a ROUTED mock 409.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md` §4.2.
 *
 * `AXI-1893-analysis-lifecycle.spec.ts`'s header explains why a LIVE EC3
 * trigger (a governed run, evidence, or a published snapshot) is not
 * reachable through this harness's lightweight REST fixtures. This spec
 * proves the UI CONTRACT instead: `page.route` intercepts the DELETE call
 * and returns the same 409 shape the server emits
 * (`ViewAnalysesService.blockingArtifactsFor`), and the test asserts the
 * dialog's real behavior — it stays OPEN and renders the inline refusal
 * text — which is exactly what a live 409 would also prove, since
 * `DeleteAnalysisModal.tsx` is generic over the message (no per-reason
 * branch).
 */

const TOUR_IDS = ['orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions', 'graph-rules', 'charts-views', 'help', 'admin', 'collaboration'];

async function silenceTours(api: Api): Promise<void> {
  for (const tourId of TOUR_IDS) {
    const res = await api.ctx.put(apiUrl('/api/v1/onboarding-state'), { data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 } });
    expect(res.status(), `silence tour ${tourId}: ${await res.text()}`).toBeLessThan(300);
  }
}

async function loginViaUi(page: Page): Promise<void> {
  const password = process.env.E2E_TEST_PASSWORD;
  if (!password) throw new Error('E2E_TEST_PASSWORD is not set.');
  await page.goto('/login');
  await page.getByPlaceholder('your-email@company.com').fill(TEST_IDENTITY_EMAIL);
  await page.getByPlaceholder('••••••••••••').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 });
}

let api: Api;
let tenant: Tenant;

test.beforeAll(async () => {
  api = await testIdentityApi();
  await silenceTours(api);
  tenant = await ensureTenant(api);
});

test.afterAll(async () => {
  await api.ctx.dispose();
});

function analysesUrl(): string {
  return `/projects/${tenant.projectId}/view-analyses`;
}

test.beforeEach(async ({ page }) => {
  await loginViaUi(page);
});

test('EC3 (FR22, routed mock): a 409 held-artifact refusal keeps the delete dialog open and renders the message inline', async ({ page }) => {
  const name = `AXI-1893 EC3-Mocked ${Date.now()}`;
  const id = await createAnalysis(api, tenant, name);

  // The exact shape ConflictException serializes to, naming a held artifact
  // the way `blockingArtifactsFor` composes it (rule run(s)/evidence item(s)/
  // published snapshot(s)).
  await page.route(`**/api/v1/view-analyses/${id}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        statusCode: 409,
        message: 'Cannot delete ViewAnalysis: it has 2 rule run(s)',
      }),
    });
  });

  await page.goto(analysesUrl());
  const row = page.getByTestId('analysis-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 15_000 });

  await row.getByTitle('Delete').click();
  const modal = page.getByTestId('delete-analysis-modal');
  await expect(modal).toBeVisible();

  await page.getByTestId('confirm-delete-analysis').click();

  // The refusal renders inline and the dialog STAYS OPEN — a routed 409 must
  // never be read as success, and the row must never disappear from the list.
  await expect(page.getByTestId('delete-analysis-error')).toHaveText(/2 rule run\(s\)/);
  await expect(modal).toBeVisible();
  await expect(row).toBeVisible();
});
