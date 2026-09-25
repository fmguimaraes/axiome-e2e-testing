import { test, expect, Page } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ingestFixture } from '../AXI-1435/harness/seed';
import { anchorDataset, buildEnvelope, planQuestion, ensureTenant1603 } from './harness/planner';

/**
 * AXI-1603 — Intent-Compiled Planner (epic acceptance), UI half.
 * manual-e2e/AXI-1603-Intent-Compiled-Planner.md §4.1 (question box liveness,
 * no degraded-planner banner) and §5.1 (the unsupported render path — no run
 * affordance, "What is missing" panel).
 *
 * Also folds in the THREE @SI-046 scenarios AXI-1612 (frontend) documented in
 * its own UT.md but could not author as E2E, being out of that story's
 * single-worktree ownership boundary (axiome-e2e-testing is a separate repo):
 *  1. the live GuidedAnalysisPanel renders `UnsupportedPlanCard` for a flagged
 *     plan, with NO run affordance anywhere in the DOM (FR25/AC17);
 *  2. the "What is missing" panel (`StructuralGapPanel`) renders under the
 *     live plan when the backend's `structuralGap` is present (FR45/AC35),
 *     and is absent-tolerant when it is not (pending AXI-1611);
 *  3. `GuidedAnalysisHistory` renders the SAME `UnsupportedPlanCard` for a
 *     selected past flagged plan (the closest live-reachable proxy for the
 *     scenario's "reload renders identically" — the panel itself starts a
 *     fresh visit session on reload, per `GuidedAnalysisPanel`'s own
 *     `readVisitSession`/reset-on-mount contract; the History page is the
 *     durable, reload-safe view of a past plan), WITHOUT the structural-gap
 *     panel (`listPlans` never carries the create-response-only field).
 */
// `parallel`, not `serial`: none of the tests below depend on a PRECEDING
// TEST's outcome (only on the shared `beforeAll` seed), so one test's failure
// must not skip the rest — each AC's real result stays independently visible.
test.describe.configure({ mode: 'parallel', timeout: 180_000 });

const UNSUPPORTED_QUESTION =
  'Show how score and score2 co-vary across three ordered timepoints, adjusting for cohort as a covariate.';

let api: Api;
let workspaceId: string;
let orgId: string;
let projectId: string;
let anchor: Awaited<ReturnType<typeof anchorDataset>>;
let flaggedPlanId: string | undefined;
let flaggedUnsupportedReason: string | undefined;
let flaggedStructuralGap: any;

async function seedWorkspaceScope(page: Page): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [workspaceId, orgId] as const,
  );
}

test.beforeAll(async () => {
  api = await adminApi();
  const tenant = await ensureTenant1603(api);
  workspaceId = tenant.workspaceId;
  orgId = tenant.orgId;
  projectId = tenant.projectId;
  await ingestFixture(api, tenant, 'statistical-trigger.csv');
  anchor = await anchorDataset(api, workspaceId);

  // Seed the flagged plan through the API once, up front, so the UI tests
  // below only need to render it (the History page) and the live-compose
  // path (typing the question again) independently, per scenario.
  if (anchor) {
    const envelope = buildEnvelope(projectId, UNSUPPORTED_QUESTION, [anchor]);
    const res = await planQuestion(api, workspaceId, projectId, envelope);
    if (res.status < 300 && res.body.plan?.planId) {
      flaggedPlanId = res.body.plan.planId;
      flaggedUnsupportedReason = (res.body.plan as any).unsupportedReason;
      flaggedStructuralGap = res.body.structuralGap ?? null;
    }
  }
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test('AC16 AC28 — the guided question box is ready with no degraded-planner banner', async ({ page }) => {
  test.skip(!anchor, 'no dataset available in the seeded tenant');
  await seedWorkspaceScope(page);
  await page.goto(`/guided-analysis?scope=project&projectId=${projectId}&workspaceId=${workspaceId}`);

  await expect(page.getByTestId('ga-question')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId('ga-send')).toBeVisible();
  await expect(page.getByTestId('ga-strategy-fallback-notice')).toHaveCount(0);
});

test('AC12 AC17 — the live guided panel renders the unsupported state with no run affordance', async ({ page }) => {
  test.skip(!anchor, 'no dataset available in the seeded tenant');
  await seedWorkspaceScope(page);
  await page.goto(`/guided-analysis?scope=project&projectId=${projectId}&workspaceId=${workspaceId}`);

  await page.getByTestId('ga-question').fill(UNSUPPORTED_QUESTION);
  await page.getByTestId('ga-send').click();

  await expect(page.getByTestId('ga-unsupported-state')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('ga-unsupported-question')).toHaveText(UNSUPPORTED_QUESTION);
  await expect(page.getByTestId('ga-unsupported-headline')).toBeVisible();
  await expect(page.getByTestId('ga-unsupported-reason')).toBeVisible();
  await expect(page.getByTestId('ga-supported-shapes')).toBeVisible();

  // FR25 — no run affordance anywhere on this result.
  await expect(page.getByTestId('plan-run')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^run$/i })).toHaveCount(0);
});

test('AC35 — the "What is missing" panel renders as a suggestion, never a rule, with no create/accept/run control', async ({ page }) => {
  test.skip(!anchor, 'no dataset available in the seeded tenant');
  await seedWorkspaceScope(page);
  await page.goto(`/guided-analysis?scope=project&projectId=${projectId}&workspaceId=${workspaceId}`);

  await page.getByTestId('ga-question').fill(UNSUPPORTED_QUESTION);
  await page.getByTestId('ga-send').click();
  await expect(page.getByTestId('ga-unsupported-state')).toBeVisible({ timeout: 60_000 });

  const gapPanel = page.getByTestId('ga-structural-gap-panel');
  // AXI-1611 (merged): `structuralGap` is present iff a suggestion row was
  // written — every `intentUnsupported` outcome EXCEPT `unsupportedReason ===
  // 'refused'` (a provider refusal carries no gap to classify). Assert the
  // panel's presence/absence against that rule rather than discovering it.
  if (flaggedUnsupportedReason === 'refused') {
    await expect(gapPanel).toHaveCount(0);
  } else {
    await expect(gapPanel).toBeVisible({ timeout: 10_000 });
    await expect(gapPanel.getByTestId('ga-suggestion-badge')).toHaveText(/Suggestion.*not a rule/i);
    await expect(gapPanel.getByTestId('ga-gap-platform-reason')).toBeVisible();
    await expect(gapPanel.getByRole('button', { name: /create|accept|run/i })).toHaveCount(0);
    // FR42 — the empty-suggestion case: a compiler-detected gap with no model
    // block persists `suggestedRule: null`. The panel must render without
    // throwing and simply omit the rule card, never show one keyed on nothing.
    if (flaggedStructuralGap && flaggedStructuralGap.suggestedRule === null) {
      await expect(gapPanel.getByTestId('ga-gap-suggested-rule')).toHaveCount(0);
      // The rest of the card (the load-bearing part — the platform reason) is
      // still there: a null suggestion does not blank the whole panel.
      await expect(gapPanel.getByTestId('ga-gap-platform-reason')).toBeVisible();
    }
  }
});

test('AC17 — the session history renders a past flagged plan as the same unsupported state, without the structural-gap panel', async ({ page }) => {
  test.skip(!anchor, 'no dataset available in the seeded tenant');
  test.skip(!flaggedPlanId, 'no flagged plan seeded via the API');
  await seedWorkspaceScope(page);
  await page.goto(`/projects/${projectId}/guided-analyses`);

  await expect(page.getByRole('heading', { name: 'Guided Analyses' })).toBeVisible({ timeout: 25_000 });
  // A shared demo DB accumulates one row per prior run of this same question —
  // `.first()` is the most recently listed (this run's own seed), not a
  // strict-mode ambiguity.
  const row = page.getByText(UNSUPPORTED_QUESTION).first();
  await expect(row).toBeVisible({ timeout: 25_000 });
  await row.click();

  await expect(page.getByTestId('ga-unsupported-state')).toBeVisible();
  await expect(page.getByTestId('ga-unsupported-question')).toHaveText(UNSUPPORTED_QUESTION);
  // `listPlans` never carries `structuralGap` (create-response-only field) — the
  // historical preview is absent-tolerant, never an empty card or an error.
  await expect(page.getByTestId('ga-structural-gap-panel')).toHaveCount(0);
  await expect(page.getByTestId('plan-run')).toHaveCount(0);
});
