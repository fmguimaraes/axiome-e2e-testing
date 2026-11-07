import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { answered, choose, gotoSettled, seedScope, stubWizardRoutes, type StubLog, type WizardStubs } from '../AXI-2308/harness/new-analysis';

/**
 * AXI-2437 (epic AXI-2433 — FR56, AC24): the New analysis wizard no longer asks a Yes/No
 * "use the project's analysis plan" question. The Plan step (`PlanStep.tsx`), `sapAnswer` and
 * `chooseSap` are removed entirely, on a project with a SAP exactly as on one without — the SAP
 * surfaces only as read-only context on Ready, never as a question blocking Run.
 *
 * AXI-2443 retired the per-run SAP choice: the interim `sapChoice: 'skip'` this spec once asserted
 * is gone — the launch body carries NO SAP choice at all (`wizardDraft.ts#buildWizardDraft`), and
 * the server refuses `bind` 422 `SAP_BINDING_RETIRED` (AXI-2443's own spec).
 * Requires the AXI-2443 front on the target stack.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md` § AXI-2437.1–.2.
 *
 * Stubbed, as AXI-2328's spec (`harness/new-analysis.ts`): AXI-2345's intent-prefill
 * `suggest`/`catalog`, the project SAP list (`saps`, per test), the idempotent
 * `ensure-recognized-fill`. NOT stubbed: Run — `POST /guided-analysis/wizard-runs` launches for
 * real, needing the T1 carrier (`stats.mann_whitney_u`) approved on this stack.
 *
 * Fixture: the same synthetic Paul-header CSV AXI-2328/AXI-2356 use.
 *
 * Run: `BASE_URL=<worktree Vite serving the AXI-2437 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2433/AXI-2437-*`.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const SEX_QUESTION = 'Does IgG4 differ by sex?';
const SEX_READ = answered(SEX_QUESTION, 'compare_groups', [
  ['outcome', 'igg4_g_l', 'IgG4'],
  ['groupingColumn', 'sexe', 'by sex'],
]);
const SEX_SLOTS_ONLY = answered(SEX_QUESTION, null, [
  ['outcome', 'igg4_g_l', 'IgG4'],
  ['groupingColumn', 'sexe', 'by sex'],
]);
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';
const SAP_ROW = { id: 'sap1', sapVersionId: 'sap-v1', version: 1, title: 'IgG4 SAP', supersededBy: null };

let api: Api;
let t: Tenant;
let datasetId: string;

/** AXI-2359: the Analysis step renders one card per template, keyed by `templateId` alone
 *  (datasets are chips on the card) — no longer the AXI-2361 `template::dataset` pair key. */
function pk(templateId: string): string {
  return templateId;
}

async function openWizard(page: Page, stubs: WizardStubs = {}): Promise<StubLog> {
  await seedScope(page, t);
  const log = await stubWizardRoutes(page, stubs);
  await gotoSettled(page, `/new-analysis?datasetId=${datasetId}`);
  await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 15_000 });
  return log;
}

/** Question → suggested intent → suggested T1 → Read → Ready, by the SEX_READ suggestion. */
async function reachReadyBySex(page: Page) {
  const input = page.getByLabel('What do you want to find out?');
  await input.fill(SEX_QUESTION);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('na-choice-compare_groups')).toHaveAttribute('aria-checked', 'true');
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await choose(page, `na-choice-${pk('T1')}`);
  await expect(page.getByTestId('na-step-read')).toBeVisible();
  await choose(page, 'na-read-confirm');
  await expect(page.getByTestId('na-step-ready')).toBeVisible();
}

test.describe.serial('AXI-2437 remove the wizard SAP Plan step @SI-066 @SI-045', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    await approveCarriersFor(['stats.mann_whitney_u']);
    await silenceTours(await adminToken());
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AC24 — AXI-2437.1 no Plan step, on a project with a SAP or without one, in rail or flow @SI-066', async ({ page }) => {
    // with a SAP
    await openWizard(page, { saps: [SAP_ROW], suggestion: { kind: 'answer', body: SEX_READ } });
    await expect(page.getByTestId('na-step-plan')).toHaveCount(0);
    await reachReadyBySex(page);
    await expect(page.getByTestId('na-step-plan')).toHaveCount(0);
    await expect(page.getByTestId('na-ready-row-plan')).toContainText('does not use');
    await expect(page.getByTestId('na-ready-analysis')).not.toContainText('you chose');

    // without a SAP — same shape, worded "no analysis plan"
    await openWizard(page, { saps: [], suggestion: { kind: 'answer', body: SEX_READ } });
    await expect(page.getByTestId('na-step-plan')).toHaveCount(0);
    await reachReadyBySex(page);
    await expect(page.getByTestId('na-step-plan')).toHaveCount(0);
    await expect(page.getByTestId('plan-status-exploratory')).toBeVisible();
    await expect(page.getByTestId('na-ready-analysis')).toContainText('This project has no analysis plan');
  });

  test('AC24 FR56 — AXI-2437.2 a run submits with no SAP choice in the body (AXI-2443), SAP present or absent @SI-066 @SI-045', async ({ page }) => {
    // The launch is real, so the intent is CHOSEN, not suggested: a suggested intent must cite a
    // logged recorded-transport suggestion (AXI-2352, else WIZ_SUGGESTION_UNVERIFIED), and the
    // shared stack carries no recording for this fixture. The suggestion stub offers no intent.
    await openWizard(page, { saps: [SAP_ROW], suggestion: { kind: 'answer', body: SEX_SLOTS_ONLY } });
    await page.getByLabel('What do you want to find out?').fill(SEX_QUESTION);
    await page.keyboard.press('Enter');
    await choose(page, 'na-choice-compare_groups');
    await expect(page.getByTestId('na-step-template')).toBeVisible();
    await choose(page, `na-choice-${pk('T1')}`);
    await expect(page.getByTestId('na-step-read')).toBeVisible();
    await choose(page, 'na-read-confirm');
    await expect(page.getByTestId('na-step-ready')).toBeVisible();

    const launched = page.waitForResponse((r) => r.url().includes(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    const response = await launched;
    const requestBody = response.request().postDataJSON();
    // AXI-2443 (AC24): was `toMatchObject({ sapChoice: 'skip' })` — the field is retired.
    expect(requestBody).not.toHaveProperty('sapChoice');
    expect(requestBody).not.toHaveProperty('sap');

    const answer = await response.json();
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/projects/${t.projectId}/runs/${answer.runId}$`), { timeout: 30_000 });
  });
});
