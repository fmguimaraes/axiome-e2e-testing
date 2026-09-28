import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, inReviewRule, ReviewWorld, RuleResponse, send } from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1765 (epic AXI-1762 — FR11, FR12, FR13, EC9, EC10, EC14, EC17, NFR3, NFR4):
 * rule review — approve (`in_review → published`) and request changes
 * (`in_review → draft`), gated server-side on `rule:publish` read from the
 * caller's ASSIGNED roles, with an append-only approval record carrying the
 * content hash of the version it published.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §8.
 *
 * API-level by design: the review UI is AXI-1774's. Every actor is a throwaway
 * self-registered user with a throwaway role, every workspace is fresh — so the
 * self-approval pool is exactly what each test arranged.
 */

const READER = ['rule:read'];
const PUBLISHER = ['rule:read', 'rule:publish'];

let world: ReviewWorld;
let readerRole: string;
let publisherRole: string;

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  readerRole = await world.role('reader', READER);
  publisherRole = await world.role('publisher', PUBLISHER);
});

test.afterAll(async () => {
  await world?.dispose();
});

async function detail(actor: Actor, id: string): Promise<RuleResponse> {
  return (await send(actor.api, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
}

async function approve(actor: Actor, id: string, body: Record<string, unknown>) {
  return actor.api.post(apiUrl(`/api/v1/rules/${id}/approve`), { data: body });
}

async function requestChanges(actor: Actor, id: string, body: Record<string, unknown>) {
  return actor.api.post(apiUrl(`/api/v1/rules/${id}/request-changes`), { data: body });
}

test.describe('AXI-1765 — rule review, approval records and server-side permission', () => {
  // §8.3.1 (AC9, AC11, FR11, FR13)
  test('AC9 AC11 FR13 — an approver holding rule:publish approves; the record carries the served version hash @SI-017', async () => {
    const author = await world.actor('author', readerRole);
    const reviewer = await world.actor('reviewer', publisherRole);
    const ws = await world.workspace('approve', [author, reviewer]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    const before = await detail(reviewer, rule.id);
    expect(before.review?.canApprove, JSON.stringify(before.review)).toBe(true);
    expect(before.review?.wouldSelfApprove).toBe(false);
    expect(before.servedVersion ?? null).toBeNull();
    const reviewedHash = before.review!.contentHash;
    expect(reviewedHash).toMatch(/^[0-9a-f]{64}$/);

    const res = await approve(reviewer, rule.id, {
      note: 'Checked the thresholds against the SOP.',
      expectedContentHash: reviewedHash,
    });
    expect(res.status(), await res.text()).toBe(201);
    expect(((await res.json()) as RuleResponse).status).toBe('published');

    const after = await detail(reviewer, rule.id);
    expect(after.status).toBe('published');
    expect(after.approvalHistory).toHaveLength(1);
    const record = after.approvalHistory![0];
    expect(record).toMatchObject({
      decision: 'approve',
      actorId: reviewer.userId,
      selfApproved: false,
      note: 'Checked the thresholds against the SOP.',
      contentHash: reviewedHash,
    });
    // The record names the version it minted, and that is the served version,
    // whose hash is recomputed from the version snapshot — not copied.
    expect(after.servedVersion).toBeTruthy();
    expect(record.ruleVersionId).toBe(after.servedVersion!.id);
    expect(after.servedVersion!.contentHash).toBe(reviewedHash);

    // A second decision on a published rule is refused — review is over.
    const again = await approve(reviewer, rule.id, { note: 'again' });
    expect(again.status()).toBe(400);
    expect(await again.text()).toContain('NOT_IN_REVIEW');
  });

  // §8.3.2 (FR11, NFR3)
  test('FR11 NFR3 — a caller without rule:publish is refused 403 at the gateway on every review route @SI-017', async () => {
    const author = await world.actor('author-noperm', readerRole);
    const noPerm = await world.actor('noperm', readerRole);
    const ws = await world.workspace('noperm', [author, noPerm]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    const view = await detail(noPerm, rule.id);
    expect(view.review?.canApprove).toBe(false);
    expect(view.review?.approveBlockedCode).toBe('MISSING_RULE_PUBLISH');

    for (const res of [
      await approve(noPerm, rule.id, { note: 'let me in' }),
      await requestChanges(noPerm, rule.id, { note: 'let me in' }),
      await noPerm.api.post(apiUrl(`/api/v1/rules/${rule.id}/publish`), { data: { justification: 'x' } }),
      await noPerm.api.post(apiUrl('/api/v1/rules/bulk/publish'), {
        data: { ruleIds: [rule.id], justification: 'x' },
      }),
    ]) {
      expect(res.status(), await res.text()).toBe(403);
      expect(await res.text()).toContain('MISSING_RULE_PUBLISH');
    }
    expect((await detail(author, rule.id)).status).toBe('in_review');
  });

  // §8.3.3 (EC10, NFR3) — the service re-checks what the gateway may have cached.
  test('EC10 NFR3 — a grant revoked inside the gateway cache is still refused by the service @SI-017', async () => {
    const author = await world.actor('author-ec10', readerRole);
    const revocable = await world.role('revocable', PUBLISHER);
    const reviewer = await world.actor('reviewer-ec10', revocable);
    const ws = await world.workspace('ec10', [author, reviewer]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    // Warm the gateway's 60 s permission cache with the grant...
    expect((await detail(reviewer, rule.id)).review?.canApprove).toBe(true);
    // ...then revoke it. The gateway still admits (cached) — the service must not.
    await world.revoke(reviewer.userId, revocable);

    const res = await approve(reviewer, rule.id, { note: 'approved from a stale grant' });
    expect(res.status(), await res.text()).toBe(403);
    expect(await res.text()).toContain('MISSING_RULE_PUBLISH');
    const after = await detail(author, rule.id);
    expect(after.status).toBe('in_review');
    expect(after.approvalHistory ?? []).toHaveLength(0);
  });

  // §8.3.4 (FR12, EC9)
  test('FR12 EC9 — an author alone holding rule:publish in the workspace self-approves, recorded as such @SI-017', async () => {
    const solo = await world.actor('solo', publisherRole);
    const bystander = await world.actor('bystander', readerRole);
    const ws = await world.workspace('solo', [solo, bystander]);
    const rule = await inReviewRule(solo.api, { scope: 'workspace', workspaceId: ws });

    const view = await detail(solo, rule.id);
    expect(view.review).toMatchObject({ canApprove: true, wouldSelfApprove: true });

    const res = await approve(solo, rule.id, { note: 'Sole approver in this workspace.' });
    expect(res.status(), await res.text()).toBe(201);
    const after = await detail(solo, rule.id);
    expect(after.status).toBe('published');
    expect(after.approvalHistory?.[0]).toMatchObject({ actorId: solo.userId, selfApproved: true });
  });

  // §8.3.5 (FR12, EC9)
  test('FR12 EC9 — self-approval is refused when another member holds rule:publish; that member approves @SI-017', async () => {
    const author = await world.actor('author-pool', publisherRole);
    const colleague = await world.actor('colleague', publisherRole);
    const ws = await world.workspace('pool', [author, colleague]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    const view = await detail(author, rule.id);
    expect(view.review).toMatchObject({
      canApprove: false,
      approveBlockedCode: 'SELF_APPROVAL_OTHER_APPROVER_EXISTS',
      canRequestChanges: true,
    });

    const refused = await approve(author, rule.id, { note: 'my own rule' });
    expect(refused.status(), await refused.text()).toBe(403);
    expect(await refused.text()).toContain('SELF_APPROVAL_OTHER_APPROVER_EXISTS');
    expect((await detail(author, rule.id)).status).toBe('in_review');

    const ok = await approve(colleague, rule.id, { note: 'Reviewed by a colleague.' });
    expect(ok.status(), await ok.text()).toBe(201);
    expect((await detail(author, rule.id)).approvalHistory?.[0]).toMatchObject({
      actorId: colleague.userId,
      selfApproved: false,
    });
  });

  // §8.3.6 (FR12, D4)
  test('FR12 — Claude-authored content is never self-approved, even by a sole approver @SI-017', async () => {
    const conduit = await world.actor('conduit', publisherRole);
    const ws = await world.workspace('claude', [conduit]);
    const rule = await inReviewRule(conduit.api, { scope: 'workspace', workspaceId: ws }, { authorKind: 'claude' });

    const view = await detail(conduit, rule.id);
    expect(view.review?.approveBlockedCode).toBe('SELF_APPROVAL_CLAUDE_AUTHORED');

    const refused = await approve(conduit, rule.id, { note: 'I only pasted it' });
    expect(refused.status(), await refused.text()).toBe(403);
    expect(await refused.text()).toContain('SELF_APPROVAL_CLAUDE_AUTHORED');
    expect((await detail(conduit, rule.id)).status).toBe('in_review');
  });

  // §8.3.7 (FR11, FR13, AC11)
  test('FR11 FR13 — request changes returns the rule to draft with the comment recorded; a blank comment is refused @SI-017', async () => {
    const author = await world.actor('author-rc', readerRole);
    const reviewer = await world.actor('reviewer-rc', publisherRole);
    const ws = await world.workspace('request-changes', [author, reviewer]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    const blank = await requestChanges(reviewer, rule.id, { note: '   ' });
    expect(blank.status(), await blank.text()).toBe(400);
    expect((await detail(author, rule.id)).status).toBe('in_review');

    const hash = (await detail(reviewer, rule.id)).review!.contentHash;
    const res = await requestChanges(reviewer, rule.id, {
      note: 'Guidance example does not match the output fields.',
    });
    expect(res.status(), await res.text()).toBe(201);

    const after = await detail(author, rule.id);
    expect(after.status).toBe('draft');
    expect(after.servedVersion ?? null).toBeNull();
    expect(after.approvalHistory?.[0]).toMatchObject({
      decision: 'request_changes',
      actorId: reviewer.userId,
      note: 'Guidance example does not match the output fields.',
      ruleVersionId: null,
      contentHash: hash,
    });

    const audit = await send(author.api, 'get', `/api/v1/rules/${rule.id}/audit`);
    const rows = (Array.isArray(audit) ? audit : audit.entries ?? audit.data ?? []) as Array<{
      action: string;
      changes?: Record<string, { new?: unknown }>;
    }>;
    const entry = rows.find((r) => r.action === 'request_changes');
    expect(entry, JSON.stringify(rows.map((r) => r.action))).toBeTruthy();
    expect(entry!.changes?.status).toMatchObject({ new: 'draft' });
  });

  // §8.3.8 (FR13)
  test('FR13 — a decision on content that changed since it was loaded is refused 409 @SI-017', async () => {
    const author = await world.actor('author-stale', readerRole);
    const reviewer = await world.actor('reviewer-stale', publisherRole);
    const ws = await world.workspace('stale', [author, reviewer]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    const res = await approve(reviewer, rule.id, { note: 'ok', expectedContentHash: '0'.repeat(64) });
    expect(res.status(), await res.text()).toBe(409);
    expect(await res.text()).toContain('RULE_REVIEW_CONTENT_STALE');
    expect((await detail(author, rule.id)).status).toBe('in_review');
  });

  // §8.3.9 (EC17)
  test('EC17 — of two concurrent approvals exactly one wins and exactly one record is written @SI-017', async () => {
    const author = await world.actor('author-race', readerRole);
    const first = await world.actor('racer-a', publisherRole);
    const second = await world.actor('racer-b', publisherRole);
    const ws = await world.workspace('race', [author, first, second]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    const [a, b] = await Promise.all([
      approve(first, rule.id, { note: 'A approves' }),
      approve(second, rule.id, { note: 'B approves' }),
    ]);
    const statuses = [a.status(), b.status()].sort();
    // The loser either lost the conditional transition (409) or read the rule
    // after the winner committed (400 NOT_IN_REVIEW) — never a second publish.
    expect(statuses[0], `${await a.text()} | ${await b.text()}`).toBe(201);
    expect([400, 409]).toContain(statuses[1]);

    const after = await detail(author, rule.id);
    expect(after.status).toBe('published');
    expect(after.approvalHistory).toHaveLength(1);
    const versions = (await send(author.api, 'get', `/api/v1/rules/${rule.id}/versions`)) as Array<{
      status: string;
    }>;
    expect(versions.filter((v) => v.status === 'published')).toHaveLength(1);
  });

  // §8.3.10 (EC14)
  test('EC14 — a system rule refuses a rule:publish holder who is not a platform administrator @SI-017', async () => {
    const holder = await world.actor('system-holder', publisherRole);
    const rule = await inReviewRule(world.admin, { scope: 'system' });

    const res = await approve(holder, rule.id, { note: 'not an admin' });
    // The gateway admits (holder has rule:publish); the service refuses — as a
    // write gate on a system rule (403) or a visibility NotFound (404), never a publish.
    expect([403, 404], await res.text()).toContain(res.status());
    const after = await send(world.admin, 'get', `/api/v1/rules/${rule.id}`);
    expect(after.status).toBe('in_review');
  });
});
