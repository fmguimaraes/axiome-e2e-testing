import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, driveToSplit, primeWorkspace, forceBrowserAuthStaleForTest, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1818 (epic AXI-1717) — the batch outruns the 15-minute JWT lifetime.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` (infra
 * fix — no new user-facing scenario; this spec is the regression guard for the
 * harness mechanism itself, see the story's `d` step note in its beacon/report).
 * Tags: @SI-046 (canvas rendering, reached by `driveToSplit`).
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. Running the actual AXI-1717 batch for
 * >15 real minutes was out of budget for this story. Instead this spec forces
 * the EXACT SAME staleness check `primeWorkspace` runs mid-batch
 * (`forceBrowserAuthStaleForTest`, `tests/AXI-1717/harness/live-workbench.ts`)
 * to fire on its very next call, then plants a deliberately INVALID
 * `access_token` in the page's `localStorage` before that call — simulating a
 * `storageState` frozen so long ago its token is worthless, the condition the
 * real batch reaches at minute 15+. It asserts `driveToSplit` still reaches
 * `discovery-workbench`, never the login screen, proving the re-mint runs and
 * wins before the app's own boot code reads `localStorage`. It does NOT prove
 * the 8-minute default interval survives a real 24-minute run wall-clock —
 * that is a real-time claim this spec cannot make cheaply and is left as the
 * honest gap in the story's report.
 */

test.describe('AXI-1818 - proactive re-mint survives a storageState token that has already gone bad', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1818-jwt-refresh-${Date.now().toString(36)}`, `AXI-1818 JWT Refresh ${Date.now().toString(36)}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('a page whose storageState access_token is already invalid still reaches discovery-workbench, not the login screen', async ({ page }) => {
    // Simulate a storageState this batch minted long ago: plant a token the
    // backend will reject outright, registered BEFORE primeWorkspace's own
    // init script so the later one (the real re-mint) overwrites it — the
    // same last-write-wins ordering `addInitScript` gives the real batch.
    await page.addInitScript(() => {
      localStorage.setItem('access_token', 'expired-simulated-for-axi-1818');
      localStorage.setItem('refresh_token', 'expired-simulated-for-axi-1818');
    });

    forceBrowserAuthStaleForTest();
    await primeWorkspace(page, s);

    await driveToSplit(page, s.projectId, s.viewAnalysisId);

    // Not the login screen: `driveToSplit` already asserts `discovery-workbench`
    // is visible; this is the explicit negative check the AXI-1818 root-cause
    // evidence named (`heading "Welcome back"` / `Sign In` button).
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign In' })).toHaveCount(0);
  });
});
