import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  COMPLETE_GUIDANCE,
  COMPLETE_OUTPUT_FIELDS,
  inReviewRule,
  ReviewWorld,
  RuleResponse,
  send,
} from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1766 (epic AXI-1762 — FR17, FR18, FR20, FR21): rule runnability and the
 * ONE server-side offering predicate (offered ≡ live ∧ served ∧ runnable).
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §9.
 *
 * API-level against the LIVE consumers: the pickers' read
 * (`GET /rule-runs/offered-rules`), the rule detail (`GET /rules/:id`) and the
 * run path (`POST /rule-runs/preflight`, `POST /rule-runs`). Rules the spec
 * creates are system-scope, so the admin caller (a platform admin) needs no
 * workspace membership; the offering read confines to the admin's first
 * workspace, or — on a stack with none — to a fixed id a platform admin is
 * authorized for.
 */

interface OfferedRule {
  id: string;
  code: string;
  scope: string;
  status: string;
  runnable: boolean;
  runnabilityReasonCode: string | null;
  runnabilityReason: string | null;
  runKind: string | null;
  operationId: string | null;
}

interface OfferedRules {
  offered: OfferedRule[];
  notAvailable: Array<{ rule: OfferedRule; reasonCode: string; reason: string }>;
}

interface OperationDescriptor {
  operationId: string;
  runKind: string;
  submitToken: string | null;
}

const PLATFORM_ADMIN_WORKSPACE = '00000000-0000-4000-8000-000000000001';
const SUBMITTABLE_KINDS = new Set(['DELTA', 'STRATIFY', 'STATISTICAL', 'JOIN', 'DESCRIBE']);

let world: ReviewWorld;
let api: APIRequestContext;
let workspaceId: string;

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  api = world.admin;
  // Publishing is gated on an ASSIGNED `rule:publish` role (AXI-1765), never
  // on platform-admin alone.
  await world.grant(world.adminUserId, await world.role('AXI-1766 publisher', ['rule:read', 'rule:publish']));
  const res = await api.get(apiUrl('/api/v1/workspaces?limit=1'));
  expect(res.ok(), await res.text()).toBe(true);
  const body = await res.json();
  workspaceId = body?.data?.[0]?.id ?? PLATFORM_ADMIN_WORKSPACE;
});

test.afterAll(async () => {
  await world?.dispose();
});

function uniqueCode(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function offeredRules(): Promise<OfferedRules> {
  const res = await api.get(apiUrl(`/api/v1/rule-runs/offered-rules?workspaceId=${workspaceId}`));
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as OfferedRules;
}

/**
 * AXI-1768 (FR16, D1): carriers are boot-seeded at `checked`/`draft` and are
 * offered only once an approver approves them — so a carrier is found in the
 * LIBRARY, not in the offering, on a stack nobody has reviewed yet.
 */
async function systemRulesByCode(): Promise<Map<string, OfferedRule & { tags?: string[] }>> {
  const page = await send(api, 'get', '/api/v1/rules?scope=system&limit=200');
  return new Map((page.data as Array<OfferedRule & { tags?: string[] }>).map((r) => [r.code, r]));
}

async function getRule(id: string): Promise<OfferedRule> {
  const res = await api.get(apiUrl(`/api/v1/rules/${id}`));
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as OfferedRule;
}

/**
 * A published system FEATURE_RULE with the given tags. Since AXI-1765 the only
 * way to publish is review: create → complete → submit-for-review → approve by
 * an ASSIGNED `rule:publish` holder who (system scope, EC14) is a platform
 * admin. The admin authors AND approves, which the policy admits as a recorded
 * self-approval only when no other platform admin holds `rule:publish` — true
 * on a fresh stack (the sidecar trio this spec is run on).
 */
async function publishedSystemRule(tags: string[]): Promise<OfferedRule> {
  const submitted = await inReviewRule(world.admin, { scope: 'system' }, {
    code: uniqueCode('AXI-1766'),
    title: 'AXI-1766 runnability fixture',
    tags,
  });
  const before = (await send(world.admin, 'get', `/api/v1/rules/${submitted.id}`)) as RuleResponse;
  const res = await world.admin.post(apiUrl(`/api/v1/rules/${submitted.id}/approve`), {
    data: { note: 'AXI-1766 e2e fixture', expectedContentHash: before.review?.contentHash },
  });
  expect(res.status(), await res.text()).toBe(201);
  return getRule(submitted.id);
}

/** Every body field a run submission needs — the ids are never read past the FR20 gate. */
function submission(ruleId: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ruleId,
    workspaceId,
    projectId: '00000000-0000-4000-8000-0000000000a1',
    datasetId: '00000000-0000-4000-8000-0000000000d1',
    ...extra,
  };
}

test.describe('AXI-1766 — rule runnability and the offering predicate', () => {
  // §9.3.1 (AC7, FR21)
  // AXI-1768 (FR16, D1): the carriers are boot-seeded UNPUBLISHED; they reach
  // the offering only through an approval, so this asserts the seeding in the
  // library and that no unapproved carrier is offered.
  test('AC7 FR21 — a fresh stack carries every submittable operation with a boot-seeded carrier, offered only once approved @SI-017', async () => {
    const opsRes = await api.get(apiUrl('/api/v1/rule-runs/operations'));
    expect(opsRes.status(), await opsRes.text()).toBe(200);
    const { operations } = (await opsRes.json()) as { operations: OperationDescriptor[] };
    const submittable = operations.filter(
      (op) => SUBMITTABLE_KINDS.has(op.runKind) && (op.runKind !== 'DELTA' || !!op.submitToken),
    );
    expect(submittable.length).toBeGreaterThan(30);

    const library = await systemRulesByCode();
    const carrierTags = [...library.values()].flatMap((r) => r.tags ?? []);
    const uncarried = submittable
      .filter((op) => op.runKind !== 'DELTA' && op.runKind !== 'STRATIFY')
      .filter((op) => !carrierTags.includes(`op:${op.operationId}`))
      .map((op) => op.operationId);
    expect(uncarried).toEqual([]);
    for (const code of ['DELTA-01', 'STRATIFY-01', 'JOIN-01', 'STAT-MANN-WHITNEY-U', 'DESC-COUNT']) {
      expect(library.has(code), `${code} is boot-seeded`).toBe(true);
    }

    const { offered } = await offeredRules();
    expect(offered.every((r) => r.runnable && r.status === 'published')).toBe(true);
    for (const r of offered.filter((o) => library.has(o.code))) {
      const full = (await send(api, 'get', `/api/v1/rules/${r.id}`)) as RuleResponse;
      expect(
        (full.approvalHistory ?? []).some((a) => a.decision === 'approve'),
        `${r.code} is offered without an approval record`,
      ).toBe(true);
    }
  });

  // §9.3.2 (AC5, FR17, FR18)
  // AXI-1768: read from the library — a carrier is offered only once approved.
  test('AC5 FR17 — a runnable carrier\'s detail says what it runs as @SI-017 @SI-035', async () => {
    const mwu = (await systemRulesByCode()).get('STAT-MANN-WHITNEY-U');
    expect(mwu).toBeDefined();
    const detail = await getRule(mwu!.id);
    expect(detail).toMatchObject({
      runnable: true,
      runnabilityReasonCode: null,
      runKind: 'STATISTICAL',
      operationId: 'stats.mann_whitney_u',
    });
  });

  // §9.3.3 (AC5, EC3, FR17, FR18)
  // Since AXI-1764/1765 an AUTHORED rule naming an unregistered operation can
  // never be published: the FR9 checked gate names the operation and keeps it a
  // draft, and only an in_review rule can be approved. So EC3's published half
  // (a deploy that REMOVES an operation a published rule still cites) is not
  // reachable through the API; its run-path refusal is pinned at unit level
  // (UT-RR-1766-*, `rule-executor-match.spec.ts`). What the API CAN show is
  // that the one predicate judges such a rule `operation_unregistered` wherever
  // it is read, that the offering never lists it, and that it cannot run.
  test('AC5 EC3 — a rule naming an unregistered operation is judged operation_unregistered, never offered, never publishable, and refused by the run path with its reason code @SI-017 @SI-035', async () => {
    const created = (await send(api, 'post', '/api/v1/rules', {
      code: uniqueCode('AXI-1766'),
      title: 'AXI-1766 unregistered-operation fixture',
      category: 'phenotype_detection',
      protocolType: 'FEATURE_RULE',
      scope: 'system',
      signals: ['marker:cd4_count'],
      tags: ['relationship-rule', 'statistical', 'op:stats.axi1766_not_registered'],
    })) as RuleResponse;
    const completed = (await send(api, 'patch', `/api/v1/rules/${created.id}`, {
      outputFields: COMPLETE_OUTPUT_FIELDS,
      guidance: COMPLETE_GUIDANCE,
    })) as RuleResponse;
    // The FR9 gate refuses to call it checked, so it can never enter review.
    expect(completed.status).toBe('draft');
    const submit = await api.post(apiUrl(`/api/v1/rules/${created.id}/submit-for-review`));
    expect(submit.status(), await submit.text()).toBeGreaterThanOrEqual(400);

    const rule = await getRule(created.id);
    expect(rule).toMatchObject({ runnable: false, runnabilityReasonCode: 'operation_unregistered', runKind: null });
    expect(rule.runnabilityReason).toContain('stats.axi1766_not_registered');

    const { offered, notAvailable } = await offeredRules();
    expect(offered.map((r) => r.id)).not.toContain(rule.id);
    expect(notAvailable.map((n) => n.rule.id)).not.toContain(rule.id);

    // Cited by its explicit version (the only way to name an unserved one), the
    // run path reaches the FR20 check on that version's snapshot and refuses
    // with the reason code — on preflight and on execute alike.
    const versions = (await send(api, 'get', `/api/v1/rules/${rule.id}/versions`)) as Array<{ id: string }>;
    expect(versions.length).toBeGreaterThan(0);
    const body = submission(rule.id, {
      ruleVersionId: versions[0].id,
      runKind: 'STATISTICAL',
      operationId: 'stats.mann_whitney_u',
    });
    for (const path of ['/api/v1/rule-runs/preflight', '/api/v1/rule-runs']) {
      const res = await api.post(apiUrl(path), { data: body });
      const text = await res.text();
      expect(res.status(), `${path}: ${text}`).toBe(400);
      expect(text).toContain('operation_unregistered');
      expect(text).toContain('stats.axi1766_not_registered');
    }
  });

  // §9.3.4 (AC6, FR20)
  // AXI-1768: the carrier is unapproved, so it is cited by its explicit version
  // (as §9.3.3 does) to reach the FR20 check.
  test('AC6 FR20 — a describe carrier is never runnable as DELTA; the refusal names both kinds @SI-017', async () => {
    const found = (await systemRulesByCode()).get('DESC-COUNT');
    expect(found).toBeDefined();
    const count = await getRule(found!.id);
    expect(count).toMatchObject({ runKind: 'DESCRIBE', operationId: 'describe.count' });
    const versions = (await send(api, 'get', `/api/v1/rules/${count.id}/versions`)) as Array<{ id: string }>;

    const res = await api.post(apiUrl('/api/v1/rule-runs/preflight'), {
      data: submission(count.id, { runKind: 'DELTA', formula: 'difference', ruleVersionId: versions[0].id }),
    });
    const text = await res.text();
    expect(res.status(), text).toBe(400);
    expect(text).toContain('runs as DESCRIBE (describe.count)');
    expect(text).toContain('this submission is a DELTA run');
  });

  // §9.3.5 (EC13, FR17)
  test('EC13 FR17 — a declarative rule with no executor is no_executor and never offered @SI-017', async () => {
    const rule = await publishedSystemRule([]);
    expect(rule).toMatchObject({ status: 'published', runnable: false, runnabilityReasonCode: 'no_executor', runKind: null });
    const { offered } = await offeredRules();
    expect(offered.map((r) => r.id)).not.toContain(rule.id);
  });

  // §9.3.6 (FR18)
  test('FR18 — the offering read is confined to a workspace: no workspaceId is a 400 @SI-035', async () => {
    const res = await api.get(apiUrl('/api/v1/rule-runs/offered-rules'));
    expect(res.status(), await res.text()).toBe(400);
  });
});
