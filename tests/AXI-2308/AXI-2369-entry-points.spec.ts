import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { seedScope } from './harness/new-analysis';

/**
 * AXI-2369 (epic AXI-2308 — owner request 2026-10-31; @SI-030 @SI-035 @SI-046). Four UI-only
 * entry points that all converge on the ONE wizard path (`newAnalysisPath`):
 *  - the project rail's "New analysis" pill, above Overview, project-scoped (SI-030);
 *  - the SAME pill, from the same shared component, in the global-nav OVERLAY drawer that
 *    replaces the rail on the Discovery Workbench / New analysis page (SI-046);
 *  - the Analysis page header, where it is now the primary action beside a secondary
 *    "Discovery Workbench" (SI-035);
 *  - Dataset Tables' header (Guided Analysis / New analysis removed, Explorer kept) and its new
 *    per-row "Analyse this dataset" action, preselecting that one dataset (SI-030).
 * A fifth change quiets the Analysis table: `#` and Facets start hidden (still offered under
 * Columns); a saved view/URL that explicitly names them is unaffected (SI-035).
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2369.
 *
 * No wizard internals are driven here (owned by AXI-2328/2349/2345, read-only to this story):
 * every scenario stops at "the right URL was opened" / "the right control is gone".
 *
 * Fixture: `opening-templates-paul-header.csv` (AXI-2339; synthetic), ingested and linked to the
 * project, so Dataset Tables has one real IMPORTED row.
 *
 * Run: `BASE_URL=<Vite serving the AXI-2369 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2369-*`.
 * Authored but NOT run for this handoff: the isolated stack (`wt-up.sh`) is blocked for
 * story-developer subagents. Do not read a green/red result into this file — none was taken.
 */

const FIXTURE = 'opening-templates-paul-header.csv';

let api: Api;
let t: Tenant;
let datasetId: string;

test.describe.serial('AXI-2369 new-analysis entry points @AXI-2369', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are not governed by describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    await silenceTours(await adminToken());
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  async function openProjectPage(page: Page, path: string) {
    await seedScope(page, t);
    await page.goto(path);
  }

  test('owner item 1 — AXI-2369.2 the rail shows "New analysis" above Overview, project-scoped, opening the wizard with no dataset preselected @SI-030 @AXI-2369', async ({ page }) => {
    await openProjectPage(page, '/project-datasets');
    const pill = page.getByTestId('rail-new-analysis');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/New analysis/);
    await pill.click();
    await expect(page).toHaveURL(/\/new-analysis(?!\?.*datasetId)/);
  });

  test('owner item 1 — AXI-2369.2 collapsing the rail turns the pill icon-only with a tooltip @SI-030 @AXI-2369', async ({ page }) => {
    await openProjectPage(page, '/project-datasets');
    await page.getByRole('button', { name: 'Collapse' }).click();
    const pill = page.getByTestId('rail-new-analysis');
    await expect(pill).toBeVisible();
    await expect(pill).not.toHaveText(/New analysis/);
    await pill.hover();
    await expect(page.getByText('New analysis', { exact: true })).toBeVisible();
  });

  test('owner item 1 — AXI-2369.2 the rail pill is absent with no active project @SI-030 @AXI-2369', async ({ page }) => {
    await page.addInitScript(([org]) => { localStorage.setItem('axiome-top-org', org); }, [t.orgId] as const);
    await page.goto('/workspaces');
    await expect(page.getByTestId('rail-new-analysis')).toHaveCount(0);
  });

  test('overlay scope addition — AXI-2369.3 the global-nav overlay on the Discovery Workbench shows the SAME pill above Overview @SI-046 @AXI-2369', async ({ page }) => {
    await openProjectPage(page, `/projects/${t.projectId}/discovery-workbench`);
    await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const panel = page.locator('#workbench-nav-drawer');
    await expect(panel).toBeVisible();
    const pill = panel.getByTestId('overlay-new-analysis');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/New analysis/);
    await pill.click();
    await expect(page).toHaveURL(/\/new-analysis(?!\?.*datasetId)/);
  });

  test('overlay scope addition — AXI-2369.3 the Discovery Workbench canvas itself is unaffected (only the menu content changed) @SI-046 @AXI-2369', async ({ page }) => {
    await openProjectPage(page, `/projects/${t.projectId}/discovery-workbench`);
    const canvas = page.getByTestId('discovery-workbench');
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.locator('#workbench-nav-drawer')).toBeVisible();
    // the drawer is an overlay above the SAME canvas, not a relayout of it
    await expect(canvas).toBeVisible();
    const boxAfter = await canvas.boundingBox();
    expect(boxAfter?.width).toBe(box?.width);
  });

  test('owner item 2 — AXI-2369.4 the Analysis page header leads with "New analysis", Discovery Workbench secondary beside it @SI-035 @AXI-2369', async ({ page }) => {
    await openProjectPage(page, `/projects/${t.projectId}/view-analyses`);
    const primary = page.getByTestId('header-new-analysis');
    const secondary = page.getByTestId('open-discovery-workbench');
    await expect(primary).toBeVisible();
    await expect(primary).toHaveText(/New analysis/);
    await expect(secondary).toBeVisible();
    await expect(secondary).toHaveText(/Discovery Workbench/);
    await primary.click();
    await expect(page).toHaveURL(/\/new-analysis(?!\?.*datasetId)/);
  });

  test('owner item 3 — AXI-2369.5 Dataset Tables keeps only Explorer in the header @SI-030 @AXI-2369', async ({ page }) => {
    await openProjectPage(page, '/project-datasets');
    await expect(page.getByRole('button', { name: 'Explorer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Guided Analysis' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New analysis', exact: true })).toHaveCount(0);
  });

  test('owner item 3 — AXI-2369.5 "Analyse this dataset" opens the wizard preselected on that row @SI-030 @AXI-2369', async ({ page }) => {
    await openProjectPage(page, '/project-datasets');
    const row = page.locator('tr', { has: page.getByTestId('row-analyse-dataset') }).first();
    await expect(row).toBeVisible();
    await row.getByTestId('row-analyse-dataset').click();
    await expect(page).toHaveURL(new RegExp(`/new-analysis\\?datasetId=${datasetId}`));
  });

  test('owner item 4 — AXI-2369.6 "#" and Facets start hidden on the Analysis table, still offered under Columns @SI-035 @AXI-2369', async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('axiome.viewAnalyses.listState'));
    await openProjectPage(page, `/projects/${t.projectId}/view-analyses`);
    await expect(page.getByRole('columnheader', { name: 'Question id' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Facets' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Columns' }).click();
    await page.getByRole('menuitemcheckbox', { name: '#' }).click();
    await expect(page.getByRole('columnheader', { name: 'Question id' })).toBeVisible();
  });

  test('owner item 4 — AXI-2369.6 a URL that explicitly names "#"/Facets honours it unchanged @SI-035 @AXI-2369', async ({ page }) => {
    await openProjectPage(page, `/projects/${t.projectId}/view-analyses?cols=questionNumber,facets,dataset,interpretationCount,evidenceCount,updatedAt`);
    await expect(page.getByRole('columnheader', { name: 'Question id' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Facets' })).toBeVisible();
  });
});
