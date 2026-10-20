import { test, expect, type Page, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  COMPLETE_GUIDANCE,
  COMPLETE_OUTPUT_FIELDS,
  deleteFixtureRules,
  ReviewWorld,
  RuleResponse,
  send,
  trackFixtureRule,
} from '../AXI-1762/AXI-1765-rule-review-fixtures';

/**
 * AXI-2083 (epic AXI-2060 — FR25, AC12): rule review actions — submit for
 * review, approve, request changes — on the rule detail page AND as bulk
 * actions on the rule library's selection bar, for rules of every scope
 * including system, each offered only when the SERVER says the signed-in
 * user may take it (the `review` block of `GET /rules/:id`), never a
 * client-side role guess.
 *
 * Scenario doc: manual-e2e/AXI-2060-Microbiote-IgG4-Study-Reproduction.md
 * (AXI-2083 section).
 *
 * This fixes a regression where the rule DETAIL page's Submit button was
 * driven by a client-side `scope !== 'system'` guess, so a checked SYSTEM
 * rule could never be submitted in the UI even though the server already
 * accepted the submit for a platform administrator. This spec proves the
 * UI now reads the server's `canSubmitForReview` advisory on a SYSTEM-scope
 * rule, following the API-level pattern established by AXI-1765/AXI-1774
 * for this epic family. Every rule this spec creates is a THROWAWAY fixture
 * (never the two real demo rules `796cfeb8-…`/`b80f04ef-…`): for the
 * system-rule path only visibility/refusal is asserted — no real system
 * rule outside this spec's own fixtures is ever mutated.
 */

const ACTOR_PASSWORD = 'AXI1765-e2e-pw!';
const AUTHOR = ['rule:read', 'rule:create', 'rule:update'];
// `rule:view_shared` is required (on top of org entitlement) to see a SYSTEM-
// scope rule at all (rule-visibility.service.ts#isRuleActionPermitted) — the
// reader here stays otherwise unprivileged so it still sees neither review
// action once it CAN see the rule.
const READER = ['rule:read', 'rule:view_shared'];
const PUBLISHER = ['rule:read', 'rule:update', 'rule:publish', 'rule:view_shared'];

// Every browser session is seeded explicitly per actor.
test.use({ storageState: { cookies: [], origins: [] } });

let world: ReviewWorld;
let authorRole: string;
let readerRole: string;
let publisherRole: string;

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  authorRole = await world.role('author-2083', AUTHOR);
  readerRole = await world.role('reader-2083', READER);
  publisherRole = await world.role('publisher-2083', PUBLISHER);
});

test.afterAll(async () => {
  // AXI-1809 / AXI-1822: rules this spec created must not outlive it.
  try {
    if (world) await deleteFixtureRules(world.admin);
  } finally {
    await world?.dispose();
  }
});

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function tokensFor(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
  const ctx = await apiRequest.newContext();
  try {
    return await send(ctx, 'post', '/api/v1/auth/login', { email, password });
  } finally {
    await ctx.dispose();
  }
}

/**
 * The onboarding tours auto-start on a user's first visit and navigate away
 * from the page under test — every throwaway actor is on its first visit.
 * Mark each tour skipped through the same API the tour's Skip button calls.
 */
const ONBOARDING_TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions',
  'graph-rules', 'help', 'admin', 'charts-views', 'collaboration',
];

async function skipOnboardingTours(accessToken: string): Promise<void> {
  const ctx = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` } });
  try {
    for (const tourId of ONBOARDING_TOUR_IDS) {
      const res = await ctx.put(apiUrl('/api/v1/onboarding-state'), {
        data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 },
      });
      expect(res.ok(), `skip tour ${tourId}: ${res.status()} ${await res.text()}`).toBeTruthy();
    }
  } finally {
    await ctx.dispose();
  }
}

/** Seed `page` with `actor`'s own session (the app reads the tokens from localStorage). */
async function signIn(page: Page, actor: Actor): Promise<void> {
  const tokens = await tokensFor(actor.email, ACTOR_PASSWORD);
  await skipOnboardingTours(tokens.accessToken);
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('access_token', access as string);
      localStorage.setItem('refresh_token', refresh as string);
    },
    [tokens.accessToken, tokens.refreshToken] as const,
  );
}

/** Seed `page` with the platform admin's session (bootstrap grant holds `rule:publish`). */
async function signInAdmin(page: Page): Promise<void> {
  const email = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
  const password = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
  const tokens = await tokensFor(email, password);
  await skipOnboardingTours(tokens.accessToken);
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('access_token', access as string);
      localStorage.setItem('refresh_token', refresh as string);
    },
    [tokens.accessToken, tokens.refreshToken] as const,
  );
}

async function detail(actor: Actor, id: string): Promise<RuleResponse> {
  return (await send(actor.api, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
}

/** A complete FEATURE_RULE landed `checked` by the FR9 gate — NOT submitted. */
async function checkedRule(
  author: Actor,
  scope: { scope: 'workspace'; workspaceId: string } | { scope: 'system' },
  overrides: Record<string, unknown> = {},
): Promise<RuleResponse> {
  const created = (await send(author.api, 'post', '/api/v1/rules', {
    code: unique('AXI-2083'),
    title: 'AXI-2083 review action fixture',
    category: 'phenotype_detection',
    protocolType: 'FEATURE_RULE',
    signals: ['marker:cd4_count'],
    ...scope,
    ...overrides,
  })) as RuleResponse;
  // Tracked before the PATCH, so a failure there cannot leak the rule.
  trackFixtureRule(created.id);
  const completed = (await send(author.api, 'patch', `/api/v1/rules/${created.id}`, {
    outputFields: COMPLETE_OUTPUT_FIELDS,
    guidance: COMPLETE_GUIDANCE,
  })) as RuleResponse;
  expect(completed.status, 'fixture rule must pass the FR9 gate').toBe('checked');
  return completed;
}

/** Open the rule page and wait until the review bar has rendered the server's view. */
async function openRule(page: Page, id: string, expectedStatus: string): Promise<void> {
  await page.goto(`/rules/${id}`);
  await expect(page.getByTestId('rule-review-panel')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('rule-review-status')).toHaveText(expectedStatus);
}

test.describe('AXI-2083 — rule review actions, system scope included (AC12)', () => {
  // AC12 — a platform administrator sees Submit for review on a checked SYSTEM
  // rule on the detail page (server advisory, not the retired client-side
  // `scope !== 'system'` guess) and submits it. Whether the admin ALSO sees
  // Approve on its own submission afterwards is a separate self-approval-pool
  // question (solo self-approval is allowed when no other rule:publish holder
  // exists yet — AXI-1765 §8.3.4) covered by the next test's two-actor
  // scenario; this test only pins UI/server PARITY on that point, never a
  // hardcoded outcome that depends on how many other approvers this shared
  // throwaway org has accumulated by the time it runs.
  test('AC12 — platform admin submits a checked system rule from the detail page @SI-017 @SI-035', async ({ page }) => {
    const admin: Actor = { userId: world.adminUserId, email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local', api: world.admin };
    const rule = await checkedRule(admin, { scope: 'system' });

    // Direct-endpoint parity check first: the server's own advisory already
    // says the admin may submit — the UI must say exactly the same thing.
    const before = await detail(admin, rule.id);
    expect(before.review?.canSubmitForReview, 'server advisory must allow the platform admin to submit a system rule').toBe(true);

    await signInAdmin(page);
    await openRule(page, rule.id, 'Checked');
    await expect(page.getByTestId('rule-status-badge')).toHaveText('Checked');
    // `rule-review-status` (asserted by openRule) is the page's STATUS badge,
    // fed from the already-fetched rule object; the review ACTION buttons are
    // gated on the separate by-id `review` read (`RuleReviewBar`'s `detail`
    // prop), which can still be in flight once the status badge has already
    // painted — so this needs its own generous wait, not the default 5s.
    await expect(page.getByTestId('rule-submit-for-review')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('rule-approve')).toHaveCount(0);

    await page.getByTestId('rule-submit-for-review').click();
    await expect(page.getByTestId('rule-review-status')).toHaveText('In review');
    await expect(page.getByTestId('rule-submit-for-review')).toHaveCount(0);

    const after = await detail(admin, rule.id);
    expect(after.status).toBe('in_review');
    // Parity: the UI's Approve affordance must match the server's own verdict,
    // whichever way the shared pool currently resolves it — never a role guess.
    const approveCount = after.review?.canApprove ? 1 : 0;
    await expect(page.getByTestId('rule-approve')).toHaveCount(approveCount);
  });

  // AC12 — a second Rule Approver who did not submit the (now in_review) system
  // rule sees Approve; a user without rule:publish sees neither action; and
  // calling the endpoints directly as each actor gives the same outcome.
  //
  // AXI-2086 (epic AXI-2060, owner ruling 2026-10-20) update: the approver
  // below used to need promoting to platform admin before it could approve a
  // system-scope rule (`rule-review-policy.ts` required BOTH rule:publish AND
  // platform admin for system scope). That branch is removed — rule:publish
  // alone is sufficient, any scope — so this test no longer promotes the
  // approver, which is the point being proven: a plain Rule Approver account
  // (no platform-admin account type) can review a system rule.
  test('AC12 — a non-submitting, non-admin approver sees Approve on the system rule; a no-permission user sees neither @SI-035 @SI-017', async ({ page }) => {
    const admin: Actor = { userId: world.adminUserId, email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local', api: world.admin };
    const checked = await checkedRule(admin, { scope: 'system' }, { code: unique('AXI-2083-SYS') });
    const submitted = (await send(admin.api, 'post', `/api/v1/rules/${checked.id}/submit-for-review`)) as RuleResponse;
    expect(submitted.status).toBe('in_review');

    const approver = await world.actor('approver-2083-sys', publisherRole);
    const reader = await world.actor('reader-2083-sys', readerRole);
    // System-scope visibility needs an OrgRuleAccess entitlement, which a
    // caller gets only through an organization membership — a workspace
    // membership carries one (ReviewWorld.workspace stamps world.orgId). A
    // fresh org defaults to ALL entitlement (no config row), so joining any
    // workspace is enough; the actors' ROLES (rule:publish vs rule:read-only)
    // are what then differ their review outcome.
    await world.workspace('ui-2083-sys-visibility', [approver, reader]);

    // Direct-endpoint parity, before touching the browser at all. `approver`
    // is NOT a platform admin (AXI-2086 — rule:publish alone is enough).
    const approverView = await detail(approver, checked.id);
    expect(approverView.review?.canApprove, JSON.stringify(approverView.review)).toBe(true);
    const readerView = await detail(reader, checked.id);
    expect(readerView.review?.canApprove).toBe(false);
    expect(readerView.review?.canRequestChanges).toBe(false);

    await signIn(page, approver);
    await openRule(page, checked.id, 'In review');
    await expect(page.getByTestId('rule-approve')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rule-request-changes')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('rule-submit-for-review')).toHaveCount(0);

    await signIn(page, reader);
    await openRule(page, checked.id, 'In review');
    await expect(page.getByTestId('rule-approve')).toHaveCount(0);
    await expect(page.getByTestId('rule-request-changes')).toHaveCount(0);
    await expect(page.getByTestId('rule-submit-for-review')).toHaveCount(0);
    await expect(page.getByTestId('rule-review-blocked')).toBeVisible({ timeout: 20_000 });
  });

  // AC12 (library selection bar) — the same server advisory drives the Submit
  // for review bulk action on the Rules page's selection bar, on a THROWAWAY
  // workspace-scope rule (never a real demo rule).
  test('AC12 — Submit for review appears on the library selection bar for an eligible checked rule @SI-010 @SI-017 @SI-035', async ({ page }) => {
    const author = await world.actor('author-2083-bar', authorRole);
    const ws = await world.workspace('ui-2083-bar', [author]);
    const prefix = unique('AXI2083BAR');
    const rule = await checkedRule(author, { scope: 'workspace', workspaceId: ws }, { code: `${prefix}-A` });

    await signIn(page, author);
    await page.goto('/rules');
    await page.getByPlaceholder('Search by code, title, or question...').fill(prefix);
    await page.locator('select').filter({ has: page.locator('option[value="checked"]') }).first().selectOption('checked');
    const row = page.locator('tr', { hasText: rule.code });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('Checked');

    await page.getByRole('checkbox', { name: `Select ${rule.code}` }).check();
    // Appears only once the server confirmed this caller may submit the selected
    // rule (`useBulkApproveEligibility`'s own per-rule `GET /rules/:id` read) —
    // generous timeout: on the shared dev-mode sidecar this read queues behind
    // whatever load earlier tests in the same run left in flight.
    await expect(page.getByTestId('rules-bulk-submit-for-review')).toContainText('(1)', { timeout: 30_000 });
    await page.getByTestId('rules-bulk-submit-for-review').click();
    await expect(page.getByTestId('bulk-submit-modal')).toBeVisible();
    await expect(page.getByTestId('bulk-submit-excluded')).toHaveCount(0);
    await page.getByTestId('bulk-submit-confirm').click();

    await expect(page.getByTestId('bulk-submit-result')).toContainText('1 submitted');
    const after = await detail(author, rule.id);
    expect(after.status).toBe('in_review');
  });

  // AC12 — a workspace-scope rule's selection-bar Request changes action, gated
  // on the server's `canRequestChanges`, exercised on its own throwaway rule.
  test('AC12 — Request changes appears on the library selection bar once the bulk approve read confirms eligibility @SI-010 @SI-017 @SI-035', async ({ page }) => {
    const author = await world.actor('author-2083-rc', authorRole);
    const approver = await world.actor('approver-2083-rc', publisherRole);
    const ws = await world.workspace('ui-2083-rc', [author, approver]);
    const prefix = unique('AXI2083RC');
    const checked = await checkedRule(author, { scope: 'workspace', workspaceId: ws }, { code: `${prefix}-A` });
    const submitted = (await send(author.api, 'post', `/api/v1/rules/${checked.id}/submit-for-review`)) as RuleResponse;
    expect(submitted.status).toBe('in_review');

    await signIn(page, approver);
    await page.goto('/rules');
    await page.getByPlaceholder('Search by code, title, or question...').fill(prefix);
    await page.locator('select').filter({ has: page.locator('option[value="in_review"]') }).first().selectOption('in_review');
    const row = page.locator('tr', { hasText: submitted.code });
    await expect(row).toBeVisible({ timeout: 20_000 });

    await page.getByRole('checkbox', { name: `Select ${submitted.code}` }).check();
    await expect(page.getByTestId('rules-bulk-request-changes')).toContainText('(1)', { timeout: 20_000 });
    await page.getByTestId('rules-bulk-request-changes').click();
    await expect(page.getByTestId('bulk-request-changes-modal')).toBeVisible();
    await page.getByTestId('bulk-request-changes-justification').fill(`Tighten this ${Date.now()}`);
    await page.getByTestId('bulk-request-changes-confirm').click();

    await expect(page.getByTestId('bulk-request-changes-result')).toContainText('1 sent back');
    const after = await detail(author, submitted.id);
    expect(after.status).toBe('draft');
  });
});
