import { test, expect, type Page } from '@playwright/test';
import {
  seedLiveWorkbench, driveToSplit, primeWorkspace, declineHoldoutUrl, branchUrl, submitStepAndWait, SCREEN_OP, type Seeded,
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
 * the cleanup sets its `cancelled` flag. `analysisId` (`useRestoreWorkbench`'s
 * `live?.analysisId`, `axiome-front/src/lib/discoveryWorkbench/useRestoreWorkbench.ts:30`,
 * the effect's own `[analysisId]` dependency) is stable from the first render,
 * so nothing else can retrigger the read: dev issues exactly 2, a production build exactly 1.
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

/**
 * AXI-1812 — additive coverage recommended by the AXI-1803 review gate (not a
 * defect fix). `expectOneReadPerAnalysis`'s `<= 2` bound discriminates a
 * per-node read from the correct page-level one only when per-node WOULD have
 * scaled past it — and AXI-1760's own fixture holds exactly ONE branch, so a
 * page-level read and a read re-issued once per branch (the shape AXI-1793
 * fixed: the read used to live inside `HoldoutRule`, which `SplitNode.tsx`
 * renders `key={branchName}`, i.e. once per branch) both land on exactly 2 —
 * indistinguishable on a single-branch plan.
 *
 * This fixture forks THREE branches before the fresh mount under test. A
 * per-node read scales as `2 x branches` — 6 here — and would trip the SAME
 * `<= 2` bound `expectOneReadPerAnalysis` already enforces; a page-level read
 * stays at `<= 2` regardless of how many branches the plan carries. The branch
 * switcher assertion below additionally proves the bounded read is not
 * vacuous — the three branches actually landed FROM this one read (the store's
 * `branches` list is populated purely from the `GET …/plan` response,
 * `axiome-front/src/lib/discoveryWorkbench/planRestore.ts`), not from some
 * other, unmeasured channel.
 */
test.describe('AXI-1812 - a multi-branch plan proves the read stays page-level, not per-node (UI, real backend)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let s: Seeded;

  const restored = (page: Page) =>
    expect(page.getByTestId('discovery-workbench')).toHaveAttribute('data-restore-status', 'restored', { timeout: 60_000 });

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1812-${tag}`, `AXI-1812 Multi-branch read guard ${tag}`);
    // Branch 1: settle `screen` so it is forkable (FR18 — a fork off a step
    // that has not completed is refused). The API has no precondition that
    // `split` be decided first (AXI-1725's own harness submits `screen` the
    // same way), so this stays a pure API setup with no browser involved.
    await submitStepAndWait(s, s.viewAnalysisId, 'screen', SCREEN_OP);
    // Branch 2: fork off the now-settled `screen` on Branch 1.
    const fork2 = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen' }, s.t.headers);
    expect(fork2.status, JSON.stringify(fork2.body)).toBe(200);
    expect(fork2.body.forked, JSON.stringify(fork2.body)).toBe(true);
    expect(fork2.body.counts, JSON.stringify(fork2.body)).toMatchObject({ total: 2 });
    // Branch 3: fork off `screen` on Branch 1 a second time (independent of Branch 2).
    const fork3 = await s.api.post(branchUrl(s.viewAnalysisId), { nodeRef: 'screen' }, s.t.headers);
    expect(fork3.status, JSON.stringify(fork3.body)).toBe(200);
    expect(fork3.body.forked, JSON.stringify(fork3.body)).toBe(true);
    expect(fork3.body.counts, JSON.stringify(fork3.body)).toMatchObject({ total: 3 });
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('three branches on one analysis still cost ONE page-level read, never one per branch', async ({ page }) => {
    const planStateRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && /\/discovery\/analyses\/[^/]+\/plan(\?|$)/.test(req.url())) planStateRequests.push(req.url());
    });

    await primeWorkspace(page, s);
    await page.goto(`/projects/${s.projectId}/discovery-workbench?analysisId=${s.viewAnalysisId}`);
    await restored(page);

    // All three branches actually landed FROM THIS READ — never a click in
    // this session, and never a second, unmeasured fetch (`phase-rail-branch`
    // reads straight off the store's `branches`, which `planRestore.ts` builds
    // purely from the `GET …/plan` response under test).
    const switcher = page.getByTestId('phase-rail-branch');
    await expect(switcher).toBeVisible({ timeout: 30_000 });
    await expect(switcher.getByRole('button', { name: 'Branch 1' })).toBeVisible();
    await expect(switcher.getByRole('button', { name: 'Branch 2' })).toBeVisible();
    await expect(switcher.getByRole('button', { name: 'Branch 3' })).toBeVisible();

    // A per-node read would have scaled to 2 x 3 = 6 here and tripped this
    // SAME `<= 2` bound — the discrimination a single-branch fixture cannot make.
    await expectOneReadPerAnalysis(planStateRequests, s.viewAnalysisId);
  });
});
