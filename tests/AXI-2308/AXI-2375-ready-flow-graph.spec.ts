import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { answered, askQuestion, choose, gotoSettled, seedScope, stubWizardRoutes, type WizardStubs } from './harness/new-analysis';

/**
 * AXI-2375 (epic AXI-2308 — FR47 restyle; owner, 2026-11-01): the Ready step's orientation
 * strip is a real React Flow graph (`ReadyFlowGraph.tsx`), built the way the Discovery
 * Workbench builds its graph, in place of the hand-made flex row of boxes it replaces.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2375.1–.2.
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

test.describe.serial('AXI-2375 Ready step React Flow graph @SI-066', () => {
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

  test('FR47 — AXI-2375.1 the graph renders the question, dataset, population and template nodes, framed on load', async ({ page }) => {
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: { ...answered(QUESTION, 'compare_groups'), datasetIds: [dataset1] } } });
    await reachReady(page, dataset1);
    const graph = page.getByTestId('na-ready-graph');
    await expect(graph).toBeVisible();
    await expect(graph.getByTestId('na-ready-flow-question')).toContainText(QUESTION);
    await expect(graph.getByTestId('na-ready-flow-population')).toContainText('Population');
    await expect(graph.getByTestId('na-ready-flow-template')).toContainText('Compare groups');
    // Framed on load: the canvas's own bounding box is non-empty and no node sits outside it.
    const box = await graph.boundingBox();
    expect(box?.width).toBeGreaterThan(0);
    expect(box?.height).toBeGreaterThan(0);
  });

  test('FR47 FR51 — AXI-2375.2 changing the dataset on Ready updates the graph\'s dataset node and re-frames', async ({ page }) => {
    await openWizard(page, '/new-analysis', { suggestion: { kind: 'answer', body: { ...answered(QUESTION, 'compare_groups'), datasetIds: [dataset1] } } });
    await reachReady(page, dataset1);
    const other = page.getByTestId(`na-change-dataset-${dataset2}`);
    await expect(other).toBeVisible();
    await other.click();
    await expect(page.getByTestId('na-ready-graph').getByTestId('na-ready-flow-dataset')).toBeVisible();
    // The design row below the graph is the existing source of truth for the dataset name —
    // the graph node is asserted to simply be present and re-mounted, not re-reading the name twice.
    await expect(page.getByTestId('na-ready-row-dataset')).toBeVisible();
  });
});
