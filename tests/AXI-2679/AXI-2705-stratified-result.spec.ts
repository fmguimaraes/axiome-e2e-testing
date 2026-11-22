import { expect, test, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL, apiUrl } from '../../config/env';

/**
 * AXI-2705 (epic AXI-2679 — Save Analysis As Workflow; bug fix; SI-072, SI-002, SI-010, IEC
 * 62304 class C). Scenarios: `axiome-docs/manual-e2e/AXI-2679-Save-Analysis-As-Workflow.md`
 * (AXI-2705 section).
 *
 * Bug: the investigator result page of a per-reference (stratified) Dunn run showed every
 * summary line listing all 9 Dunn pairs (never naming its own reference) and pooled group sizes
 * (HD 30 / IgG4-RD 78 / SD 30) instead of per-reference (10 / 26 / 10). AXI-2712 made the T10
 * launch run ONLY its recorded steps — three per-reference Dunn comparisons in ONE stratified
 * node, no Kruskal-Wallis — which made the pre-fix `composeT2` answer with nothing at all
 * (`answer: []`), worse than the ticket's reported symptom. Fix: `composeStratifiedAnswer` /
 * `composeT2DunnOnly` (back `result-page-answer.ts`) read stratification off the run's own
 * `operandRoles.featureColumn` and each row's `feature` value, never a recorded chart preset;
 * `ResultPageService.groupNsOf` reads "n per group" off one stratum's own pairwise Dunn rows,
 * never the callback's pooled `rule_run_group_ns` report. The evidence chart itself
 * (`stratified_posthoc`) was already fixed by AXI-2706/2708/2709/2714 — this spec's scenario 3 is
 * a regression guard, not a re-fix.
 *
 * Drives a real browser against the story's ISOLATED stack (its own Postgres copy of the demo
 * DB carrying the AXI-2712-fixed Dunn-only replay run):
 *
 *   BASE_URL=http://127.0.0.1:5176 API_BASE_URL=http://localhost:3012 \
 *     npx playwright test tests/AXI-2679/AXI-2705-stratified-result.spec.ts --project=axi-2705-stratified-result
 *
 * Fixed data (demo DB reference case per the bug report), overridable by env: workspace
 * "Mag4" `8946e06a…`, project `7b4c3704…`, governed run `GR-11cc1a8b` (the T10 Dunn-only replay).
 *
 * Credentials come ONLY from `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD` (no literal default here or
 * anywhere in this file — NFR6).
 */

const WS = process.env.AXI2705_WORKSPACE_ID ?? '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT = process.env.AXI2705_PROJECT_ID ?? '7b4c3704-caaf-4ccf-ac88-8614fd2afdec';
const RUN_ID = process.env.AXI2705_RUN_ID ?? 'GR-11cc1a8b';
const INVESTIGATOR_EMAIL = process.env.E2E_TEST_EMAIL;
const INVESTIGATOR_PASSWORD = process.env.E2E_TEST_PASSWORD;

// AC56 reference figures (per-stratum, never pooled): HD 10, IgG4-RD 26, SD 10 per reference.
const POOLED_GROUP_NS = ['HD: 30', 'IgG4-RD: 78', 'SD: 30'];
const PER_STRATUM_GROUP_NS = ['HD: 10', 'IgG4-RD: 26', 'SD: 10'];

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface Session {
  api: APIRequestContext;
  accessToken: string;
  refreshToken: string;
}

async function login(email: string, password: string): Promise<Session> {
  const anon = await apiRequest.newContext();
  const res = await anon.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy();
  const { accessToken, refreshToken } = await res.json();
  await anon.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WS } });
  return { api, accessToken, refreshToken };
}

let investigator: Session;

test.beforeAll(async () => {
  test.skip(!INVESTIGATOR_EMAIL || !INVESTIGATOR_PASSWORD, 'E2E_TEST_EMAIL/E2E_TEST_PASSWORD not set for this environment');
  investigator = await login(INVESTIGATOR_EMAIL as string, INVESTIGATOR_PASSWORD as string);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
});

async function signInBrowser(page: Page): Promise<void> {
  await page.addInitScript(
    ([access, refresh, ws, project]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-active-workspace', ws);
      sessionStorage.setItem('axiome-investigator-last-workspace', ws);
      sessionStorage.setItem('axiome-investigator-last-project', project);
    },
    [investigator.accessToken, investigator.refreshToken, WS, PROJECT] as const,
  );
}

function resultPageUrl(): string {
  return `${BASE_URL}/investigator/projects/${PROJECT}/runs/${RUN_ID}`;
}

test.describe('AXI-2705 Stratified result answers/evidence per reference @SI-072 @SI-002 @SI-010', () => {
  test('AXI-2705 (AC56) — each reference answers once, naming itself and only its own Dunn pairs, never pooled', async ({ page }) => {
    // Backend contract: one sentence per reference, each self-naming.
    const resultPage = await (await investigator.api.get(apiUrl(`/api/v1/projects/${PROJECT}/runs/${RUN_ID}/result-page`))).json();
    expect(Array.isArray(resultPage.answer), 'the run answers (never [])').toBeTruthy();
    expect(resultPage.answer.length).toBeGreaterThanOrEqual(3);
    const references = ['ENT 059', 'CER 229', 'CER 215'];
    for (const reference of references) {
      const line = resultPage.answer.find((l: string) => l.includes(reference));
      expect(line, `a line names ${reference}`).toBeTruthy();
      for (const other of references.filter((r) => r !== reference)) {
        expect(line, `${reference}'s line never names ${other}`).not.toContain(`reference = ${other}`);
      }
    }

    // Browser: the page renders the same per-reference lines.
    await signInBrowser(page);
    await page.goto(resultPageUrl());
    await expect(page.getByTestId('rp-page')).toBeVisible({ timeout: 30_000 });
    const answer = page.getByTestId('rp-answer');
    await expect(answer).toBeVisible({ timeout: 30_000 });
    for (const reference of references) {
      await expect(answer).toContainText(reference);
    }
  });

  test('AXI-2705 (AC56) — "n per group" shows this reference\'s own sizes, never the pooled total', async ({ page }) => {
    await signInBrowser(page);
    await page.goto(resultPageUrl());
    await expect(page.getByTestId('rp-page')).toBeVisible({ timeout: 30_000 });

    const facts = page.getByTestId('rp-how-facts');
    await expect(facts).toBeVisible({ timeout: 30_000 });
    for (const line of PER_STRATUM_GROUP_NS) {
      await expect(facts).toContainText(line);
    }
    for (const line of POOLED_GROUP_NS) {
      await expect(facts).not.toContainText(line);
    }
  });

  test('AXI-2705 — the stratified evidence chart still draws (regression guard: AXI-2706/2708/2709/2714)', async ({ page }) => {
    const resultPage = await (await investigator.api.get(apiUrl(`/api/v1/projects/${PROJECT}/runs/${RUN_ID}/result-page`))).json();
    const primary = resultPage.results?.[0];
    expect(primary?.chartWithheld ?? null, 'the chart is not withheld').toBeNull();
    expect(primary?.chart?.type).toBe('stratified_posthoc');
    expect(primary?.chart?.params?.facet_order?.length ?? 0, 'one panel per reference').toBeGreaterThanOrEqual(3);

    await signInBrowser(page);
    await page.goto(resultPageUrl());
    await expect(page.getByTestId('rp-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('rp-chart')).toBeVisible({ timeout: 30_000 });
  });
});
