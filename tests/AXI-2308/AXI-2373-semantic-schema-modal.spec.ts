import { test, expect, type Page } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { ingestCsvFixture } from './harness/opening-templates';
import { seedScope } from './harness/new-analysis';

/**
 * AXI-2373 (epic AXI-2308 Platform Opening: Human Guided — FR13-FR15, AXI-2326; @SI-066
 * @SI-014 @SI-002). The project dataset table's new per-row action that shows
 * `GET /v1/discovery/datasets/:datasetId/semantic-declaration`'s `templateColumnBindings` in
 * a read-only modal: revision (+ who/when), the bindings table (column/role/unit/control
 * levels), and a collapsible raw JSON view. Null response -> the FR14 empty state; a failed
 * call -> an error state.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2373.
 *
 * Fixture: `axi2373-tableau1-group-pct.csv` — Tableau-1 headers (serum, group, reference,
 * isotype, pct), AXI-2326's own recognised format: once filled it carries a `group` binding
 * with `controlLevels: ['HD']` and a `continuous_outcome` binding on `pct` with `unit: '%'`,
 * matching the real demo dataset the story was written against (f5344441-...).
 *
 * The fill is NOT auto-triggered on ingest (AXI-2326 follow-up) — this spec calls
 * `POST …/semantic-declaration/ensure-recognized-fill` itself, exactly as the AXI-2328 wizard
 * does on upload-complete, so AC2's dataset carries a real declaration to show.
 *
 * Run: `BASE_URL=<Vite serving the AXI-2373 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2373-*`.
 * Authored but NOT run for this handoff: the isolated stack (`wt-up.sh`) is blocked for
 * story-developer subagents. Do not read a green/red result into this file — none was taken.
 * The API response + unit-rendering contract it exercises WAS verified directly against the
 * running shared demo stack (curl against the real f5344441-c460-4c18-aac0-da8468891510 and
 * f93231f3-20e7-445c-b0b3-8d767444ecb3 datasets, matching this story's component tests).
 */

const FIXTURE_WITH_SCHEMA = 'axi2373-tableau1-group-pct.csv';
const FIXTURE_NO_SCHEMA = 'opening-templates-second-dataset.csv'; // unrecognised header set (EC3)

let api: Api;
let t: Tenant;
let datasetWithSchemaId: string;
let datasetNoSchemaId: string;

async function openProjectDatasets(page: Page) {
  await seedScope(page, t);
  await page.goto('/project-datasets');
}

test.describe.serial('AXI-2373 semantic schema modal @AXI-2373', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are not governed by describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    datasetWithSchemaId = await ingestCsvFixture(api, t, FIXTURE_WITH_SCHEMA);
    await api.post(`/api/v1/discovery/datasets/${datasetWithSchemaId}/semantic-declaration/ensure-recognized-fill`, {}, t.headers);
    datasetNoSchemaId = await ingestCsvFixture(api, t, FIXTURE_NO_SCHEMA);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AC1 AXI-2373.1 the row action opens the read-only modal for that row\'s dataset @SI-066', async ({ page }) => {
    await openProjectDatasets(page);
    const row = page.locator('tr').filter({ hasText: FIXTURE_WITH_SCHEMA.replace('.csv', '') }).first();
    await row.getByTestId('row-view-semantic-schema').click();
    await expect(page.getByTestId('semantic-schema-modal')).toBeVisible();
  });

  test('AC2 AXI-2373.2 the bindings table shows the group/control-level and unit columns @SI-014 @SI-002', async ({ page }) => {
    await openProjectDatasets(page);
    const row = page.locator('tr').filter({ hasText: FIXTURE_WITH_SCHEMA.replace('.csv', '') }).first();
    await row.getByTestId('row-view-semantic-schema').click();
    const modal = page.getByTestId('semantic-schema-modal');
    await expect(modal).toBeVisible();
    const rows = modal.getByTestId('semantic-schema-binding-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'group' })).toContainText(['Group', 'HD']);
    await expect(rows.filter({ hasText: 'pct' })).toContainText(['Continuous outcome', '%']);
    await expect(modal.getByTestId('semantic-schema-revision')).toContainText('Revision 1');
    await modal.getByTestId('semantic-schema-raw-json').locator('summary').click();
    await expect(modal.getByTestId('semantic-schema-raw-json')).toContainText('templateColumnBindings');
  });

  test('AC3 AXI-2373.3 an unrecognised header shows the FR14 empty state, not a table @SI-014', async ({ page }) => {
    await openProjectDatasets(page);
    const row = page.locator('tr').filter({ hasText: FIXTURE_NO_SCHEMA.replace('.csv', '') }).first();
    await row.getByTestId('row-view-semantic-schema').click();
    const modal = page.getByTestId('semantic-schema-modal');
    await expect(modal.getByTestId('semantic-schema-empty')).toContainText('FR14');
    await expect(modal.getByTestId('semantic-schema-bindings-table')).toHaveCount(0);
  });

  test('AC1 AXI-2373.4 the modal closes on Escape, without navigating away', async ({ page }) => {
    await openProjectDatasets(page);
    const row = page.locator('tr').filter({ hasText: FIXTURE_WITH_SCHEMA.replace('.csv', '') }).first();
    await row.getByTestId('row-view-semantic-schema').click();
    const modal = page.getByTestId('semantic-schema-modal');
    await expect(modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(page).toHaveURL(/\/project-datasets/);
  });
});
