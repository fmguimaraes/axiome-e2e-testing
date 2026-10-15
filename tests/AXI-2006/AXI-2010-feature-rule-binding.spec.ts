import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, asList, type Api } from '../AXI-1400/harness/api';
import { ensureDefaultAnalysis, ingestFixture, type Tenant } from '../AXI-1474/harness/seed';
import {
  deleteFixtureRules,
  inReviewRule,
  send as fixtureSend,
  type Actor,
  type RuleResponse,
  ReviewWorld,
} from '../AXI-1762/AXI-1765-rule-review-fixtures';

/**
 * AXI-2010 (epic AXI-2006 — FR4, AC8, EC2; SI-010, SI-013, SI-016, SI-017):
 * the per-project binding of a Feature rule's abstract `bindingTarget` to a
 * dataset variable, and `binding_missing` on the offering read.
 *
 * Scenario doc: manual-e2e/AXI-2006-Reasoning-Branch-Executors.md "AXI-2010".
 *
 * The fixture rule is a published SYSTEM `FEATURE_RULE` that declares a binding
 * target AND carries an `op:describe.count` tag: role-executor Feature rules are
 * withheld as `not_submittable` until AXI-2012 (AXI-2008 B1), so only a carrier
 * reaches the binding step live today. The step is executor-agnostic
 * (UT-RULES-2010-007..009 prove it for a role-executor rule).
 *
 * Self-contained: a throwaway organization + two workspaces + projects per run;
 * the dataset is the AXI-1474 `qc_sample.csv` fixture
 * (`row_id, biomarker_x, biomarker_y, arm, response`). Bindings are append-only
 * by design and are left in the throwaway projects.
 *
 * AUTHORED, NOT RUN: no stack serves this story's axiome-back branch (the shared
 * demo stack serves `main`, and its database must not be migrated from a
 * worktree). Do not report `e2e-pass` until it has run green against a stack
 * carrying migration `20261015190000_add_feature_rule_bindings`.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const SERUM_TARGET = {
  entity: 'IgG4',
  measure: 'concentration',
  unit: 'g/L',
  context: { assay: 'nephelometry', matrix: 'serum', population: 'adult' },
};

interface Binding {
  id: string;
  projectId: string;
  ruleId: string;
  ruleVersion: number;
  bindingTarget: unknown;
  variable: string;
  rationale: string;
  boundBy: string;
  boundAt: string;
  supersedesId: string | null;
  current?: boolean;
}

interface Offering {
  offered: Array<{ id: string }>;
  notAvailable: Array<{ rule: { id: string }; reasonCode: string; reason: string }>;
}

function refusalText(body: any): string {
  const message = body?.message ?? body?.error ?? body?._raw ?? '';
  return Array.isArray(message) ? message.join(' ') : String(message);
}

test.describe.serial('AXI-2010 — per-project binding of a Feature rule (FR4, AC8, EC2)', () => {
  let world: ReviewWorld;
  let api: Api;
  let adminUserId: string;
  let tenant: Tenant;
  let foreignWorkspaceId: string;
  let projectA: string;
  let projectB: string;
  let foreignProject: string;
  let datasetId: string;
  let declared: RuleResponse;
  let undeclared: RuleResponse;
  let viewer: Actor;
  let first: Binding;
  let second: Binding;

  const bindingsPath = (workspaceId: string, projectId: string) =>
    `/api/v1/workspaces/${workspaceId}/projects/${projectId}/feature-rule-bindings`;

  function bind(projectId: string, body: Record<string, unknown>, workspaceId = tenant.workspaceId) {
    return api.post(bindingsPath(workspaceId, projectId), body, tenant.headers);
  }

  function listBindings(projectId: string) {
    return api.get<{ bindings: Binding[] }>(bindingsPath(tenant.workspaceId, projectId), tenant.headers);
  }

  async function offering(projectId: string, withDataset = false): Promise<Offering> {
    const query = `workspaceId=${tenant.workspaceId}&projectId=${projectId}${withDataset ? `&datasetId=${datasetId}` : ''}`;
    const res = await api.get<Offering>(`/api/v1/rule-runs/offered-rules?${query}`, tenant.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  /** Create → complete → review → approve, as the platform admin holding an assigned rule:publish. */
  async function publishedSystemFeatureRule(label: string, extra: Record<string, unknown>): Promise<RuleResponse> {
    const submitted = await inReviewRule(world.admin, { scope: 'system' }, {
      code: unique(`AXI-2010-${label}`).toUpperCase().slice(0, 60),
      title: `AXI-2010 binding fixture ${label}`,
      tags: ['op:describe.count'],
      ...extra,
    });
    const before = (await fixtureSend(world.admin, 'get', `/api/v1/rules/${submitted.id}`)) as RuleResponse;
    const res = await world.admin.post(apiUrl(`/api/v1/rules/${submitted.id}/approve`), {
      data: { note: 'AXI-2010 e2e fixture', expectedContentHash: before.review?.contentHash },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await fixtureSend(world.admin, 'get', `/api/v1/rules/${submitted.id}`)) as RuleResponse;
  }

  async function workspace(orgId: string, label: string): Promise<string> {
    const res = await api.post('/api/v1/workspaces', {
      name: unique(`AXI-2010 ${label}`),
      description: 'AXI-2010 feature rule binding E2E fixture',
      type: 'internal',
      ownerOrganizationId: orgId,
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body.id;
  }

  async function project(workspaceId: string, label: string): Promise<string> {
    const res = await api.post(
      '/api/v1/projects',
      { name: unique(`AXI-2010 ${label}`), workspaceId },
      { 'X-Workspace-Id': workspaceId },
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body.id;
  }

  test.beforeAll(async () => {
    world = await ReviewWorld.create();
    api = await adminApi();
    adminUserId = world.adminUserId;
    await world.grant(adminUserId, await world.role('AXI-2010 publisher', ['rule:read', 'rule:publish']));

    const org = await api.post('/api/v1/organizations', { name: unique('AXI-2010 Org'), type: 'biotech' });
    expect(org.status, JSON.stringify(org.body)).toBeLessThan(300);
    const workspaceId = await workspace(org.body.id, 'WS');
    tenant = { orgId: org.body.id, workspaceId, headers: { 'X-Workspace-Id': workspaceId } };
    foreignWorkspaceId = await workspace(org.body.id, 'Foreign WS');

    projectA = await project(workspaceId, 'Project A');
    projectB = await project(workspaceId, 'Project B');
    foreignProject = await project(foreignWorkspaceId, 'Foreign project');

    datasetId = await ingestFixture(api, tenant);
    await ensureDefaultAnalysis(api, tenant, projectA, datasetId);

    declared = await publishedSystemFeatureRule('declared', {
      featureDeclaration: {
        outputScope: 'row',
        outputName: 'igg4_level',
        bindingTarget: SERUM_TARGET,
        output: { shape: 'numeric' },
      },
    });
    undeclared = await publishedSystemFeatureRule('undeclared', {});

    // A workspace viewer: membership (reads) but no governs_analysis_parameters.
    viewer = await world.actor('viewer', await world.role('AXI-2010 reader', ['rule:read']));
    const member = await api.post(
      `/api/v1/workspaces/${workspaceId}/members`,
      { userId: viewer.userId, organizationId: tenant.orgId, role: 'viewer' },
      tenant.headers,
    );
    expect(member.status, JSON.stringify(member.body)).toBeLessThan(300);
  });

  test.afterAll(async () => {
    if (world) await deleteFixtureRules(world.admin);
    await api?.ctx.dispose();
    await world?.dispose();
  });

  test('AC8 FR4 (Scenario 1): a reviewer records a binding carrying who, when, rationale and the served target @SI-010 @SI-013 @SI-016', async () => {
    const res = await bind(projectA, {
      ruleId: declared.id,
      variable: 'biomarker_x',
      rationale: 'Serum IgG4 is exported as biomarker_x at this site.',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    first = res.body as Binding;
    expect(first).toMatchObject({
      projectId: projectA,
      ruleId: declared.id,
      ruleVersion: declared.version,
      bindingTarget: SERUM_TARGET,
      variable: 'biomarker_x',
      rationale: 'Serum IgG4 is exported as biomarker_x at this site.',
      boundBy: adminUserId,
      supersedesId: null,
    });
    expect(Number.isNaN(Date.parse(first.boundAt))).toBe(false);
  });

  test('AC8 (Scenario 2): a re-binding appends a superseding record; the earlier one reads back unchanged @SI-010 @SI-016', async () => {
    const res = await bind(projectA, {
      ruleId: declared.id,
      variable: 'biomarker_y',
      rationale: 'The site re-mapped serum IgG4 to biomarker_y.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    second = res.body as Binding;
    expect(second.supersedesId).toBe(first.id);

    const list = await listBindings(projectA);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const mine = list.body.bindings.filter((b) => b.ruleId === declared.id);
    expect(mine.map((b) => [b.id, b.current])).toEqual([
      [second.id, true],
      [first.id, false],
    ]);
    expect(mine[1]).toEqual({ ...first, current: false });
  });

  test('AC8 (Scenario 3): with no binding in a project the rule is not offered and reports binding_missing @SI-017 @SI-016', async () => {
    const unbound = await offering(projectB);
    expect(unbound.offered.map((r) => r.id)).not.toContain(declared.id);
    const entry = unbound.notAvailable.find((e) => e.rule.id === declared.id);
    expect(entry?.reasonCode, JSON.stringify(unbound.notAvailable)).toBe('binding_missing');

    const bound = await offering(projectA);
    expect(bound.offered.map((r) => r.id)).toContain(declared.id);
    expect(bound.notAvailable.map((e) => e.rule.id)).not.toContain(declared.id);
  });

  test('AC8 EC2 (Scenario 4): a bound variable the referent does not carry is binding_missing, naming the variable @SI-017 @SI-016', async () => {
    const present = await offering(projectA, true);
    expect(present.offered.map((r) => r.id), JSON.stringify(present.notAvailable)).toContain(declared.id);

    const dropped = await bind(projectA, {
      ruleId: declared.id,
      variable: 'serum_igg4_g_l',
      rationale: 'Bound to the column the new export will carry; the current one does not.',
    });
    expect(dropped.status, JSON.stringify(dropped.body)).toBe(201);
    expect(dropped.body.supersedesId).toBe(second.id);

    const missing = await offering(projectA, true);
    expect(missing.offered.map((r) => r.id)).not.toContain(declared.id);
    const entry = missing.notAvailable.find((e) => e.rule.id === declared.id);
    expect(entry?.reasonCode, JSON.stringify(missing.notAvailable)).toBe('binding_missing');
    expect(entry?.reason).toContain('serum_igg4_g_l');

    const history = await listBindings(projectA);
    expect(history.body.bindings.filter((b) => b.ruleId === declared.id).map((b) => b.id)).toEqual([
      dropped.body.id,
      second.id,
      first.id,
    ]);
  });

  test('FR4 (Scenario 5): a viewer without governs_analysis_parameters is refused 403 and nothing is recorded; the viewer can read @SI-010', async () => {
    const before = await listBindings(projectA);
    const res = await viewer.api.post(apiUrl(bindingsPath(tenant.workspaceId, projectA)), {
      headers: tenant.headers,
      data: { ruleId: declared.id, variable: 'biomarker_x', rationale: 'Viewer attempt.' },
    });
    expect(res.status(), await res.text()).toBe(403);

    const read = await viewer.api.get(apiUrl(bindingsPath(tenant.workspaceId, projectA)), { headers: tenant.headers });
    expect(read.status(), await read.text()).toBe(200);
    const after = (await read.json()) as { bindings: Binding[] };
    expect(after.bindings.map((b) => b.id)).toEqual(before.body.bindings.map((b) => b.id));
  });

  test('FR4 (Scenario 6): no binding target is 400 FEATURE_BINDING_NOT_REQUIRED, a blank rationale 400, a foreign project 404 @SI-010 @SI-016', async () => {
    const notRequired = await bind(projectA, { ruleId: undeclared.id, variable: 'biomarker_x', rationale: 'No target.' });
    expect(notRequired.status, JSON.stringify(notRequired.body)).toBe(400);
    expect(refusalText(notRequired.body)).toContain('FEATURE_BINDING_NOT_REQUIRED');

    const blank = await bind(projectA, { ruleId: declared.id, variable: 'biomarker_x', rationale: '   ' });
    expect(blank.status, JSON.stringify(blank.body)).toBe(400);

    const foreign = await bind(foreignProject, { ruleId: declared.id, variable: 'biomarker_x', rationale: 'Wrong tenant.' });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);

    const list = await listBindings(projectA);
    expect(list.body.bindings.filter((b) => b.ruleId === undeclared.id)).toEqual([]);
    expect(asList(list.body.bindings).length).toBe(3);
  });
});
