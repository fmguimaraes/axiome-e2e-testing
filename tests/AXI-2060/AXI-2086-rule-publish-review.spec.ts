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
 * AXI-2086 (epic AXI-2060 — FR25, AC12; Gap G4; owner ruling 2026-10-20:
 * "change so user with only the role can approve, this is not an admin
 * specific action"): reviewing a SYSTEM-scope rule is authorized by
 * `rule:publish` alone — no platform-admin account type required.
 *
 * Scenario doc: manual-e2e/AXI-2060-Microbiote-IgG4-Study-Reproduction.md
 * (AXI-2086 section).
 *
 * Before this fix, `rule-review-policy.ts#decideRuleReview` required BOTH
 * `rule:publish` AND a platform-admin JWT role for a system-scope review
 * decision (approve/request-changes); a separate, undocumented producer of
 * the same refusal (`RulesService.loadForReview`'s call to the EDIT gate,
 * `assertCanMutateRule`) refused a `rule:publish` holder even earlier, before
 * the review gate itself ever ran. Both are removed. Unaffected and asserted
 * here as still-unchanged: deny-by-default without `rule:publish`; the
 * self-approval guard; submit-for-review on a system rule (a different,
 * still platform-admin-gated act, per AXI-2083).
 *
 * Every rule this spec creates is a THROWAWAY fixture (never the two real
 * demo rules `796cfeb8-…`/`b80f04ef-…` or any other pre-existing system
 * rule) — created and submitted by the real platform admin, then reviewed by
 * a throwaway, NON-admin `rule:publish`-holding account.
 */

const ACTOR_PASSWORD = 'AXI1765-e2e-pw!';
const READER = ['rule:read', 'rule:view_shared'];
const PUBLISHER = ['rule:read', 'rule:update', 'rule:publish', 'rule:view_shared'];

// Every browser session is seeded explicitly per actor.
test.use({ storageState: { cookies: [], origins: [] } });

let world: ReviewWorld;
let readerRole: string;
let publisherRole: string;

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  readerRole = await world.role('reader-2086', READER);
  publisherRole = await world.role('publisher-2086', PUBLISHER);
});

test.afterAll(async () => {
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

async function detail(actor: Actor, id: string): Promise<RuleResponse> {
  return (await send(actor.api, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
}

/** A complete FEATURE_RULE, SYSTEM scope, authored+submitted by the real platform admin. */
async function inReviewSystemRule(admin: Actor): Promise<RuleResponse> {
  const created = (await send(admin.api, 'post', '/api/v1/rules', {
    code: unique('AXI-2086'),
    title: 'AXI-2086 rule:publish-alone fixture',
    category: 'phenotype_detection',
    protocolType: 'FEATURE_RULE',
    signals: ['marker:cd4_count'],
    scope: 'system',
  })) as RuleResponse;
  trackFixtureRule(created.id);
  const completed = (await send(admin.api, 'patch', `/api/v1/rules/${created.id}`, {
    outputFields: COMPLETE_OUTPUT_FIELDS,
    guidance: COMPLETE_GUIDANCE,
  })) as RuleResponse;
  expect(completed.status, 'fixture rule must pass the FR9 gate').toBe('checked');
  const submitted = (await send(admin.api, 'post', `/api/v1/rules/${created.id}/submit-for-review`)) as RuleResponse;
  expect(submitted.status).toBe('in_review');
  return submitted;
}

async function openRule(page: Page, id: string, expectedStatus: string): Promise<void> {
  await page.goto(`/rules/${id}`);
  await expect(page.getByTestId('rule-review-panel')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('rule-review-status')).toHaveText(expectedStatus);
}

test.describe('AXI-2086 — rule review on system rules is authorized by rule:publish alone', () => {
  test('a non-admin rule:publish holder approves a system-scope rule from the detail page @SI-017 @SI-035', async ({ page }) => {
    const admin: Actor = { userId: world.adminUserId, email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local', api: world.admin };
    const rule = await inReviewSystemRule(admin);

    const approver = await world.actor('approver-2086', publisherRole);
    // System-scope visibility needs an OrgRuleAccess entitlement, reached
    // through an organization membership — any workspace membership carries
    // one. `approver` is deliberately NEVER promoted to platform admin.
    await world.workspace('ui-2086-approve', [approver]);

    // Direct-endpoint parity first: the server's own advisory must already
    // say the non-admin holder may approve.
    const before = await detail(approver, rule.id);
    expect(before.review?.canApprove, JSON.stringify(before.review)).toBe(true);

    await signIn(page, approver);
    await openRule(page, rule.id, 'In review');
    await expect(page.getByTestId('rule-approve')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('rule-approve').click();
    await expect(page.getByTestId('review-decision-modal')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('review-note').fill(`AXI-2086 non-admin approval ${Date.now()}`);
    await page.getByTestId('review-confirm').click();

    await expect(page.getByTestId('rule-review-status')).toHaveText('Published');
    const after = await detail(admin, rule.id);
    expect(after.status).toBe('published');
    expect(after.approvalHistory?.[0]).toMatchObject({ actorId: approver.userId, selfApproved: false });
  });

  test('a non-admin rule:publish holder sends a system-scope rule back for changes @SI-017 @SI-035', async ({ page }) => {
    const admin: Actor = { userId: world.adminUserId, email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local', api: world.admin };
    const rule = await inReviewSystemRule(admin);

    const approver = await world.actor('approver-2086-rc', publisherRole);
    await world.workspace('ui-2086-request-changes', [approver]);

    const before = await detail(approver, rule.id);
    expect(before.review?.canRequestChanges, JSON.stringify(before.review)).toBe(true);

    await signIn(page, approver);
    await openRule(page, rule.id, 'In review');
    await expect(page.getByTestId('rule-request-changes')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('rule-request-changes').click();
    await expect(page.getByTestId('review-decision-modal')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('review-note').fill(`AXI-2086 non-admin request changes ${Date.now()}`);
    await page.getByTestId('review-confirm').click();

    await expect(page.getByTestId('rule-review-status')).toHaveText('Draft');
    const after = await detail(admin, rule.id);
    expect(after.status).toBe('draft');
  });

  test('a user without rule:publish still cannot review a system-scope rule @SI-017 @SI-035', async ({ page }) => {
    const admin: Actor = { userId: world.adminUserId, email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local', api: world.admin };
    const rule = await inReviewSystemRule(admin);

    const reader = await world.actor('reader-2086-noperm', readerRole);
    await world.workspace('ui-2086-no-permission', [reader]);

    const before = await detail(reader, rule.id);
    expect(before.review?.canApprove).toBe(false);
    expect(before.review?.canRequestChanges).toBe(false);

    await signIn(page, reader);
    await openRule(page, rule.id, 'In review');
    await expect(page.getByTestId('rule-approve')).toHaveCount(0);
    await expect(page.getByTestId('rule-request-changes')).toHaveCount(0);

    const direct = await reader.api.post(apiUrl(`/api/v1/rules/${rule.id}/approve`), { data: { note: 'no permission' } });
    expect(direct.status()).toBe(403);
  });

  // Scenario 5.2 (manual-e2e §5.2): the platform admin who authored+submitted
  // the throwaway system rule cannot self-approve it, even with no platform-
  // admin requirement on the review act itself. Review bounce #1 on AXI-2086
  // corrected `otherApprovers` to return an UNRESOLVED pool for every system
  // rule (never `platformAdminsOnly: true`, which could silently narrow the
  // real population and fail open) — so this is deterministic, not
  // environment-dependent, and the refusal code is
  // `SELF_APPROVAL_WORKSPACE_UNRESOLVED`, not `..._OTHER_APPROVER_EXISTS`
  // (the pool is never resolved well enough to even cite a name).
  test('5.2 — the admin submitter cannot self-approve the system rule it authored @SI-017 @SI-035', async ({ page }) => {
    const admin: Actor = { userId: world.adminUserId, email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local', api: world.admin };
    const rule = await inReviewSystemRule(admin);
    // A non-admin rule:publish holder also exists — proving the refusal is
    // NOT "pool empty, allow", it is "pool unresolvable, refuse" regardless.
    const otherHolder = await world.actor('approver-2086-sa', publisherRole);
    await world.workspace('ui-2086-self-approve', [otherHolder]);

    const before = await detail(admin, rule.id);
    expect(before.review?.canApprove, JSON.stringify(before.review)).toBe(false);
    expect(before.review?.approveBlockedCode).toBe('SELF_APPROVAL_WORKSPACE_UNRESOLVED');

    await signIn(page, admin);
    await openRule(page, rule.id, 'In review');
    await expect(page.getByTestId('rule-approve')).toHaveCount(0);

    const direct = await admin.api.post(apiUrl(`/api/v1/rules/${rule.id}/approve`), { data: { note: 'self-approval attempt' } });
    expect(direct.status(), await direct.text()).toBe(403);
    expect(await direct.text()).toContain('SELF_APPROVAL_WORKSPACE_UNRESOLVED');
  });

  // Scenario 5.3 (manual-e2e §5.3): submit-for-review on a system rule is a
  // different act (the EDIT gate) and is UNCHANGED by AXI-2086 — a non-admin
  // rule:publish holder is still refused, exactly as AXI-2083 already pins
  // for the detail-page submit button. Re-pinned here under the AXI-2086
  // story key because the manual-e2e scenario lives in this section.
  test('5.3 — submit-for-review on a system rule stays platform-admin-gated @SI-017 @SI-035', async ({ page }) => {
    const admin: Actor = { userId: world.adminUserId, email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local', api: world.admin };
    const created = (await send(admin.api, 'post', '/api/v1/rules', {
      code: unique('AXI-2086-submit'),
      title: 'AXI-2086 submit-for-review fixture',
      category: 'phenotype_detection',
      protocolType: 'FEATURE_RULE',
      signals: ['marker:cd4_count'],
      scope: 'system',
    })) as RuleResponse;
    trackFixtureRule(created.id);
    const checked = (await send(admin.api, 'patch', `/api/v1/rules/${created.id}`, {
      outputFields: COMPLETE_OUTPUT_FIELDS,
      guidance: COMPLETE_GUIDANCE,
    })) as RuleResponse;
    expect(checked.status).toBe('checked');

    const holder = await world.actor('approver-2086-submit', publisherRole);
    await world.workspace('ui-2086-submit-gated', [holder]);

    const before = await detail(holder, checked.id);
    expect(before.review?.canSubmitForReview).toBe(false);
    expect(before.review?.submitForReviewBlockedCode).toBe('SYSTEM_RULE_REQUIRES_PLATFORM_ADMIN');

    await signIn(page, holder);
    await openRule(page, checked.id, 'Checked');
    await expect(page.getByTestId('rule-submit-for-review')).toHaveCount(0);

    const direct = await holder.api.post(apiUrl(`/api/v1/rules/${checked.id}/submit-for-review`));
    expect(direct.status(), await direct.text()).toBe(403);
    expect(await direct.text()).toContain('SYSTEM_RULE_REQUIRES_PLATFORM_ADMIN');
  });
});
