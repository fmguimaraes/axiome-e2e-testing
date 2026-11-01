import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { answered, askQuestion, choose, chooseRadio, gotoSettled, press, seedScope, stubWizardRoutes } from './harness/new-analysis';

/**
 * AXI-2374 (epic AXI-2308 — Canon §4.1 "Confirm these", FR49; @SI-066): per-value dismissal on
 * the Read step. Each row gets a ✕; ↑/↓ move the focused row, Backspace dismisses it, Enter
 * confirms whatever remains. A dismissed row is set back to absent and flows through the SAME
 * resolution every other value does (`overrides` in `slotResolution.ts`): a slot the template
 * requires reopens as a blocking "Must be decided" question; a slot nothing requires reopens on
 * Ready as an offer. Esc is unchanged.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2374.
 *
 * The Canon question reading (AXI-2364/AXI-2366) is stubbed directly here, like AXI-2365.4's
 * failure case — this spec does NOT depend on the (not yet authored) AXI-2366 MAG4 bank
 * recordings: `question-reading/read` is routed to a crafted, deterministic `answered` body so
 * both scenarios (a required landing, and a non-landing slot) are exercised without recorded
 * transport. The intent-prefill suggestion is stubbed as usual (AXI-2328 discipline).
 *
 * Fixture: `opening-templates-paul-header.csv` (AXI-2339; synthetic) — `igg4_g_l` (outcome),
 * `sexe` F/M (groupingColumn).
 *
 * Run: `BASE_URL=<Vite serving the AXI-2374 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2374-*`.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const READ_PATH = '**/api/v1/guided-analysis/question-reading/read';
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';
const QUESTION = 'Does IgG4 differ by sex among adults?';

let api: Api;
let t: Tenant;
let datasetId: string;

const pk = (templateId: string) => `${templateId}::${datasetId}`;

/** A crafted Canon reading: `target` (lands on `outcome`, required by T1/T2) and
 * `populationFilter` (lands on nothing — no clarification slot consumes it). */
function stubbedReading(ds: string) {
  const span = (text: string) => {
    const start = QUESTION.indexOf(text);
    return { text, start, end: start + text.length };
  };
  return {
    status: 'answered',
    type: 'analysis',
    readings: [
      {
        datasetId: ds,
        slots: {
          target: { state: 'settled', values: [{ value: 'igg4_g_l', confidence: 1, sourceSpan: span('IgG4'), column: null }] },
          populationFilter: { state: 'settled', values: [{ value: 'adult', confidence: 1, sourceSpan: span('adults'), column: null }] },
        },
      },
    ],
    clarifyingQuestion: null,
    callId: null,
  };
}

async function openWizard(page: Page) {
  await page.route(READ_PATH, (r) => r.fulfill({ status: 200, json: stubbedReading(datasetId) }));
  await seedScope(page, t);
  await stubWizardRoutes(page, {
    suggestion: { kind: 'answer', body: answered(QUESTION, 'compare_groups', [['outcome', 'igg4_g_l', 'IgG4'], ['groupingColumn', 'sexe', 'by sex']]) },
  });
  await gotoSettled(page, `/new-analysis?datasetId=${datasetId}`);
  await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 15_000 });
}

/** Ask the question and take compare_groups / T1 up to the Read step. */
async function reachReadStep(page: Page) {
  await askQuestion(page, QUESTION);
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await choose(page, `na-choice-${pk('T1')}`);
  await expect(page.getByTestId('na-step-read')).toBeVisible();
}

test.describe.serial('AXI-2374 per-value dismissal on the Read step @SI-066 @AXI-2374', () => {
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

  test('AXI-2374.2 — dismissing a row that lands on a required slot reopens it as a blocking question, never prefilled @SI-066 @AXI-2374', async ({ page }) => {
    await openWizard(page);
    await reachReadStep(page);

    await expect(page.getByTestId('na-read-target')).toContainText('from IgG4');
    await choose(page, 'na-read-dismiss-target');
    await expect(page.getByTestId('na-read-target')).toHaveCount(0);
    await expect(page.getByTestId('na-read-dismiss-hint')).toBeVisible();

    await choose(page, 'na-read-confirm');

    const outcome = page.getByTestId('na-step-decide-outcome');
    await expect(outcome).toBeVisible();
    await expect(outcome.getByRole('heading', { level: 1 })).toHaveText('Which measurement do you compare?');
    await expect(page.getByTestId('na-decide-blocks')).toBeVisible();
    // the full option set is offered — nothing is pre-checked with the dismissed value
    await expect(page.getByRole('radiogroup', { name: 'Which measurement do you compare?' }).locator('[aria-checked="true"]')).toHaveCount(0);

    await chooseRadio(page, /igg4_g_l/);
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    // "decided by you", never "from your question": the re-answered value lands in the
    // "What you decided here" card, not the question card, and carries no dismissed trace.
    await expect(page.getByTestId('na-ready-decided')).toContainText('igg4_g_l');

    // Review bounce 1 (BLOCKING 1): the dismissal's recorded sourceSpan must actually be
    // ACCEPTED by the server at launch — this is the end-to-end proof the span the front
    // located (or honestly omitted) never trips `WIZ_DISMISSAL_SPAN_INVALID`/`ANSWERS_REFUSED`.
    const launched = page.waitForResponse((r) => r.url().includes(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    const answer = await (await launched).json();
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/projects/${t.projectId}/runs/${answer.runId}$`), { timeout: 30_000 });
  });

  test('AXI-2374.3 — dismissing a row that lands on nothing reopens it as an offer on Ready @SI-066 @AXI-2374', async ({ page }) => {
    await openWizard(page);
    await reachReadStep(page);

    await expect(page.getByTestId('na-read-populationFilter')).toContainText('from adults');
    await choose(page, 'na-read-dismiss-populationFilter');
    await expect(page.getByTestId('na-read-populationFilter')).toHaveCount(0);

    await choose(page, 'na-read-confirm');
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    await expect(page.getByTestId('na-ready-offers')).toContainText('adult');
    await expect(page.getByTestId('na-ready-offers')).toContainText('not used');
  });

  test('AXI-2374.4 — keyboard interactions and focus after removal, including the last row @SI-066 @AXI-2374', async ({ page }) => {
    await openWizard(page);
    await reachReadStep(page);

    await expect(page.getByTestId('na-read-dismiss-hint')).toHaveText("Wrong? Remove it and I’ll ask you properly instead.");

    const first = page.getByTestId('na-read-target');
    await first.focus();
    await press(page, 'ArrowDown');
    await expect(page.getByTestId('na-read-populationFilter')).toBeFocused();
    await press(page, 'ArrowUp');
    await expect(first).toBeFocused();

    // Backspace on the first (non-last) row dismisses it; focus lands on a real control.
    await press(page, 'Backspace');
    await expect(page.getByTestId('na-read-target')).toHaveCount(0);
    await expect(page.getByTestId('na-read-populationFilter')).toBeFocused();

    // Dismiss the only remaining row — focus must land on the Confirm control, never nothing.
    await press(page, 'Backspace');
    await expect(page.getByTestId('na-read-populationFilter')).toHaveCount(0);
    await expect(page.getByTestId('na-read-confirm')).toBeFocused();

    // Enter confirms whatever remains (nothing) — the wizard moves on, not stuck.
    await press(page, 'Enter');
    await expect(page.getByTestId('na-step-read')).toHaveCount(0);
  });

  test('AXI-2374.5 — Esc on the Read step still returns to the question, dismissal included @SI-066 @AXI-2374', async ({ page }) => {
    await openWizard(page);
    await reachReadStep(page);

    await choose(page, 'na-read-dismiss-populationFilter');
    const row = page.getByTestId('na-read-target');
    await row.focus();
    await press(page, 'Escape');

    await expect(page.getByTestId('na-step-question')).toBeVisible();
  });
});
