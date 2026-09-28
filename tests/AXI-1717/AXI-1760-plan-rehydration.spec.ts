import { test, expect } from '@playwright/test';
import {
  seedLiveWorkbench, driveToSplit, primeWorkspace, declineHoldoutUrl, type Seeded,
} from './harness/live-workbench';

/**
 * AXI-1760 — Live split rehydrates on a fresh mount (epic AXI-1717, FR4).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` §19.
 * Tag: @SI-046 (front: SplitNode live wiring / rehydration hook).
 *
 * REAL BACKEND, LLM-FREE — the nine-step plan is a TEMPLATE instantiation
 * (`POST /discovery/plans`), never a planner call.
 *
 * `driveToSplit` (harness, AXI-1760) reaches the Split node WITHOUT ever
 * clicking take/decline — the point of a rehydration test is that the node's
 * state comes from `GET .../plan` alone, never from a click made in this
 * session.
 */

test.describe('AXI-1760 - a fresh mount rehydrates the instance\'s own settled split state (UI, real backend)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    s = await seedLiveWorkbench(`axi-1760-${Date.now().toString(36)}`, `AXI-1760 Plan Rehydration ${Date.now().toString(36)}`);
    // Decline recorded via a DIRECT API call, in a session that never opens
    // the browser — the point of AC1 is that a FRESH mount (a different
    // session entirely) reads this back, never that this page's own click did.
    const declined = await s.api.post(declineHoldoutUrl(s.viewAnalysisId, 'split'), { reason: 'axi-1760: declined in an earlier session' }, s.t.headers);
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    expect(declined.body.declined).toBe(true);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC1 - a question declined in an earlier session renders the decline + reason on a fresh mount, with no click', async ({ page }) => {
    const planStateRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && /\/discovery\/analyses\/[^/]+\/plan(\?|$)/.test(req.url())) planStateRequests.push(req.url());
    });

    await primeWorkspace(page, s);
    await driveToSplit(page, s.projectId, s.viewAnalysisId);

    // The decline renders from the REHYDRATED state — this session never
    // clicked `split-decline-holdout` or `split-decline-confirm`.
    await expect(page.getByTestId('split-holdout-decision')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('split-holdout-decision')).toContainText('axi-1760: declined in an earlier session');
    await expect(page.getByTestId('split-take-holdout')).toHaveCount(0);
    await expect(page.getByTestId('split-decline-holdout')).toHaveCount(0);
    await expect(page.getByTestId('split-holdout-rehydrate-error')).toHaveCount(0);

    await expect.poll(() => planStateRequests.length).toBe(1);
  });

  test('AC3 - a question with no decision stays undecided on a fresh mount, and the rehydration read is the only extra request', async ({ page }) => {
    const planStateRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && /\/discovery\/analyses\/[^/]+\/plan(\?|$)/.test(req.url())) planStateRequests.push(req.url());
    });

    await primeWorkspace(page, s);
    // The DECLARED container never had its split touched — undecided.
    await driveToSplit(page, s.projectId, s.declaredAnalysisId);

    await expect(page.getByTestId('split-take-holdout')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('split-decline-holdout')).toBeVisible();
    await expect(page.getByTestId('split-holdout-decision')).toHaveCount(0);
    await expect(page.getByTestId('split-holdout-rehydrate-error')).toHaveCount(0);

    await expect.poll(() => planStateRequests.length).toBe(1);
  });
});
