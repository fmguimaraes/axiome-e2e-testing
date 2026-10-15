import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureDefaultAnalysis, pollRunTerminal, type Tenant } from '../AXI-1474/harness/seed';
import {
  COMPLETE_GUIDANCE,
  deleteFixtureRules,
  send as fixtureSend,
  trackFixtureRule,
  type RuleResponse,
  ReviewWorld,
} from '../AXI-1762/AXI-1765-rule-review-fixtures';
import { ingestCsv, snapshotsOf } from './harness/feature-run';

/**
 * AXI-2013 (epic AXI-2006 — FR8, FR9, FR10, FR11, FR12, FR21, AC2, AC13, EC3;
 * SI-016, SI-017): a NODE-scope Feature run executes, writes typed, stamped,
 * append-only attributes on its referent snapshot's provenance node (no table, no
 * snapshot), and downstream nodes inherit them along DERIVED_FROM.
 *
 * Scenario doc: manual-e2e/AXI-2006-Reasoning-Branch-Executors.md "AXI-2013".
 *
 * The fixture rule is a published SYSTEM `FEATURE_RULE` with NO `op:` tag and a
 * node-scope categorical declaration (`igg4_node`, cut-point 2.5). The dataset is
 * this directory's `feature_node.csv`: `serum_igg4` is 2.8 on every row but one
 * blank, `igg4_by_arm` is 3.0 on arm A and 1.2 on arm B, `biomarker_x` differs per
 * row, and `empty_igg4` is blank everywhere.
 *
 * Self-contained: a throwaway organization + workspace + projects per run.
 * Bindings and attributes are append-only by design and stay in those projects.
 *
 * AUTHORED, NOT RUN: no stack serves this story's axiome-back branch (the shared
 * demo stack serves `main`, and its database must not be migrated from a
 * worktree). Do not report `e2e-pass` until it has run green against a stack
 * carrying the AXI-2008..AXI-2013 migrations.
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
const OUTPUT = 'igg4_node';
const CATEGORY = `${OUTPUT}_category`;
const STATUS = `${OUTPUT}_status`;

const NODE_DECLARATION = {
  outputScope: 'node',
  outputName: OUTPUT,
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
};

interface AttributeRecord {
  id: string;
  provenanceNodeId: string;
  attributeKey: string;
  valueType: string;
  value: unknown;
  ruleId: string;
  ruleVersionId: string;
  ruleCode: string;
  ruleVersion: number;
  ruleRunId: string;
  reusedFromRunId: string | null;
  inputFingerprint: string;
}

interface AttributeView {
  effective: Array<{ key: string; origin: 'own' | 'inherited'; record: AttributeRecord }>;
  conflicts: Array<{ key: string; candidates: AttributeRecord[] }>;
  history: AttributeRecord[];
}

test.describe.serial('AXI-2013 — node-scope Feature run, node attributes and inheritance', () => {
  let world: ReviewWorld;
  let api: Api;
  let tenant: Tenant;
  let project: string;
  let disagreeProject: string;
  let missingProject: string;
  let analysisId: string;
  let datasetId: string;
  let rule: RuleResponse;
  let firstRun: any;
  let baselineSnapshotId: string;
  let childSnapshotId: string;

  function bind(projectId: string, variable: string) {
    return api.post(
      `/api/v1/workspaces/${tenant.workspaceId}/projects/${projectId}/feature-rule-bindings`,
      { ruleId: rule.id, variable, rationale: `AXI-2013 e2e: ${variable} is the bound variable here.` },
      tenant.headers,
    );
  }

  async function bindOrFail(projectId: string, variable: string): Promise<void> {
    const res = await bind(projectId, variable);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  function featureRun(projectId = project, snapshotId?: string) {
    return {
      ruleId: rule.id,
      runKind: 'FEATURE',
      projectId,
      workspaceId: tenant.workspaceId,
      datasetId,
      ...(snapshotId ? { snapshotId } : {}),
    };
  }

  async function runToTerminal(projectId = project, snapshotId?: string): Promise<any> {
    const res = await api.post('/api/v1/rule-runs', featureRun(projectId, snapshotId), tenant.headers);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return pollRunTerminal(api, tenant, res.body.ruleRunId);
  }

  async function graph(viewAnalysisId = analysisId): Promise<any> {
    const res = await api.get(`/api/v1/view-analyses/${viewAnalysisId}/provenance-graph`, tenant.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  /** The attribute view of one snapshot's provenance node (absent = nothing own or inherited). */
  async function attributesOfSnapshot(snapshotId: string, viewAnalysisId = analysisId): Promise<AttributeView | undefined> {
    const g = await graph(viewAnalysisId);
    const node = g.nodes.find((n: any) => n.nodeType === 'ViewAnalysisSnapshot' && n.referenceId === snapshotId);
    expect(node, `snapshot ${snapshotId} has a provenance node in the analysis graph`).toBeTruthy();
    return node.attributes;
  }

  function effective(view: AttributeView | undefined, key: string) {
    return view?.effective.find((e) => e.key === key);
  }

  /** Every attribute record anywhere in an analysis graph. */
  async function allRecords(viewAnalysisId = analysisId): Promise<AttributeRecord[]> {
    const g = await graph(viewAnalysisId);
    const seen = new Map<string, AttributeRecord>();
    for (const node of g.nodes) for (const r of (node.attributes?.history ?? []) as AttributeRecord[]) seen.set(r.id, r);
    return [...seen.values()];
  }

  async function childOf(parentSnapshotId: string, filters: unknown[]): Promise<string> {
    const res = await api.post(
      '/api/v1/view-analyses/snapshots',
      { viewAnalysisId: analysisId, datasetId, parentSnapshotId, origin: 'filter', filters },
      tenant.headers,
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(res.body.parentSnapshotId).toBe(parentSnapshotId);
    return res.body.id;
  }

  async function approve(id: string): Promise<RuleResponse> {
    const before = (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
    const res = await world.admin.post(apiUrl(`/api/v1/rules/${id}/approve`), {
      data: { note: 'AXI-2013 e2e fixture', expectedContentHash: before.review?.contentHash },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
  }

  async function project_(label: string): Promise<string> {
    const res = await api.post(
      '/api/v1/projects',
      { name: unique(`AXI-2013 ${label}`), workspaceId: tenant.workspaceId },
      tenant.headers,
    );
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body.id;
  }

  test.beforeAll(async () => {
    world = await ReviewWorld.create();
    api = await adminApi();
    await world.grant(world.adminUserId, await world.role('AXI-2013 publisher', ['rule:read', 'rule:publish']));

    const org = await api.post('/api/v1/organizations', { name: unique('AXI-2013 Org'), type: 'biotech' });
    expect(org.status, JSON.stringify(org.body)).toBeLessThan(300);
    const ws = await api.post('/api/v1/workspaces', {
      name: unique('AXI-2013 WS'),
      description: 'AXI-2013 node attributes E2E fixture',
      type: 'internal',
      ownerOrganizationId: org.body.id,
    });
    expect(ws.status, JSON.stringify(ws.body)).toBeLessThan(300);
    tenant = { orgId: org.body.id, workspaceId: ws.body.id, headers: { 'X-Workspace-Id': ws.body.id } };

    project = await project_('Project');
    disagreeProject = await project_('Disagreeing rows');
    missingProject = await project_('Missing value');
    datasetId = await ingestCsv(api, tenant, 'feature_node.csv');
    analysisId = await ensureDefaultAnalysis(api, tenant, project, datasetId);
    await ensureDefaultAnalysis(api, tenant, disagreeProject, datasetId);
    await ensureDefaultAnalysis(api, tenant, missingProject, datasetId);

    const created = await fixtureSend(world.admin, 'post', '/api/v1/rules', {
      code: unique('AXI-2013-node').toUpperCase().slice(0, 60),
      title: 'AXI-2013 node-scope feature fixture',
      category: 'phenotype_detection',
      protocolType: 'FEATURE_RULE',
      signals: ['marker:serum_igg4'],
      scope: 'system',
      featureDeclaration: NODE_DECLARATION,
    });
    trackFixtureRule(created.id);
    const checked = await fixtureSend(world.admin, 'patch', `/api/v1/rules/${created.id}`, {
      outputFields: [
        { key: CATEGORY, type: 'string', description: 'Category label assigned by the cutoff' },
        { key: STATUS, type: 'string', description: 'applied | not_applicable | unit_mismatch | missing' },
      ],
      guidance: COMPLETE_GUIDANCE,
    });
    expect(checked.status, 'fixture rule must pass the FR9 gate').toBe('checked');
    const submitted = await fixtureSend(world.admin, 'post', `/api/v1/rules/${created.id}/submit-for-review`);
    expect(submitted.status).toBe('in_review');
    rule = await approve(created.id);
  });

  test.afterAll(async () => {
    if (world) await deleteFixtureRules(world.admin);
    await api?.ctx.dispose();
    await world?.dispose();
  });

  test('FR21 P8 (Scenario 1): a bound node-scope rule is offered and preflights clean — no longer owed @SI-017 @SI-016', async () => {
    await bindOrFail(project, 'serum_igg4');

    const offering = await api.get(
      `/api/v1/rule-runs/offered-rules?workspaceId=${tenant.workspaceId}&projectId=${project}&datasetId=${datasetId}`,
      tenant.headers,
    );
    expect(offering.status, JSON.stringify(offering.body)).toBe(200);
    expect(offering.body.offered.map((r: any) => r.id), JSON.stringify(offering.body.notAvailable)).toContain(rule.id);

    const preflight = await api.post('/api/v1/rule-runs/preflight', featureRun(), tenant.headers);
    expect(preflight.status, JSON.stringify(preflight.body)).toBeLessThan(300);
    expect(preflight.body.blocks ?? []).toEqual([]);
  });

  test('AC2 FR8 FR10 (Scenario 2): the run writes typed, stamped attributes on the referent node and no snapshot @SI-016 @SI-017', async () => {
    firstRun = await runToTerminal();
    expect(firstRun.status, JSON.stringify(firstRun)).toBe('SUCCEEDED');
    expect(firstRun.runKind).toBe('FEATURE');
    baselineSnapshotId = firstRun.snapshotId;
    expect(baselineSnapshotId, 'the run names its referent snapshot').toBeTruthy();

    const view = await attributesOfSnapshot(baselineSnapshotId);
    const category = effective(view, CATEGORY);
    const status = effective(view, STATUS);
    expect(category?.origin).toBe('own');
    expect(category?.record.value).toBe('high');
    expect(status?.record.value).toBe('applied');
    for (const entry of [category!, status!]) {
      expect(entry.record).toMatchObject({
        valueType: 'string',
        ruleId: rule.id,
        ruleRunId: firstRun.id,
        reusedFromRunId: null,
      });
      expect(entry.record.ruleVersionId).toBeTruthy();
      expect(entry.record.ruleVersion).toBeGreaterThanOrEqual(1);
      expect(entry.record.inputFingerprint).toBeTruthy();
    }
    expect(view?.conflicts).toEqual([]);

    const derived = (await snapshotsOf(api, tenant, analysisId)).filter((s) => s.ruleRunId === firstRun.id);
    expect(derived, 'a node-scope run materializes no snapshot').toEqual([]);
  });

  test('AC2 FR8 (Scenario 3): a filtered child inherits the value without a copy @SI-016', async () => {
    childSnapshotId = await childOf(baselineSnapshotId, [{ column: 'igg4_by_arm', operator: 'lt', value: 2.0 }]);

    const view = await attributesOfSnapshot(childSnapshotId);
    const category = effective(view, CATEGORY);
    expect(category?.origin).toBe('inherited');
    expect(category?.record.value).toBe('high');
    expect(category?.record.ruleRunId).toBe(firstRun.id);
    expect(view?.history, 'nothing is copied onto the child').toEqual([]);
  });

  test('FR11 EC3 (Scenario 4): an identical resubmission dedupes and records the reuse, append-only @SI-016 @SI-017', async () => {
    const deduped = await runToTerminal();
    expect(deduped.status, JSON.stringify(deduped)).toBe('DEDUPED');
    expect(deduped.dedupedFromRunId).toBe(firstRun.id);

    const records = await allRecords();
    const reuse = records.filter((r) => r.ruleRunId === deduped.id);
    expect(reuse.map((r) => r.attributeKey).sort()).toEqual([CATEGORY, STATUS]);
    for (const r of reuse) expect(r.reusedFromRunId).toBe(firstRun.id);
    expect(reuse.find((r) => r.attributeKey === CATEGORY)?.value).toBe('high');

    const original = records.filter((r) => r.ruleRunId === firstRun.id);
    expect(original, "the first run's records are still there").toHaveLength(2);
  });

  test('AC13 FR9 (Scenario 5): an overwrite downstream shadows below it only; the baseline keeps its value and history @SI-016 @SI-017', async () => {
    const baselineBefore = await attributesOfSnapshot(baselineSnapshotId);
    await bindOrFail(project, 'igg4_by_arm');

    const overwrite = await runToTerminal(project, childSnapshotId);
    expect(overwrite.status, JSON.stringify(overwrite)).toBe('SUCCEEDED');

    const child = await attributesOfSnapshot(childSnapshotId);
    expect(effective(child, CATEGORY)).toMatchObject({ origin: 'own', record: { value: 'normal', ruleRunId: overwrite.id } });

    const grandchildId = await childOf(childSnapshotId, [{ column: 'biomarker_x', operator: 'lt', value: 3.0 }]);
    const grandchild = await attributesOfSnapshot(grandchildId);
    expect(effective(grandchild, CATEGORY)).toMatchObject({ origin: 'inherited', record: { value: 'normal' } });

    const baselineAfter = await attributesOfSnapshot(baselineSnapshotId);
    expect(effective(baselineAfter, CATEGORY)?.record.value).toBe('high');
    expect(baselineAfter?.history, 'the overwrite edited nothing upstream').toEqual(baselineBefore?.history);
  });

  test('FR8 P10 (Scenario 6): rows that disagree FAIL the run and record nothing @SI-017', async () => {
    await bindOrFail(disagreeProject, 'biomarker_x');

    const run = await runToTerminal(disagreeProject);
    expect(run.status, JSON.stringify(run)).toBe('FAILED');
    expect(`${run.errorMessage ?? ''} ${run.statusMessage ?? ''}`).toMatch(/not a node-level value/);

    const disagreeAnalysis = await ensureDefaultAnalysis(api, tenant, disagreeProject, datasetId);
    const records = await allRecords(disagreeAnalysis);
    expect(records.filter((r) => r.ruleRunId === run.id)).toEqual([]);
  });

  test('FR12 (Scenario 7): a node with no value records `missing` and a null category @SI-016 @SI-017', async () => {
    await bindOrFail(missingProject, 'empty_igg4');

    const run = await runToTerminal(missingProject);
    expect(run.status, JSON.stringify(run)).toBe('SUCCEEDED');

    const missingAnalysis = await ensureDefaultAnalysis(api, tenant, missingProject, datasetId);
    const view = await attributesOfSnapshot(run.snapshotId, missingAnalysis);
    expect(effective(view, STATUS)?.record.value).toBe('missing');
    expect(effective(view, CATEGORY)?.record.value ?? null).toBeNull();
  });
});
