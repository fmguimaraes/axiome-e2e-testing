import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureDefaultAnalysis, ingestFixture, pollRunTerminal, type Tenant } from '../AXI-1474/harness/seed';
import {
  COMPLETE_GUIDANCE,
  deleteFixtureRules,
  inReviewRule,
  send as fixtureSend,
  trackFixtureRule,
  type RuleResponse,
  ReviewWorld,
} from '../AXI-1762/AXI-1765-rule-review-fixtures';
import { ingestCsv, queryDataset, runsOf, snapshotsOf } from './harness/feature-run';

/**
 * AXI-2012 (epic AXI-2006 — FR6, FR7, FR10, FR11, FR16, FR21, AC1, AC9, AC14, EC5;
 * SI-017, SI-016, SI-018) and AXI-2011's run-time preconditions (FR13, AC3, AC11,
 * EC1, EC2), which AXI-2012 made reachable: a ROW-scope Feature run executes,
 * materializes a `rule_derived` snapshot carrying exactly the declared output
 * columns, dedupes on an identical fingerprint, and refuses by reason code.
 *
 * Scenario doc: manual-e2e/AXI-2006-Reasoning-Branch-Executors.md "AXI-2011" and
 * "AXI-2012".
 *
 * The fixture rules are published SYSTEM `FEATURE_RULE`s with NO `op:` tag, so they
 * run under the role executor (`runKind: FEATURE`, `operationId: null`). The
 * dataset is the AXI-1474 `qc_sample.csv` (`row_id, biomarker_x, biomarker_y, arm,
 * response`; `biomarker_x` roughly 2.0..3.5) plus this directory's
 * `feature_collision.csv`, which already carries `bx_level_category`.
 *
 * Self-contained: a throwaway organization + workspace + projects per run. Bindings
 * are append-only by design and stay in the throwaway projects.
 *
 * AUTHORED, NOT RUN: no stack serves this story's axiome-back branch (the shared
 * demo stack serves `main`, and its database must not be migrated from a worktree).
 * Do not report `e2e-pass` until it has run green against a stack carrying the
 * AXI-2008..AXI-2012 migrations and the AXI-2012 executor.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const TARGET = {
  entity: 'Biomarker X',
  measure: 'concentration',
  unit: 'g/L',
  context: { assay: 'nephelometry', matrix: 'serum', population: 'adult' },
};

const CUT_POINT = 2.5;

function categorical(outputName: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outputScope: 'row',
    outputName,
    bindingTarget: TARGET,
    output: {
      shape: 'categorical',
      cutoff: {
        kind: 'numeric',
        groups: [
          { id: 'high', min: CUT_POINT, min_inclusive: false },
          { id: 'normal', max: CUT_POINT, max_inclusive: true },
        ],
      },
    },
    ...over,
  };
}

function categoricalOutputFields(outputName: string) {
  return [
    { key: `${outputName}_category`, type: 'string', description: 'Category label assigned by the cutoff' },
    { key: `${outputName}_status`, type: 'string', description: 'applied | not_applicable | unit_mismatch | missing' },
  ];
}

function refusalText(body: any): string {
  const message = body?.message ?? body?.error ?? body?._raw ?? '';
  return Array.isArray(message) ? message.join(' ') : String(message);
}

function isBlank(cell: unknown): boolean {
  return cell === null || cell === undefined || String(cell).trim() === '';
}

test.describe.serial('AXI-2012 — row-scope Feature run, snapshot and dedup; AXI-2011 run preconditions', () => {
  let world: ReviewWorld;
  let api: Api;
  let tenant: Tenant;
  let project: string;
  let unboundProject: string;
  let collisionProject: string;
  let analysisId: string;
  let datasetId: string;
  let collisionDatasetId: string;
  let rule: RuleResponse;
  let nodeRule: RuleResponse;
  let undeclared: RuleResponse;
  let numericRule: RuleResponse;
  let unitRule: RuleResponse;
  let carrier: RuleResponse;
  let firstRun: any;
  let firstSnapshot: any;

  function bind(projectId: string, ruleId: string, variable: string, rationale: string) {
    return api.post(
      `/api/v1/workspaces/${tenant.workspaceId}/projects/${projectId}/feature-rule-bindings`,
      { ruleId, variable, rationale },
      tenant.headers,
    );
  }

  async function bindOrFail(projectId: string, ruleId: string, variable: string): Promise<string> {
    const res = await bind(projectId, ruleId, variable, `AXI-2012 e2e: ${variable} is the bound variable here.`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
  }

  function featureRun(ruleId: string, projectId = project, dataset = datasetId) {
    return { ruleId, runKind: 'FEATURE', projectId, workspaceId: tenant.workspaceId, datasetId: dataset };
  }

  function submit(ruleId: string, projectId = project, dataset = datasetId) {
    return api.post('/api/v1/rule-runs', featureRun(ruleId, projectId, dataset), tenant.headers);
  }

  async function runsFor(ruleId: string, projectId = project): Promise<any[]> {
    return (await runsOf(api, tenant, projectId)).filter((r) => r.ruleId === ruleId);
  }

  async function approve(id: string): Promise<RuleResponse> {
    const before = (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
    const res = await world.admin.post(apiUrl(`/api/v1/rules/${id}/approve`), {
      data: { note: 'AXI-2012 e2e fixture', expectedContentHash: before.review?.contentHash },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
  }

  /** A published tagless system Feature rule with a CATEGORICAL declaration (its own output fields). */
  async function publishedCategorical(label: string, declaration: Record<string, unknown>): Promise<RuleResponse> {
    const created = await fixtureSend(world.admin, 'post', '/api/v1/rules', {
      code: unique(`AXI-2012-${label}`).toUpperCase().slice(0, 60),
      title: `AXI-2012 feature fixture ${label}`,
      category: 'phenotype_detection',
      protocolType: 'FEATURE_RULE',
      signals: ['marker:biomarker_x'],
      scope: 'system',
      featureDeclaration: declaration,
    });
    trackFixtureRule(created.id);
    const outputName = String(declaration.outputName);
    const checked = await fixtureSend(world.admin, 'patch', `/api/v1/rules/${created.id}`, {
      outputFields: categoricalOutputFields(outputName),
      guidance: COMPLETE_GUIDANCE,
    });
    expect(checked.status, 'fixture rule must pass the FR9 gate').toBe('checked');
    const submitted = await fixtureSend(world.admin, 'post', `/api/v1/rules/${created.id}/submit-for-review`);
    expect(submitted.status).toBe('in_review');
    return approve(created.id);
  }

  async function project_(label: string): Promise<string> {
    const res = await api.post(
      '/api/v1/projects',
      { name: unique(`AXI-2012 ${label}`), workspaceId: tenant.workspaceId },
      tenant.headers,
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body.id;
  }

  test.beforeAll(async () => {
    world = await ReviewWorld.create();
    api = await adminApi();
    await world.grant(world.adminUserId, await world.role('AXI-2012 publisher', ['rule:read', 'rule:publish']));

    const org = await api.post('/api/v1/organizations', { name: unique('AXI-2012 Org'), type: 'biotech' });
    expect(org.status, JSON.stringify(org.body)).toBeLessThan(300);
    const ws = await api.post('/api/v1/workspaces', {
      name: unique('AXI-2012 WS'),
      description: 'AXI-2012 Feature executor E2E fixture',
      type: 'internal',
      ownerOrganizationId: org.body.id,
    });
    expect(ws.status, JSON.stringify(ws.body)).toBeLessThan(300);
    tenant = { orgId: org.body.id, workspaceId: ws.body.id, headers: { 'X-Workspace-Id': ws.body.id } };

    project = await project_('Project');
    unboundProject = await project_('Unbound project');
    collisionProject = await project_('Collision project');
    datasetId = await ingestFixture(api, tenant);
    analysisId = await ensureDefaultAnalysis(api, tenant, project, datasetId);
    await ensureDefaultAnalysis(api, tenant, unboundProject, datasetId);
    collisionDatasetId = await ingestCsv(api, tenant, 'feature_collision.csv');
    await ensureDefaultAnalysis(api, tenant, collisionProject, collisionDatasetId);

    rule = await publishedCategorical('row', categorical('bx_level'));
    nodeRule = await publishedCategorical('node', categorical('bx_node', { outputScope: 'node' }));
    unitRule = await publishedCategorical('unit', categorical('bx_unit'));
    undeclared = await approve((await inReviewRule(world.admin, { scope: 'system' }, {
      code: unique('AXI-2012-undeclared').toUpperCase().slice(0, 60),
      title: 'AXI-2012 undeclared Feature fixture',
    })).id);
    numericRule = await approve((await inReviewRule(world.admin, { scope: 'system' }, {
      code: unique('AXI-2012-numeric').toUpperCase().slice(0, 60),
      title: 'AXI-2012 numeric-shape Feature fixture (no op: tag)',
      featureDeclaration: { outputScope: 'row', outputName: 'bx_ratio', bindingTarget: TARGET, output: { shape: 'numeric' } },
    })).id);
    carrier = await approve((await inReviewRule(world.admin, { scope: 'system' }, {
      code: unique('AXI-2012-carrier').toUpperCase().slice(0, 60),
      title: 'AXI-2012 declared carrier fixture',
      tags: ['op:describe.count'],
      featureDeclaration: { outputScope: 'row', outputName: 'carrier_x', bindingTarget: TARGET, output: { shape: 'numeric' } },
    })).id);
  });

  test.afterAll(async () => {
    if (world) await deleteFixtureRules(world.admin);
    await api?.ctx.dispose();
    await world?.dispose();
  });

  // ── AXI-2012 ────────────────────────────────────────────────────────────────

  test('FR6 FR21 (Scenario 1): a tagless Feature rule runs under FEATURE and, once bound, is offered @SI-017 @SI-016', async () => {
    const read = (await fixtureSend(world.admin, 'get', `/api/v1/rules/${rule.id}`)) as any;
    expect({ runnable: read.runnable, runKind: read.runKind, operationId: read.operationId ?? null }).toEqual({
      runnable: true,
      runKind: 'FEATURE',
      operationId: null,
    });

    await bindOrFail(project, rule.id, 'biomarker_x');
    const offering = await api.get(
      `/api/v1/rule-runs/offered-rules?workspaceId=${tenant.workspaceId}&projectId=${project}&datasetId=${datasetId}`,
      tenant.headers,
    );
    expect(offering.status, JSON.stringify(offering.body)).toBe(200);
    expect(offering.body.offered.map((r: any) => r.id), JSON.stringify(offering.body.notAvailable)).toContain(rule.id);
  });

  test('AC1 FR6 FR7 FR10 (Scenario 2): a bound row-scope run writes a rule_derived snapshot with exactly the two declared columns, input untouched @SI-017 @SI-016 @SI-018', async () => {
    const input = await queryDataset(api, tenant, datasetId);

    const res = await submit(rule.id);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    firstRun = await pollRunTerminal(api, tenant, res.body.ruleRunId);
    expect(firstRun.status, JSON.stringify(firstRun)).toBe('SUCCEEDED');
    expect(firstRun.runKind).toBe('FEATURE');

    const derived = (await snapshotsOf(api, tenant, analysisId)).filter(
      (s) => s.origin === 'rule_derived' && s.ruleRunId === firstRun.id,
    );
    expect(derived, 'exactly one rule_derived snapshot for the run').toHaveLength(1);
    firstSnapshot = derived[0];
    expect(firstSnapshot.parentSnapshotId, 'the result parents to the container baseline').toBeTruthy();
    expect(firstSnapshot.derivedColumns).toEqual(['bx_level_category', 'bx_level_status']);

    const output = await queryDataset(api, tenant, firstSnapshot.datasetId);
    expect(output.columns).toEqual([...input.columns, 'bx_level_category', 'bx_level_status']);
    expect(output.rows).toHaveLength(input.rows.length);
    output.rows.forEach((row, i) => {
      for (const column of input.columns) expect(row[column], `row ${i} ${column}`).toEqual(input.rows[i][column]);
      const x = input.rows[i].biomarker_x;
      if (isBlank(x)) {
        expect([row.bx_level_status, row.bx_level_category ?? null]).toEqual(['missing', null]);
      } else {
        expect(row.bx_level_status, `row ${i}`).toBe('applied');
        expect(row.bx_level_category, `row ${i} (x=${x})`).toBe(Number(x) > CUT_POINT ? 'high' : 'normal');
      }
    });

    const unchanged = await queryDataset(api, tenant, datasetId);
    expect(unchanged).toEqual(input);
  });

  test('AC9 FR11 (Scenario 3): an identical resubmission dedupes onto the first run; no second evaluation @SI-017 @SI-016', async () => {
    const res = await submit(rule.id);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const second = await pollRunTerminal(api, tenant, res.body.ruleRunId);
    expect(second.status, JSON.stringify(second)).toBe('DEDUPED');
    expect(second.dedupedFromRunId).toBe(firstRun.id);

    const evaluated = (await snapshotsOf(api, tenant, analysisId)).filter(
      (s) => s.origin === 'rule_derived' && s.ruleRunId === firstRun.id,
    );
    expect(evaluated, 'the evaluated result still exists exactly once').toHaveLength(1);
  });

  test('FR10 FR11 (Scenario 4): a re-binding is a new identity — the next run evaluates, it does not dedupe @SI-017 @SI-016', async () => {
    await bindOrFail(project, rule.id, 'biomarker_y');

    const res = await submit(rule.id);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const rerun = await pollRunTerminal(api, tenant, res.body.ruleRunId);
    expect(rerun.status, JSON.stringify(rerun)).toBe('SUCCEEDED');
    expect(rerun.id).not.toBe(firstRun.id);
  });

  test('FR21 (Scenario 5): a node-scope rule is refused not_submittable naming AXI-2013; no run row @SI-017', async () => {
    await bindOrFail(project, nodeRule.id, 'biomarker_x');

    const res = await submit(nodeRule.id);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalText(res.body)).toContain('not_submittable');
    expect(refusalText(res.body)).toContain('AXI-2013');
    expect(await runsFor(nodeRule.id)).toEqual([]);

    const offering = await api.get(
      `/api/v1/rule-runs/offered-rules?workspaceId=${tenant.workspaceId}&projectId=${project}`,
      tenant.headers,
    );
    const entry = offering.body.notAvailable.find((e: any) => e.rule.id === nodeRule.id);
    expect(entry?.reasonCode, JSON.stringify(offering.body.notAvailable)).toBe('not_submittable');
  });

  test('FR21 (Scenario 6): a Feature rule with no declaration has nothing to evaluate — refused, no run row @SI-017', async () => {
    const res = await submit(undeclared.id);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalText(res.body)).toContain('not_submittable');
    expect(refusalText(res.body)).toContain('declares no Feature output');
    expect(await runsFor(undeclared.id)).toEqual([]);
  });

  test('FR6 FR21 (Scenario 6b): a tagless NUMERIC-shape rule is refused not_submittable — numeric output is an op: carrier\'s computation; no run row @SI-017', async () => {
    await bindOrFail(project, numericRule.id, 'biomarker_x');

    const res = await submit(numericRule.id);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalText(res.body)).toContain('not_submittable');
    expect(refusalText(res.body)).toContain('computed by an op: carrier');
    expect(await runsFor(numericRule.id)).toEqual([]);
  });

  test('FR13 (Scenario 7): preflight returns the same refusal as a typed BLOCK @SI-017', async () => {
    const res = await api.post('/api/v1/rule-runs/preflight', featureRun(rule.id, unboundProject), tenant.headers);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.blocks.map((b: any) => b.id)).toEqual(['binding_missing']);
  });

  test('FR21 ruling (e) (Scenario 8): a declared op: carrier never opens a FEATURE run, and is gated on its binding @SI-017 @SI-016', async () => {
    const read = (await fixtureSend(world.admin, 'get', `/api/v1/rules/${carrier.id}`)) as any;
    expect({ runKind: read.runKind, operationId: read.operationId }).toEqual({
      runKind: 'DESCRIBE',
      operationId: 'describe.count',
    });

    const asFeature = await submit(carrier.id);
    expect(asFeature.status, JSON.stringify(asFeature.body)).toBe(400);
    expect(await runsFor(carrier.id)).toEqual([]);

    const offering = await api.get(
      `/api/v1/rule-runs/offered-rules?workspaceId=${tenant.workspaceId}&projectId=${unboundProject}`,
      tenant.headers,
    );
    const entry = offering.body.notAvailable.find((e: any) => e.rule.id === carrier.id);
    expect(entry?.reasonCode, JSON.stringify(offering.body.notAvailable)).toBe('binding_missing');
  });

  test('AC14 FR16 (Scenario 9): the row-scope outputs read back through the generic dataset query like any column @SI-018', async () => {
    const output = await queryDataset(api, tenant, firstSnapshot.datasetId);
    const categories = new Set(output.rows.map((r) => r.bx_level_category).filter((c) => c !== null && c !== undefined));
    expect([...categories].sort()).toEqual(['high', 'normal']);
  });

  // ── AXI-2011 (made reachable by AXI-2012) ──────────────────────────────────

  test('AC3 FR13 (AXI-2011 Scenario 1): an unbound declared rule is blocked binding_missing and nothing is written @SI-017 @SI-016', async () => {
    const res = await submit(rule.id, unboundProject);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalText(res.body)).toContain('binding_missing');
    expect(await runsFor(rule.id, unboundProject)).toEqual([]);
  });

  test('AC3 (AXI-2011 Scenario 2): a binding recorded before the served unit changed is blocked unit_mismatch, nothing written @SI-017 @SI-016', async () => {
    await bindOrFail(project, unitRule.id, 'biomarker_x');

    const forked = await fixtureSend(world.admin, 'patch', `/api/v1/rules/${unitRule.id}`, {
      featureDeclaration: categorical('bx_unit', { bindingTarget: { ...TARGET, unit: 'mg/dL' } }),
    });
    expect(['draft', 'checked']).toContain(forked.status);
    if (forked.status !== 'checked') {
      await fixtureSend(world.admin, 'patch', `/api/v1/rules/${unitRule.id}`, {
        outputFields: categoricalOutputFields('bx_unit'),
        guidance: COMPLETE_GUIDANCE,
      });
    }
    await fixtureSend(world.admin, 'post', `/api/v1/rules/${unitRule.id}/submit-for-review`);
    unitRule = await approve(unitRule.id);

    const res = await submit(unitRule.id);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalText(res.body)).toContain('unit_mismatch');
    expect(await runsFor(unitRule.id)).toEqual([]);
  });

  test('AC11 EC1 (AXI-2011 Scenario 3): a referent already carrying <name>_category is refused output_collision; nothing written @SI-017 @SI-016', async () => {
    await bindOrFail(collisionProject, rule.id, 'biomarker_x');
    const before = await queryDataset(api, tenant, collisionDatasetId);

    const res = await submit(rule.id, collisionProject, collisionDatasetId);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalText(res.body)).toContain('output_collision');
    expect(refusalText(res.body)).toContain('bx_level_category');
    expect(await runsFor(rule.id, collisionProject)).toEqual([]);
    expect(await queryDataset(api, tenant, collisionDatasetId)).toEqual(before);
  });

  test('FR13 EC2 (AXI-2011 Scenario 4): re-bound to a variable the referent lacks — binding_missing naming it; existing snapshots stand @SI-017 @SI-016', async () => {
    const lost = await bind(project, rule.id, 'serum_bx_g_l', 'The next export renames the column; this one lacks it.');
    expect(lost.status, JSON.stringify(lost.body)).toBe(201);

    const res = await submit(rule.id);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(refusalText(res.body)).toContain('binding_missing');
    expect(refusalText(res.body)).toContain('serum_bx_g_l');

    const derived = (await snapshotsOf(api, tenant, analysisId)).find((s) => s.id === firstSnapshot.id);
    expect(derived, 'the earlier result snapshot is untouched').toBeTruthy();
  });

  // Last: the rule is deprecated, so nothing after this may submit it.
  test('FR7 EC5 (Scenario 10): deprecating the rule after a run leaves its snapshot and result table standing @SI-017 @SI-018', async () => {
    const deprecated = await world.admin.post(apiUrl(`/api/v1/rules/${rule.id}/deprecate`));
    expect(deprecated.status(), await deprecated.text()).toBeLessThan(300);

    const derived = (await snapshotsOf(api, tenant, analysisId)).find((s) => s.id === firstSnapshot.id);
    expect(derived?.derivedColumns).toEqual(['bx_level_category', 'bx_level_status']);
    const output = await queryDataset(api, tenant, firstSnapshot.datasetId);
    expect(output.columns).toContain('bx_level_category');
  });
});
