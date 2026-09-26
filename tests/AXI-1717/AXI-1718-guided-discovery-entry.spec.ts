import { test, expect, Page, Route } from '@playwright/test';
import { adminApi, workspaceHeader, asList, type Api } from '../AXI-1435/harness/api';
import { ingestFixture } from '../AXI-1435/harness/seed';
import { buildEnvelope, planQuestion, findPersistedPlan, submitPlanRun, ensureTenant1603 } from '../AXI-1603/harness/planner';
import { anchorDataset } from '../AXI-1604/harness/anchor-dataset';

/**
 * AXI-1718 — Guided discovery strategy entry and post-Run routing (epic AXI-1717).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` §4.
 * Tags: @SI-046 (front: selector, plan details, Run gate, workbench shell),
 *       @SI-045 (back: locked prompt, plan record, instance), @SI-030 (route).
 *
 * HARD RULE (same as AXI-1524): NO test here lets a request reach
 * `POST /guided-analysis/plan` unmocked unless it is in the E2E_LIVE_LLM-gated
 * describe at the bottom. That route calls the live Anthropic API. The UI tests
 * mock plan/submit/status/plans and assert the REAL request the front end built
 * and the REAL routing it does; the API test reads only LLM-free routes.
 *
 * STATUS: authored 2026-09-26 against the AXI-1718 worktrees; NOT yet run against
 * a live stack (the shared demo stack serves main and applying this story's
 * migration to the one shared DB was not authorised). Run before e2e-pass:
 *   npx playwright test tests/AXI-1717/AXI-1718-*   (stack on the AXI-1718 branches)
 */

const LOCKED_TITLE = 'Guided analysis';

interface Tenant { orgId: string; workspaceId: string; projectId: string }

let api: Api;
let tenant: Tenant;
let lockedPromptId: string | undefined;

async function seedWorkspaceScope(page: Page, workspaceId: string, orgId: string): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [workspaceId, orgId] as const,
  );
}

/** An opening-only plan: an ingest `profile` node and a `qc_check`. */
function openingPlan(question: string, planId: string) {
  const node = (id: string, nodeType: string) => ({
    id, nodeType, stepLabel: `${id}`, clinicalQuestion: question, why: 'opening step', dependsOn: [], params: {},
    expectedEvidence: 'n/a', visualisation: null, proposedClaimCeiling: 'descriptive_only', familyId: null,
  });
  return {
    planId, revision: 1, question, sendData: false,
    reasoning: { restatedQuestion: question, whyThisApproach: 'mocked (AXI-1718 E2E)', whatThisWillNotEstablish: 'n/a', alternativesConsidered: [] },
    datasetsUsed: [], datasetsAvailableNotUsed: [], declaredFamily: null,
    nodes: [node('d1', 'profile'), node('d2', 'qc_check')],
  };
}

const HASH = `sha256:${'ab'.repeat(32)}`;

function planResponse(body: any, over: Record<string, unknown> = {}) {
  return {
    plan: openingPlan(body.envelope.question, `PL-mock-${Date.now()}`),
    status: 'draft', envelopeHash: 'sha256:mock', plannerSawData: false, planner: 'anthropic',
    promptId: body.promptId ?? null, promptVersion: body.promptId ? 1 : null, promptTitle: body.promptId ? LOCKED_TITLE : null,
    plannerFallback: false, intentUnsupported: false, attemptCount: 1, correlationId: 'corr-mock',
    ...over,
  };
}

async function selectGuided(page: Page): Promise<void> {
  const select = page.getByTestId('ga-strategy');
  await expect(select).toBeVisible({ timeout: 25_000 });
  await select.selectOption({ label: LOCKED_TITLE });
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByTestId('ga-question').fill(question);
  await page.getByTestId('ga-send').click();
}

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

test.beforeAll(async () => {
  api = await adminApi();
  const t = await ensureTenant1603(api);
  tenant = { orgId: t.orgId, workspaceId: t.workspaceId, projectId: t.projectId };
  const list = await api.get('/api/v1/guided-analysis/prompts', workspaceHeader(tenant.workspaceId));
  lockedPromptId = asList(list.body).find((p: any) => p.title === LOCKED_TITLE)?.id;
});

test.afterAll(async () => { await api?.ctx.dispose(); });

test.describe('AXI-1718 — locked strategy in the existing library (AC0a, NFR8, API)', { tag: ['@SI-045', '@SI-046'] }, () => {
  test('AC0a — the library lists ONE locked "Guided analysis" strategy, flagged guided_discovery, beside the existing ones', async () => {
    const res = await api.get('/api/v1/guided-analysis/prompts', workspaceHeader(tenant.workspaceId));
    expect(res.status).toBe(200);
    const rows = asList(res.body);
    const guided = rows.filter((p: any) => p.strategy === 'guided_discovery');
    expect(guided).toHaveLength(1);
    expect(guided[0]).toMatchObject({ title: LOCKED_TITLE, locked: true, origin: 'system' });
    // No second selector / no other flagged row; the pre-existing seeds still exist unflagged.
    const biomarker = rows.find((p: any) => p.title === 'Biomarker exploration');
    expect(biomarker, 'AXI-1601 seed still present').toBeTruthy();
    expect(biomarker).not.toHaveProperty('locked');
  });

  test('AC0a — the locked strategy cannot be edited or archived, even by an admin', async () => {
    test.skip(!lockedPromptId, 'locked strategy not seeded in this workspace (stack not on the AXI-1718 branch)');
    const headers = workspaceHeader(tenant.workspaceId);
    const edit = await api.patch(`/api/v1/guided-analysis/prompts/${lockedPromptId}`, { title: LOCKED_TITLE, text: 'x'.repeat(50) }, headers);
    expect(edit.status).toBe(403);
    const archive = await api.post(`/api/v1/guided-analysis/prompts/${lockedPromptId}/archive`, {}, headers);
    expect(archive.status).toBe(403);
    const after = await api.get(`/api/v1/guided-analysis/prompts/${lockedPromptId}`, headers);
    expect(after.body.archivedAt).toBeNull();
  });
});

test.describe('AXI-1718 — entry, plan details, Run gate (UI, planner mocked)', { tag: ['@SI-046'] }, () => {
  test('AC0a — selecting Guided analysis sends its promptId and the plan details show the version hash; Run stays available', async ({ page }) => {
    test.skip(!lockedPromptId, 'locked strategy not seeded in this workspace');
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    const captured: any[] = [];
    await page.route('**/api/v1/guided-analysis/plan', async (route: Route) => {
      const body = route.request().postDataJSON();
      captured.push(body);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(planResponse(body, { strategy: 'guided_discovery', promptHash: HASH })) });
    });
    await page.goto(`/guided-analysis?projectId=${tenant.projectId}`);
    await selectGuided(page);
    await expect(page.getByTestId('ga-strategy-guided-hint')).toBeVisible();
    await ask(page, 'AXI-1718 AC0a — which markers differ between responders?');
    await expect.poll(() => captured.length, { timeout: 30_000 }).toBe(1);
    expect(captured[0].promptId).toBe(lockedPromptId);
    await expect(page.getByTestId('ga-strategy-hash')).toHaveAttribute('data-hash', HASH, { timeout: 25_000 });
    await expect(page.getByTestId('ga-strategy-refusal')).toHaveCount(0);
    await expect(page.getByTestId('plan-run')).toBeEnabled();
  });

  test('EC1b — a guided plan the server refuses shows the reason and Run is unavailable', async ({ page }) => {
    test.skip(!lockedPromptId, 'locked strategy not seeded in this workspace');
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    const reason = 'The planner returned no supported plan for this question under the guided discovery strategy, so there is no opening to continue from.';
    await page.route('**/api/v1/guided-analysis/plan', async (route: Route) => {
      const body = route.request().postDataJSON();
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(planResponse(body, { strategy: 'guided_discovery', promptHash: HASH, strategyRefusal: reason })) });
    });
    await page.goto(`/guided-analysis?projectId=${tenant.projectId}`);
    await selectGuided(page);
    await ask(page, 'AXI-1718 EC1b — refused opening');
    await expect(page.getByTestId('ga-strategy-refusal')).toHaveText(reason, { timeout: 25_000 });
    await expect(page.getByTestId('plan-run')).toBeDisabled();
    await expect(page).not.toHaveURL(/guided-workbench/);
  });

  test('NFR8 — a No-strategy plan renders exactly as before: no strategy line, no refusal, Run available', async ({ page }) => {
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    const captured: any[] = [];
    await page.route('**/api/v1/guided-analysis/plan', async (route: Route) => {
      const body = route.request().postDataJSON();
      captured.push(body);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(planResponse(body)) });
    });
    await page.goto(`/guided-analysis?projectId=${tenant.projectId}`);
    await expect(page.getByTestId('ga-strategy')).toHaveValue('', { timeout: 25_000 });
    await ask(page, 'AXI-1718 NFR8 — no strategy');
    await expect.poll(() => captured.length, { timeout: 30_000 }).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(captured[0], 'promptId')).toBe(false);
    await expect(page.getByTestId('plan-run')).toBeEnabled({ timeout: 25_000 });
    await expect(page.getByTestId('ga-strategy-detail')).toHaveCount(0);
    await expect(page.getByTestId('ga-strategy-refusal')).toHaveCount(0);
  });
});

test.describe('AXI-1718 — post-Run routing (UI, planner and run mocked)', { tag: ['@SI-046', '@SI-030'] }, () => {
  async function mockRun(page: Page, planIdOut: { id?: string }, guided: boolean) {
    await page.route('**/api/v1/guided-analysis/plan', async (route: Route) => {
      const body = route.request().postDataJSON();
      const res = planResponse(body, guided ? { strategy: 'guided_discovery', promptHash: HASH } : {});
      planIdOut.id = res.plan.planId;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(res) });
    });
    await page.route('**/api/v1/governed-execution/submit', async (route: Route) => {
      await route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify({ runId: 'GR-mock1', viewAnalysisId: 'VA-mock1', ...(guided ? { discoveryInstanceId: 'INST-mock1' } : {}) }),
      });
    });
    await page.route('**/api/v1/governed-execution/status*', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: 'GR-mock1', status: 'RUNNING', nodes: [], runStatus: 'running' }) });
    });
  }

  test('AC0b — Run on a guided plan opens the workbench shell on that plan and run', async ({ page }) => {
    test.skip(!lockedPromptId, 'locked strategy not seeded in this workspace');
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    const planIdOut: { id?: string } = {};
    await mockRun(page, planIdOut, true);
    await page.goto(`/guided-analysis?projectId=${tenant.projectId}`);
    await selectGuided(page);
    await ask(page, 'AXI-1718 AC0b — guided run');
    await expect(page.getByTestId('plan-run')).toBeEnabled({ timeout: 25_000 });
    // The workbench shell reads the persisted plan list; serve the same mocked plan back.
    await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          planId: planIdOut.id, question: 'AXI-1718 AC0b — guided run', planner: 'anthropic', revision: 1, status: 'run',
          createdAt: new Date().toISOString(), plan: openingPlan('AXI-1718 AC0b — guided run', planIdOut.id!),
          strategy: 'guided_discovery', promptHash: HASH, promptVersion: 1, promptTitle: LOCKED_TITLE, analysisId: 'VA-mock1',
        }]),
      });
    });
    await page.getByTestId('plan-run').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${tenant.projectId}/guided-workbench/${planIdOut.id}\\?.*runId=GR-mock1`), { timeout: 25_000 });
    await expect(page.getByTestId('workbench-shell')).toBeVisible();
    await expect(page.getByTestId('workbench-question')).toHaveText('AXI-1718 AC0b — guided run');
    await expect(page.getByTestId('workbench-run-id')).toContainText('GR-mock1');
    await expect(page.getByTestId('workbench-strategy')).toContainText('abababababab');
    await expect(page.getByTestId('workbench-result-link')).toHaveAttribute('href', new RegExp('/view-analyses/VA-mock1$'));
    await expect(page.getByTestId('workbench-shell-content')).toBeVisible();
  });

  test('AC0b — Run on an unguided plan stays on today\'s view; no workbench opens', async ({ page }) => {
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    await mockRun(page, {}, false);
    await page.goto(`/guided-analysis?projectId=${tenant.projectId}`);
    await expect(page.getByTestId('ga-strategy')).toBeVisible({ timeout: 25_000 });
    await ask(page, 'AXI-1718 AC0b — unguided run');
    await expect(page.getByTestId('plan-run')).toBeEnabled({ timeout: 25_000 });
    await page.getByTestId('plan-run').click();
    await expect(page.getByTestId('plan-run-status').or(page.getByTestId('ga-run-status-chip')).first()).toBeVisible({ timeout: 25_000 });
    await expect(page).not.toHaveURL(/guided-workbench/);
    await expect(page.getByTestId('workbench-shell')).toHaveCount(0);
  });

  test('EC1b — the workbench route for a non-guided plan opens no workbench', async ({ page }) => {
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    await page.route('**/api/v1/guided-analysis/plans*', async (route: Route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{ planId: 'PL-none-1', question: 'q', planner: 'anthropic', revision: 1, status: 'run', createdAt: new Date().toISOString(), plan: openingPlan('q', 'PL-none-1') }]),
      });
    });
    await page.goto(`/projects/${tenant.projectId}/guided-workbench/PL-none-1`);
    await expect(page.getByTestId('workbench-not-guided')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('workbench-shell-content')).toHaveCount(0);
  });
});

// ── Real planner (opt-in: E2E_LIVE_LLM=1 — paid; never in a default run) ─────────────
test.describe('AXI-1718 — real planner under the locked strategy (AC0d, AC0e, AC0c, NFR8)', { tag: ['@SI-045', '@SI-046'] }, () => {
  test.describe.configure({ timeout: 300_000 });

  test('AC0d/AC0e — a guided plan is opening-only or refused; a runnable one gets exactly one instance, reused on a second Run (AC0c: same analysis lineage)', async () => {
    test.skip(!lockedPromptId, 'locked strategy not seeded in this workspace');
    const { workspaceId, projectId } = tenant;
    const t = await ensureTenant1603(api);
    await ingestFixture(api, t, 'statistical-trigger.csv');
    const anchor = await anchorDataset(api, workspaceId, projectId);
    test.skip(!anchor, 'no dataset available to anchor a plan on');

    const res = await planQuestion(api, workspaceId, projectId, buildEnvelope(projectId, 'Compare score between cohort 0 and cohort 1.', [anchor!]), lockedPromptId);
    expect(res.status).toBeLessThan(300);
    expect(res.body).toMatchObject({ strategy: 'guided_discovery' });
    expect((res.body as any).promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const persisted = await findPersistedPlan(api, workspaceId, projectId, res.body.plan.planId);
    expect(persisted).toMatchObject({ strategy: 'guided_discovery', promptHash: (res.body as any).promptHash });

    const refusal = (res.body as any).strategyRefusal as string | undefined;
    const first = await submitPlanRun(api, workspaceId, projectId, res.body.plan.planId, res.body.plan, anchor!.datasetId);
    if (refusal) {
      // EC1b: server-side refusal, nothing submitted.
      expect(first.status).toBe(409);
      expect(JSON.stringify(first.body)).toContain('GUIDED_DISCOVERY_PLAN_REFUSED');
      return;
    }
    expect(first.status).toBeLessThan(300);
    expect(first.body.discoveryInstanceId).toBeTruthy();
    const second = await submitPlanRun(api, workspaceId, projectId, res.body.plan.planId, res.body.plan, anchor!.datasetId);
    expect(second.status).toBeLessThan(300);
    expect(second.body.discoveryInstanceId).toBe(first.body.discoveryInstanceId);
  });

  test('NFR8 — a No-strategy plan submits with no discoveryInstanceId', async () => {
    const { workspaceId, projectId } = tenant;
    const anchor = await anchorDataset(api, workspaceId, projectId);
    test.skip(!anchor, 'no dataset available to anchor a plan on');
    const res = await planQuestion(api, workspaceId, projectId, buildEnvelope(projectId, 'Compare score between cohort 0 and cohort 1.', [anchor!]));
    expect(res.body).not.toHaveProperty('strategy');
    test.skip(!!res.body.intentUnsupported, 'planner returned none for the ordinary question');
    const run = await submitPlanRun(api, workspaceId, projectId, res.body.plan.planId, res.body.plan, anchor!.datasetId);
    expect(run.status).toBeLessThan(300);
    expect(run.body).not.toHaveProperty('discoveryInstanceId');
  });
});
