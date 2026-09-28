import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ReviewWorld, RuleResponse, send } from '../AXI-1762/AXI-1765-rule-review-fixtures';

/**
 * AXI-1808 (epic AXI-1762 — FR11, FR16, D1): ruleset activation routed through
 * the FR9-derived lifecycle instead of writing `published` directly.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §16.
 *
 * ⚠️ NOT RUN as part of this story's implementation pass (see the report to the
 * lead): `admin/rulesets/*` is a GLOBAL, platform-wide side effect (one active
 * ruleset at a time, materializing/deprecating system-scope rules across the
 * whole database — same caveat the AXI-1149 spec already records for this
 * surface) and, at authoring time, the shared demo stack had a hand-restored
 * rule library plus a live Playwright batch running against it. This spec is
 * written to the real `admin/rulesets` contract (multipart JSON import,
 * `req.user.role === 'ADMIN'` only) and is ready to run against a disposable
 * sidecar stack — never the shared demo backend.
 *
 * API-level by design (no ruleset-authoring UI exists yet).
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** A minimal, schema-valid ruleset import payload with one complete
 *  (FR9-passing) member and one incomplete (FR9-failing) member. */
function rulesetPayload(labelPrefix: string) {
  const completeKey = unique(`${labelPrefix}-complete`).slice(0, 40);
  const incompleteKey = unique(`${labelPrefix}-incomplete`).slice(0, 40);
  return {
    name: unique(`AXI-1808 ${labelPrefix}`),
    version: '1.0.0',
    rules: [
      {
        rule_id: completeKey,
        name: 'AXI-1808 complete member',
        category: 'phenotype_detection',
        question: 'Is CD4 count elevated?',
        logic: { type: 'comparison', operator: '>', field: 'cd4_count', value: 500 },
        scoring: { outputFields: [{ key: 'value', type: 'number', description: 'Computed value.' }] },
      },
      {
        rule_id: incompleteKey,
        name: 'AXI-1808 incomplete member',
        category: 'phenotype_detection',
        question: 'Is CD4 count elevated?',
        logic: { type: 'comparison', operator: '>', field: 'cd4_count', value: 500 },
      },
    ],
  };
}

async function importAndActivate(
  world: ReviewWorld,
  labelPrefix: string,
): Promise<{ rulesetId: string; ruleIds: string[] }> {
  const payload = rulesetPayload(labelPrefix);
  const importRes = await world.admin.post(apiUrl('/api/v1/admin/rulesets/import'), {
    multipart: {
      file: {
        name: 'ruleset.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(payload)),
      },
    },
  });
  expect(importRes.status(), await importRes.text()).toBe(201);
  const imported = await importRes.json();
  expect(imported.success, JSON.stringify(imported.validationReport)).toBe(true);
  const rulesetId = imported.ruleset.id as string;

  const activateRes = await world.admin.post(apiUrl(`/api/v1/admin/rulesets/${rulesetId}/activate`));
  expect(activateRes.status(), await activateRes.text()).toBe(200);

  const rulesRes = await send(world.admin, 'get', `/api/v1/admin/rulesets/${rulesetId}/rules?limit=50`);
  const ruleIds = (rulesRes.data as Array<{ ruleId: string }>).map((r) => r.ruleId);
  return { rulesetId, ruleIds };
}

async function ruleDetail(world: ReviewWorld, id: string): Promise<RuleResponse> {
  return (await send(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
}

let world: ReviewWorld;

test.beforeAll(async () => {
  world = await ReviewWorld.create();
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-1808 — ruleset activation never writes published (FR11, FR16, D1)', () => {
  // §16.3.1
  test('activating a ruleset lands members at the FR9 verdict, never published @SI-017', async () => {
    const { ruleIds } = await importAndActivate(world, 'materialize');
    expect(ruleIds.length).toBe(2);

    const details = await Promise.all(ruleIds.map((id) => ruleDetail(world, id)));
    for (const rule of details) {
      expect(['checked', 'draft']).toContain(rule.status);
      expect(rule.status).not.toBe('published');
      expect(rule.approvalHistory ?? []).toEqual([]);
      expect(rule.servedVersion ?? null).toBeNull();
    }
    // The complete fixture rule passes FR9 (has a question, logic, output fields).
    expect(details.some((r) => r.status === 'checked')).toBe(true);
    // The incomplete fixture rule (no output-field scoring) fails FR9.
    expect(details.some((r) => r.status === 'draft')).toBe(true);
  });

  // §16.3.2
  test('a restart (FR16 reconciliation) leaves an activated ruleset unchanged — nothing to demote @SI-017', async () => {
    const { ruleIds } = await importAndActivate(world, 'restart');

    const before = await Promise.all(ruleIds.map((id) => ruleDetail(world, id)));
    const reconcile = await world.admin.post(apiUrl('/api/v1/rules/seed-pack/deploy'));
    expect(reconcile.status(), await reconcile.text()).toBe(200);

    for (const rule of before) {
      const audit = await send(world.admin, 'get', `/api/v1/rules/${rule.id}/audit`);
      const actions = (audit.entries as Array<{ action: string }>).map((e) => e.action);
      expect(actions).not.toContain('demote_unapproved');
    }
  });

  // §16.3.3 (closes AXI-1784)
  test('deprecating a ruleset catches a member forked mid-edit, not only a live-published one @SI-017', async () => {
    const { rulesetId, ruleIds } = await importAndActivate(world, 'deprecate');
    const complete = (await Promise.all(ruleIds.map((id) => ruleDetail(world, id)))).find(
      (r) => r.status === 'checked',
    )!;

    // Walk it to published (submit-for-review + approve), then fork it by editing.
    await send(world.admin, 'post', `/api/v1/rules/${complete.id}/submit-for-review`);
    const inReview = await ruleDetail(world, complete.id);
    await send(world.admin, 'post', `/api/v1/rules/${complete.id}/approve`, {
      justification: 'AXI-1808 e2e — publish before forking.',
      expectedContentHash: inReview.review!.contentHash,
    });
    expect((await ruleDetail(world, complete.id)).status).toBe('published');

    // Fork: any edit to a published rule forks the live row (FR14).
    await send(world.admin, 'patch', `/api/v1/rules/${complete.id}`, {
      question: 'Is CD4 count elevated (revised)?',
    });
    const forked = await ruleDetail(world, complete.id);
    expect(forked.status).not.toBe('published');

    // The served-set (`offered-rules`) is workspace-scoped and asserted in the
    // AXI-1766 offering spec; here the rule row's own status/servedVersion is
    // the direct, workspace-free way to observe "is this rule served".
    const deprecateRes = await world.admin.post(apiUrl(`/api/v1/admin/rulesets/${rulesetId}/deprecate`), {
      data: { reason: 'AXI-1808 e2e — supersede for forked-member coverage.' },
    });
    expect(deprecateRes.status(), await deprecateRes.text()).toBe(200);

    const afterDeprecate = await ruleDetail(world, complete.id);
    expect(afterDeprecate.status).toBe('deprecated');
  });

  // §16.3.4
  test('reactivating a deprecated ruleset keeps an approved member served — no fabricated approval; an unapproved member stays unserved @SI-017', async () => {
    const { rulesetId, ruleIds } = await importAndActivate(world, 'reactivate');
    const complete = (await Promise.all(ruleIds.map((id) => ruleDetail(world, id)))).find(
      (r) => r.status === 'checked',
    )!;
    const bare = (await Promise.all(ruleIds.map((id) => ruleDetail(world, id)))).find((r) => r.status === 'draft')!;

    await send(world.admin, 'post', `/api/v1/rules/${complete.id}/submit-for-review`);
    const inReview = await ruleDetail(world, complete.id);
    await send(world.admin, 'post', `/api/v1/rules/${complete.id}/approve`, {
      justification: 'AXI-1808 e2e — approve before deprecation.',
      expectedContentHash: inReview.review!.contentHash,
    });
    const approvalHistoryBefore = (await ruleDetail(world, complete.id)).approvalHistory;
    expect(approvalHistoryBefore).toHaveLength(1);

    await world.admin.post(apiUrl(`/api/v1/admin/rulesets/${rulesetId}/deprecate`), {
      data: { reason: 'AXI-1808 e2e — deprecate before reactivate coverage.' },
    });
    expect((await ruleDetail(world, complete.id)).status).toBe('deprecated');

    const reactivateRes = await world.admin.post(apiUrl(`/api/v1/admin/rulesets/${rulesetId}/reactivate`), {
      data: { reason: 'AXI-1808 e2e — reactivate coverage.' },
    });
    expect(reactivateRes.status(), await reactivateRes.text()).toBe(200);

    const approvedAfter = await ruleDetail(world, complete.id);
    expect(approvedAfter.status).not.toBe('published');
    expect(approvedAfter.status).not.toBe('deprecated');
    // Deprecation/reactivation mint NEW RuleVersion rows but never an approval record, and never touch the earlier approved version — so the approval history is unchanged.
    expect(approvedAfter.approvalHistory).toEqual(approvalHistoryBefore);

    const bareAfter = await ruleDetail(world, bare.id);
    expect(bareAfter.status).not.toBe('published');
    expect(bareAfter.approvalHistory ?? []).toEqual([]);
  });
});
