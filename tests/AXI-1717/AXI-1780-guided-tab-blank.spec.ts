import { test, expect, Route } from '@playwright/test';
import { seedLiveWorkbench, primeWorkspace, type Seeded } from './harness/live-workbench';

/**
 * AXI-1780 — `?tab=guided` must never render a blank page (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` section 27.
 * Tags: @SI-030 (the app-wide error boundary), @SI-046 (the Guided tab / PlanPreview).
 *
 * REAL BACKEND, LLM-FREE: the guided-analysis plan LIST and the resume-on-reload
 * chain are mocked at the Playwright route level (the pattern AXI-1726 and
 * AXI-1718 already use) — never a live planner call.
 *
 * WHAT THIS PINS. The bug was found through console capture against the running
 * stack: a stored plan carrying no `reasoning` block made `PlanPreview` throw
 *
 *   TypeError: Cannot read properties of undefined (reading 'whyThisApproach')
 *
 * and, with no error boundary anywhere in `axiome-front`, React unmounted the
 * WHOLE tree — `<div id="root"></div>`, a completely blank document: no reason,
 * no guard text, nothing to act on, contradicting FR22. Two defects were fixed:
 * the unguarded read (`lib/guidedAnalysis/planShape.ts`) and the absent boundary
 * (`components/ErrorBoundary.tsx`). This spec asserts the OUTCOME both share —
 * a malformed plan never blanks the surface — so it stays true whichever of the
 * two a future regression breaks.
 */

const PLAN_ID = 'PL-1780-no-reasoning';
const RUN_ID = 'RUN-1780-no-reasoning';

test.describe('AXI-1780 - a malformed stored plan never blanks the Guided tab', { tag: ['@SI-030', '@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1780-${Date.now().toString(36)}`, `AXI-1780 Blank Guided Tab ${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  async function mockPlanWithoutReasoning(page: import('@playwright/test').Page): Promise<void> {
    await page.route('**/api/v1/governed-execution/in-flight*', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: null }) });
    });
    await page.route('**/api/v1/governed-execution/latest-run-for-analysis*', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: RUN_ID }) });
    });
    await page.route('**/api/v1/governed-execution/status*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ runId: RUN_ID, status: 'completed', nodes: [], planId: PLAN_ID }),
      });
    });
    // The defect payload, verbatim: a persisted plan with NO `reasoning` block
    // and NO `nodes` — both declared required by `AnalysisPlan`, both absent on
    // real stored rows (a pre-field revision, a non-planner instantiation).
    await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          planId: PLAN_ID, question: 'AXI-1780 plan with no reasoning', planner: 'anthropic', revision: 1, status: 'run',
          createdAt: new Date().toISOString(),
          plan: { planId: PLAN_ID, question: 'AXI-1780 plan with no reasoning' },
          strategy: 'guided_discovery', analysisId: s.viewAnalysisId,
        }]),
      });
    });
  }

  test('AC1 - the Guided tab renders the page shell, never an empty document, for a plan with no reasoning block', async ({ page }) => {
    const thrown: string[] = [];
    page.on('pageerror', (e) => thrown.push(e.message));

    await primeWorkspace(page, s);
    await mockPlanWithoutReasoning(page);
    await page.goto(`/projects/${s.projectId}/view-analyses/${s.viewAnalysisId}?tab=guided`);

    // The reported symptom was `<div id="root"></div>` — the tab bar itself gone.
    await expect(page.getByRole('tab', { name: 'Guided Analysis' })).toBeVisible({ timeout: 20_000 });
    expect(thrown, `an unguarded throw reached the page: ${thrown[0] ?? ''}`).toEqual([]);
  });

  test('AC2 - the plan is shown with its absent reasoning STATED, per FR22', async ({ page }) => {
    await primeWorkspace(page, s);
    await mockPlanWithoutReasoning(page);
    await page.goto(`/projects/${s.projectId}/view-analyses/${s.viewAnalysisId}?tab=guided`);

    // Either the panel renders the field as not recorded (the fix in
    // `planShape.ts`), or — if some other field throws — the boundary states a
    // reason. What is forbidden is a surface that says nothing at all.
    const stated = page.getByTestId('plan-why-this-approach').or(page.getByTestId('error-boundary-reason'));
    await expect(stated.first()).toBeVisible({ timeout: 20_000 });
    await expect(stated.first()).not.toHaveText('');
  });

  test('AC3 - a well-formed plan still renders the Guided tab in full (no regression from the guard)', async ({ page }) => {
    await primeWorkspace(page, s);
    await page.route('**/api/v1/governed-execution/in-flight*', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: null }) });
    });
    await page.route('**/api/v1/governed-execution/latest-run-for-analysis*', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: RUN_ID }) });
    });
    await page.route('**/api/v1/governed-execution/status*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ runId: RUN_ID, status: 'completed', nodes: [], planId: PLAN_ID }),
      });
    });
    await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          planId: PLAN_ID, question: 'AXI-1780 well-formed plan', planner: 'anthropic', revision: 1, status: 'run',
          createdAt: new Date().toISOString(),
          plan: {
            planId: PLAN_ID, question: 'AXI-1780 well-formed plan', nodes: [],
            reasoning: {
              restatedQuestion: 'AXI-1780 well-formed plan',
              whyThisApproach: 'Recorded by the planner.',
              whatThisWillNotEstablish: 'Nothing analytic — a rendering assertion.',
              alternativesConsidered: [],
            },
          },
          strategy: 'guided_discovery', analysisId: s.viewAnalysisId,
        }]),
      });
    });

    await page.goto(`/projects/${s.projectId}/view-analyses/${s.viewAnalysisId}?tab=guided`);

    await expect(page.getByTestId('plan-run-status')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('plan-why-this-approach')).toHaveText('Recorded by the planner.');
    await expect(page.getByTestId('error-boundary')).toHaveCount(0);
  });
});
