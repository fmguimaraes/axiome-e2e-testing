import { test, expect, request } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { testIdentityApi, signInAsTestIdentity, type Api } from './harness/api';
import { ensureTenant, createAnalysis, fetchAnalysis, type Tenant } from './harness/seed';

/**
 * AXI-1893 (epic AXI-1883) — Analysis lifecycle: delete, archive, unarchive +
 * audit. Scenario doc: `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md` §4.
 * Tags: @SI-035 (front: ProjectViewAnalyses list + detail panel), @SI-017
 * (back: view-analyses.service.ts), @SI-010 (gateway route).
 *
 * Covers FR22 (AC13, EC3), FR23 (AC14, EC4), NFR5/AC18 (not independently
 * re-verified here — see `UT-VA-020..026` back-end unit coverage).
 *
 * EC3 ("delete is blocked with a clear message when the analysis has governed
 * runs, evidence, or a published snapshot") is NOT given a Playwright
 * scenario here: every one of the three blocking artifacts requires either a
 * resolved governed rule-run against real column data or a resolved evidence
 * citation, neither reachable through a lightweight REST-only fixture (the
 * route this harness otherwise uses throughout). The refusal path itself is
 * exhaustively covered server-side (`UT-VA-023`..`UT-VA-026`,
 * `view-analyses.service.spec.ts`) and the dialog's error renderer
 * (`DeleteAnalysisModal.tsx`) is generic — it renders whatever message the
 * server returns, with no branch per blocking reason — so there is no
 * additional UI behavior a live 409 would prove that a mocked one does not.
 * `AXI-1893-delete-blocked-mocked.spec.ts` below covers the UI contract via a
 * routed 409, which IS real UI behavior (the dialog staying open, the message
 * rendering) without needing a live blocking artifact.
 */

const TOUR_IDS = ['orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions', 'graph-rules', 'charts-views', 'help', 'admin', 'collaboration'];

async function silenceTours(api: Api): Promise<void> {
  for (const tourId of TOUR_IDS) {
    const res = await api.ctx.put(apiUrl('/api/v1/onboarding-state'), { data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 } });
    expect(res.status(), `silence tour ${tourId}: ${await res.text()}`).toBeLessThan(300);
  }
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

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
  // The project storageState is already signed in, so a `/login` form
  // fill never renders (Login.tsx redirects) — see `signInAsTestIdentity`.
  await signInAsTestIdentity(page, tenant);
});

test.describe('AXI-1893 — delete and archive/unarchive lifecycle', () => {
  // Every `getByTitle` here is `exact`: the row's name cell carries
  // `title={name}` (ProjectViewAnalyses.tsx), and each fixture name contains
  // its action's word ("Delete", "Archive-Toggle", "Unarchive"), while
  // "Unarchive" itself contains "archive" — a default (substring,
  // case-insensitive) title match resolves to 2 elements in strict mode.
  // AC13 (FR22): a Delete action with confirmation removes the analysis.
  test('AC13 (FR22): delete with confirmation removes the analysis from the active list', async ({ page }) => {
    const name = `AXI-1893 Delete ${Date.now()}`;
    const id = await createAnalysis(api, tenant, name);
    await page.goto(analysesUrl());
    const row = page.getByTestId('analysis-row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.getByTitle('Delete', { exact: true }).click();
    await expect(page.getByTestId('delete-analysis-modal')).toBeVisible();
    await page.getByTestId('confirm-delete-analysis').click();
    await expect(page.getByTestId('delete-analysis-modal')).not.toBeVisible();
    await expect(page.getByTestId('analysis-row').filter({ hasText: name })).not.toBeVisible();

    const res = await api.get(`/api/v1/view-analyses/${id}`, tenant.headers);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // AC14 (FR23): an archived row shows Unarchive, never Archive.
  test('AC14 (FR23): archived row shows Unarchive in place of Archive', async ({ page }) => {
    const name = `AXI-1893 Archive-Toggle ${Date.now()}`;
    await createAnalysis(api, tenant, name);
    await page.goto(analysesUrl());
    const row = page.getByTestId('analysis-row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.getByTitle('Archive', { exact: true }).click();
    await expect(row.getByTitle('Archive', { exact: true })).not.toBeVisible();
    await expect(row.getByTitle('Unarchive', { exact: true })).toBeVisible();
  });

  // EC4 (FR23): unarchive restores the analysis (status back to active).
  test('EC4 (FR23): unarchive restores the analysis to active', async ({ page }) => {
    const name = `AXI-1893 Unarchive ${Date.now()}`;
    const id = await createAnalysis(api, tenant, name);
    // `performedBy` is derived server-side from the auth token (`@ActorId()`),
    // never from the request — nothing to pass here.
    await api.patch(`/api/v1/view-analyses/${id}/archive`, {}, tenant.headers);

    await page.goto(analysesUrl());
    const row = page.getByTestId('analysis-row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByTitle('Unarchive', { exact: true }).click();
    await expect(row.getByTitle('Archive', { exact: true })).toBeVisible();

    const after = await fetchAnalysis(api, tenant, id);
    expect(after.status).toBe('active');
  });

  // AC13/AC14 (FR22, FR23): every lifecycle route sits behind auth, server
  // side — an unauthenticated caller is refused before any business logic
  // (deny-by-default), independent of what the browser renders. (A genuine
  // "wrong role, logged in" check needs a second, lesser-privileged test
  // identity this harness does not provision — see manual-e2e §4.5.)
  test('AC13, AC14: lifecycle endpoints refuse an unauthenticated caller', async () => {
    const name = `AXI-1893 Permission ${Date.now()}`;
    const id = await createAnalysis(api, tenant, name);
    const anon = await request.newContext();
    const del = await anon.delete(apiUrl(`/api/v1/view-analyses/${id}`));
    expect(del.status()).toBe(401);
    const archive = await anon.patch(apiUrl(`/api/v1/view-analyses/${id}/archive`), { data: {} });
    expect(archive.status()).toBe(401);
    await anon.dispose();
  });
});
