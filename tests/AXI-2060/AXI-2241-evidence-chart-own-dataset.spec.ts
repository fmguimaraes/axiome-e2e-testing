import { test, expect, type Page } from '@playwright/test';

/**
 * AXI-2241 (epic AXI-2060) — evidence chart renders from its OWN dataset,
 * drawer + "Expand to Full View".
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2241.
 * Tags: @SI-033, @SI-034.
 *
 * READ-ONLY against the real seeded demo project "Microbiote IgG4 —
 * synthetic reproduction (AXI-2064)" (org CeRAINOM-IgG4, workspace Mag4).
 * No POST/PATCH call — this spec only opens pages and asserts on what
 * already exists: evidence `e3314f6a…` cites a `boxplot_v1` chart
 * (`38046212…`) bound to a DIFFERENT dataset (`4d4daa79…`/Tableau 2) than
 * the citing analysis's own dataset (`9315c385…`/Tableau 1) — the exact
 * AXI-1570-shaped defect case diagnosed live for this story.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = 'd78b6a26-4bc6-4bd2-8896-b2ff5e21b148';
const VIEW_ANALYSIS_ID = '0db04b5d-2957-4930-874d-7580e61797a2';
const CROSS_DATASET_EVIDENCE_ID = 'e3314f6a-87a8-40f3-ad31-7a2feb5eb61c';
const CROSS_DATASET_CHART_SPEC_ID = '38046212-efd4-448c-a426-3f007c0bedfc';
const CHART_OWN_DATASET_ID = '4d4daa79-e414-477b-87d4-79d53f4a967e';
const PAGE_DATASET_ID = '9315c385-e5a3-422c-a83b-fc728629e703';
const SAME_DATASET_EVIDENCE_ID = 'dbff5fef-5731-49a1-8d4b-99a6fcae7b85';
const SAME_DATASET_CHART_SPEC_ID = 'd9f76c3b-8273-4d13-8db3-355c40f3fa15';

async function signInAdmin(page: Page) {
  const email = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com';
  const password = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  // The demo admin account belongs to multiple organizations; prime the
  // top-menu scope (same localStorage keys `topMenuStore.ts` persists to)
  // so a direct deep-link resolves against CeRAINOM-IgG4/Mag4 instead of
  // "No Organization" / "Select workspace".
  await page.evaluate(([org, ws]) => {
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', ws);
  }, [ORGANIZATION_ID, WORKSPACE_ID]);
}

function evidenceUrl(evidenceId: string) {
  return `/projects/${PROJECT_ID}/view-analyses/${VIEW_ANALYSIS_ID}/evidences/${evidenceId}`;
}

/** Opens the (single, filtered-to-this-evidence) chart card's drawer. */
async function openDrawer(page: Page) {
  const card = page.locator('[role="button"].cursor-pointer').first();
  await card.click();
  await expect(page.getByText('Expand to Full View')).toBeVisible();
}

test.describe('AXI-2241 - evidence chart renders from its own dataset', { tag: ['@SI-033', '@SI-034'] }, () => {
  // This spec signs in via the demo-stack admin account through the login
  // form itself (never the fixture-org `setup` project's storageState — same
  // AXI-1884 opt-out shape), since the demo stack is a different org/user
  // than the `setup` project's fixture.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AC1 - the drawer renders a cross-dataset chart with real data, and withholds the page row count @SI-033', async ({ page }) => {
    await signInAdmin(page);
    await page.goto(evidenceUrl(CROSS_DATASET_EVIDENCE_ID));
    await openDrawer(page);

    // Real axes/points: the chart's drawn shapes, not just an empty frame.
    const plotShapes = page.locator('.js-plotly-plot svg.main-svg path');
    await expect.poll(async () => plotShapes.count(), { timeout: 15_000 }).toBeGreaterThan(2);
    await expect(page.getByText('Failed to load chart data')).toHaveCount(0);

    // The page's 462-row dataset-level count must never be shown for a spec
    // bound to a different dataset.
    await expect(page.getByText('Rows', { exact: true })).toHaveCount(0);
  });

  test('AC2 - Expand to Full View opens the chart on the SPEC\'S OWN dataset, not the page\'s @SI-033', async ({ page, context }) => {
    await signInAdmin(page);
    await page.goto(evidenceUrl(CROSS_DATASET_EVIDENCE_ID));
    await openDrawer(page);

    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByText('Expand to Full View').click(),
    ]);
    await newPage.waitForLoadState();

    expect(newPage.url()).toContain(`/datasets/${CHART_OWN_DATASET_ID}/chart/${CROSS_DATASET_CHART_SPEC_ID}`);
    expect(newPage.url()).not.toContain(PAGE_DATASET_ID);
    await expect(newPage.getByText('Chart Not Available')).toHaveCount(0);
  });

  test('AC3 - a same-dataset evidence is unchanged: drawer shows the row count, full view opens on the page dataset @SI-033', async ({ page, context }) => {
    await signInAdmin(page);
    await page.goto(evidenceUrl(SAME_DATASET_EVIDENCE_ID));
    await openDrawer(page);

    await expect(page.getByText('Rows', { exact: true })).toBeVisible();

    const [newPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByText('Expand to Full View').click(),
    ]);
    await newPage.waitForLoadState();

    expect(newPage.url()).toContain(`/datasets/${PAGE_DATASET_ID}/chart/${SAME_DATASET_CHART_SPEC_ID}`);
    await expect(newPage.getByText('Chart Not Available')).toHaveCount(0);
  });
});
