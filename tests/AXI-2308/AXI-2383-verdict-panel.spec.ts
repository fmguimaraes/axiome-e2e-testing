import { test, expect, type Page, type Route } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { gotoSettled, seedScope } from './harness/new-analysis';
import { launchAndDrain, wizardBody } from './harness/result-page';

/**
 * AXI-2383 (epic AXI-2308, slice of AXI-2377): the result page's verdict panel — the STORED
 * proposal of the interpretation the result's template binds, read server-side from the
 * content-hashed decision object AXI-2381's interpretation run wrote, rendered ABOVE the
 * statistics sentence (`rp-answer`), labelled proposed (awaiting acceptance) vs accepted; a
 * refusal/unbound shows the server's reason and no sentence.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2383.
 *  - AXI-2383.1 is LIVE end to end: no opening template declares an interpretation today, so a
 *    real T2 run's page must say so (state `unbound`), with no sentence.
 *  - AXI-2383.2–.4 drive the REAL page with the REAL server response, patching only its
 *    `verdicts` field through `page.route` — no producer writes a resolved reading for an
 *    opening-template run yet (AXI-2381 follow-ups: no STATISTICAL-completion hook, no seeded
 *    branch rule, no template binding), so the proposed/accepted/refused states cannot be reached
 *    live today. What these pin is the rendering contract, not the server's resolution (that is
 *    pinned by UT-RP-2383-001..014).
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 * Run: `BASE_URL=<worktree Vite serving this branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2383-* --project=chromium --no-deps`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const SENTENCE = 'Not shown. igg4_g_l did not differ between the groups (p = 0.3990).';

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

/** Serve the REAL result-page response with only `verdicts` replaced (the first result's node). */
async function patchVerdicts(page: Page, verdictsFor: (nodeId: string) => unknown[]): Promise<void> {
  await page.route('**/runs/*/result-page', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, verdicts: verdictsFor(body.results[0].nodeId) } });
  });
}

const reading = (state: 'proposed' | 'accepted', nodeId: string) => ({
  state, nodeId, ruleCode: 'IMM-INT-KW', ruleVersion: 3, sentence: SENTENCE, matchedBranchId: 'not_significant', decisionDraftId: 'dd-e2e',
});

test.describe.serial('AXI-2383 result page — verdict panel from the bound interpretation @SI-066 @SI-017 @SI-002', () => {
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

  test('AXI-2383.1 a template with no bound interpretation: the panel says so above the statistics sentence, and shows no sentence @SI-066 @SI-017', async ({ page }) => {
    // Arrange
    await openPage(page, t2RunId);

    // Act
    const panel = page.getByTestId('rp-verdict');

    // Assert
    await expect(panel).toHaveAttribute('data-verdict-state', 'unbound');
    await expect(page.getByTestId('rp-verdict-explanation')).toHaveText("This result's template declares no interpretation, so no reading is proposed.");
    await expect(page.getByTestId('rp-verdict-sentence')).toHaveCount(0);
    const verdictBox = await panel.boundingBox();
    const answerBox = await page.getByTestId('rp-answer').boundingBox();
    expect(verdictBox!.y).toBeLessThan(answerBox!.y);
  });

  test('AXI-2383.2 a proposed reading: the stored sentence in bold, labelled awaiting acceptance, never as a decision @SI-066', async ({ page }) => {
    // Arrange
    await patchVerdicts(page, (nodeId) => [reading('proposed', nodeId)]);

    // Act
    await openPage(page, t2RunId);

    // Assert
    await expect(page.getByTestId('rp-verdict')).toHaveAttribute('data-verdict-state', 'proposed');
    await expect(page.getByTestId('rp-verdict-sentence')).toHaveText(SENTENCE);
    await expect(page.getByTestId('rp-verdict-eyebrow')).toContainText('proposed, awaiting acceptance');
    await expect(page.getByTestId('rp-verdict-explanation')).toContainText('Not yet accepted');
    await expect(page.getByTestId('rp-answer')).toBeVisible();
  });

  test('AXI-2383.3 an accepted reading is labelled accepted @SI-066', async ({ page }) => {
    // Arrange
    await patchVerdicts(page, (nodeId) => [reading('accepted', nodeId)]);

    // Act
    await openPage(page, t2RunId);

    // Assert
    await expect(page.getByTestId('rp-verdict')).toHaveAttribute('data-verdict-state', 'accepted');
    await expect(page.getByTestId('rp-verdict-eyebrow')).toContainText('accepted');
    await expect(page.getByTestId('rp-verdict-eyebrow')).not.toContainText('awaiting');
  });

  test('AXI-2383.4 a refused reading shows the server reason and no sentence @SI-066', async ({ page }) => {
    // Arrange
    const reason = 'No reading has been resolved for this result by the template\'s interpretation (IMM-INT-KW).';
    await patchVerdicts(page, (nodeId) => [{ state: 'refused', nodeId, ruleCode: 'IMM-INT-KW', reason }]);

    // Act
    await openPage(page, t2RunId);

    // Assert
    await expect(page.getByTestId('rp-verdict')).toHaveAttribute('data-verdict-state', 'refused');
    await expect(page.getByTestId('rp-verdict-explanation')).toHaveText(reason);
    await expect(page.getByTestId('rp-verdict-sentence')).toHaveCount(0);
  });
});
