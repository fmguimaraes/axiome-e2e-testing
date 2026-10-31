import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { answered, askQuestion, choose, gotoSettled, seedScope, stubWizardRoutes, type WizardStubs } from './harness/new-analysis';

/**
 * AXI-2365 (epic AXI-2308 — Canon §4.1, FR49, NFR12; @SI-066): the wizard's Read step on the
 * Canon question reading (AXI-2364, `POST /api/v1/guided-analysis/question-reading/read`), fetched
 * beside the intent-prefill suggestion when the question is submitted.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2365.
 *
 * Automated here: §.4 "No reading leaves the wizard as before". The reading route is NOT stubbed:
 * the question carries a fresh UUID, so the real recorded transport has no recording for it and
 * answers `recording_missing` — the honest "no reading" case. The intent-prefill suggestion is
 * stubbed (`harness/new-analysis.ts`, the AXI-2328 discipline) so each test controls which
 * template rows exist. The test waits for the reading's answer BEFORE confirming the template
 * (the wizard freezes the reading there), so the fallback is proven against an arrived miss, not
 * a reading that simply had not come back yet.
 *
 * §.2 and §.3 (Canon rows, "Still to decide") are DEFERRED: they need the AXI-2366 MAG4 bank
 * recordings, which are not authored. Unit coverage meanwhile: UT-INVESTIGATOR-7080…7092.
 *
 * Fixture: `opening-templates-paul-header.csv` (AXI-2339; synthetic), ingested and linked to the
 * project — the reading route refuses a dataset outside the project's workspace (NFR5).
 *
 * Run: `BASE_URL=<Vite serving the AXI-2365 branch> API_BASE_URL=<its gateway, AXI-2364 merged>
 *       npx playwright test tests/AXI-2308/AXI-2365-*`.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const READ_PATH = '**/api/v1/guided-analysis/question-reading/read';

let api: Api;
let t: Tenant;
let datasetId: string;

const pk = (templateId: string) => `${templateId}::${datasetId}`;
/** A question no recording can exist for. */
const unrecorded = () => `Does IgG4 differ by sex? (${randomUUID()})`;

async function openWizard(page: Page, stubs: WizardStubs) {
  await seedScope(page, t);
  await stubWizardRoutes(page, stubs);
  await gotoSettled(page, `/new-analysis?datasetId=${datasetId}`);
  await expect(page.getByTestId('na-step-question')).toBeVisible({ timeout: 15_000 });
}

/** Ask, wait for the REAL reading to answer, then take the suggested intent and T1. */
async function askAndReachPastTemplate(page: Page, question: string): Promise<{ status: number; body: any }> {
  const reading = page.waitForResponse((r) => r.url().includes('/guided-analysis/question-reading/read') && r.request().method() === 'POST');
  await askQuestion(page, question);
  const res = await reading;
  const answer = { status: res.status(), body: await res.json().catch(() => null) };
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await choose(page, `na-choice-${pk('T1')}`);
  return answer;
}

test.describe.serial('AXI-2365 the Read step on the Canon question reading @SI-066 @AXI-2365', () => {
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

  test('NFR12 — AXI-2365.4 no reading (recording_missing) falls back to the intent-prefill rows, with no "Still to decide" @SI-066 @AXI-2365', async ({ page }) => {
    const question = unrecorded();
    await openWizard(page, { suggestion: { kind: 'answer', body: answered(question, 'compare_groups', [['outcome', 'igg4_g_l', 'IgG4'], ['groupingColumn', 'sexe', 'by sex']]) } });

    const reading = await askAndReachPastTemplate(page, question);

    expect(reading.status, JSON.stringify(reading.body)).toBe(200);
    expect(reading.body).toMatchObject({ status: 'recording_missing', type: null, readings: [] });
    await expect(page.getByTestId('na-step-read')).toBeVisible();
    await expect(page.getByTestId('na-read-outcome')).toContainText('from IgG4');
    await expect(page.getByTestId('na-read-groupingColumn')).toContainText('from by sex');
    await expect(page.getByTestId('na-read-still-to-decide')).toHaveCount(0);
    await expect(page.getByTestId('na-read-confirm')).toBeFocused();
  });

  test('NFR12 — AXI-2365.4 no reading and no template row skips the Read step, as before @SI-066 @AXI-2365', async ({ page }) => {
    const question = unrecorded();
    await openWizard(page, { suggestion: { kind: 'answer', body: answered(question, 'compare_groups') } });

    const reading = await askAndReachPastTemplate(page, question);

    expect(reading.status, JSON.stringify(reading.body)).toBe(200);
    expect(reading.body).toMatchObject({ status: 'recording_missing', readings: [] });
    await expect(page.getByTestId('na-step-decide-groupingColumn')).toBeVisible();
    await expect(page.getByTestId('na-step-read')).toHaveCount(0);
  });

  test('NFR12 — AXI-2365.4 a failed reading never holds the wizard back @SI-066 @AXI-2365', async ({ page }) => {
    const question = unrecorded();
    await page.route(READ_PATH, (r) => r.fulfill({ status: 500, json: { message: 'stubbed failure' } }));
    await openWizard(page, { suggestion: { kind: 'answer', body: answered(question, 'compare_groups', [['outcome', 'igg4_g_l', 'IgG4']]) } });

    const reading = await askAndReachPastTemplate(page, question);

    expect(reading.status).toBe(500);
    await expect(page.getByTestId('na-step-read')).toBeVisible();
    await expect(page.getByTestId('na-read-outcome')).toContainText('from IgG4');
    await expect(page.getByTestId('na-read-still-to-decide')).toHaveCount(0);
  });
});
