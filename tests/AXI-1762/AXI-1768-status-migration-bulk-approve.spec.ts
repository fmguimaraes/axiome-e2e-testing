import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  COMPLETE_GUIDANCE,
  COMPLETE_OUTPUT_FIELDS,
  inReviewRule,
  ReviewWorld,
  RuleResponse,
  send,
} from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1768 (epic AXI-1762 — FR16, D1, AC13, EC12): the honest status
 * migration and bulk approval.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §10.
 *
 * API-level by design (the review UI is AXI-1774's). The migration itself is a
 * boot job of the organization service: these specs assert what it LEFT — on a
 * database that held published-without-approval rules before the boot (the
 * demo copy) §10.3.1 proves the demotion; on a fresh database §10.3.2 skips, loudly.
 *
 * Preconditions: the stack runs this branch's organization service (booted at
 * least once) and user-service migrations; the platform admin the fixtures log
 * in as is the only platform admin holding `rule:publish` (true on a fresh
 * stack and on the demo copy — the AXI-1768 bootstrap grant).
 */

const READER = ['rule:read'];
const PUBLISHER = ['rule:read', 'rule:publish'];

let world: ReviewWorld;
let readerRole: string;
let publisherRole: string;
let adminWorkspaceId: string | undefined;

interface BulkResult {
  ruleId: string;
  code: string | null;
  outcome: 'published' | 'submitted' | 'skipped' | 'failed';
  reasonCode: string | null;
  status: string | null;
  approvalRecordId?: string;
  selfApproved?: boolean;
}

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  readerRole = await world.role('reader', READER);
  publisherRole = await world.role('publisher', PUBLISHER);
  const ws = await send(world.admin, 'get', '/api/v1/workspaces?limit=1');
  adminWorkspaceId = ws?.data?.[0]?.id;
});

test.afterAll(async () => {
  await world?.dispose();
});

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function detail(api: APIRequestContext, id: string): Promise<RuleResponse> {
  return (await send(api, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
}

/** A complete (FR9-passing) workspace FEATURE_RULE at `checked`, or a bare one at `draft`. */
async function workspaceRule(author: Actor, workspaceId: string, complete: boolean): Promise<RuleResponse> {
  const created = (await send(author.api, 'post', '/api/v1/rules', {
    code: unique('AXI-1768'),
    title: 'AXI-1768 bulk fixture',
    category: 'phenotype_detection',
    protocolType: 'FEATURE_RULE',
    signals: ['marker:cd4_count'],
    scope: 'workspace',
    workspaceId,
  })) as RuleResponse;
  if (!complete) return created;
  const checked = (await send(author.api, 'patch', `/api/v1/rules/${created.id}`, {
    outputFields: COMPLETE_OUTPUT_FIELDS,
    guidance: COMPLETE_GUIDANCE,
  })) as RuleResponse;
  expect(checked.status, 'fixture rule must pass the FR9 gate').toBe('checked');
  return checked;
}

async function systemRules(): Promise<RuleResponse[]> {
  const page = await send(world.admin, 'get', '/api/v1/rules?scope=system&limit=200');
  return page.data as RuleResponse[];
}

async function auditActions(id: string): Promise<string[]> {
  const audit = await send(world.admin, 'get', `/api/v1/rules/${id}/audit`);
  return (audit.entries as Array<{ action: string }>).map((e) => e.action);
}

async function offeredIds(): Promise<Set<string>> {
  if (!adminWorkspaceId) return new Set();
  const res = await world.admin.get(apiUrl(`/api/v1/rule-runs/offered-rules?workspaceId=${adminWorkspaceId}`));
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return new Set(((body.offered ?? []) as Array<{ id: string }>).map((r) => r.id));
}

test.describe('AXI-1768 — FR16 status migration: nothing is served without an approval record', () => {
  // §10.3.2 (FR16, AC13, D1, EC12)
  test('AC13 FR16 — a rule published before the gate is demoted with an audit entry, not served and not offered @SI-017', async () => {
    const rules = await systemRules();
    let demoted: RuleResponse | undefined;
    for (const rule of rules) {
      if ((await auditActions(rule.id)).includes('demote_unapproved')) {
        demoted = rule;
        break;
      }
    }
    test.skip(!demoted, 'no rule on this database was published before the review gate (fresh database) — §10.3.2 runs on the demo copy');

    const now = await detail(world.admin, demoted!.id);
    expect(['draft', 'checked']).toContain(now.status);
    expect(now.servedVersion ?? null).toBeNull();
    expect(now.approvalHistory ?? []).toEqual([]);
    expect((await offeredIds()).has(demoted!.id)).toBe(false);
  });

  // §10.3.1 (FR16, FR21, D1)
  test('FR16 D1 — boot-seeded carriers are never published without an approval record @SI-017', async () => {
    const carriers = (await systemRules()).filter((r) =>
      ((r.tags as string[] | undefined) ?? []).some((t) => t.startsWith('op:')),
    );
    expect(carriers.length, 'the seed pack carries one rule per submittable operation').toBeGreaterThan(10);
    const offered = await offeredIds();
    for (const carrier of carriers) {
      const full = await detail(world.admin, carrier.id);
      const approved = (full.approvalHistory ?? []).some((r) => r.decision === 'approve');
      if (!approved) {
        expect(full.status, `${carrier.code} is published without an approval record`).not.toBe('published');
        expect(full.servedVersion ?? null, `${carrier.code} is served without approval`).toBeNull();
        expect(offered.has(carrier.id), `${carrier.code} is offered without approval`).toBe(false);
      }
    }
  });
});

test.describe('AXI-1768 — bulk submit-for-review and bulk approve (AC13)', () => {
  // §10.3.3 (AC13, FR11, FR13, FR16)
  test('AC13 — a rule:publish holder bulk-approves; each rule gets its own record; a draft is skipped by name @SI-017 @SI-010', async () => {
    const author = await world.actor('author', readerRole);
    const reviewer = await world.actor('reviewer', publisherRole);
    const ws = await world.workspace('bulk', [author, reviewer]);
    const one = await workspaceRule(author, ws, true);
    const two = await workspaceRule(author, ws, true);
    const bare = await workspaceRule(author, ws, false);
    const ids = [one.id, two.id, bare.id];

    const submitted = await send(author.api, 'post', '/api/v1/rules/bulk/submit-for-review', { ruleIds: ids });
    expect(submitted).toMatchObject({ submitted: 2, skipped: 1, failed: 0 });
    expect((submitted.results as BulkResult[]).map((r) => [r.ruleId, r.outcome, r.reasonCode])).toEqual([
      [one.id, 'submitted', null],
      [two.id, 'submitted', null],
      [bare.id, 'skipped', 'NOT_CHECKED'],
    ]);

    const hashes = Object.fromEntries(
      await Promise.all([one.id, two.id].map(async (id) => [id, (await detail(reviewer.api, id)).review!.contentHash])),
    );
    const approved = await send(reviewer.api, 'post', '/api/v1/rules/bulk/approve', {
      ruleIds: ids,
      justification: 'AXI-1768 e2e — batch reviewed.',
      expectedContentHashes: hashes,
    });
    expect(approved).toMatchObject({ published: 2, skipped: 1, failed: 0 });
    const results = approved.results as BulkResult[];
    expect(results[2]).toMatchObject({ ruleId: bare.id, outcome: 'skipped', reasonCode: 'NOT_IN_REVIEW', status: 'draft' });

    for (const [index, id] of [one.id, two.id].entries()) {
      expect(results[index]).toMatchObject({ ruleId: id, outcome: 'published', selfApproved: false });
      const after = await detail(reviewer.api, id);
      expect(after.status).toBe('published');
      expect(after.approvalHistory).toHaveLength(1);
      expect(after.approvalHistory![0]).toMatchObject({
        id: results[index].approvalRecordId,
        decision: 'approve',
        actorId: reviewer.userId,
        note: 'AXI-1768 e2e — batch reviewed.',
        contentHash: hashes[id],
      });
      expect(after.servedVersion?.contentHash).toBe(hashes[id]);
    }
  });

  // §10.3.4 (EC10, NFR3)
  test('AC13 EC10 — a caller without rule:publish gets 403 from bulk/approve and bulk/publish, and nothing changes @SI-010', async () => {
    const author = await world.actor('author403', readerRole);
    const reader = await world.actor('reader403', readerRole);
    const ws = await world.workspace('bulk-403', [author, reader]);
    const rule = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });

    for (const path of ['/api/v1/rules/bulk/approve', '/api/v1/rules/bulk/publish']) {
      const res = await reader.api.post(apiUrl(path), {
        data: { ruleIds: [rule.id], justification: 'not mine to approve' },
      });
      expect(res.status(), `${path}: ${await res.text()}`).toBe(403);
    }
    const after = await detail(author.api, rule.id);
    expect(after.status).toBe('in_review');
    expect(after.approvalHistory ?? []).toEqual([]);
  });

  // §10.3.5 (FR12, FR16, EC14)
  test('AC13 FR12 — partial failures are reported per rule: own rule refused, unknown id skipped, the rest published @SI-017', async () => {
    const author = await world.actor('selfauthor', publisherRole);
    const peer = await world.actor('selfpeer', publisherRole);
    const ws = await world.workspace('bulk-self', [author, peer]);
    const own = await inReviewRule(author.api, { scope: 'workspace', workspaceId: ws });
    const peers = await inReviewRule(peer.api, { scope: 'workspace', workspaceId: ws });
    const unknown = '00000000-0000-4000-8000-00000000f168';

    const res = await send(author.api, 'post', '/api/v1/rules/bulk/approve', {
      ruleIds: [own.id, unknown, peers.id],
      justification: 'AXI-1768 e2e — mixed batch.',
    });

    expect(res).toMatchObject({ published: 1, failed: 1, skipped: 1 });
    const results = res.results as BulkResult[];
    expect(results[0]).toMatchObject({
      ruleId: own.id,
      outcome: 'failed',
      reasonCode: 'SELF_APPROVAL_OTHER_APPROVER_EXISTS',
    });
    expect(results[1]).toMatchObject({ ruleId: unknown, outcome: 'skipped', reasonCode: 'NOT_FOUND', code: null });
    expect(results[2]).toMatchObject({ ruleId: peers.id, outcome: 'published' });
    expect((await detail(author.api, own.id)).status).toBe('in_review');
  });

  // §10.3.6 (FR16, EC14, D1 — the operator path after the migration)
  test('FR16 EC14 — the platform admin holds rule:publish through the bootstrap grant and can approve a system rule @SI-017 @SI-011', async () => {
    const rule = await inReviewRule(world.admin, { scope: 'system' }, { code: unique('AXI-1768-SYS') });
    const before = await detail(world.admin, rule.id);
    expect(before.review?.canApprove, JSON.stringify(before.review)).toBe(true);

    const res = await send(world.admin, 'post', '/api/v1/rules/bulk/approve', {
      ruleIds: [rule.id],
      justification: 'AXI-1768 e2e — platform approval after the migration.',
      expectedContentHashes: { [rule.id]: before.review!.contentHash },
    });

    expect(res).toMatchObject({ published: 1, failed: 0 });
    // The admin authored AND approved: a RECORDED self-approval (sole platform approver).
    expect((res.results as BulkResult[])[0]).toMatchObject({ outcome: 'published', selfApproved: true });
    expect((await detail(world.admin, rule.id)).status).toBe('published');
  });

  // §10.3.7 (input validation — 400 before anything is read)
  test('AC13 — a malformed bulk request is refused with 400 @SI-010', async () => {
    for (const body of [{ ruleIds: [] }, { ruleIds: ['not-a-uuid'] }, { ruleIds: 'x' }]) {
      const res = await world.admin.post(apiUrl('/api/v1/rules/bulk/approve'), {
        data: { ...body, justification: 'x' },
      });
      expect(res.status(), JSON.stringify(body)).toBe(400);
    }
  });
});
