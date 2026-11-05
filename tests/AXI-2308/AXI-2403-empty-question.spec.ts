import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import {
  choose,
  focusedTestId,
  gotoSettled,
  press,
  seedScope,
  stubWizardRoutes,
  type StubLog,
} from './harness/new-analysis';

/**
 * AXI-2403 (epic AXI-2308 — FR18, FR33, FR52, FR53, AC51, EC30; SI-066 front, SI-045/SI-010
 * back): in Guided mode, pressing Enter on the Question step with NOTHING typed (D23) advances
 * the wizard with the question empty — no suggestion or Canon reading is ever asked for it, the
 * Intent step lists all five intents with none preselected, "Read from your question" never
 * renders, and every one of the chosen template's clarification slots is asked under "Must be
 * decided" with nothing pre-filled. Ready still allows Run with no question and offers "No
 * question — add the question this answers" (`na-ready-add-question`) back to the Question step
 * without discarding anything already decided. The launched record carries the empty question
 * verbatim, no `suggestionCallId`, and no slot of provenance `question`. The result page renders
 * the fixed sentence "No question was asked; the analysis was chosen directly." in the
 * question's place.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2403.2–.4.
 *
 * Stubbed, exactly as AXI-2328's spec (`harness/new-analysis.ts`): AXI-2345's intent-prefill
 * `suggest`/`catalog`, the project SAP list, the idempotent `ensure-recognized-fill`. This spec
 * additionally asserts `suggest` is NEVER hit (an empty question never calls it — AC51/EC30).
 * NOT stubbed: Run — `POST /guided-analysis/wizard-runs` launches for real, same as AXI-2328.11,
 * needing the T1 carrier (`stats.mann_whitney_u`) approved on this stack.
 *
 * Fixture: the same synthetic Paul-header CSV AXI-2328 uses. Its `sexe` column has exactly two
 * levels (F/M), so T1's "groups" clarification auto-resolves and only `groupingColumn` +
 * `outcome` are ever asked under "Must be decided" — this spec never names them: it walks
 * whichever decide step(s) render generically (AXI-2328.12's own proven pattern: the first
 * choice is always focused by default, so a bounded loop of deliberate Enter presses reaches
 * Ready regardless of how many slots a template declares).
 *
 * The result page's full report content ("## Question" section) is NOT asserted here: it needs
 * the run to reach a terminal status, which this spec does not wait on (mirrors AXI-2328's own
 * spec, which never navigates to the result page at all). The exact fixed sentence is already
 * pinned server-side by `client-report-markdown.renderer.spec.ts`'s AXI-2403 unit tests; this
 * spec covers the one thing no unit test can reach — that the result page itself renders the
 * heading, which it does unconditionally (even mid-run), so no wait is needed for that half.
 *
 * Run: `BASE_URL=<worktree Vite serving the AXI-2403 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2403-*`.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';

let api: Api;
let t: Tenant;
let datasetId: string;
/** Set by the Run test, read by the result-page test — the same serial describe block. */
let launchedRunId: string;

/** AXI-2361 (D21): the Template step's choice id is the (template, dataset) PAIR key. */
function pk(templateId: string): string {
  return `${templateId}::${datasetId}`;
}

async function openWizard(page: Page): Promise<StubLog> {
  await seedScope(page, t);
  const log = await stubWizardRoutes(page);
  await gotoSettled(page, `/new-analysis?datasetId=${datasetId}`);
  await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 15_000 });
  return log;
}

/** The step's choices, in order, as their data-testid suffix. */
async function choiceKeys(page: Page, group: string): Promise<string[]> {
  const ids = await page.getByRole('radiogroup', { name: group }).getByRole('radio').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.replace('na-choice-', ''));
}

async function checkedKeys(page: Page, group: string): Promise<string[]> {
  const ids = await page.getByRole('radiogroup', { name: group }).locator('[aria-checked="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  return ids.map((id) => id.replace('na-choice-', ''));
}

/**
 * compare_groups → T1: picks the intent and the (template, dataset) pair, asserting nothing a
 * contradicted/suggested question would show (AC51/EC30), then walks whichever "Must be
 * decided" step(s) render — generically, by pressing Enter on the always-focused-by-default
 * first choice (AXI-2328.12's own proven pattern) — bounded, until Ready renders.
 */
async function pickCompareGroupsT1(page: Page): Promise<void> {
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await choose(page, `na-choice-${pk('T1')}`);
  await expect(page.getByTestId('na-step-read')).toHaveCount(0); // never rendered — nothing was read from an empty question

  const decide = page.locator('[data-testid^="na-step-decide-"]');
  await expect(decide).toBeVisible();
  await expect(decide.locator('[aria-checked="true"]')).toHaveCount(0); // AC51: nothing pre-filled
  await expect(page.getByTestId('na-decide-contradiction')).toHaveCount(0); // nothing came from a question to contradict

  for (let i = 0; i < 4 && !(await page.getByTestId('na-step-ready').isVisible()); i += 1) {
    expect(await focusedTestId(page)).toMatch(/^na-choice-/);
    await press(page, 'Enter');
  }
  await expect(page.getByTestId('na-step-ready')).toBeVisible();
}

test.describe.serial('AXI-2403 empty question — Enter alone chooses the analysis directly (D23) @SI-066 @SI-045 @SI-010', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    await approveCarriersFor(['stats.mann_whitney_u']); // T1's carrier — Run executes for real
    await silenceTours(await adminToken());
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('FR18 FR52 EC27 EC30 — AXI-2403.2 Enter on an empty question skips suggestion/reading and asks every parameter @SI-066', async ({ page }) => {
    const log = await openWizard(page);
    const input = page.getByLabel('What do you want to find out?');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    await expect(page.getByTestId('na-question-skip-hint')).toHaveText('Or press Enter to choose the analysis yourself.');
    await expect(page.getByTestId('na-question-ok')).toBeDisabled(); // Next stays disabled while empty — Enter is the only way in

    // EC27: a held Enter (auto-repeat) advances exactly ONE step, never two — the same global
    // press guard AXI-2328.12 exercises on the Intent step.
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await expect(page.getByTestId('na-step-intent')).toBeVisible();

    // all five intents, none preselected, no "reading…"/"suggested" wording at all
    expect(await choiceKeys(page, 'Intent')).toEqual(['explore_dataset', 'compare_groups', 'find_validate_biomarkers', 'follow_patients_over_time', 'reproduce_published_analysis']);
    expect(await checkedKeys(page, 'Intent')).toEqual([]);
    await expect(page.getByTestId('na-intent-heading')).toHaveText('Pick the closest one.');

    await pickCompareGroupsT1(page);

    expect(log.suggestionBodies, 'the suggest route must never be hit for an empty question').toHaveLength(0);
  });

  test('FR52 FR53 AC51 EC30 — AXI-2403.3 Ready offers "No question — add the question this answers"; nothing is discarded @SI-066', async ({ page }) => {
    await openWizard(page);
    const input = page.getByLabel('What do you want to find out?');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('na-step-intent')).toBeVisible();
    await pickCompareGroupsT1(page);

    await expect(page.getByTestId('na-rail-question-answer')).toHaveText('none'); // never a blank line
    await expect(page.getByTestId('na-ready-lineage-question')).toHaveText('—'); // not an empty label
    await expect(page.getByTestId('na-ready-question')).toHaveCount(0); // no "taken from how you asked" card — nothing was

    const addQuestion = page.getByTestId('na-ready-add-question');
    await expect(addQuestion).toHaveText('No question — add the question this answers');
    await expect(page.getByTestId('na-ready-analysis')).toContainText('Compare groups'); // sanity: the confirmed pick, before we jump away

    await choose(page, 'na-ready-add-question');
    await expect(page.getByTestId('na-step-question')).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(''); // the jump itself discarded nothing — the question is still simply unset
  });

  test('FR18 FR52 FR53 — AXI-2403.3b Run launches with no question: question \'\', no suggestionCallId, no slot of provenance \'question\' @SI-066 @SI-045', async ({ page }) => {
    await openWizard(page);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('na-step-intent')).toBeVisible();
    await pickCompareGroupsT1(page);

    let postCount = 0;
    page.on('request', (r) => {
      if (r.url().includes(WIZARD_RUNS) && r.method() === 'POST') postCount += 1;
    });
    const launched = page.waitForResponse((r) => r.url().includes(WIZARD_RUNS) && r.request().method() === 'POST');

    await choose(page, 'na-run');

    const response = await launched;
    const body = response.request().postDataJSON();
    expect(body).toMatchObject({ question: '', suggestionCallId: null });
    expect(body.slots.some((s: { provenance: string }) => s.provenance === 'question'), JSON.stringify(body.slots)).toBe(false);

    const answer = await response.json();
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/projects/${t.projectId}/runs/${answer.runId}$`), { timeout: 30_000 });
    expect(postCount, 'exactly one wizard-runs POST — no duplicate launch').toBe(1);

    launchedRunId = answer.runId;
  });

  test('FR33 AC51 — AXI-2403.4 the result page says "No question was asked; the analysis was chosen directly." @SI-066 @SI-045 @SI-010', async ({ page }) => {
    await seedScope(page, t);
    await gotoSettled(page, `/projects/${t.projectId}/runs/${launchedRunId}`);
    // `rp-question` renders unconditionally — before the run even reaches a terminal status
    // (ResultPage.tsx renders RunStateLead separately below it) — so no completion wait is owed.
    await expect(page.getByTestId('rp-question')).toHaveText('No question was asked; the analysis was chosen directly.', { timeout: 15_000 });
  });
});
