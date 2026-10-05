import { test, expect, type Page, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  COMPLETE_GUIDANCE,
  COMPLETE_OUTPUT_FIELDS,
  deleteFixtureRules,
  inReviewRule,
  ReviewWorld,
  RuleResponse,
  send,
  trackFixtureRule,
} from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1774 (epic AXI-1762 — AC9 UI side, AC11, AC13, AC15; FR10, FR11, FR12, FR13,
 * FR15, FR16, FR31, FR32; EC9): the rule review PAGES — Submit for review, Approve &
 * publish, Request changes, the approval history, bulk approve on the Rules page,
 * the relabelled permission and the help-article context keys.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §16.
 *
 * Every review affordance on these pages is driven by the `review` block of
 * `GET /rules/:id` (`canApprove`, `canRequestChanges`, `approveBlockedCode`) —
 * so each scenario arranges the SERVER's decision (who holds `rule:publish`, who
 * else in the workspace does) and asserts the page renders exactly that. Actors
 * are throwaway self-registered users with throwaway roles and a fresh workspace
 * per scenario (the AXI-1765 fixtures); each browser session is seeded with that
 * actor's own tokens, never the admin storageState.
 */

const ACTOR_PASSWORD = 'AXI1765-e2e-pw!';
const AUTHOR = ['rule:read', 'rule:create', 'rule:update'];
const READER = ['rule:read'];
const PUBLISHER = ['rule:read', 'rule:update', 'rule:publish'];

// Every browser session is seeded explicitly per actor.
test.use({ storageState: { cookies: [], origins: [] } });

let world: ReviewWorld;
let authorRole: string;
let readerRole: string;
let publisherRole: string;

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  authorRole = await world.role('author', AUTHOR);
  readerRole = await world.role('reader', READER);
  publisherRole = await world.role('publisher', PUBLISHER);
});

test.afterAll(async () => {
  // AXI-1809 / AXI-1822: rules this spec created must not outlive it (system-scope leftovers
  // push boot seeds off the catalogue's first page). Delete them before the world is disposed.
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
 * The onboarding tours (AXI-1324/1354) auto-start on a user's first visit and
 * navigate away from the page under test — every throwaway actor is on its first
 * visit. Mark each tour skipped for this user through the same API the tour's
 * Skip button calls, so the page under test stays put.
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

/** A complete FEATURE_RULE created by `author`, landed `checked` by the FR9 gate — NOT submitted. */
async function checkedRule(author: Actor, workspaceId: string): Promise<RuleResponse> {
  const created = (await send(author.api, 'post', '/api/v1/rules', {
    code: unique('AXI-1774'),
    title: 'AXI-1774 review page fixture',
    category: 'phenotype_detection',
    protocolType: 'FEATURE_RULE',
    signals: ['marker:cd4_count'],
    scope: 'workspace',
    workspaceId,
  })) as RuleResponse;
  // Tracked before the PATCH and the FR9 expect, so a failure there cannot leak the rule.
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

test.describe('AXI-1774 — rule review pages (§16)', () => {
  // §16.3.1 (FR10, FR31)
  test('FR10 FR31 — the author submits a checked rule for review from the rule page @SI-030 @SI-035', async ({ page }) => {
    const author = await world.actor('author-submit', authorRole);
    const ws = await world.workspace('ui-submit', [author]);
    const rule = await checkedRule(author, ws);

    await signIn(page, author);
    await openRule(page, rule.id, 'Checked');
    await expect(page.getByTestId('rule-status-badge')).toHaveText('Checked');
    await expect(page.getByTestId('rule-submit-for-review')).toBeVisible();
    await expect(page.getByTestId('rule-approve')).toHaveCount(0);
    await expect(page.getByTestId('rule-request-changes')).toHaveCount(0);

    await page.getByTestId('rule-submit-for-review').click();

    await expect(page.getByTestId('rule-review-status')).toHaveText('In review');
    await expect(page.getByTestId('rule-submit-for-review')).toHaveCount(0);
    // The author holds no rule:publish — the page says why it is waiting, and offers no decision.
    await expect(page.getByTestId('rule-review-blocked')).toBeVisible();
    await expect(page.getByTestId('rule-approve')).toHaveCount(0);
    expect((await detail(author, rule.id)).status).toBe('in_review');
  });

  // §16.3.2 (AC9, AC11)
  test('AC9 AC11 — an approver sees Approve & publish, approves, and the history records it @SI-030 @SI-035', async ({ page }) => {
    const author = await world.actor('author-approve', authorRole);
    const approver = await world.actor('approver-approve', publisherRole);
    const ws = await world.workspace('ui-approve', [author, approver]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });
    const justification = `Reviewed against the protocol ${Date.now()}`;

    await signIn(page, approver);
    await openRule(page, rule.id, 'In review');
    await expect(page.getByTestId('rule-approve')).toBeVisible();
    await expect(page.getByTestId('rule-request-changes')).toBeVisible();

    await page.getByTestId('rule-approve').click();
    await expect(page.getByTestId('review-decision-modal')).toBeVisible();
    await expect(page.getByTestId('review-self-approval-note')).toHaveCount(0);
    await page.getByTestId('review-note').fill(justification);
    await page.getByTestId('review-confirm').click();

    await expect(page.getByTestId('rule-review-status')).toHaveText('Published');
    const records = page.getByTestId('rule-approval-history').getByTestId('approval-record');
    await expect(records).toHaveCount(1);
    await expect(records.first()).toHaveAttribute('data-decision', 'approve');
    await expect(records.first()).toHaveAttribute('data-self-approved', 'false');
    await expect(records.first()).toContainText(justification);

    const after = await detail(approver, rule.id);
    expect(after.status).toBe('published');
    expect(after.approvalHistory?.[0]?.actorId).toBe(approver.userId);
    expect(after.approvalHistory?.[0]?.decision).toBe('approve');
  });

  // §16.3.3 (AC9, FR12, EC9)
  test('AC9 FR12 EC9 — the author with another approver in the workspace sees no Approve; a forced call is refused 403 @SI-030 @SI-035', async ({ page }) => {
    const author = await world.actor('author-pool', publisherRole);
    const colleague = await world.actor('colleague-pool', publisherRole);
    const ws = await world.workspace('ui-pool', [author, colleague]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    await signIn(page, author);
    await openRule(page, rule.id, 'In review');
    await expect(page.getByTestId('rule-request-changes')).toBeVisible();
    await expect(page.getByTestId('rule-approve')).toHaveCount(0);
    await expect(page.getByTestId('rule-review-blocked')).toContainText('another member of its workspace');

    const current = await detail(author, rule.id);
    const forced = await author.api.post(apiUrl(`/api/v1/rules/${rule.id}/approve`), {
      data: { note: 'forcing it', expectedContentHash: current.review?.contentHash },
    });
    expect(forced.status(), await forced.text()).toBe(403);
    expect(await forced.text()).toContain('SELF_APPROVAL_OTHER_APPROVER_EXISTS');
    expect((await detail(author, rule.id)).status).toBe('in_review');
  });

  // §16.3.4 (AC9)
  test('AC9 — a user without rule:publish never sees a review action @SI-030 @SI-035', async ({ page }) => {
    const author = await world.actor('author-reader', authorRole);
    const reader = await world.actor('reader-reader', readerRole);
    const ws = await world.workspace('ui-reader', [author, reader]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    await signIn(page, reader);
    await openRule(page, rule.id, 'In review');
    await expect(page.getByTestId('rule-review-blocked')).toBeVisible();
    await expect(page.getByTestId('rule-approve')).toHaveCount(0);
    await expect(page.getByTestId('rule-request-changes')).toHaveCount(0);
    await expect(page.getByTestId('rule-submit-for-review')).toHaveCount(0);
  });

  // §16.3.5 (FR11, AC11)
  test('FR11 AC11 — request changes needs a comment and returns the rule to draft with it recorded @SI-030 @SI-035', async ({ page }) => {
    const author = await world.actor('author-changes', authorRole);
    const approver = await world.actor('approver-changes', publisherRole);
    const ws = await world.workspace('ui-changes', [author, approver]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });
    const comment = `Tighten the when-not-to-use guidance ${Date.now()}`;

    await signIn(page, approver);
    await openRule(page, rule.id, 'In review');
    await page.getByTestId('rule-request-changes').click();
    await expect(page.getByTestId('review-decision-modal')).toBeVisible();
    await expect(page.getByTestId('review-confirm')).toBeDisabled();
    await page.getByTestId('review-note').fill('   ');
    await expect(page.getByTestId('review-confirm')).toBeDisabled();
    await page.getByTestId('review-note').fill(comment);
    await page.getByTestId('review-confirm').click();

    await expect(page.getByTestId('rule-review-status')).toHaveText('Draft');
    const records = page.getByTestId('rule-approval-history').getByTestId('approval-record');
    await expect(records).toHaveCount(1);
    await expect(records.first()).toHaveAttribute('data-decision', 'request_changes');
    await expect(records.first()).toContainText(comment);

    const after = await detail(author, rule.id);
    expect(after.status).toBe('draft');
    expect(after.approvalHistory?.[0]?.decision).toBe('request_changes');
    expect(after.approvalHistory?.[0]?.actorId).toBe(approver.userId);
  });

  // §16.3.6 (FR13)
  test('FR13 — approving content that changed since it was loaded is refused, reloaded and explained @SI-030 @SI-035', async ({ page }) => {
    const author = await world.actor('author-stale', authorRole);
    const approver = await world.actor('approver-stale', publisherRole);
    const ws = await world.workspace('ui-stale', [author, approver]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    await signIn(page, approver);
    await openRule(page, rule.id, 'In review');
    await expect(page.getByTestId('rule-approve')).toBeVisible();

    // Meanwhile: sent back, edited and resubmitted — the content hash changes.
    const loaded = await detail(approver, rule.id);
    await send(approver.api, 'post', `/api/v1/rules/${rule.id}/request-changes`, {
      note: 'Sent back behind the page',
      expectedContentHash: loaded.review?.contentHash,
    });
    const edited = (await send(author.api, 'patch', `/api/v1/rules/${rule.id}`, {
      title: 'AXI-1774 review page fixture (edited)',
    })) as RuleResponse;
    expect(edited.status).toBe('checked');
    await send(author.api, 'post', `/api/v1/rules/${rule.id}/submit-for-review`);
    const resubmitted = await detail(approver, rule.id);
    expect(resubmitted.review?.contentHash).not.toBe(loaded.review?.contentHash);

    await page.getByTestId('rule-approve').click();
    await page.getByTestId('review-note').fill('Approving what I loaded');
    await page.getByTestId('review-confirm').click();

    await expect(page.getByTestId('rule-review-error')).toContainText('This rule changed since you opened it');
    await expect(page.getByTestId('rule-review-status')).toHaveText('In review');
    const after = await detail(approver, rule.id);
    expect(after.status).toBe('in_review');
    expect(after.approvalHistory?.filter((r) => r.decision === 'approve')).toHaveLength(0);
  });

  // §16.3.7 (FR16, AC13)
  test('FR16 AC13 — bulk approve from the Rules page approves each selected in-review rule @SI-030 @SI-035', async ({ page }) => {
    const author = await world.actor('author-bulk', authorRole);
    const ws = await world.workspace('ui-bulk', [author]);
    const prefix = unique('AXI1774BULK');
    const first = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws }, { code: `${prefix}-A` });
    const second = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws }, { code: `${prefix}-B` });
    const justification = `Bulk reviewed ${Date.now()}`;

    await signInAdmin(page);
    await page.goto('/rules');
    await page.getByPlaceholder('Search by code, title, or question...').fill(prefix);
    await page.locator('select').filter({ has: page.locator('option[value="in_review"]') }).first().selectOption('in_review');
    for (const code of [first.code, second.code]) {
      const row = page.locator('tr', { hasText: code });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row).toContainText('In review');
    }

    await page.getByRole('checkbox', { name: `Select ${first.code}` }).check();
    await page.getByRole('checkbox', { name: `Select ${second.code}` }).check();
    // Appears only once the server confirmed the admin may approve each selected rule.
    await expect(page.getByTestId('rules-bulk-approve')).toContainText('(2)', { timeout: 20_000 });
    await page.getByTestId('rules-bulk-approve').click();
    await expect(page.getByTestId('bulk-approve-modal')).toBeVisible();
    await expect(page.getByTestId('bulk-approve-excluded')).toHaveCount(0);
    await page.getByTestId('bulk-approve-justification').fill(justification);
    await page.getByTestId('bulk-approve-confirm').click();

    await expect(page.getByTestId('bulk-approve-result')).toContainText('2 approved');
    for (const id of [first.id, second.id]) {
      const after = await detail(author, id);
      expect(after.status).toBe('published');
      expect(after.approvalHistory).toHaveLength(1);
      expect(after.approvalHistory?.[0]?.decision).toBe('approve');
      expect(after.approvalHistory?.[0]?.actorId).toBe(world.adminUserId);
      expect(after.approvalHistory?.[0]?.note).toContain(justification);
    }
  });

  // §16.3.8 (FR15)
  test('FR15 — the permission is labelled "Approve & publish rules" on the role editor @SI-031', async ({ page }) => {
    await signInAdmin(page);
    await page.goto('/system/roles/new');
    await expect(page.getByText('Approve & publish rules', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Publish Rules', { exact: true })).toHaveCount(0);
  });

  // §16.3.9 (FR32, AC15)
  test('FR32 AC15 — the review bar and status filter help anchors open their help articles @SI-037', async ({ page }) => {
    // `/help` is gated on help:view (a user without it is sent home), so this author holds it.
    const helpAuthorRole = await world.role('author-help', [...AUTHOR, 'help:view']);
    const author = await world.actor('author-help', helpAuthorRole);
    const ws = await world.workspace('ui-help', [author]);
    const rule = await checkedRule(author, ws);

    await signIn(page, author);
    await openRule(page, rule.id, 'Checked');
    const reviewHelp = page.getByRole('link', { name: 'Help — reviewing and approving rules' });
    await expect(reviewHelp).toHaveAttribute('href', /\/help\/analysis\/reviewing-and-approving-rules$/);
    await reviewHelp.click();
    await expect(page).toHaveURL(/\/help\/analysis\/reviewing-and-approving-rules$/);
    await expect(page.getByRole('heading', { name: 'Reviewing and approving rules' }).first()).toBeVisible();

    await page.goto('/rules');
    const statusHelp = page.getByRole('link', { name: 'Help — what each rule status means' });
    await expect(statusHelp).toHaveAttribute('href', /\/help\/analysis\/rule-statuses$/);
    await statusHelp.click();
    await expect(page).toHaveURL(/\/help\/analysis\/rule-statuses$/);
    await expect(page.getByRole('heading', { name: /Rule statuses/ }).first()).toBeVisible();

    // The run-surface articles whose anchors live in AXI-1772/AXI-1773 components (keys
    // rules.run.picker / rules.run.oneclick / rules.provenance / rules.run.editor): each is served.
    // Each article is identified by one of its own section headings (a body that rendered, not just a title).
    for (const [slug, section] of [
      ['choosing-and-running-a-rule', /^The detail pane/],
      ['running-a-rule-in-one-click', /^When Run is offered/],
      ['who-wrote-and-approved-a-rule', /^Who approved it/],
      ['choosing-values-in-a-rule-run-editor', /^The chip beside a pre-filled value/],
    ] as const) {
      await page.goto(`/help/analysis/${slug}`);
      await expect(page.getByRole('heading', { name: section }).first()).toBeVisible();
    }
  });
});
