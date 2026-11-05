import { test, expect } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { drainGoverned, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { gotoSettled, seedScope } from '../AXI-2308/harness/new-analysis';
import { wizardBody } from '../AXI-2308/harness/result-page';

/**
 * AXI-2413 (epic AXI-2414 — D35, AC61, EC36; SI-045/SI-047/SI-017 back, SI-030/SI-035 front):
 * a run launched with NO question (D23/EC30) gets its OWN question number, never one shared
 * "no question" bucket, and the title "Guided: <template name> (no question)". The title names
 * the analysis (breadcrumb) and is its framing question (workspace line), never the compiler's
 * synthesized question label and never the run id. A typed question still reuses its number
 * (AXI-2371, unchanged).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2413.1–.3.
 *
 * Fixture `opening-templates-paul-header.csv`, T1 (`sexe` F/M → `igg4_g_l`); launch path is the
 * wizard's own request, `POST /guided-analysis/wizard-runs` (AXI-2371's `wizardBody`).
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2414/AXI-2413-* --project=chromium --no-deps`.
 * NOT run for this handoff: no sidecar stack for story-developer agents this week (epic
 * precedent, AXI-2409..2412). Do not read a green/red result into this file — none was taken.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';
const TITLE = 'Guided: Compare groups (no question)';
const TYPED_QUESTION = 'Does igg4 differ by sex?';
const T1_SLOTS = [
  { slot: 'groupingColumn', value: 'sexe' },
  { slot: 'outcome', value: 'igg4_g_l' },
];

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
/** The three no-question analyses ('', '', '   ') and the two typed-question ones. */
let noQuestionIds: string[] = [];
let typedIds: string[] = [];

/** Launch T1 through the wizard's own request; returns the analysis id once the run settled. */
async function launch(question: string): Promise<string> {
  const res = await api.post(WIZARD_RUNS, wizardBody(t, dataset, 'T1', question, 'compare_groups', T1_SLOTS), t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
  await drainGoverned(api, t, res.body.runId);
  return res.body.viewAnalysisId;
}

async function analysisOf(id: string): Promise<{ name: string; questionNumber: number | null }> {
  const res = await api.get(`/api/v1/view-analyses/${id}`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function framingTextOf(id: string): Promise<string | null> {
  const res = await api.get(`/api/v1/view-analyses/${id}/framing`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body?.reviewQuestion?.text ?? null;
}

test.describe.serial('AXI-2413 a run with no question: own number, D35 title @SI-045 @SI-047 @SI-017', () => {
  test.beforeAll(async () => {
    test.setTimeout(900_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const id = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId: id });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.mann_whitney_u']);
    await silenceTours(await adminToken());

    noQuestionIds = [await launch(''), await launch(''), await launch('   ')];
    typedIds = [await launch(TYPED_QUESTION), await launch(TYPED_QUESTION)];
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2413.1 (AC61) — two or more no-question runs on one project get distinct numbers; a typed question still reuses @SI-045 @SI-047', async () => {
    // Arrange
    const noQuestion = await Promise.all(noQuestionIds.map(analysisOf));
    const typed = await Promise.all(typedIds.map(analysisOf));

    // Act
    const numbers = noQuestion.map((a) => a.questionNumber);

    // Assert
    expect(numbers.every((n) => typeof n === 'number')).toBe(true);
    expect(new Set(numbers).size).toBe(noQuestion.length);
    expect(typed[0].questionNumber).not.toBeNull();
    expect(typed[1].questionNumber).toBe(typed[0].questionNumber);
    expect(numbers).not.toContain(typed[0].questionNumber);
  });

  test('AXI-2413.2 (EC36) — the D35 title names the analysis and frames its question, never the synthesized label or the run id @SI-047 @SI-017', async () => {
    for (const id of noQuestionIds) {
      // Act
      const { name } = await analysisOf(id);
      const framing = await framingTextOf(id);

      // Assert
      expect(name).toBe(TITLE);
      expect(framing).toBe(TITLE);
      expect(name).not.toMatch(/differ between|GR-/);
    }
  });

  test('AXI-2413.3 (EC36, AC61) — the workspace line and breadcrumb show the title; the Analyses list keeps one row per run @SI-030 @SI-035', async ({ page }) => {
    // Arrange
    await seedScope(page, t);

    // Act
    await gotoSettled(page, `/projects/${t.projectId}/view-analyses/${noQuestionIds[0]}`);

    // Assert — workspace line + breadcrumb
    await expect(page.getByTestId('question-title')).toHaveText(TITLE, { timeout: 30_000 });
    // The view-analysis pages render the breadcrumb through an override `<nav>` (no aria-label).
    await expect(page.locator('nav', { hasText: TITLE }).first()).toBeVisible();

    // Act — the Analyses list
    await gotoSettled(page, `/projects/${t.projectId}/view-analyses`);

    // Assert — never one shared "no question" group row
    for (const id of noQuestionIds) await expect(page.locator(`[data-row-id="${id}"]`)).toBeVisible();
    await expect(page.getByTestId('question-group-row').filter({ hasText: 'no question' })).toHaveCount(0);
  });
});
