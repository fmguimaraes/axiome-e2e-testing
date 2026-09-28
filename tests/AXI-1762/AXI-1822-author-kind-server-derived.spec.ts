import { APIResponse, test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  COMPLETE_GUIDANCE,
  COMPLETE_OUTPUT_FIELDS,
  ReviewWorld,
  send,
} from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1822 (epic AXI-1762 — FR7, FR12, FR13; D4; SI-017, SI-010): a rule's
 * `authorKind` is SERVER-derived.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §18.
 *
 * The defect: `PATCH /rules/:id {authorKind: "human"}` relabelled
 * Claude-written content, and its conduit then approved it alone
 * (`SELF_APPROVAL_CLAUDE_AUTHORED` bypassed). This spec proves the bypass is
 * closed end to end against the running services.
 *
 * Hermetic: the "Claude line" is a CLONE of a Claude-authored statistical
 * carrier into a throwaway workspace whose only member is the actor. The clone
 * copies the source's `authorKind` server-side, so no body can set it. The pool
 * is the workspace, so no second platform admin is needed, and the shared
 * carriers are never edited, submitted or approved. Only 18.3.4 reads a carrier.
 *
 * Serial: the scenarios share one world (role, actor, workspace) and one carrier.
 */

const CARRIER_OPERATION = 'stats.mann_whitney_u';
const LABEL = 'axi1822';

interface RuleDetail {
  id: string;
  code: string;
  title: string;
  status: string;
  version: number;
  authorKind?: string | null;
  guidance?: Record<string, string> | null;
  review?: { contentHash: string; canApprove: boolean; approveBlockedCode: string | null };
  approvalHistory?: Array<{ decision: string; actorId: string; selfApproved: boolean }>;
}

interface AuditEntry {
  action: string;
  performedBy: string;
  performedAt: string;
  changes: Record<string, { old: unknown; new: unknown }>;
}

let world: ReviewWorld;
let actor: Actor;
let workspaceId: string;
let carrier: { id: string; code: string };
/** Every clone this spec made. They carry the carrier's `op:` tag, so they are deleted in afterAll
 *  and never shadow the real carrier in a sibling spec's catalogue lookup (AXI-1769). */
const clones: string[] = [];

const detail = (id: string): Promise<RuleDetail> => send(actor.api, 'get', `/api/v1/rules/${id}`);

async function latestUpdateAudit(id: string): Promise<AuditEntry> {
  const body = await send(actor.api, 'get', `/api/v1/rules/${id}/audit`);
  const entries: AuditEntry[] = (body.entries ?? body.data ?? []).filter((e: AuditEntry) => e.action === 'update');
  expect(entries.length, 'at least one update audit entry').toBeGreaterThan(0);
  return entries.reduce((a, b) => (Date.parse(b.performedAt) > Date.parse(a.performedAt) ? b : a));
}

/** A fresh Claude-authored line owned by the actor: a clone of the carrier into the actor's workspace. */
async function claudeLine(): Promise<RuleDetail> {
  const cloned = await send(actor.api, 'post', `/api/v1/rules/${carrier.id}/clone`, {
    targetScope: 'workspace',
    targetWorkspaceId: workspaceId,
  });
  clones.push(cloned.id);
  // The clone inherits the carrier's `op:` tag. Sibling specs running in parallel resolve a carrier
  // with an unscoped `GET /rules` + first-match on that tag (AXI-1769/1770/1772/1773), so a live
  // clone shadows the carrier and afterAll's delete then 404s their next read. Drop the `op:` tag
  // at once: a tags-only edit names no guidance, so it cannot move authorKind (AC2).
  const tags = ((cloned.tags ?? []) as string[]).filter((t) => !t.startsWith('op:'));
  await send(actor.api, 'patch', `/api/v1/rules/${cloned.id}`, { tags });
  const line = await detail(cloned.id);
  expect(line.authorKind, 'the clone copies the carrier author server-side').toBe('claude');
  expect(line.status, 'the cloned carrier content passes FR9').toBe('checked');
  return line;
}

async function expectAuthorKindRefusal(res: APIResponse): Promise<void> {
  expect(res.status()).toBe(400);
  expect(await res.text()).toContain('RULE_AUTHOR_KIND_SERVER_DERIVED');
}

test.describe.configure({ mode: 'serial' });

test.describe('AXI-1822 — server-derived rule authorKind @SI-017 @SI-010', () => {
  test.beforeAll(async () => {
    world = await ReviewWorld.create();
    const role = await world.role(`${LABEL}-author-approver`, [
      'rule:read',
      'rule:create',
      'rule:update',
      'rule:publish',
    ]);
    actor = await world.actor(LABEL, role);
    // The actor is the workspace's ONLY member, so the only rule:publish holder:
    // self-approval is otherwise allowed here (D3), which is what makes the
    // relabel a bypass.
    workspaceId = await world.workspace(LABEL, [actor]);

    const catalog: Array<{ id: string; code: string; tags: string[] | null; authorKind?: string }> = (
      await send(world.admin, 'get', '/api/v1/rules?limit=200&scope=system')
    ).data;
    const found = catalog.find((r) => (r.tags ?? []).includes(`op:${CARRIER_OPERATION}`));
    expect(found, `${CARRIER_OPERATION} has a carrier rule`).toBeDefined();
    carrier = { id: found!.id, code: found!.code };
    const carrierDetail = await send(world.admin, 'get', `/api/v1/rules/${carrier.id}`);
    expect(carrierDetail.authorKind, 'the seeded statistical carrier is Claude-authored (§11)').toBe('claude');
  });

  test.afterAll(async () => {
    for (const id of clones) {
      await world.admin.delete(apiUrl(`/api/v1/rules/${id}`)).catch(() => undefined);
    }
    await world?.dispose();
  });

  test('AC1 — a body naming authorKind is refused (400 RULE_AUTHOR_KIND_SERVER_DERIVED) on PATCH, POST /rules and clone, and nothing is written @SI-017 @SI-010', async () => {
    const line = await claudeLine();

    // 1. PATCH relabel attempt.
    await expectAuthorKindRefusal(
      await actor.api.patch(apiUrl(`/api/v1/rules/${line.id}`), { data: { authorKind: 'human' } }),
    );
    const afterRelabel = await detail(line.id);
    expect(afterRelabel).toMatchObject({ authorKind: 'claude', version: line.version, title: line.title });

    // 2. Mixed into a legitimate edit: the whole request is refused.
    await expectAuthorKindRefusal(
      await actor.api.patch(apiUrl(`/api/v1/rules/${line.id}`), {
        data: { title: 'AXI-1822 smuggled', authorKind: 'claude' },
      }),
    );
    expect(await detail(line.id)).toMatchObject({ title: line.title, version: line.version });

    // 3. POST /rules asserting an author.
    const code = `AXI-1822-${Date.now()}`;
    await expectAuthorKindRefusal(
      await actor.api.post(apiUrl('/api/v1/rules'), {
        data: {
          code,
          title: 'AXI-1822 create with authorKind',
          category: 'phenotype_detection',
          protocolType: 'FEATURE_RULE',
          signals: ['marker:cd4_count'],
          scope: 'workspace',
          workspaceId,
          outputFields: COMPLETE_OUTPUT_FIELDS,
          guidance: COMPLETE_GUIDANCE,
          authorKind: 'claude',
        },
      }),
    );
    const listed = (await send(actor.api, 'get', `/api/v1/rules?limit=200&workspaceId=${workspaceId}`)).data as Array<{
      code: string;
    }>;
    expect(listed.map((r) => r.code)).not.toContain(code);

    // 4. Clone asserting an author.
    await expectAuthorKindRefusal(
      await actor.api.post(apiUrl(`/api/v1/rules/${carrier.id}/clone`), {
        data: { targetScope: 'workspace', targetWorkspaceId: workspaceId, authorKind: 'human' },
      }),
    );
  });

  test('AC1 AC2 FR12 — end to end the relabel-and-self-approve bypass is closed: relabel refused, a guidance-free edit keeps claude, the sole approver is refused SELF_APPROVAL_CLAUDE_AUTHORED @SI-017 @SI-010', async () => {
    const line = await claudeLine();

    // 1. The relabel is refused.
    await expectAuthorKindRefusal(
      await actor.api.patch(apiUrl(`/api/v1/rules/${line.id}`), { data: { authorKind: 'human' } }),
    );

    // 2. An edit that does not touch guidance: accepted, author unchanged, no author change audited.
    const renamed = `${line.title} (AXI-1822 edit)`;
    await send(actor.api, 'patch', `/api/v1/rules/${line.id}`, { title: renamed });
    const edited = await detail(line.id);
    expect(edited).toMatchObject({ title: renamed, authorKind: 'claude', status: 'checked' });
    const audit = await latestUpdateAudit(line.id);
    expect(audit.performedBy).toBe(actor.userId);
    expect(audit.changes).toHaveProperty('title');
    expect(audit.changes).not.toHaveProperty('authorKind');

    // 3. Submitted: the server already says the actor cannot approve it.
    const submitted = await send(actor.api, 'post', `/api/v1/rules/${line.id}/submit-for-review`);
    expect(submitted.status).toBe('in_review');
    const inReview = await detail(line.id);
    expect(inReview.review).toMatchObject({ canApprove: false, approveBlockedCode: 'SELF_APPROVAL_CLAUDE_AUTHORED' });

    // 4. Forcing the approve is refused, and nothing is published.
    const refused = await actor.api.post(apiUrl(`/api/v1/rules/${line.id}/approve`), {
      data: { note: 'Approving content I relabelled.', expectedContentHash: inReview.review!.contentHash },
    });
    expect(refused.status()).toBe(403);
    expect(await refused.text()).toContain('SELF_APPROVAL_CLAUDE_AUTHORED');
    const after = await detail(line.id);
    expect(after.status).toBe('in_review');
    expect((after.approvalHistory ?? []).filter((r) => r.decision === 'approve')).toEqual([]);
  });

  test('AC3 — a human guidance rewrite records authorKind human with a truthful {old,new} audit; a key-reordered re-send does not; the rewriter may then self-approve (D3) @SI-017', async () => {
    const line = await claudeLine();
    const current = line.guidance!;
    expect(current, 'the cloned carrier carries guidance').toBeTruthy();

    // 1. Same content, keys reversed: not a rewrite.
    const reordered = Object.fromEntries(Object.entries(current).reverse());
    await send(actor.api, 'patch', `/api/v1/rules/${line.id}`, { guidance: reordered });
    expect((await detail(line.id)).authorKind).toBe('claude');

    // 2. A real rewrite by the human.
    const rewritten = { ...current, whatItDoes: `${current.whatItDoes} Rewritten by a reviewer for AXI-1822.`.slice(0, 200) };
    await send(actor.api, 'patch', `/api/v1/rules/${line.id}`, { guidance: rewritten });
    const edited = await detail(line.id);
    expect(edited.authorKind).toBe('human');
    expect(edited.guidance).toEqual(rewritten);
    const audit = await latestUpdateAudit(line.id);
    expect(audit.performedBy).toBe(actor.userId);
    expect(audit.changes.authorKind).toEqual({ old: 'claude', new: 'human' });
    expect(audit.changes).toHaveProperty('guidance');

    // 3. The human who rewrote it is its author, alone in the workspace: a recorded self-approval.
    expect(edited.status).toBe('checked');
    await send(actor.api, 'post', `/api/v1/rules/${line.id}/submit-for-review`);
    const inReview = await detail(line.id);
    const approved = await send(actor.api, 'post', `/api/v1/rules/${line.id}/approve`, {
      note: 'I rewrote this guidance and stand behind it.',
      expectedContentHash: inReview.review!.contentHash,
    });
    expect(approved.status).toBe('published');
    const history = (await detail(line.id)).approvalHistory ?? [];
    expect(history.find((r) => r.decision === 'approve')).toMatchObject({ actorId: actor.userId, selfApproved: true });
  });

  test('AC4 — seeding still stamps registry content claude: the carrier the clones came from is untouched and still claude @SI-017', async () => {
    const body = await send(world.admin, 'get', `/api/v1/rules/${carrier.id}/versions`);
    const versions: Array<{ version: number; authorKind: string | null }> = Array.isArray(body) ? body : body.data;
    const newest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    expect(newest.authorKind).toBe('claude');
    const carrierDetail = await send(world.admin, 'get', `/api/v1/rules/${carrier.id}`);
    expect(carrierDetail.authorKind).toBe('claude');
  });
});
