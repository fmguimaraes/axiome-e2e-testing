import { test, expect, Page, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  deleteFixtureRules,
  inReviewRule,
  ReviewWorld,
  RuleResponse,
  send,
  trackFixtureRule,
} from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1861 (epic AXI-1762 — owner ruling 2026-09-28): owner-directed publish of
 * every rule; missing guidance is a warning and shows "To be defined".
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §23.
 *
 * Acceptance criteria (design note SI-001..SI-005):
 *   AC1 (SI-001) owner publish leaves each rule published with one owner_directed record.
 *   AC2 (SI-002) owner-published rules survive the FR16 demotion re-run (demoted 0).
 *   AC3 (SI-003) a rule without guidance is published and renders "To be defined" (UI).
 *   AC4 (SI-004) a non-admin caller gets 403 on POST /rules/bulk/owner-publish.
 *   AC5 (SI-005) the owner_directed approval appears in the approval history (UI).
 *
 * API-level except AC3 and AC5. Each test owner-publishes an explicit `ruleIds`
 * set; `allLive: true` is never sent against the shared stack (it would publish
 * the whole catalogue). Preconditions: the stack runs this branch's
 * organization service and user service; the platform admin the fixtures log in
 * as holds `rule:publish` and is a platform admin.
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
const ACTOR_PASSWORD = 'AXI1765-e2e-pw!';
const JUSTIFICATION = 'Owner-directed bulk publish 2026-09-28 — guidance to be filled later';
const AUTHOR = ['rule:read', 'rule:create', 'rule:update'];
const PUBLISHER = ['rule:read', 'rule:update', 'rule:publish'];

interface OwnerPublishResponse {
  published: number;
  skipped: number;
  failed: number;
  results: Array<{ ruleId?: string; id?: string; outcome: string; reasonCode?: string | null }>;
}

interface ApprovalRecord {
  decision: 'approve' | 'request_changes';
  ownerDirected?: boolean;
  selfApproved?: boolean;
  note?: string;
}

interface OwnerRule {
  id: string;
  status: string;
  approvalHistory?: ApprovalRecord[];
}

// The onboarding tours auto-start on first visit and navigate away from the page under test.
const ONBOARDING_TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions',
  'graph-rules', 'help', 'admin', 'charts-views', 'collaboration',
];

// Every browser session is seeded explicitly per actor.
test.use({ storageState: { cookies: [], origins: [] } });

let world: ReviewWorld;
let authorRole: string;
let publisherRole: string;
let author: Actor;
let workspaceId: string;

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  authorRole = await world.role('owner-author', AUTHOR);
  publisherRole = await world.role('owner-publisher', PUBLISHER);
  author = await world.actor('owner-author', authorRole);
  workspaceId = await world.workspace('owner-publish', [author]);
});

test.afterAll(async () => {
  await deleteFixtureRules(world.admin);
  await world?.dispose();
});

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** A complete rule walked to `in_review`. */
async function reviewRule(): Promise<RuleResponse> {
  return inReviewRule(author.api, { scope: 'workspace', workspaceId });
}

/** A rule left at `draft`: created, never completed, so it carries no guidance. */
async function draftRuleWithoutGuidance(): Promise<RuleResponse> {
  const created = (await send(author.api, 'post', '/api/v1/rules', {
    code: unique('AXI-1861-NOGUIDE'),
    title: 'AXI-1861 owner publish fixture (no guidance)',
    category: 'phenotype_detection',
    protocolType: 'FEATURE_RULE',
    signals: ['marker:cd4_count'],
    scope: 'workspace',
    workspaceId,
  })) as RuleResponse;
  trackFixtureRule(created.id);
  expect(created.status).toBe('draft');
  return created;
}

async function getRule(id: string): Promise<OwnerRule> {
  return (await send(world.admin, 'get', `/api/v1/rules/${id}`)) as OwnerRule;
}

async function ownerPublish(ruleIds: string[]): Promise<OwnerPublishResponse> {
  return (await send(world.admin, 'post', '/api/v1/rules/bulk/owner-publish', {
    ruleIds,
    justification: JUSTIFICATION,
  })) as OwnerPublishResponse;
}

async function tokensFor(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> {
  const ctx = await apiRequest.newContext();
  try {
    return await send(ctx, 'post', '/api/v1/auth/login', { email, password });
  } finally {
    await ctx.dispose();
  }
}

/** Seed `page` with a user's own session and skip the first-visit tours. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  const tokens = await tokensFor(email, password);
  const ctx = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
  });
  try {
    for (const tourId of ONBOARDING_TOUR_IDS) {
      await ctx.put(apiUrl('/api/v1/onboarding-state'), {
        data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 },
      });
    }
  } finally {
    await ctx.dispose();
  }
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('access_token', access as string);
      localStorage.setItem('refresh_token', refresh as string);
    },
    [tokens.accessToken, tokens.refreshToken] as const,
  );
}

test.describe('AXI-1861 — owner-directed publish of every rule (§23)', () => {
  test('AC1 AXI-1861 — owner publish leaves each rule published with one owner_directed record carrying the justification @SI-001', async () => {
    const reviewed = await reviewRule();
    const draft = await draftRuleWithoutGuidance();
    const ids = [reviewed.id, draft.id];

    const body = await ownerPublish(ids);
    expect(body).toEqual(
      expect.objectContaining({
        published: expect.any(Number),
        skipped: expect.any(Number),
        failed: expect.any(Number),
        results: expect.any(Array),
      }),
    );

    for (const id of ids) {
      const rule = await getRule(id);
      expect(rule.status, `rule ${id} must be published`).toBe('published');
      const owner = (rule.approvalHistory ?? []).filter((r) => r.ownerDirected === true);
      expect(owner, `rule ${id} must carry exactly one owner_directed record`).toHaveLength(1);
      expect(owner[0].decision).toBe('approve');
      expect(owner[0].selfApproved).toBe(false);
      expect(owner[0].note).toBe(JUSTIFICATION);
    }
  });

  test('AC2 AXI-1861 — owner-published rules stay published when the FR16 status migration re-runs (demoted 0) @SI-002', async () => {
    const reviewed = await reviewRule();
    const draft = await draftRuleWithoutGuidance();
    await ownerPublish([reviewed.id, draft.id]);

    // A restart is not available to this spec. Re-running the migration in-process
    // (the runbook's step 5) exercises the same demotion pass.
    const deploy = await send(world.admin, 'post', '/api/v1/rules/seed-pack/deploy');
    expect(deploy.statusMigration?.demoted ?? 0, 'owner-directed rules must not be demoted').toBe(0);

    for (const id of [reviewed.id, draft.id]) {
      const rule = await getRule(id);
      expect(rule.status).toBe('published');
      const owner = (rule.approvalHistory ?? []).filter((r) => r.ownerDirected === true);
      expect(owner).toHaveLength(1);
    }
  });

  test('AC3 AXI-1861 — a rule without guidance is published and renders "To be defined" on its rule page @SI-003', async ({ page }) => {
    const draft = await draftRuleWithoutGuidance();
    await ownerPublish([draft.id]);
    expect((await getRule(draft.id)).status).toBe('published');

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/rules/${draft.id}`);
    await expect(page.getByText('To be defined', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  });

  test('AC4 AXI-1861 — a non-platform-admin caller with rule:publish gets 403 and nothing is published @SI-004', async () => {
    const publisher = await world.actor('owner-publisher', publisherRole);
    const draft = await draftRuleWithoutGuidance();

    const res = await publisher.api.post(apiUrl('/api/v1/rules/bulk/owner-publish'), {
      data: { ruleIds: [draft.id], justification: JUSTIFICATION },
    });
    expect(res.status()).toBe(403);
    expect((await getRule(draft.id)).status).toBe('draft');
  });

  test('AC4 AXI-1861 — a member without rule:publish gets 403 on the owner publish @SI-004', async () => {
    const plain = await world.actor('owner-plain');
    const draft = await draftRuleWithoutGuidance();

    const res = await plain.api.post(apiUrl('/api/v1/rules/bulk/owner-publish'), {
      data: { ruleIds: [draft.id], justification: JUSTIFICATION },
    });
    expect(res.status()).toBe(403);
    expect((await getRule(draft.id)).status).toBe('draft');
  });

  test('AC5 AXI-1861 — the owner_directed approval is marked Owner-directed in the approval history @SI-005', async ({ page }) => {
    const reviewed = await reviewRule();
    await ownerPublish([reviewed.id]);

    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await page.goto(`/rules/${reviewed.id}`);
    const panel = page.getByTestId('rule-review-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText(/owner-directed/i).first()).toBeVisible();
    await expect(panel.getByText(JUSTIFICATION, { exact: false }).first()).toBeVisible();
  });
});
