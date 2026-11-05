import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { answered, askQuestion, choose, gotoSettled, seedScope, stubWizardRoutes, type WizardStubs } from './harness/new-analysis';

/**
 * Epic AXI-2308, W5 validation (replaces AXI-2375's React Flow graph): the Ready step's orientation
 * is a one-line lineage strip (`ReadyLineage.tsx`), plus the data check under "Handled for you".
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2375.1–.3.
 *
 * Stubbed in the browser (`harness/new-analysis.ts`), same discipline as AXI-2328/AXI-2361:
 * the intent-prefill suggestion + catalog, and the project SAP list.
 *
 * Fixtures: `opening-templates-paul-header.csv` (T1 eligible) and
 * `opening-templates-second-dataset.csv` (T1 also eligible — the "Use … instead" case).
 *
 * Run: `BASE_URL=<worktree Vite serving the AXI-2375 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2375-*`.
 * NOT RUN by this agent — `wt-up.sh` isolated-stack provisioning is blocked for story-developer
 * subagents (see `reference_wtup_blocked_for_story_developer_agents`); authored only.
 */

const FIXTURE_1 = 'opening-templates-paul-header.csv';
const FIXTURE_2 = 'opening-templates-second-dataset.csv';
const QUESTION = 'Does the outcome differ between the two groups?';

let api: Api;
let t: Tenant;
let dataset1: string;
let dataset2: string;

const pk = (datasetId: string) => `T1::${datasetId}`;

async function openWizard(page: Page, path: string, stubs: WizardStubs = {}) {
  await seedScope(page, t);
  await stubWizardRoutes(page, stubs);
  await gotoSettled(page, path);
  await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 15_000 });
}

/** Question → suggested intent → a T1 pair → Read confirm → Ready. */
async function reachReady(page: Page, datasetId: string) {
  await askQuestion(page, QUESTION);
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await choose(page, `na-choice-${pk(datasetId)}`);
  await expect(page.getByTestId('na-step-read')).toBeVisible();
  await choose(page, 'na-read-confirm');
  await expect(page.getByTestId('na-step-ready')).toBeVisible();
}

test.describe.serial('Ready step lineage strip @SI-066', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    api = await adminApi();
    t = await ensureTenant(api);
    dataset1 = await ingestCsvFixture(api, t, FIXTURE_1);
    dataset2 = await ingestCsvFixture(api, t, FIXTURE_2);
    await silenceTours(await adminToken());
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('FR47 — AXI-2375.1 the lineage reads the question, dataset with rows, population and method', async ({ page }) => {
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: { ...answered(QUESTION, 'compare_groups'), datasetIds: [dataset1] } } });
    await reachReady(page, dataset1);
    await expect(page.getByTestId('na-ready-lineage-question')).toHaveText(QUESTION);
    await expect(page.getByTestId('na-ready-lineage-dataset')).toContainText(/\(\d+ rows\)/);
    await expect(page.getByTestId('na-ready-lineage')).toContainText('Population');
    await expect(page.getByTestId('na-ready-lineage-method')).toContainText('Mann-Whitney U test');
    await expect(page.getByTestId('na-ready-row-dataCheck')).toContainText(/n=\d+ .* missing/);
  });

  test('FR47 FR51 — AXI-2375.2 changing the dataset on Ready updates the lineage', async ({ page }) => {
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: { ...answered(QUESTION, 'compare_groups'), datasetIds: [dataset1] } } });
    await reachReady(page, dataset1);
    const before = await page.getByTestId('na-ready-lineage-dataset').textContent();
    await page.getByTestId(`na-change-dataset-${dataset2}`).click();
    await expect(page.getByTestId('na-ready-lineage-dataset')).not.toHaveText(before ?? '');
  });

  test('FR47 — AXI-2375.3 the data check states its counts and the footer no longer mentions a signature', async ({ page }) => {
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: { ...answered(QUESTION, 'compare_groups'), datasetIds: [dataset1] } } });
    await reachReady(page, dataset1);
    const check = page.getByTestId('na-ready-row-dataCheck');
    await expect(check).toContainText(/n=\d+ .*\d+ missing/);
    await expect(check).toContainText(/Smallest group n=\d+ · \d+ tied values/);
    const step = page.getByTestId('na-step-ready');
    await expect(step).toContainText(/run · Esc back/);
    await expect(step).not.toContainText('signature');
  });
});
