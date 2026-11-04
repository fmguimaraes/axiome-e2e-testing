import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { gotoSettled, seedScope } from './harness/new-analysis';
import { launchAndDrain, wizardBody } from './harness/result-page';

/**
 * AXI-2378 (epic AXI-2308, slice of AXI-2377 — out-of-scope AXI-2383's verdict box and
 * AXI-2379's chart-points-under-n=8 are untouched here): the result page's structured checks
 * panel (method/data/design, five checks declared today —
 * `apps/organization-service/src/result-page/result-page-checks.ts#CHECK_DEFINITIONS`) and the
 * "Why this test fired" card — the template's own binding-guard descriptions, moved OUT of the
 * checks panel into their own card.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` §
 * AXI-2378.2 / AXI-2378.3 (AXI-2378.4 is `automation: manual`, covered at unit level by
 * `UT-CHK-7703` instead).
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 * Run: `BASE_URL=<worktree Vite serving this branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2378-* --project=chromium --no-deps`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let t2RunId: string;

const pagePath = (runId: string) => `/projects/${t.projectId}/runs/${runId}`;

async function openPage(page: Page, runId: string): Promise<void> {
  await seedScope(page, t);
  await gotoSettled(page, pagePath(runId));
  await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
}

test.describe.serial('AXI-2378 result page — checks panel & why-this-test-fired card @SI-066 @SI-013 @SI-017', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.kruskal_wallis', 'stats.dunn_posthoc']);
    await silenceTours(await adminToken());
    t2RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', 'Does igg4_g_l differ across the clusters?', 'compare_groups', [
      { slot: 'groupingColumn', value: CLUSTER }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2378.2 (1-2) the Kruskal-Wallis tab\'s checks panel: denominator header, data-owner small-group finding raised, below-LOD not_applicable', async ({ page }) => {
    // Arrange
    await openPage(page, t2RunId);

    // Act
    const panel = page.getByTestId('rp-checks');

    // Assert — T2 declares Holm at the TEMPLATE level (`multipleTesting`, same fact on every
    // tab of this run), so method.no_multiple_testing_correction passes here too; only
    // data.group_n_floor raises for this fixture (clusters below the floor of 8)
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('rp-checks-header')).toHaveText('1 of 5 checks raised something');
    await expect(page.getByTestId('rp-check-data.group_n_floor')).toHaveText(/fewer than 8 subjects/);
    await expect(page.getByTestId('rp-check-data.group_n_floor')).toContainText('Raised');
    await expect(page.getByTestId('rp-check-data.below_lod_rate')).toContainText('Not applicable');
    await expect(page.getByTestId('rp-check-data.below_lod_rate')).toHaveText(/No below-detection-limit rate is captured/);
  });

  test('AXI-2378.2 (3-4) the Dunn tab: header unchanged, method check names Holm as the TEMPLATE\'s declaration, design check stays not_applicable (never "as you chose" — review bounce 1)', async ({ page }) => {
    // Arrange
    await openPage(page, t2RunId);

    // Act
    await page.getByTestId('rp-next').click();

    // Assert
    await expect(page.getByTestId('rp-checks-header')).toHaveText('1 of 5 checks raised something');
    const methodCheck = page.getByTestId('rp-check-method.no_multiple_testing_correction');
    await expect(methodCheck).toContainText('Passed');
    await expect(methodCheck).toHaveText(/declares a multiple-testing correction \(Holm/);
    const designCheck = page.getByTestId('rp-check-design.adjustment_choice');
    await expect(designCheck).toContainText('Not applicable');
    await expect(designCheck).toHaveText(/No signed design decision is recorded for this run\./);
    await expect(designCheck).not.toContainText('as you chose');
  });

  test('AXI-2378.3 "Why this test fired" is a separate card: the template\'s binding guards render there, never inside the checks panel', async ({ page }) => {
    // Arrange
    await openPage(page, t2RunId);

    // Act
    const whyFired = page.getByTestId('rp-why-fired');
    const checksPanel = page.getByTestId('rp-checks');

    // Assert
    await expect(whyFired).toContainText('A grouping column with three or more levels');
    await expect(whyFired).toContainText('One continuous outcome');
    await expect(checksPanel).not.toContainText('A grouping column with three or more levels');
    await expect(checksPanel).not.toContainText('One continuous outcome');
  });
});
