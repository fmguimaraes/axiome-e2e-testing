import { test, expect, type Page, type Route } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { silenceTours } from '../AXI-1904/harness/tours';
import { seedScope, gotoSettled } from './harness/new-analysis';

/**
 * AXI-2376 (epic AXI-2308 — FR47 restyle): the result page's "Running…" lead is the POC run
 * screen — eyebrow "Running", title "Running the analysis you signed.", a 4px accent progress
 * bar, and a step list (preconditions → one per analysis node → writing the trace). Progress is
 * real: the front polls `GET /governed-execution/status`, mapped by the SAME `toExecutionView`
 * the Guided tab's execution view already uses (`src/lib/guidedAnalysis/governedRun.ts`
 * `runProgressSteps`/`runProgressFraction`), rendered by the one shared `PlanProgress` component.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2376.2–.3.
 *
 * Both server reads the running page needs (`result-page`, `governed-execution/status`) are
 * stubbed in the browser — the same discipline `AXI-2343-relabel-pass.spec.ts` uses for
 * `result-page` — so the per-node transitions (done/current/pending) are deterministic rather
 * than racing a real run to completion.
 *
 * Run: `BASE_URL=<worktree Vite serving the AXI-2376 branch> API_BASE_URL=<its gateway>
 *       npx playwright test tests/AXI-2308/AXI-2376-*`.
 * NOT RUN by this agent — `wt-up.sh` isolated-stack provisioning is blocked for story-developer
 * subagents (see `reference_wtup_blocked_for_story_developer_agents`); authored only.
 */

const RUN_ID = 'GR-00002376';
const PROJECT_ID = () => t.projectId;

let api: Api;
let t: Tenant;

function resultPageBody(state: 'running' | 'ready', overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    projectId: t.projectId,
    state,
    question: 'Does IgG4 differ by sex?',
    templateId: 'T1',
    analysisId: null,
    analysisKind: 'exploratory',
    answer: state === 'ready' ? ['igg4_g_l: F (n = 12) vs M (n = 12); Mann-Whitney U = 40.5, p = 0.012.'] : [],
    canStartAnalysis: true,
    // AXI-2380: the post-AXI-2380 contract always carries these (null = no signed record / no mismatch).
    signedQuestion: null,
    questionMismatch: null,
    results: state === 'ready'
      ? [{
          nodeId: 'n1', ruleRunId: 'r1', operationId: 'stats.mann_whitney_u', label: 'Mann-Whitney U test',
          chart: null, style: null, rows: [{ statistic: 40.5, pValue: 0.012 }], summary: null, numbersInWords: null,
          run: { snapshotId: null, workspaceId: t.workspaceId, operandRoles: null, operationParams: null },
          evidence: {
            groupNs: [{ group: 'F', n: 12 }, { group: 'M', n: 12 }], method: 'Mann-Whitney U test',
            whyChosen: ['Two groups', 'One outcome'], parameters: [], familySize: 'not applicable',
            dataHash: 'sha256:stub', datasetVersion: '1', ruleVersion: 'OP-MWU v1', mode: 'guided (template T1)',
          },
        }]
      : [],
    ...overrides,
  };
}

function governedStatusBody(nodes: Array<{ nodeId: string; status: string }>, runStatus = 'RUNNING', operationId = 'stats.mann_whitney_u') {
  return {
    runId: RUN_ID, status: runStatus, operationId,
    nodes: nodes.map((n) => ({ nodeId: `${RUN_ID}__${n.nodeId}`, status: n.status, inputFingerprint: null, artifactHash: null, error: null })),
  };
}

async function stubResultPageRoute(page: Page, body: Record<string, unknown>): Promise<void> {
  await page.route(/\/api\/v1\/projects\/[^/]+\/runs\/[^/]+\/result-page(\?|$)/, (r: Route) => r.fulfill({ status: 200, json: body }));
}

async function stubGovernedStatusRoute(page: Page, body: Record<string, unknown> | null): Promise<void> {
  await page.route(/\/api\/v1\/governed-execution\/status(\?|$)/, (r: Route) =>
    (body ? r.fulfill({ status: 200, json: body }) : r.fulfill({ status: 404, json: { message: 'not found' } })));
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  api = await adminApi();
  t = await ensureTenant(api);
  await silenceTours(await adminToken());
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe.serial('AXI-2376 run progress — the POC run screen @SI-066 @SI-046', () => {
  test('FR47 — AXI-2376.2 running shows eyebrow, title, bar and step list; AC2 steps track real per-node progress', async ({ page }) => {
    await seedScope(page, t);
    await stubResultPageRoute(page, resultPageBody('running'));
    await stubGovernedStatusRoute(page, governedStatusBody([{ nodeId: 'n1', status: 'SUCCEEDED' }, { nodeId: 'n2', status: 'RUNNING' }]));

    // Act
    await gotoSettled(page, `/projects/${PROJECT_ID()}/runs/${RUN_ID}`);

    // Assert — the POC chrome
    const running = page.getByTestId('rp-running');
    await expect(running).toBeVisible({ timeout: 30_000 });
    await expect(running).toContainText('Running');
    await expect(running).toContainText('Running the analysis you signed.');
    await expect(running).toContainText('Checking preconditions and assumptions');
    await expect(running).toContainText('Writing the trace: every result back to its rule and source');
    await expect(running).toHaveAttribute('aria-live', 'polite');

    // Assert — real per-node progress: n1 done, n2 current, trace pending
    await expect(running.locator('[data-testid="plan-step-n1"]')).toHaveAttribute('data-state', 'done');
    await expect(running.locator('[data-testid="plan-step-n2"]')).toHaveAttribute('data-state', 'active');
    await expect(running.locator('[data-testid="plan-step-trace"]')).toHaveAttribute('data-state', 'pending');

    // Assert — the bar fill is done/total (2 of 4 steps done: preconditions + n1)
    const bar = running.locator('[style*="width"]');
    await expect(bar).toHaveAttribute('style', /width:\s*50%/);
  });

  test('AC2 — AXI-2376.2b once every node is done the run finishes and the page shows the ready answer', async ({ page }) => {
    await seedScope(page, t);
    await stubResultPageRoute(page, resultPageBody('ready'));

    // Act
    await gotoSettled(page, `/projects/${PROJECT_ID()}/runs/${RUN_ID}`);

    // Assert
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('rp-running')).toHaveCount(0);
  });

  test('AC3 — AXI-2376.4 an unavailable governed-status read falls back to the plain 2-step list, never a fabricated node', async ({ page }) => {
    await seedScope(page, t);
    await stubResultPageRoute(page, resultPageBody('running'));
    await stubGovernedStatusRoute(page, null); // 404 — status unavailable

    // Act
    await gotoSettled(page, `/projects/${PROJECT_ID()}/runs/${RUN_ID}`);

    // Assert
    const running = page.getByTestId('rp-running');
    await expect(running).toBeVisible({ timeout: 30_000 });
    await expect(running.locator('[data-testid="plan-step-preconditions"]')).toHaveAttribute('data-state', 'active');
    await expect(running.locator('[data-testid="plan-step-trace"]')).toHaveAttribute('data-state', 'pending');
    await expect(running.locator('[data-testid^="plan-step-n"]')).toHaveCount(0);
  });
});
