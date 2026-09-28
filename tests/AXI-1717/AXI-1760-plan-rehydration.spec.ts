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

/**
 * AXI-1803 — do NOT tighten this back to `toBe(1)`.
 *
 * The property under test is that the plan-instance read is mounted ONCE, at
 * the PAGE (`useRestoreWorkbench`), and not once per node: AXI-1760 originally
 * mounted it inside `HoldoutRule`, which React renders per branch
 * (`SplitNode.tsx` — `<HoldoutRule key={branchName} …>`), so a reopened /
 * forked plan issued a read per branch. AXI-1793 moved it to the page and
 * nothing else pins that.
 *
 * But the suite runs against the Vite DEV server, where `StrictMode`
 * (`axiome-front/src/main.tsx`) mounts → unmounts → remounts every component,
 * so the read effect runs TWICE and the first fetch is already in flight when
 * the cleanup sets its `cancelled` flag. `analysisId` is a `useMemo` over the
 * route's search params and is stable from the first render, so nothing else
 * can retrigger the read: dev issues exactly 2, a production build exactly 1.
 * `toBe(1)` therefore asserts something that cannot hold in the environment it
 * executes in.
 *
 * So the bound is "one mount point, at most doubled by StrictMode" (1..2),
 * together with the stronger structural facts that survive the double-invoke:
 * every read targets the SAME analysis, and it is the analysis under test.
 * A read remounted per node scales with the branch count (2 × branches) and
 * still trips the upper bound; a read for another analysis trips the identity
 * check. Deduping by URL would NOT work here — a per-node read requests the
 * very same URL, so the duplicates are exactly what must stay countable.
 */
async function expectOneReadPerAnalysis(urls: string[], analysisId: string) {
  // The rendering assertions above already prove a read landed; settle so a
  // late third request fails the bound instead of racing past it.
  await expect.poll(() => urls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await new Promise((r) => setTimeout(r, 2_000));
  expect(new Set(urls).size, `reads hit more than one analysis: ${JSON.stringify(urls)}`).toBe(1);
  expect(urls[0]).toContain(`/discovery/analyses/${analysisId}/plan`);
  expect(urls.length, `expected ONE page-level read (≤2 under dev StrictMode), got ${urls.length}: ${JSON.stringify(urls)}`).toBeLessThanOrEqual(2);
}

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

    await expectOneReadPerAnalysis(planStateRequests, s.viewAnalysisId);
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

    await expectOneReadPerAnalysis(planStateRequests, s.declaredAnalysisId);
  });
});
