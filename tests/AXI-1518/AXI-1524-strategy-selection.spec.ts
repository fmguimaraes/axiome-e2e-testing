import { test, expect, Page, Route } from '@playwright/test';
import { adminApi, workspaceHeader, asList, type Api } from '../AXI-1400/harness/api';

/**
 * AXI-1524 — strategy selection and verbatim plan binding (epic AXI-1518, WS2),
 * covering AC7–AC14 of feature BACKLOG-Guided-Analysis-Prompt-Library-And-Sessions,
 * plus AXI-1601's third seeded strategy (FR2/FR11/NFR5/AC5).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1518-Guided-Analysis-Prompt-Library.md`
 * §5A/§5B — read that file for what each test below asserts vs. skips and why.
 *
 * HARD RULE FOR THIS FILE: no test may let a real request reach
 * `POST /guided-analysis/plan` unmocked. That route's default provider
 * (`GUIDED_ANALYSIS_LLM_PROVIDER=anthropic`) calls the LIVE Anthropic API
 * (`anthropic-planner.adapter.ts`), and this authoring pass is explicitly
 * instructed not to trigger that. Every scenario below either:
 *   (a) intercepts the route with Playwright's `page.route` and asserts the
 *       REAL request the front end built, fulfilling with a synthetic
 *       response so nothing reaches the planner;
 *   (b) reads an already-real, LLM-free route (`GET /guided-analysis/prompts`
 *       — a DB read, no planner involved); or
 *   (c) `test.skip()`s with the concrete precondition that is missing (never a
 *       token-cost or "manual" excuse for what is really a missing fixture).
 *
 * Shipped code this file is written against:
 *   - back: 27ccea47b (AXI-1524 backend), aa032d8e5 (rework — bounces C1/C2/S1/S2)
 *   - front: 15292b9d (AXI-1524 frontend)
 *   - AXI-1601 seed: c45e3b3b (`system-prompt-seeds.ts`)
 */

const NAMES = {
  org: 'Axiome E2E Org',
  workspace: 'AXI-1518 Guided Analysis Prompt Library E2E',
  project: 'AXI-1524 Strategy Selection E2E',
};

interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  headers: Record<string, string>;
}

async function findByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: any) => x.name === name)?.id;
}

/** Additive, idempotent seeding — mirrors the `ensureTenant`/`ensureProject`
 *  pattern shared across `tests/AXI-1400`, `AXI-1435`, `AXI-1507` (never a
 *  second HTTP client; reuse-or-create by stable name). */
async function ensureTenant(api: Api): Promise<Tenant> {
  const orgId = (await findByName(api, '/api/v1/organizations', NAMES.org))
    ?? (await api.post('/api/v1/organizations', { name: NAMES.org, type: 'biotech' })).body.id;

  let workspaceId = await findByName(api, '/api/v1/workspaces', NAMES.workspace);
  if (!workspaceId) {
    const res = await api.post('/api/v1/workspaces', {
      name: NAMES.workspace, type: 'internal', ownerOrganizationId: orgId,
    });
    workspaceId = res.body.id;
  }
  const headers = workspaceHeader(workspaceId!);

  const projects = await api.get(`/api/v1/projects?workspaceId=${workspaceId}&limit=100`, headers);
  let projectId = asList(projects.body).find((p: any) => p.name === NAMES.project)?.id;
  if (!projectId) {
    const res = await api.post('/api/v1/projects', { name: NAMES.project, workspaceId }, headers);
    projectId = res.body.id;
  }
  return { orgId, workspaceId: workspaceId!, projectId: projectId!, headers };
}

async function seedWorkspaceScope(page: Page, workspaceId: string, orgId: string): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [workspaceId, orgId] as const,
  );
}

/** A minimal, structurally-valid `AnalysisPlan` (empty nodes/datasets render
 *  fine in `PlanPreview`'s React Flow canvas — no live dataset is needed). */
function minimalPlan(question: string, planId: string) {
  return {
    planId,
    revision: 1,
    question,
    sendData: false,
    reasoning: {
      restatedQuestion: question,
      whyThisApproach: 'mocked for AXI-1524 E2E — see AXI-1518-strategy-selection.spec.ts',
      whatThisWillNotEstablish: 'n/a — synthetic plan, never submitted',
      alternativesConsidered: [],
    },
    datasetsUsed: [],
    datasetsAvailableNotUsed: [],
    declaredFamily: null,
    nodes: [],
  };
}

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

let api: Api;
let tenant: Tenant;

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant(api);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

// ── §5A.1 — AC7 ─────────────────────────────────────────────────────────────

test('AC7 — the strategy combobox defaults to "No strategy" and that default omits promptId entirely, byte-identical to a real selection otherwise', async ({ page }) => {
  await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);

  const captured: any[] = [];
  await page.route('**/api/v1/guided-analysis/plan', async (route: Route) => {
    const body = route.request().postDataJSON();
    captured.push(body);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        plan: minimalPlan(body.envelope.question, `PL-mock-${captured.length}`),
        status: 'draft',
        envelopeHash: 'sha256:mock',
        plannerSawData: false,
        planner: 'anthropic',
        promptId: body.promptId ?? null,
        promptVersion: body.promptId ? 1 : null,
        promptTitle: body.promptId ? 'Conservative' : null,
        plannerFallback: false,
        intentUnsupported: false,
        attemptCount: 1,
      }),
    });
  });

  await page.goto(`/guided-analysis?projectId=${tenant.projectId}`);

  const strategySelect = page.getByTestId('ga-strategy');
  await expect(strategySelect).toBeVisible({ timeout: 25_000 });
  // FR12 — "no strategy" is the explicit default, first option.
  await expect(strategySelect).toHaveValue('');

  const question = 'AXI-1524 AC7 probe — did the marker change between timepoints?';
  await page.getByTestId('ga-question').fill(question);
  await page.getByTestId('ga-send').click();
  await expect.poll(() => captured.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

  const noStrategyRequest = captured[0];
  expect(Object.prototype.hasOwnProperty.call(noStrategyRequest, 'promptId'), 'no promptId key at all when nothing is selected').toBe(false);

  // Now select a real option (populated from the live, LLM-free
  // GET /guided-analysis/prompts) and ask the identical question again.
  const options = await strategySelect.locator('option').allTextContents();
  test.skip(options.length <= 1, 'no non-archived prompt exists in this workspace to select — AC1/AXI-1523 seeding did not run');
  const strategyLabel = options.find((o) => o !== 'No strategy')!;
  await strategySelect.selectOption({ label: strategyLabel });

  await page.getByTestId('ga-question').fill(question);
  await page.getByTestId('ga-send').click();
  await expect.poll(() => captured.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

  const withStrategyRequest = captured[1];
  expect(withStrategyRequest.promptId, 'the second request carries a real promptId').toBeTruthy();
  expect(withStrategyRequest.projectId).toBe(noStrategyRequest.projectId);
  expect(withStrategyRequest.envelope).toEqual(noStrategyRequest.envelope);
});

// ── §5A.2 — AC8 ─────────────────────────────────────────────────────────────

test('AC8 — the plan-history Strategy column renders the verbatim snapshot, never "No strategy" for a plan that selected one', async ({ page }) => {
  await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);

  const mockedPlans = [
    {
      planId: 'PL-mock-with-strategy',
      question: 'Q1 — under a strategy',
      planner: 'anthropic',
      revision: 1,
      status: 'draft',
      createdAt: new Date().toISOString(),
      plan: minimalPlan('Q1 — under a strategy', 'PL-mock-with-strategy'),
      promptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      promptVersion: 2,
      promptTitle: 'Conservative — paired designs first',
      promptText: 'mocked prompt text',
      analysisId: null,
      sessionId: null,
    },
    {
      planId: 'PL-mock-no-strategy',
      question: 'Q2 — no strategy selected',
      planner: 'anthropic',
      revision: 1,
      status: 'draft',
      createdAt: new Date().toISOString(),
      plan: minimalPlan('Q2 — no strategy selected', 'PL-mock-no-strategy'),
      promptId: null,
      promptVersion: null,
      promptTitle: null,
      promptText: null,
      analysisId: null,
      sessionId: null,
    },
  ];

  await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockedPlans) });
  });
  // The history page also probes a run-status endpoint per plan (AXI-1469);
  // that call is already `.catch(() => null)`-safe in the component, but
  // stubbing it keeps this test from depending on that endpoint's real shape.
  await page.route('**/api/v1/governed-execution/status*', async (route: Route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'not found' }) });
  });

  await page.goto(`/projects/${tenant.projectId}/guided-analyses`);
  await expect(page.getByRole('heading', { name: 'Guided Analyses' })).toBeVisible({ timeout: 25_000 });

  const rows = page.getByTestId('history-strategy');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText('Conservative — paired designs first');
  await expect(rows.nth(1)).toHaveText('No strategy');
});

// ── §5A.3 — AC9 (skipped, named precondition) ───────────────────────────────

test('AC9 — editing the live prompt afterwards changes nothing about an already-produced plan\'s rendering', async () => {
  test.skip(
    true,
    'Needs a REAL, persisted plan whose promptId/promptVersion/promptTitle/promptText were ' +
      'written by an actual POST /guided-analysis/plan call made under a strategy. Producing ' +
      'one requires a live Anthropic planner call, which this authoring pass must not trigger ' +
      '(see this file\'s header and manual-e2e/AXI-1518-…md §5A.3). The persistence half of the ' +
      'claim — promptText is copied verbatim at write time and never re-read from the live row ' +
      '— is covered by prompt-resolution.service.spec.ts and plan-orchestrator.service.spec.ts ' +
      '(UT-GUIDED-1524-*).',
  );
});

// ── §5A.7 — AC14 ─────────────────────────────────────────────────────────────

test('AC14 (rendering half) — a reported planner fallback under a strategy renders the exact fallback+strategy notice', async ({ page }) => {
  await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);

  const STRATEGY_TITLE = 'Conservative — paired designs first';
  await page.route('**/api/v1/guided-analysis/plan', async (route: Route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        plan: minimalPlan(body.envelope.question, 'PL-mock-fallback'),
        status: 'draft',
        envelopeHash: 'sha256:mock',
        plannerSawData: false,
        planner: 'deterministic',
        promptId: body.promptId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        promptVersion: 1,
        promptTitle: STRATEGY_TITLE,
        // AC14 — the fallback occurrence AND the prompt in force are both
        // reported unconditionally on the create response (FR19).
        plannerFallback: true,
        intentUnsupported: false,
        attemptCount: 4,
      }),
    });
  });

  await page.route('**/api/v1/guided-analysis/prompts*', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          workspaceId: tenant.workspaceId,
          title: STRATEGY_TITLE,
          text: 'mocked',
          origin: 'system',
          version: 1,
          createdBy: 'system',
          updatedBy: null,
          archivedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    });
  });

  await page.goto(`/guided-analysis?projectId=${tenant.projectId}`);
  const strategySelect = page.getByTestId('ga-strategy');
  await expect(strategySelect).toBeVisible({ timeout: 25_000 });
  await strategySelect.selectOption({ label: STRATEGY_TITLE });

  await page.getByTestId('ga-question').fill('AXI-1524 AC14 probe');
  await page.getByTestId('ga-send').click();

  // Exact copy from `strategySelection.ts`'s `strategyFallbackNotice()` — a
  // fallback plan must never be presented as though it answered the question
  // under the selected strategy. AXI-1678: this mock sends NO `fallbackReason`,
  // so the notice is the neutral no-cause sentence — it no longer claims the
  // planner "was unavailable" (a statement nothing here can support); the
  // cause-specific sentences are asserted in tests/AXI-1604/AXI-1678-loud-failure.spec.ts.
  const expectedNotice =
    `The configured planner did not produce this plan, so this plan was produced by the deterministic ` +
    `fallback while the "${STRATEGY_TITLE}" strategy was selected — it answers what the data ` +
    `supports, not necessarily that strategy's guidance.`;
  await expect(page.getByTestId('ga-strategy-fallback-notice')).toHaveText(expectedNotice, { timeout: 15_000 });
});

test('AC14 (triggering half) — a real repair-budget exhaustion under a real strategy selection', async () => {
  test.skip(
    true,
    'Requires actually exhausting PlannerService\'s attempt budget against the LIVE Anthropic ' +
      'planner, which this authoring pass must not trigger. The fallback/provider-selection logic ' +
      'itself (planner.service.ts\'s fallbackOccurred computation) is unit-covered.',
  );
});

// ── §5B — AXI-1601 ───────────────────────────────────────────────────────────

test('AC5 (AXI-1601) — a third system-origin strategy ("Biomarker exploration") is seeded, idempotent, and content-bounded', async () => {
  const first = await api.get('/api/v1/guided-analysis/prompts', tenant.headers);
  expect(first.status, `list prompts: ${JSON.stringify(first.body)}`).toBe(200);
  const firstList = asList(first.body);
  const systemPrompts = firstList.filter((p: any) => p.origin === 'system');
  expect(systemPrompts.length, 'three system-origin strategies (descriptive_first, conservative, biomarker_exploration)').toBeGreaterThanOrEqual(3);

  const biomarker = systemPrompts.find((p: any) => p.title === 'Biomarker exploration');
  expect(biomarker, 'the AXI-1601 seed is present').toBeTruthy();
  expect(biomarker.title.length).toBeGreaterThan(0);
  expect(biomarker.text.length).toBeGreaterThan(0);
  // FR11 — the same bound AC1's user-authored prompts are held to; the seed is
  // real product data and is not exempt from its own feature's bound.
  expect(biomarker.text.length).toBeLessThanOrEqual(4000);

  // Idempotency — a second list call (which would trigger a second seed
  // attempt if the id were not derived-and-stable) must return the SAME id.
  const second = await api.get('/api/v1/guided-analysis/prompts', tenant.headers);
  const secondBiomarker = asList(second.body).find((p: any) => p.title === 'Biomarker exploration');
  expect(secondBiomarker?.id).toBe(biomarker.id);
});

test('AC5 (AXI-1601) — the seed can never compose the template-only DISCOVERY-BIOMARKER-9 plan (P35 boundary)', async () => {
  test.skip(
    true,
    'Proving this live means asking the live planner, under the biomarker_exploration ' +
      'strategy, to attempt composing the governed 9-step plan and confirming plan rule P35 ' +
      '(templateOnlyNodeRules, plan-rules.ts) refuses the planner-proposed discovery_step — a ' +
      'live Anthropic call this authoring pass does not make. P35 refuses ANY planner-proposed ' +
      'discovery_step regardless of which strategy (if any) is selected, so the boundary is ' +
      'structural, not per-strategy; pinned by plan-rules.spec.ts\'s P35 coverage and by ' +
      'system-prompt-seeds.spec.ts\'s content-line test (UT-GUIDED-1601-01).',
  );
});
