import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, driveToSplit, primeWorkspace, declineHoldoutUrl, submitStepAndWait, SCREEN_OP, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1856 — `restoreFromPlan`'s own-session-decision guard refused a WHOLE
 * restore for a branch left over from a DIFFERENT analysis, not just a race
 * against this one. Epic AXI-1717. Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` §24.
 * Tag: @SI-046 (front: `workbenchStore.ts#restoreFromPlan` / `useRestoreWorkbench`).
 *
 * The confirmed trigger: "Start over" (AXI-1873) is the one real UI control
 * that client-side-navigates `DiscoveryWorkbench` from one `?analysisId=` to
 * ANOTHER on the SAME project — the page's `reset()` effect is keyed on
 * `projectId` only, so the SAME mounted component carries the OLD analysis's
 * decided split into the NEW analysis's restore read. Before the fix, that
 * stale decided branch made the guard refuse the new analysis's restore
 * outright; the new container rendered as if it, too, had a decided split.
 *
 * REAL BACKEND, LLM-FREE — the plan is a template instantiation, never a
 * planner call. AUTHORED AND TYPECHECKED; run status recorded in the
 * delivery report (no worktree stack was provisioned to execute this spec
 * live — see the manual-e2e doc's run-status note for this section).
 */
test.describe('AXI-1856 - switching analysisId on the same mounted page lands the NEW analysis, never the old one\'s stale decision', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1856-${tag}`, `AXI-1856 Restore analysis scope ${tag}`);
    // `start-over` reads the recorded screen back (AXI-1873's own harness does the same).
    await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP);
    // The OLD container's split is DECIDED (declined) — recorded via a direct API call,
    // never a click in the browser session under test (AXI-1760's own pattern).
    const declined = await s.api.post(declineHoldoutUrl(s.viewAnalysisId, 'split'), { reason: 'axi-1856: declined before start-over' }, s.t.headers);
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.declined).toBe(true);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC - "Start over" (same mount, new analysisId) restores the FRESH container\'s undecided split, not the archived one\'s decline', async ({ page }) => {
    await primeWorkspace(page, s);
    await driveToSplit(page, s.projectId, s.viewAnalysisId);
    // Sanity: the OLD analysis's restore really does show the decided decline, so the
    // navigation below is a genuine state transition, not a vacuous pass.
    await expect(page.getByTestId('split-holdout-decision')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('split-holdout-decision')).toContainText('axi-1856: declined before start-over');

    await page.getByTestId('workbench-start-over-button').click();
    await expect(page.getByTestId('workbench-start-over-modal')).toBeVisible();
    await page.getByTestId('workbench-start-over-confirm').click();

    // Client-side navigation: the URL's `analysisId` changes, the page never reloads —
    // `DiscoveryWorkbench` stays the SAME mounted component instance throughout.
    await expect(page).toHaveURL(/\/discovery-workbench\?analysisId=[^&]+$/);
    await expect(page.getByTestId('discovery-workbench')).not.toHaveAttribute('data-restore-status', 'reading', { timeout: 60_000 });

    // THE AXI-1856 PROPERTY: the NEW container's own restore must land, not be refused
    // by the OLD analysis's decided branch still sitting in this same mounted store — so
    // the old decline's badge must NOT still be showing under the new analysisId.
    await expect(page.getByTestId('split-holdout-decision')).toHaveCount(0);
    // The restore error banner (a read that genuinely failed) must not be confused with
    // this — a failed restore is reported loudly, never rendered as "nothing recorded".
    await expect(page.getByTestId('workbench-restore-error')).toHaveCount(0);
  });
});
