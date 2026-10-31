import { test, expect } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { drainGoverned, ingestCsvFixture } from './harness/opening-templates';
import { gotoSettled, seedScope } from './harness/new-analysis';
import { launchAndDrain, wizardBody } from './harness/result-page';

/**
 * AXI-2371 (epic AXI-2308, owner ruling 2026-10-31) — "one row per question": N wizard launches
 * of the SAME question against N project datasets create N `ViewAnalysis` rows (the model is
 * UNCHANGED) that now share ONE `questionNumber` (the backend half of this story — reused, not
 * re-allocated, through `GuidedMemoryStore.allocateQuestionNumber`). The Analyses table collapses
 * those rows into ONE parent row showing a dataset count; expanding it reveals the per-dataset
 * children, each still opening through the AXI-2368 facade rule unchanged. A row whose key is
 * absent, or held by just one row, renders exactly as before this story.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2371.
 *
 * Fixtures: `opening-templates-paul-header.csv` (dataset 1: grouping `sexe`, outcome `igg4_g_l`)
 * and `opening-templates-second-dataset.csv` (dataset 2: grouping `group_arm`, outcome
 * `biomarker_x`) — the AXI-2361 precedent pair, T1 (`compare_groups`) eligible on both.
 * Launch path reused from AXI-2327/AXI-2368: the wizard's own request,
 * `POST /guided-analysis/wizard-runs` (`wizardBody` + `launchAndDrain`).
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2371-* --project=chromium --no-deps`.
 * NOT run for this handoff: no isolated stack provisioned for a story-developer agent
 * (`wt-up.sh` blocked for agents — see the story's handoff report). Do not read a green/red
 * result into this file — none was taken.
 */

const FIXTURE_1 = 'opening-templates-paul-header.csv';
const FIXTURE_2 = 'opening-templates-second-dataset.csv';
const SHARED_QUESTION = 'Does the marker change?';

let api: Api;
let t: Tenant;
let dataset1: AnchoredDataset;
let dataset2: AnchoredDataset;
let analysis1: string;
let analysis2: string;
let soloAnalysisId: string;

const listPath = () => `/projects/${t.projectId}/view-analyses`;

test.describe.serial('AXI-2371 Analyses table: one row per question @SI-030 @SI-047 @SI-066', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const id1 = await ingestCsvFixture(api, t, FIXTURE_1);
    const id2 = await ingestCsvFixture(api, t, FIXTURE_2);
    const a1 = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId: id1 });
    const a2 = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId: id2 });
    if (!a1 || !a2) throw new Error('fixture dataset(s) could not be anchored');
    dataset1 = a1;
    dataset2 = a2;
    await approveCarriersFor(['stats.mann_whitney_u']);
    await silenceTours(await adminToken());

    // T1 on BOTH datasets, SAME question text — the "one question, two datasets" shape.
    const run1 = await api.post('/api/v1/guided-analysis/wizard-runs', wizardBody(
      t, dataset1, 'T1', SHARED_QUESTION, 'compare_groups',
      [{ slot: 'groupingColumn', value: 'sexe' }, { slot: 'outcome', value: 'igg4_g_l' }],
    ), t.headers);
    expect(run1.status, JSON.stringify(run1.body)).toBe(200);
    analysis1 = run1.body.viewAnalysisId;
    await drainGoverned(api, t, run1.body.runId);

    const run2 = await api.post('/api/v1/guided-analysis/wizard-runs', wizardBody(
      t, dataset2, 'T1', SHARED_QUESTION, 'compare_groups',
      [{ slot: 'groupingColumn', value: 'group_arm' }, { slot: 'outcome', value: 'biomarker_x' }],
    ), t.headers);
    expect(run2.status, JSON.stringify(run2.body)).toBe(200);
    analysis2 = run2.body.viewAnalysisId;
    await drainGoverned(api, t, run2.body.runId);

    // A lone question on dataset1 (no sibling) — req 2's "unchanged" case.
    const soloRunId = await launchAndDrain(api, t, wizardBody(
      t, dataset1, 'T1', 'Is it elevated at week 4?', 'compare_groups',
      [{ slot: 'groupingColumn', value: 'sexe' }, { slot: 'outcome', value: 'igg4_g_l' }],
    ));
    const soloRecord = await api.get(`/api/v1/guided-analysis/wizard-runs?projectId=${t.projectId}&runId=${soloRunId}`, t.headers);
    soloAnalysisId = soloRecord.body.records[0].viewAnalysisId;
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2371.2 — T1: one question launched on 2 datasets shows ONE parent row that expands to 2 @SI-030 @SI-047', async ({ page }) => {
    await seedScope(page, t);
    await gotoSettled(page, listPath());

    // Exactly one question-group row for the shared question, no bare rows for its two analyses.
    const header = page.getByTestId('question-group-row').filter({ hasText: SHARED_QUESTION });
    await expect(header).toBeVisible();
    await expect(header.getByTestId('question-dataset-count')).toHaveText('2 datasets');
    await expect(page.locator(`[data-row-id="${analysis1}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-row-id="${analysis2}"]`)).toHaveCount(0);

    // Expand: exactly 2 children, one per dataset.
    await header.getByRole('button').click();
    await expect(page.locator(`[data-row-id="${analysis1}"]`)).toBeVisible();
    await expect(page.locator(`[data-row-id="${analysis2}"]`)).toBeVisible();

    // Collapse again.
    await header.getByRole('button').click();
    await expect(page.locator(`[data-row-id="${analysis1}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-row-id="${analysis2}"]`)).toHaveCount(0);
  });

  test('AXI-2371.2 — a child still opens through the unchanged AXI-2368 facade on double-click @SI-066 @SI-035', async ({ page }) => {
    await seedScope(page, t);
    await gotoSettled(page, listPath());
    const header = page.getByTestId('question-group-row').filter({ hasText: SHARED_QUESTION });
    await header.getByRole('button').click();
    const child = page.locator(`[data-row-id="${analysis1}"]`);
    await child.click();
    await page.getByRole('button', { name: /Open analysis/ }).click();
    // A wizard run with both runId and templateId lands on the result page (AXI-2368 rule).
    await expect(page).toHaveURL(new RegExp(`/projects/${t.projectId}/runs/`), { timeout: 30_000 });
  });

  test('AXI-2371.3 — T2: a lone questionNumber renders unchanged — no question-group row, a plain row @SI-030', async ({ page }) => {
    await seedScope(page, t);
    await gotoSettled(page, listPath());
    await expect(page.locator(`[data-row-id="${soloAnalysisId}"]`)).toBeVisible();
    const soloRow = page.locator(`[data-row-id="${soloAnalysisId}"]`);
    // Its own row, not inside any question-group header.
    await expect(soloRow.locator('xpath=ancestor::table').first()).toBeVisible();
    await expect(page.getByTestId('question-group-row').filter({ hasText: 'Is it elevated at week 4?' })).toHaveCount(0);
  });
});
