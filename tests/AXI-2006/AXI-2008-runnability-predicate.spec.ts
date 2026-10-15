import { test, expect, APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-2008 (epic AXI-2006 — AC6, AC12, EC7, EC9, C3, FR5, FR21; SI-002, SI-017):
 * Feature and Interpretation run kinds and runnability.
 *
 * Scenario doc: manual-e2e/AXI-2006-Reasoning-Branch-Executors.md §2 "AXI-2008".
 *
 * Reads the ONE runnability answer the way every surface reads it: the rule
 * response (`GET /rules/:id`) derives `runnable`, `runnabilityReasonCode`,
 * `runKind` and `operationId` from `isRuleRunnable` on every read
 * (`RulesService`, AXI-1766). This story adds no executor, so the only run-path
 * behaviour to see is the submit refusal by name (Scenario 5).
 *
 * Self-contained: one throwaway organization + workspace per run, rules created
 * there as the platform-admin bootstrap context (`adminApiContext`, the
 * AXI-1236 cross-dir convention), and every rule is draft (never published), so
 * nothing here is visible outside the workspace or offered to any picker.
 *
 * AUTHORED, NOT RUN: there is no stack serving this story's axiome-back branch
 * (the shared demo stack serves `main`, and its database must not be migrated
 * from a worktree). Do not report `e2e-pass` for this spec until it has run
 * green against a stack carrying migration
 * `20261015120000_add_feature_interpret_run_kinds`.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function send(
  api: APIRequestContext,
  method: 'get' | 'post' | 'delete',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await (api as any)[method](apiUrl(path), body === undefined ? {} : { data: body });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status(), json };
}

interface RunnabilityView {
  runnable: boolean;
  runnabilityReasonCode: string | null;
  runKind: string | null;
  operationId: string | null;
}

test.describe.serial('AXI-2008 — Feature and Interpretation runnability (AC6, AC12, EC7, EC9, C3)', () => {
  let admin: APIRequestContext;
  let workspaceId: string;
  const ruleIds: string[] = [];
  const byLabel = new Map<string, string>();

  /** Creates a draft workspace rule and returns its id. */
  async function createRule(label: string, protocolType: string, tags: string[] = []): Promise<string> {
    const code = unique(`E2E-2008-${label}`).toUpperCase().slice(0, 60);
    const res = await send(admin, 'post', '/api/v1/rules', {
      code,
      title: `AXI-2008 fixture ${label}`,
      category: 'phenotype_detection',
      protocolType,
      scope: 'workspace',
      workspaceId,
      tags,
    });
    expect(res.status, `creating ${label} (${protocolType}): ${JSON.stringify(res.json)}`).toBeLessThan(300);
    ruleIds.push(res.json.id);
    byLabel.set(label, res.json.id);
    return res.json.id;
  }

  async function runnabilityOf(ruleId: string): Promise<RunnabilityView> {
    const res = await send(admin, 'get', `/api/v1/rules/${ruleId}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return {
      runnable: res.json.runnable,
      runnabilityReasonCode: res.json.runnabilityReasonCode ?? null,
      runKind: res.json.runKind ?? null,
      operationId: res.json.operationId ?? null,
    };
  }

  test.beforeAll(async () => {
    admin = await adminApiContext();
    const org = await send(admin, 'post', '/api/v1/organizations', { name: unique('AXI-2008 Org'), type: 'biotech' });
    expect(org.status, JSON.stringify(org.json)).toBeLessThan(300);
    const ws = await send(admin, 'post', '/api/v1/workspaces', {
      name: unique('AXI-2008 WS'),
      description: 'AXI-2008 runnability E2E fixture',
      type: 'internal',
      ownerOrganizationId: org.json.id,
    });
    expect(ws.status, JSON.stringify(ws.json)).toBeLessThan(300);
    workspaceId = ws.json.id;
  });

  test.afterAll(async () => {
    for (const id of ruleIds) await send(admin, 'delete', `/api/v1/rules/${id}`);
    await admin?.dispose();
  });

  test('AC6: a Feature rule and an Interpretation rule report runnable with their own run kind @SI-002 @SI-017', async () => {
    const feature = await createRule('feature', 'FEATURE_RULE');
    const interpret = await createRule('interpret', 'INTERPRET_RULE');

    expect(await runnabilityOf(feature)).toEqual({
      runnable: true,
      runnabilityReasonCode: null,
      runKind: 'FEATURE',
      operationId: null,
    });
    expect(await runnabilityOf(interpret)).toEqual({
      runnable: true,
      runnabilityReasonCode: null,
      runKind: 'INTERPRET',
      operationId: null,
    });
  });

  test('AC6: a Decision rule stays declarative — no_executor @SI-002', async () => {
    const decision = await createRule('decision', 'DECISION_RULE');

    expect(await runnabilityOf(decision)).toMatchObject({
      runnable: false,
      runnabilityReasonCode: 'no_executor',
      runKind: null,
    });
  });

  test('AC6 / EC7: carrier and family Feature rules keep their executor, never FEATURE @SI-002 @SI-017', async () => {
    const carrier = await createRule('carrier', 'FEATURE_RULE', ['op:describe.count']);
    const family = await createRule('family', 'FEATURE_RULE', ['relationship-rule']);

    expect(await runnabilityOf(carrier)).toMatchObject({
      runnable: true,
      runKind: 'DESCRIBE',
      operationId: 'describe.count',
    });
    expect(await runnabilityOf(family)).toMatchObject({ runnable: true, runKind: 'DELTA', operationId: null });
  });

  test('AC6 / C3: a connector-less Summary rule and a tagless Stratify rule still have no executor @SI-002', async () => {
    for (const [label, protocolType] of [
      ['summary', 'SUMMARY_RULE'],
      ['stratify', 'STRATIFY_RULE'],
    ] as const) {
      const id = await createRule(label, protocolType);
      expect({ label, ...(await runnabilityOf(id)) }).toMatchObject({
        label,
        runnable: false,
        runnabilityReasonCode: 'no_executor',
      });
    }
  });

  test('AC12 / FR21: a FEATURE or INTERPRET submission is refused by name, naming the story that owes its executor @SI-017', async () => {
    for (const [label, runKind, story] of [
      ['feature', 'FEATURE', 'AXI-2012'],
      ['interpret', 'INTERPRET', 'AXI-2015'],
    ] as const) {
      const ruleId = byLabel.get(label);
      expect(ruleId, `scenario 1 must have created the ${label} rule`).toBeTruthy();
      const res = await send(admin, 'post', '/api/v1/rule-runs', { ruleId, runKind, workspaceId });
      expect(res.status, JSON.stringify(res.json)).toBe(400);
      expect(String(res.json?.message ?? ''), JSON.stringify(res.json)).toMatch(
        new RegExp(`RuleRunKind\\.${runKind} has no executor yet \\(${story}\\)`),
      );
    }

    // No run row was written for either rule.
    const runs = await send(admin, 'get', `/api/v1/rule-runs?workspaceId=${workspaceId}`);
    expect(runs.status, JSON.stringify(runs.json)).toBe(200);
    const rows: any[] = runs.json.data ?? runs.json.items ?? runs.json ?? [];
    expect(rows.filter((r) => r.ruleId === byLabel.get('feature') || r.ruleId === byLabel.get('interpret'))).toEqual([]);
  });

  test('EC9: a runnable but unserved (draft) Feature rule is not offered @SI-002 @SI-017', async () => {
    const featureId = byLabel.get('feature');
    const res = await send(admin, 'get', `/api/v1/rule-runs/offered-rules?workspaceId=${workspaceId}`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const idOf = (entry: any) => entry?.id ?? entry?.rule?.id ?? entry?.ruleId;
    expect((res.json.offered ?? []).map(idOf)).not.toContain(featureId);
    expect((res.json.notAvailable ?? []).map(idOf)).not.toContain(featureId);
  });
});
