import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ReviewWorld, send, type RuleResponse } from './AXI-1765-rule-review-fixtures';
import {
  approveCarriersFor,
  approveSeededRules,
  isServed,
  SEED_APPROVAL_OPT_IN,
  seedApprovalAllowed,
  SeedNotApprovableError,
  systemRuleCatalogue,
} from './seeded-rule-approval';

/**
 * AXI-1809 (epic AXI-1762 — FR16, NFR12): the shared seeded-rule approval
 * fixture that every older spec now uses instead of assuming published seeds.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §21.
 *
 * API-level: the fixture is a harness seam, and what it must prove is server
 * state (served version, approval record, offering, the approver's role).
 *
 * The carrier used is `stats.anosim` (STAT-ANOSIM). It is `checked` and
 * Claude-authored on a fresh stack, and no other spec approves it. The run
 * holds whether this is the first run on the stack (the fixture walks the
 * review) or a re-run (the carrier is already served; the fixture must write
 * nothing).
 */

const CARRIER_OP = 'stats.anosim';

type Detail = RuleResponse & {
  checks?: Array<{ id: string; passed: boolean; message: string }>;
  authorKind?: string;
};

let world: ReviewWorld;
let workspaceId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  const ws = await send(world.admin, 'post', '/api/v1/workspaces', {
    name: `E2E AXI-1809 seeded approval ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    type: 'internal',
    ownerOrganizationId: world.orgId,
  });
  workspaceId = ws.id;
});

test.afterAll(async () => {
  await world?.dispose();
});

const detail = (id: string): Promise<Detail> => send(world.admin, 'get', `/api/v1/rules/${id}`);

async function systemRules(): Promise<Array<{ id: string; code: string; status: string }>> {
  return systemRuleCatalogue(world.admin);
}

async function offeredIds(): Promise<Set<string>> {
  const body = await send(world.admin, 'get', `/api/v1/rule-runs/offered-rules?workspaceId=${workspaceId}`);
  return new Set(((body.offered ?? []) as Array<{ id: string }>).map((r) => r.id));
}

/** A system seed that FR9 keeps at `draft` on this stack: the fixture's refusal case. */
async function aDraftSeed(): Promise<Detail> {
  for (const row of (await systemRules()).filter((r) => r.status === 'draft')) {
    const d = await detail(row.id);
    if (!isServed(d)) return d;
  }
  throw new Error(
    'no unserved draft system seed on this stack: every seed passes FR9 now (AXI-1771/AXI-1815 content landed?) — ' +
      '§21.3.2 needs re-pointing at another not-approvable case',
  );
}

test.describe('AXI-1809 — approveSeededRules: the one path to a served seed', () => {
  test('21.3.1 FR16 — a checked Claude-authored carrier is served and offered after the fixture, approved by a SECOND approver, never self-approved @SI-017 @SI-010', async () => {
    const [{ code, ruleId }] = Object.values(await approveCarriersFor([CARRIER_OP]));
    expect(code).toBe('STAT-ANOSIM');

    const after = await detail(ruleId);
    expect(after.authorKind, 'seeded carrier guidance is Claude-authored').toBe('claude');
    expect(isServed(after), `${code} is served: ${JSON.stringify(after.servedVersion)}`).toBe(true);
    expect(after.status).toBe('published');

    const approvals = (after.approvalHistory ?? []).filter((r) => r.decision === 'approve');
    expect(approvals.length, 'an approval record exists (nothing is served without one)').toBeGreaterThan(0);
    const record = approvals[approvals.length - 1];
    expect(record.selfApproved, 'Claude-authored content is never self-approved').toBe(false);
    expect(record.actorId, 'the approver is not the submitting admin').not.toBe(world.adminUserId);
    expect(record.ruleVersionId, 'the record names the served version').toBe(after.servedVersion!.id);

    expect((await offeredIds()).has(ruleId), `${code} is offered once approved`).toBe(true);
  });

  test('21.3.2 FR16 — a second call writes nothing: idempotent on a served seed @SI-017', async () => {
    const [{ ruleId }] = Object.values(await approveCarriersFor([CARRIER_OP]));
    const before = await detail(ruleId);
    await approveSeededRules([before.code]);
    const after = await detail(ruleId);
    expect(after.approvalHistory?.length).toBe(before.approvalHistory?.length);
    expect(after.servedVersion).toEqual(before.servedVersion);
    expect(after.version).toBe(before.version);
  });

  test('21.3.3 NFR12 — the promoted approver is demoted again: no throwaway platform admin remains @SI-010', async () => {
    const [{ ruleId }] = Object.values(await approveCarriersFor([CARRIER_OP]));
    const approvals = ((await detail(ruleId)).approvalHistory ?? []).filter((r) => r.decision === 'approve');
    const approver = await send(world.admin, 'get', `/api/v1/users/${approvals[approvals.length - 1].actorId}`);
    expect(approver.role, 'the second approver is back to USER after the approval').toBe('USER');
  });

  test('21.3.4 FR9 FR16 — a draft seed is refused LOUDLY, naming its failing checks, and nothing is written @SI-017', async () => {
    const draft = await aDraftSeed();
    const failing = (draft.checks ?? []).filter((c) => !c.passed).map((c) => c.id);
    expect(failing.length, `${draft.code} is draft because a check fails`).toBeGreaterThan(0);

    const refusal = await approveSeededRules([draft.code]).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refusal, 'the fixture refuses instead of editing seed content').toBeInstanceOf(SeedNotApprovableError);
    const blocked = (refusal as SeedNotApprovableError).blocked;
    expect(blocked.map((b) => b.code)).toEqual([draft.code]);
    for (const id of failing) expect((refusal as Error).message).toContain(id);

    const after = await detail(draft.id);
    expect(after.status).toBe(draft.status);
    expect(after.version).toBe(draft.version);
    expect(after.approvalHistory ?? []).toEqual(draft.approvalHistory ?? []);
    expect(isServed(after)).toBe(false);
  });

  test('21.3.5 FR11 — the retired direct publish never serves a seed: refused without and with a justification @SI-010', async () => {
    const draft = await aDraftSeed();
    const bare = await world.admin.post(apiUrl(`/api/v1/rules/${draft.id}/publish`), { data: {} });
    expect(bare.ok(), await bare.text()).toBe(false);
    expect(await bare.text()).toContain('An approval requires a justification');

    const justified = await world.admin.post(apiUrl(`/api/v1/rules/${draft.id}/publish`), {
      data: { justification: 'AXI-1809 e2e: the retired direct publish must not serve a seed.' },
    });
    expect(justified.ok(), `publish is an alias of approve and only an in_review rule is approvable: ${await justified.text()}`).toBe(false);
    const after = await detail(draft.id);
    expect(after.status).toBe(draft.status);
    expect(isServed(after)).toBe(false);
  });

  test('21.3.6 NFR12 — the stack guard: approving seeds on the shared demo gateway (:3000) needs a deliberate opt-in @SI-017', async () => {
    const saved = process.env[SEED_APPROVAL_OPT_IN];
    try {
      delete process.env[SEED_APPROVAL_OPT_IN];
      expect(seedApprovalAllowed('http://localhost:3000')).toBe(false);
      expect(seedApprovalAllowed('http://127.0.0.1:3000/')).toBe(false);
      expect(seedApprovalAllowed('http://localhost:3091')).toBe(true);
      process.env[SEED_APPROVAL_OPT_IN] = '1';
      expect(seedApprovalAllowed('http://localhost:3000')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[SEED_APPROVAL_OPT_IN];
      else process.env[SEED_APPROVAL_OPT_IN] = saved;
    }
  });
});
