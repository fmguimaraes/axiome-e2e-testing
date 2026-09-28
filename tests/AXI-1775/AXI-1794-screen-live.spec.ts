import { test, expect, type Page, type Request } from '@playwright/test';
import {
  seedLiveWorkbench, primeWorkspace, declineHoldoutUrl, publishedRuleCode, confirmScreenRunConfig, MEASUREMENTS, SCREEN_OP, type Seeded,
} from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1794 - Screen phase wired to live governed runs
 * (epic AXI-1775, FR15, FR16, FR17; NFR2, NFR6, NFR7, NFR8; AC5, AC12; EC3, EC4; OC3).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 11.
 * Tags: @SI-046 (the workbench Screen surface), @SI-045 (the governed screen step + its
 * persisted choice), @SI-017 (the governed discovery config the Screen states).
 *
 * REAL BACKEND, LLM-FREE - a TEMPLATE instantiation, never a planner call. The holdout of the
 * DECLARED container is declined through the API. The suite is SERIAL on that one analysis:
 * the screen is launched once through the UI (Branch 1 holds one screen claim), and every
 * later test opens a NEW page, so what it asserts was read back from the server (EC2), never
 * carried over from a click in the same page.
 *
 * Governed config: the shared seed (`ensureApprovedDiscoveryConfig`) states `alpha = 0.05` as
 * customer config and leaves `correctionMethod` / `defaultProcedure` unstated, so the Screen
 * must say those two are "awaiting bioinformatics approval" and never print a default (NFR2).
 */
const AWAITING = 'not stated — awaiting bioinformatics approval';
const SUBMIT = /\/discovery\/analyses\/[^/]+\/steps\/screen\/submit$/;
const MARKER = 'CD8A_pre';

const open = (page: Page, s: Seeded) => page.goto(`/projects/${s.projectId}/discovery-workbench?analysisId=${s.declaredAnalysisId}`);
const restored = (page: Page) => expect(page.getByTestId('discovery-workbench')).toHaveAttribute('data-restore-status', 'restored', { timeout: 60_000 });

function recordSubmits(page: Page): { bodies: () => any[] } {
  const seen: Request[] = [];
  page.on('request', (req) => { if (req.method() === 'POST' && SUBMIT.test(req.url())) seen.push(req); });
  return { bodies: () => seen.map((r) => r.postDataJSON()) };
}

async function planScreen(s: Seeded): Promise<any> {
  const plan = await s.api.get(`/api/v1/discovery/analyses/${s.declaredAnalysisId}/plan`, s.t.headers);
  expect(plan.status, JSON.stringify(plan.body)).toBe(200);
  return plan.body.branches?.[0]?.screen ?? null;
}

test.describe('AXI-1794 - the Screen runs the plan rule on the governed path and persists the choice (UI, real backend)', { tag: ['@SI-046', '@SI-045', '@SI-017'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 360_000 });

  let s: Seeded;
  let code: string;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1794-${tag}`, `AXI-1794 Screen live ${tag}`);
    code = await publishedRuleCode(s, SCREEN_OP);
    const declined = await s.api.post(declineHoldoutUrl(s.declaredAnalysisId, 'split'), { reason: 'axi-1794: exploratory arm' }, s.t.headers);
    expect(declined.body.declined, JSON.stringify(declined.body)).toBe(true);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('FR15 AC12 OC3 - only the plan screen rule is offered, with the governed values and their origin; nothing unstated is printed as a value', async ({ page }) => {
    await primeWorkspace(page, s);
    await open(page, s);
    await restored(page);
    await page.getByTestId('screen-choose-rule').click();
    await expect(page.getByTestId(`screen-rule-${code}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid^="screen-rule-run-"]')).toHaveCount(1);
    await expect(page.getByTestId('screen-rules-other-toggle')).toHaveCount(0);
    const governance = page.getByTestId(`screen-rule-governance-${code}`);
    await expect(governance).toContainText('α 0.05 (customer config)', { timeout: 30_000 });
    await expect(governance).toContainText(`correction ${AWAITING}`);
    await expect(governance).toContainText(`default procedure ${AWAITING}`);
    await expect(page.getByTestId(`screen-rule-awaiting-${code}`)).toHaveCount(0);
    await expect(page.getByTestId(`screen-rule-run-${code}`)).toHaveText(/Configure and run/);
  });

  test('FR15 AC5 NFR6 - Configure and run opens the run-config modal; its Run rule makes ONE governed submit naming Branch 1 (branchId null) and a live result lands', async ({ page }) => {
    const submits = recordSubmits(page);
    await primeWorkspace(page, s);
    await open(page, s);
    await restored(page);
    await page.getByTestId('screen-choose-rule').click();
    await page.getByTestId(`screen-rule-run-${code}`).click();
    await expect(page.getByRole('dialog', { name: /^Configure / })).toBeVisible({ timeout: 15_000 });
    expect(submits.bodies()).toHaveLength(0);
    await confirmScreenRunConfig(page);
    const result = page.getByTestId(`workbench-screen-result-${code}`);
    await expect(result.getByTestId('screen-result-count')).toContainText(`${MEASUREMENTS.length} screened`, { timeout: 240_000 });
    await expect(result.getByTestId('screen-result-badge')).toHaveText('live');
    expect(submits.bodies()).toHaveLength(1);
    expect(submits.bodies()[0]).toMatchObject({ operationId: SCREEN_OP, branchId: null });
    await expect(result.getByTestId('screen-result-count')).toContainText('pass after correction (not stated)');
  });

  test('FR8 NFR2 FR17 - a fresh page restores the run and reads its table: live mode, alpha and correction not stated (never a default), no drawn distribution, the claim-cap gap stated', async ({ page }) => {
    await primeWorkspace(page, s);
    await open(page, s);
    await restored(page);
    const result = page.getByTestId(`workbench-screen-result-${code}`);
    await expect(result.getByTestId('screen-result-count')).toContainText(`${MEASUREMENTS.length} screened`, { timeout: 120_000 });
    await result.getByTestId('screen-result-expand').click();
    await expect(page.getByTestId('screen-result-mode')).toHaveText('live');
    // A restored run states no alpha or correction of its own (the choice read carries none): never a default.
    await expect(page.getByTestId('screen-result-correction')).toContainText('correction not stated');
    await expect(page.getByTestId('screen-result-partial')).toHaveCount(0);
    await page.getByTestId('screen-filter').getByText('all', { exact: true }).click();
    await page.getByTestId('screen-shortlist-table').getByRole('row', { name: new RegExp(MARKER) }).click();
    await expect(page.getByTestId('screen-row-evidence-live')).toBeVisible();
    await expect(page.getByTestId('screen-distribution')).toHaveCount(0);
    await expect(page.getByTestId('screen-row-claim-cap')).toContainText('states no per-row below-LOD burden or claim cap');
  });

  test('FR16 AC5 - choosing a marker is recorded by the server on the branch screen run; the canvas shows the server choice', async ({ page }) => {
    expect((await planScreen(s))?.choice ?? null).toBeNull();
    await primeWorkspace(page, s);
    await open(page, s);
    await restored(page);
    const result = page.getByTestId(`workbench-screen-result-${code}`);
    await expect(result.getByTestId('screen-result-count')).toContainText(`${MEASUREMENTS.length} screened`, { timeout: 120_000 });
    await result.getByTestId('screen-result-expand').click();
    await page.getByTestId('screen-filter').getByText('all', { exact: true }).click();
    await page.getByTestId('screen-shortlist-table').getByRole('row', { name: new RegExp(MARKER) }).click();
    // No default procedure is stated, so no deviation is judged and no deviation rationale is asked.
    await expect(page.getByTestId('screen-choice-deviation')).toHaveCount(0);
    await page.getByTestId('screen-choice-rationale').fill('axi-1794: strongest separation on this cohort');
    await page.getByTestId('screen-choose-marker').click();
    await expect(page.getByTestId('marker-chosen')).toContainText(MARKER, { timeout: 30_000 });
    const screen = await planScreen(s);
    expect(screen).toMatchObject({ operationId: SCREEN_OP, state: 'completed', choice: { marker: MARKER, rationale: 'axi-1794: strongest separation on this cohort', deviationRationale: null } });
  });

  test('FR8 FR16 EC2 - a reload restores the persisted choice and settles Screen on the rail with no click', async ({ page }) => {
    await primeWorkspace(page, s);
    await open(page, s);
    await restored(page);
    await expect(page.getByTestId('marker-chosen')).toContainText(MARKER, { timeout: 60_000 });
    await expect(page.getByTestId('phase-rail-step-screen')).not.toHaveAttribute('aria-current', 'step');
    await page.reload();
    await restored(page);
    await expect(page.getByTestId('marker-chosen')).toContainText(MARKER, { timeout: 60_000 });
  });

  test('FR16 NFR8 - a second choice on the same screen run is refused by the server and the first stands', async () => {
    const screen = await planScreen(s);
    const res = await s.api.post(`/api/v1/discovery/analyses/${s.declaredAnalysisId}/screen-choice`, {
      branchId: null, runId: screen.runId, marker: 'IFNG_pre', rationale: 'axi-1794: a second attempt',
    }, s.t.headers);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.chosen).toBe(false);
    expect(res.body.reasons.length).toBeGreaterThan(0);
    expect((await planScreen(s)).choice.marker).toBe(MARKER);
  });
});
