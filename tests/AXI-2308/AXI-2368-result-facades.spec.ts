import { test, expect } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { drainGoverned, ingestCsvFixture } from './harness/opening-templates';
import { gotoSettled, seedScope } from './harness/new-analysis';
import {
  INVESTIGATOR_ROLE_ID,
  addMember,
  launchAs,
  person,
  signIn,
  wizardBody,
  type Person,
} from './harness/result-page';

/**
 * AXI-2368 (epic AXI-2308, owner 2026-10-31) — "two facades of the same thing": the result page
 * (AXI-2327) and the canonical explorer (`/projects/:p/view-analyses/:analysisId`) are two views
 * of the SAME view-analysis. The routing rule: a run with BOTH a `runId` AND a `templateId` is a
 * wizard run and opens the result page; anything else — no run, automatic mode, or a legacy
 * guided-planner run with no `templateId` — opens the explorer. Covers three surfaces: the
 * analyses-list row click, the result page's "Open in explorer", and the explorer's "Result view".
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2368 (.2–.3).
 * § AXI-2368.4 (a legacy guided-planner run with no `templateId`) stays `automation: manual` — not
 * reproducible through the current UI (no seeding path for a pre-AXI-2338 run record).
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 * Launch path reused from `AXI-2327-result-page.spec.ts`: the wizard's own request,
 * `POST /guided-analysis/wizard-runs` (`wizardBody` + `launchAndDrain`/`launchAs`).
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2368-* --project=chromium --no-deps`.
 * NOT run for this story (no isolated stack provisioned for a story-developer agent —
 * see the story's handoff report); recorded as deferred in the manual-e2e run notes.
 */

const FIXTURE = 'opening-templates-paul-header.csv';

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let investigator: Person;
let adminUserId: string;
let t1RunId: string;
let t1AnalysisId: string;
let plainAnalysisId: string;
let hisRunId: string;

const listPath = () => `/projects/${t.projectId}/view-analyses`;
const explorerPath = (analysisId: string) => `/projects/${t.projectId}/view-analyses/${analysisId}`;
const resultPath = (runId: string) => `/projects/${t.projectId}/runs/${runId}`;

test.describe.serial('AXI-2368 result facades: one analysis row, two entry points @SI-066 @SI-035 @SI-030 @SI-033 @SI-013', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u']);
    await silenceTours(await adminToken());
    const me = await api.get('/api/v1/auth/me', t.headers);
    adminUserId = me.body.id;
    investigator = await person('investigator', t.workspaceId);
    await addMember(api, t, investigator, INVESTIGATOR_ROLE_ID);
    await silenceTours(investigator.accessToken);

    const t1Body = wizardBody(t, dataset, 'T1', 'Does igg4_g_l differ by sex?', 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'outcome', value: 'igg4_g_l' },
    ]);
    const launched = await api.post('/api/v1/guided-analysis/wizard-runs', t1Body, t.headers);
    expect(launched.status, JSON.stringify(launched.body)).toBe(200);
    t1RunId = launched.body.runId;
    t1AnalysisId = launched.body.viewAnalysisId;
    await drainGoverned(api, t, t1RunId);

    const plain = await api.post('/api/v1/view-analyses', {
      projectId: t.projectId, datasetId: dataset.datasetId, name: 'Plain analysis (AXI-2368)', createdBy: adminUserId,
    }, t.headers);
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    plainAnalysisId = plain.body.id;

    hisRunId = await launchAs(investigator, api, t, wizardBody(t, dataset, 'T1', 'Does igg4_g_l differ by sex? (his)', 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
  });

  test.afterAll(async () => {
    await api.ctx.delete(`/api/v1/workspaces/${t.workspaceId}/members/${investigator.userId}`, { headers: t.headers }).catch(() => undefined);
    await investigator?.api.dispose();
    await api?.ctx.dispose();
  });

  test('owner goal 2026-10-31 — AXI-2368.2 a wizard-run row opens the result page; a plain row opens the explorer @SI-066 @SI-035 @SI-030', async ({ page }) => {
    // Arrange
    await seedScope(page, t);
    await gotoSettled(page, listPath());

    // Act — the guided row for the wizard run
    await page.locator(`[data-row-id="${t1AnalysisId}"]`).click();
    await page.getByRole('button', { name: /Open analysis/ }).click();

    // Assert — the SAME result page the wizard's Run would have landed on
    await expect(page).toHaveURL(new RegExp(`${resultPath(t1RunId)}$`), { timeout: 30_000 });

    // Act — the plain (non-guided) row
    await gotoSettled(page, listPath());
    await page.locator(`[data-row-id="${plainAnalysisId}"]`).click();
    await page.getByRole('button', { name: /Open analysis/ }).click();

    // Assert — the canonical explorer, never the result page
    await expect(page).toHaveURL(new RegExp(`${explorerPath(plainAnalysisId)}$`), { timeout: 30_000 });
  });

  test('owner goal 2026-10-31 — AXI-2368.3 the result page links to the explorer (team only); the explorer links back to the result page @SI-066 @SI-035 @SI-033', async ({ page, browser }) => {
    // Arrange
    await seedScope(page, t);
    await gotoSettled(page, resultPath(t1RunId));
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });

    // Act
    await page.getByTestId('rp-open-explorer').click();

    // Assert — lands on the SAME analysis's explorer
    await expect(page).toHaveURL(new RegExp(`${explorerPath(t1AnalysisId)}$`), { timeout: 30_000 });
    await expect(page.getByTestId('question-title')).toBeVisible();

    // Act — the explorer's "Result view" returns to the result page
    await page.getByTestId('object-line-result-view').click();

    // Assert
    await expect(page).toHaveURL(new RegExp(`${resultPath(t1RunId)}$`), { timeout: 30_000 });

    // Assert — the plain analysis's explorer has no "Result view" (no wizard run)
    await gotoSettled(page, explorerPath(plainAnalysisId));
    await expect(page.getByTestId('question-title')).toBeVisible();
    await expect(page.getByTestId('object-line-result-view')).toHaveCount(0);

    // Assert — the Investigator's result page never offers "Open in explorer"
    // (the explorer route sits behind the team SurfaceGate)
    const hisPage = await browser.newPage();
    await signIn(hisPage, investigator, t, `/investigator/projects/${t.projectId}/runs/${hisRunId}`);
    await expect(hisPage.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
    await expect(hisPage.getByTestId('rp-open-explorer')).toHaveCount(0);
    await hisPage.close();
  });
});
