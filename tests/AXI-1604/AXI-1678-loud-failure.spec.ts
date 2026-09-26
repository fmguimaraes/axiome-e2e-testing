import { test, expect, Page, Route } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import { ingestFixture } from '../AXI-1435/harness/seed';
import { buildEnvelope, planQuestion, ensureTenant1603 } from '../AXI-1603/harness/planner';
import { anchorDataset } from './harness/anchor-dataset';
import { LIVE_LLM, LIVE_LLM_SKIP_REASON } from '../../config/env';

/**
 * AXI-1678 — loud planner failure (epic AXI-1604): the Guided Analysis panel's
 * fallback notice is CAUSE-SPECIFIC per closed `fallbackReason` token and ends
 * with `Ref: <correlationId>` (AC2/AC3/AC5).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1604-Compiled-Planner-Rollout.md` §4.9.
 *
 * HARD RULE FOR THIS FILE: forcing a real provider failure on the shared demo
 * stack is not allowed (its key/provider must not be touched). Scenarios 1–5
 * therefore intercept `POST /api/v1/guided-analysis/plan` with `page.route`:
 * the front end's REAL request is built and sent, only the RESPONSE is
 * synthetic, and no planner token is spent. Scenario 6 makes ONE real call
 * and asserts the real response SCHEMA (correlationId always; fallbackReason
 * iff plannerFallback), skipping the fallback-shape half — never passing it —
 * when the planner answers.
 *
 * Shipped code this file is written against:
 *   - front: `strategySelection.ts#strategyFallbackNotice` (AXI-1678),
 *     `GuidedAnalysisPanel.tsx` (`ga-strategy-fallback-notice`,
 *     `data-fallback-reason`, `data-severity`).
 *   - back: `analysis-plan.patterns.ts#PLANNER_FALLBACK_REASONS` (AXI-1636/1654),
 *     `plan-orchestrator.service.ts` (top-level `fallbackReason` + `correlationId`).
 */

const PLANNER_FALLBACK_REASONS = [
  'attempts_exhausted',
  'provider_unavailable',
  'provider_not_configured',
  'provider_request_invalid',
] as const;

type Tenant = Awaited<ReturnType<typeof ensureTenant1603>>;

async function seedWorkspaceScope(page: Page, workspaceId: string, orgId: string): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [workspaceId, orgId] as const,
  );
}

/** A minimal, structurally-valid `AnalysisPlan` (mirrors the AXI-1524 spec). */
function minimalPlan(question: string, planId: string, correlationId?: string) {
  return {
    planId,
    revision: 1,
    question,
    sendData: false,
    reasoning: {
      restatedQuestion: question,
      whyThisApproach: 'mocked for AXI-1678 E2E — see AXI-1678-loud-failure.spec.ts',
      whatThisWillNotEstablish: 'n/a — synthetic plan, never submitted',
      alternativesConsidered: [],
    },
    datasetsUsed: [],
    datasetsAvailableNotUsed: [],
    declaredFamily: null,
    nodes: [],
    attemptCount: 1,
    intentUnsupported: false,
    ...(correlationId ? { correlationId } : {}),
  };
}

interface Injected {
  fallbackReason?: (typeof PLANNER_FALLBACK_REASONS)[number];
  correlationId?: string;
  attemptCount?: number;
  promptTitle?: string | null;
}

/** Intercept the plan POST and answer with a fallback plan carrying `inject`. */
async function interceptPlan(page: Page, inject: Injected): Promise<void> {
  await page.route('**/api/v1/guided-analysis/plan', async (route: Route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        plan: minimalPlan(body.envelope.question, `PL-mock-${inject.fallbackReason ?? 'none'}`, inject.correlationId),
        status: 'draft',
        envelopeHash: 'sha256:mock',
        plannerSawData: false,
        planner: 'deterministic',
        promptId: null,
        promptVersion: null,
        promptTitle: inject.promptTitle ?? null,
        plannerFallback: true,
        ...(inject.fallbackReason ? { fallbackReason: inject.fallbackReason } : {}),
        ...(inject.correlationId ? { correlationId: inject.correlationId } : {}),
        intentUnsupported: false,
        attemptCount: inject.attemptCount ?? 1,
      }),
    });
  });
}

async function askAndReadNotice(page: Page, tenant: Tenant, question: string) {
  await page.goto(`/guided-analysis?projectId=${tenant.projectId}`);
  await expect(page.getByTestId('ga-question')).toBeVisible({ timeout: 25_000 });
  await page.getByTestId('ga-question').fill(question);
  await page.getByTestId('ga-send').click();
  const notice = page.getByTestId('ga-strategy-fallback-notice');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  return notice;
}

test.describe.configure({ mode: 'parallel', timeout: 120_000 });

let api: Api;
let tenant: Tenant;

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant1603(api);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-1678 — cause-specific fallback notice (AC2/AC3/AC5)', { tag: ['@SI-045', '@SI-046'] }, () => {
  test('AC2 AC3 §4.9.1 — attempts_exhausted says the planner ANSWERED and was rejected N times, never "unavailable", with the Ref', async ({ page }) => {
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    const CID = 'axi1678-e2e-exhausted-0001';
    await interceptPlan(page, { fallbackReason: 'attempts_exhausted', attemptCount: 5, correlationId: CID });

    const notice = await askAndReadNotice(page, tenant, 'AXI-1678 §4.9.1 probe');
    await expect(notice).toContainText('answered');
    await expect(notice).toContainText('each of its 5 proposals was rejected');
    await expect(notice).not.toContainText(/unavailable|could not be reached/i);
    await expect(notice).toContainText(`Ref: ${CID}`);
    await expect(notice).toHaveAttribute('data-fallback-reason', 'attempts_exhausted');
    await expect(notice).toHaveAttribute('data-severity', 'warning');
    // No raw token in the visible copy.
    await expect(notice).not.toContainText('attempts_exhausted');
  });

  test('AC2 AC3 §4.9.2 — provider_unavailable uses outage wording with the Ref', async ({ page }) => {
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    const CID = 'axi1678-e2e-unavailable-0002';
    await interceptPlan(page, { fallbackReason: 'provider_unavailable', correlationId: CID });

    const notice = await askAndReadNotice(page, tenant, 'AXI-1678 §4.9.2 probe');
    await expect(notice).toContainText('could not be reached');
    await expect(notice).toContainText(/outage|rate limit|timeout/);
    await expect(notice).toContainText(`Ref: ${CID}`);
    await expect(notice).toHaveAttribute('data-fallback-reason', 'provider_unavailable');
    await expect(notice).not.toContainText('provider_unavailable');
  });

  test('AC2 AC3 §4.9.3 — provider_not_configured says no planner is configured, not an outage', async ({ page }) => {
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    const CID = 'axi1678-e2e-notconfigured-0003';
    await interceptPlan(page, { fallbackReason: 'provider_not_configured', correlationId: CID });

    const notice = await askAndReadNotice(page, tenant, 'AXI-1678 §4.9.3 probe');
    await expect(notice).toContainText('No planner is configured');
    await expect(notice).not.toContainText(/unavailable|could not be reached|outage/i);
    await expect(notice).toContainText(`Ref: ${CID}`);
    await expect(notice).toHaveAttribute('data-fallback-reason', 'provider_not_configured');
  });

  test('AC2 AC3 §4.9.4 — provider_request_invalid is a red "platform defect" alert asking the user to report the Ref', async ({ page }) => {
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    const CID = 'axi1678-e2e-requestinvalid-0004';
    await interceptPlan(page, { fallbackReason: 'provider_request_invalid', correlationId: CID });

    const notice = await askAndReadNotice(page, tenant, 'AXI-1678 §4.9.4 probe');
    await expect(notice).toContainText('platform defect');
    await expect(notice).toContainText('not a problem with your question or data');
    await expect(notice).toContainText('report this to support');
    await expect(notice).toContainText(`Ref: ${CID}`);
    await expect(notice).not.toContainText(/unavailable/i);
    await expect(notice).toHaveAttribute('data-severity', 'defect');
    await expect(notice).toHaveAttribute('role', 'alert');
    await expect(notice).toHaveClass(/bg-red-50/);
    await expect(notice).not.toContainText('provider_request_invalid');
  });

  test('AC2 §4.9.5 — a fallback with NO reason token commits to no cause and names the strategy, no Ref', async ({ page }) => {
    await seedWorkspaceScope(page, tenant.workspaceId, tenant.orgId);
    const STRATEGY_TITLE = 'AXI-1678 no-token strategy';
    await interceptPlan(page, { promptTitle: STRATEGY_TITLE });

    const notice = await askAndReadNotice(page, tenant, 'AXI-1678 §4.9.5 probe');
    await expect(notice).toContainText('did not produce this plan');
    await expect(notice).toContainText(`"${STRATEGY_TITLE}"`);
    await expect(notice).not.toContainText(/unavailable|could not be reached|rejected/i);
    await expect(notice).not.toContainText('Ref:');
    await expect(notice).toHaveAttribute('data-fallback-reason', 'unknown');
  });
});

test.describe('AXI-1678 — real response schema (AC3/AC5, API)', { tag: ['@SI-045'] }, () => {
  // The only real planner call in this file — everything above is route-intercepted and free.
  test.skip(!LIVE_LLM, LIVE_LLM_SKIP_REASON);
  test('AC3 §4.9.6 — one real plan carries a correlationId; fallbackReason is a closed token iff plannerFallback', async ({}, testInfo) => {
    // ONE real planner call (the compiled arm's repair loop can run 5 attempts).
    testInfo.setTimeout(240_000);
    await ingestFixture(api, tenant, 'statistical-trigger.csv');
    const anchor = await anchorDataset(api, tenant.workspaceId, tenant.projectId);
    test.skip(!anchor, 'no dataset available in the AXI-1603 E2E tenant');

    const envelope = buildEnvelope(tenant.projectId, 'Is score different between the cohorts?', [anchor!]);
    const res = await planQuestion(api, tenant.workspaceId, tenant.projectId, envelope);
    expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBeLessThan(300);
    const body = res.body as any;

    // AXI-1624: every plan response echoes the minted correlationId at the top level.
    expect(typeof body.correlationId).toBe('string');
    expect(body.correlationId.length).toBeGreaterThan(0);
    expect(body.plan?.correlationId).toBe(body.correlationId);

    if (body.plannerFallback === true) {
      expect(PLANNER_FALLBACK_REASONS as readonly string[]).toContain(body.fallbackReason);
    } else {
      expect(body.fallbackReason).toBeUndefined();
      test.skip(
        true,
        `no fallback occurred live (planner="${body.planner}", attemptCount=${body.attemptCount}, intentUnsupported=${body.intentUnsupported}); ` +
          'the fallbackReason-present half of the schema is not exercised on this run — never claimed as passed.',
      );
    }
  });
});
