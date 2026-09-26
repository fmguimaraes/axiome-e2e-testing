import { test, expect, Page, Route } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ensureTenant1603 } from '../AXI-1603/harness/planner';

/**
 * AXI-1705 - J.W6 Front-end honesty (epic AXI-1687, SI-046). Offline: the browser drives the REAL
 * front end (the AXI-1705 worktree served by Vite, BASE_URL) and every planner/governed response
 * is synthetic through `page.route`, so no planner, provider key or Anthropic call is made and
 * `E2E_LIVE_LLM` is never read. The tenant/project fixture is API setup only (no LLM).
 * Scenario doc: manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md section J.1 to J.8.
 * Contract mocked: back `PlanResponse` / `AnalysisPlan` / `GovernedRunStatusResponse.family`
 * (axiome-back libs/contracts, AXI-1695/1701/1703 on main).
 */

type Tenant = Awaited<ReturnType<typeof ensureTenant1603>>;

async function seedWorkspaceScope(page: Page, t: Tenant): Promise<void> {
  await page.addInitScript(([ws, org]) => {
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-top-org', org);
  }, [t.workspaceId, t.orgId] as const);
}

function node(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, nodeType: 'compare_groups', stepLabel: `Compare ${id}`, clinicalQuestion: '', why: 'mock',
    dependsOn: [], params: {}, expectedEvidence: { effect_measure: 'difference in medians', report_ci: true },
    visualisation: null, proposedClaimCeiling: 'exploratory', familyId: 'F1',
    operation: { operationId: 'stats.mann_whitney_u' }, ...extra,
  };
}

function plan(question: string, over: Record<string, unknown> = {}) {
  return {
    planId: 'PL-mock-1705', revision: 1, question, sendData: false,
    reasoning: { restatedQuestion: question, whyThisApproach: 'mock', whatThisWillNotEstablish: 'mock', alternativesConsidered: [] },
    datasetsUsed: [], datasetsAvailableNotUsed: [], declaredFamily: null, nodes: [node('n1')],
    attemptCount: 1, intentUnsupported: false, ...over,
  };
}

async function interceptPlan(page: Page, body: (q: string) => Record<string, unknown>): Promise<void> {
  await page.route('**/api/v1/guided-analysis/plan', async (route: Route) => {
    const q = route.request().postDataJSON().envelope.question as string;
    await route.fulfill({
      status: 201, contentType: 'application/json',
      body: JSON.stringify({
        status: 'draft', envelopeHash: 'sha256:mock', plannerSawData: false, planner: 'compiled',
        promptId: null, promptVersion: null, promptTitle: null, plannerFallback: false, correlationId: 'axi1705-mock',
        attemptCount: 1, intentUnsupported: false, ...body(q),
      }),
    });
  });
}

async function ask(page: Page, t: Tenant, question: string): Promise<void> {
  await page.goto(`/guided-analysis?projectId=${t.projectId}`);
  await expect(page.getByTestId('ga-question')).toBeVisible({ timeout: 25_000 });
  await page.getByTestId('ga-question').fill(question);
  await page.getByTestId('ga-send').click();
}

test.describe.configure({ mode: 'parallel', timeout: 120_000 });
let api: Api;
let tenant: Tenant;
test.beforeAll(async () => { api = await adminApi(); tenant = await ensureTenant1603(api); });
test.afterAll(async () => { await api?.ctx.dispose(); });

test.describe('AXI-1705 front-end honesty', { tag: ['@SI-046'] }, () => {
  test('J.1 AC74 a stored summary that says "corrected" is not rendered when the flag is false @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    await interceptPlan(page, (q) => ({
      plan: plan(q, {
        familyCorrectionApplied: false,
        declaredFamily: { id: 'F1', correction: 'FDR', familySize: 1, memberNodeIds: ['n1'], summary: 'FDR-corrected across 1 test' },
      }),
    }));
    await ask(page, tenant, 'AXI-1705 J.1 probe');
    const label = page.getByTestId('ga-family-label');
    await expect(label).toBeVisible({ timeout: 20_000 });
    await expect(label).toContainText('No multiple-testing correction has been applied');
    await expect(label).not.toContainText('FDR-corrected');
  });

  test('J.2 AC77 exactly the declared disclaimers render, none added @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    await interceptPlan(page, (q) => ({
      plan: plan(q, { claimDisclaimers: [{ key: 'ruo', text: 'For research use only.' }, { key: 'sampling_design', text: 'Sampling design limits this claim.' }] }),
    }));
    await ask(page, tenant, 'AXI-1705 J.2 probe');
    const list = page.getByTestId('ga-claim-disclaimers');
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list).toContainText('For research use only.');
    await expect(list).toContainText('Sampling design limits this claim.');
  });

  test('J.3 AC76 a 48-member fan: badges from reported flags, 48 family rows, bounded scrollable table @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    const ids = Array.from({ length: 48 }, (_, i) => `m${i}`);
    await interceptPlan(page, (q) => ({
      plan: plan(q, {
        nodes: ids.map((id) => node(id)),
        declaredFamily: { id: 'F1', correction: 'FDR', familySize: 48, memberNodeIds: ids, summary: '48 contrasts declared as one FDR family' },
      }),
    }));
    await page.route('**/api/v1/governed-execution/submit', (r) =>
      r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ runId: 'GR-1705', viewAnalysisId: 'va-mock' }) }));
    await page.route('**/api/v1/governed-execution/status**', (r) =>
      r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          runId: 'GR-1705', status: 'COMPLETED', runStatus: 'ok', degraded: false, degradeReasons: [], failReason: null,
          counts: { plannedTests: 48, evaluableTests: 48, subjectsInScope: 10, completePairs: 0 },
          nodes: ids.map((id) => ({ nodeId: `GR-1705__${id}`, status: 'SUCCEEDED', inputFingerprint: null, artifactHash: null, error: null })),
          family: { familyId: 'F1', familySize: 48, familyCorrectionApplied: false, members: ids.map((id) => ({ nodeId: `GR-1705__${id}`, proposedClaimCeiling: 'exploratory' })) },
        }),
      }));
    await ask(page, tenant, 'AXI-1705 J.3 probe');
    await page.getByTestId('plan-run').click({ timeout: 20_000 });
    await expect(page.getByTestId('ga-badge-exploratory')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('ga-badge-not_corrected')).toBeVisible();
    await expect(page.getByTestId('ga-badge-corrected')).toHaveCount(0);
    await expect(page.getByTestId('ga-family-label')).toContainText('48 tests declared');
    await expect(page.getByTestId('ga-family-row')).toHaveCount(48);
    const table = page.getByTestId('ga-family-table');
    const [scrollH, clientH] = await table.evaluate((el) => [el.scrollHeight, el.clientHeight]);
    expect(scrollH).toBeGreaterThan(clientH);
    // Rows do not overlap: each row's top is at or below the previous row's bottom.
    const boxes = await page.getByTestId('ga-family-row').evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect()).map((b) => [b.top, b.bottom]));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i][0]).toBeGreaterThanOrEqual(boxes[i - 1][1] - 1);
  });

  test('J.4 AC76 EC39 a none whose route target is not built names the surface by id and renders no link @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    await interceptPlan(page, (q) => ({
      intentUnsupported: true, unsupportedReason: 'no_shape', unsupportedDetail: 'A cut-off proposal routes to discovery.',
      plan: plan(q, { intentUnsupported: true, unsupportedReason: 'no_shape', nodes: [] }),
      structuralGap: {
        suggestionId: 's1', missing: 'shape', platformReason: 'no_shape: cut-off proposals route to the discovery flow',
        explanation: null, suggestedRule: null,
        route: { kind: 'discovery_flow', ref: 'DISCOVERY-BIOMARKER-9', entry: 'cutoff', prefilled: { dataset: 'ds-1' } },
      },
    }));
    await ask(page, tenant, 'AXI-1705 J.4 probe');
    const named = page.getByTestId('ga-gap-route-named');
    await expect(named).toBeVisible({ timeout: 20_000 });
    await expect(named).toContainText('DISCOVERY-BIOMARKER-9');
    await expect(page.getByTestId('ga-gap-route-link')).toHaveCount(0);
    await expect(page.getByTestId('ga-structural-gap-panel').getByRole('link')).toHaveCount(0);
  });

  test('J.5 AC75 an operation declaring no interval reads "no interval for this test", never a 95% CI @SI-046', async ({ page }) => {
    await seedWorkspaceScope(page, tenant);
    const real = await api.get('/api/v1/rule-runs/operations');
    const ops = ((real.body as { operations?: unknown[] })?.operations ?? []) as Array<Record<string, any>>;
    const mw = ops.find((o) => o.operationId === 'stats.mann_whitney_u');
    test.skip(!mw, 'stats.mann_whitney_u is not served by this stack');
    await page.route('**/api/v1/rule-runs/operations**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ operations: [{ ...mw, output: { ...mw!.output, interval: null } }] }) }));
    await interceptPlan(page, (q) => ({ plan: plan(q) }));
    await ask(page, tenant, 'AXI-1705 J.5 probe');
    await page.locator('.react-flow__node[data-id="n1"]').dispatchEvent('click', undefined, { timeout: 25_000 });
    const drawer = page.getByText('Expected evidence:').locator('..');
    await expect(drawer).toContainText(/no interval for this test/i);
    await expect(drawer).not.toContainText('95% CI');
  });
});
