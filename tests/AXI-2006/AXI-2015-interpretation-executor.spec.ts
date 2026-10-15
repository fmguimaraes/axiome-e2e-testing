import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, asList, type Api } from '../AXI-1400/harness/api';
import { ensureDefaultAnalysis, pollRunTerminal, type Tenant } from '../AXI-1474/harness/seed';
import {
  COMPLETE_GUIDANCE,
  deleteFixtureRules,
  send as fixtureSend,
  trackFixtureRule,
  type RuleResponse,
  ReviewWorld,
} from '../AXI-1762/AXI-1765-rule-review-fixtures';
import { ingestCsv, runsOf, snapshotsOf } from './harness/feature-run';

/**
 * AXI-2015 (epic AXI-2006 — FR17..FR21, AC5, AC10, EC4, EC10, NFR3; rulings O2..O4;
 * SI-015, SI-016, SI-017): an INTERPRET run binds its declared evaluations to the
 * branch's NODE ATTRIBUTES (read through `readForNode`), evaluates the declared
 * expression, and proposes exactly ONE DecisionDraft (`status: draft`) whose `Decision`
 * node is DERIVED_FROM what it read. A missing input BLOCKs, named, and writes nothing.
 *
 * Scenario doc: manual-e2e/AXI-2006-Reasoning-Branch-Executors.md "AXI-2015".
 * Scenario 6 (a conflicting inherited value) is `manual` — unit-covered — see the doc.
 *
 * Fixtures: the AXI-2013 node-scope Feature rule (`igg4_node`, cut-point 2.5) over
 * `feature_node.csv`; an INTERPRET_RULE `e1: igg4_node_category == "high"`, `LEAF e1`;
 * and a second one naming `cd8_t_cell_fraction`, which is off the binding surface.
 *
 * Self-contained: a throwaway organization + workspace + project per run. Drafts,
 * bindings and attributes are append-only by design and stay in that workspace.
 *
 * AUTHORED, NOT RUN: no stack serves this story's axiome-back branch (the shared demo
 * stack serves `main`, and its database must not be migrated from a worktree). Do not
 * report `e2e-pass` until it has run green against a stack carrying AXI-2008..AXI-2015.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

const OUTPUT = 'igg4_node';
const CATEGORY = `${OUTPUT}_category`;
const STATUS = `${OUTPUT}_status`;
const CUT_POINT = 2.5;

const NODE_DECLARATION = {
  outputScope: 'node',
  outputName: OUTPUT,
  bindingTarget: {
    entity: 'Biomarker X',
    measure: 'concentration',
    unit: 'g/L',
    context: { assay: 'nephelometry', matrix: 'serum', population: 'adult' },
  },
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

/** The INTERPRET_RULE contract outputs (`PROTOCOL_REGISTRY.INTERPRET_RULE.requiredOutputFields`). */
const INTERPRET_OUTPUT_FIELDS = [
  { key: 'output_type', type: 'string', description: 'state_label' },
  { key: 'confidence', type: 'number', description: 'Confidence score (0-1)' },
  { key: 'evidence_refs', type: 'string[]', description: 'Node attributes the label was derived from' },
  { key: 'scoring_schema', type: 'string', description: '{"expression":"LEAF e1"}' },
];

const onKey = (attributeKey: string) => ({
  attributeEvaluations: [{ id: 'e1', attributeKey, operator: '==', value: 'high', valueType: 'string' }],
  expression: { type: 'LEAF', evaluationId: 'e1' },
});

test.describe.serial('AXI-2015 — Interpretation executor and DecisionDraft proposal', () => {
  let world: ReviewWorld;
  let api: Api;
  let tenant: Tenant;
  let project: string;
  let analysisId: string;
  let datasetId: string;
  let featureRule: RuleResponse;
  let interpretRule: RuleResponse;
  let offSurfaceRule: RuleResponse;
  let baselineSnapshotId: string;
  let featureRun: any;
  let firstInterpretation: any;

  async function approve(id: string): Promise<RuleResponse> {
    const before = (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
    const res = await world.admin.post(apiUrl(`/api/v1/rules/${id}/approve`), {
      data: { note: 'AXI-2015 e2e fixture', expectedContentHash: before.review?.contentHash },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
  }

  /** Create → check → submit → approve one published system rule. */
  async function publish(body: Record<string, unknown>, outputFields: unknown[]): Promise<RuleResponse> {
    const created = await fixtureSend(world.admin, 'post', '/api/v1/rules', { scope: 'system', ...body });
    trackFixtureRule(created.id);
    const checked = await fixtureSend(world.admin, 'patch', `/api/v1/rules/${created.id}`, {
      outputFields,
      guidance: COMPLETE_GUIDANCE,
    });
    expect(checked.status, 'fixture rule must pass the FR9 gate').toBe('checked');
    const submitted = await fixtureSend(world.admin, 'post', `/api/v1/rules/${created.id}/submit-for-review`);
    expect(submitted.status).toBe('in_review');
    return approve(created.id);
  }

  function interpretation(ruleId: string, snapshotId: string | undefined) {
    return {
      ruleId,
      runKind: 'INTERPRET',
      projectId: project,
      workspaceId: tenant.workspaceId,
      datasetId,
      ...(snapshotId ? { snapshotId } : {}),
    };
  }

  async function runToTerminal(body: Record<string, unknown>): Promise<any> {
    const res = await api.post('/api/v1/rule-runs', body, tenant.headers);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return pollRunTerminal(api, tenant, res.body.ruleRunId);
  }

  async function bindOrFail(variable: string): Promise<void> {
    const res = await api.post(
      `/api/v1/workspaces/${tenant.workspaceId}/projects/${project}/feature-rule-bindings`,
      { ruleId: featureRule.id, variable, rationale: `AXI-2015 e2e: ${variable} is the bound variable here.` },
      tenant.headers,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  async function decisionsOfProject(): Promise<any[]> {
    const res = await api.get(`/api/v1/workspaces/${tenant.workspaceId}/decisions?projectId=${project}&limit=100`, tenant.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return asList(res.body);
  }

  async function graph(): Promise<any> {
    const res = await api.get(`/api/v1/view-analyses/${analysisId}/provenance-graph`, tenant.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  function nodeOfSnapshot(g: any, snapshotId: string): any {
    return g.nodes.find((n: any) => n.nodeType === 'ViewAnalysisSnapshot' && n.referenceId === snapshotId);
  }

  test.beforeAll(async () => {
    world = await ReviewWorld.create();
    api = await adminApi();
    await world.grant(world.adminUserId, await world.role('AXI-2015 publisher', ['rule:read', 'rule:publish']));

    const org = await api.post('/api/v1/organizations', { name: unique('AXI-2015 Org'), type: 'biotech' });
    expect(org.status, JSON.stringify(org.body)).toBeLessThan(300);
    const ws = await api.post('/api/v1/workspaces', {
      name: unique('AXI-2015 WS'),
      description: 'AXI-2015 interpretation executor E2E fixture',
      type: 'internal',
      ownerOrganizationId: org.body.id,
    });
    expect(ws.status, JSON.stringify(ws.body)).toBeLessThan(300);
    tenant = { orgId: org.body.id, workspaceId: ws.body.id, headers: { 'X-Workspace-Id': ws.body.id } };

    const proj = await api.post('/api/v1/projects', { name: unique('AXI-2015 Project'), workspaceId: tenant.workspaceId }, tenant.headers);
    expect(proj.status, JSON.stringify(proj.body)).toBeLessThan(300);
    project = proj.body.id;
    datasetId = await ingestCsv(api, tenant, 'feature_node.csv');
    analysisId = await ensureDefaultAnalysis(api, tenant, project, datasetId);
    const baseline = (await snapshotsOf(api, tenant, analysisId)).find((s) => !s.parentSnapshotId);
    expect(baseline, 'the default analysis carries a parentless baseline snapshot').toBeTruthy();
    baselineSnapshotId = baseline.id;

    featureRule = await publish(
      {
        code: unique('AXI-2015-feat').toUpperCase().slice(0, 60),
        title: 'AXI-2015 node-scope feature fixture',
        category: 'phenotype_detection',
        protocolType: 'FEATURE_RULE',
        signals: ['marker:serum_igg4'],
        featureDeclaration: NODE_DECLARATION,
      },
      [
        { key: CATEGORY, type: 'string', description: 'Category label assigned by the cutoff' },
        { key: STATUS, type: 'string', description: 'applied | not_applicable | unit_mismatch | missing' },
      ],
    );
    interpretRule = await publish(
      {
        code: unique('AXI-2015-int').toUpperCase().slice(0, 60),
        title: 'AXI-2015 IgG4-high phenotype',
        category: 'phenotype_detection',
        protocolType: 'INTERPRET_RULE',
        signals: [`feature:${OUTPUT}`],
        ...onKey(CATEGORY),
      },
      INTERPRET_OUTPUT_FIELDS,
    );
    offSurfaceRule = await publish(
      {
        code: unique('AXI-2015-off').toUpperCase().slice(0, 60),
        title: 'AXI-2015 off-surface interpretation',
        category: 'phenotype_detection',
        protocolType: 'INTERPRET_RULE',
        signals: ['feature:cd8'],
        ...onKey('cd8_t_cell_fraction'),
      },
      INTERPRET_OUTPUT_FIELDS,
    );
  });

  test.afterAll(async () => {
    if (world) await deleteFixtureRules(world.admin);
    await api?.ctx.dispose();
    await world?.dispose();
  });

  test('FR17 FR21 P8 (Scenario 1): a node-attribute Interpretation is offered; an off-surface one is withheld and refused with the same sentence @SI-017 @SI-016', async () => {
    const offering = await api.get(
      `/api/v1/rule-runs/offered-rules?workspaceId=${tenant.workspaceId}&projectId=${project}&datasetId=${datasetId}`,
      tenant.headers,
    );
    expect(offering.status, JSON.stringify(offering.body)).toBe(200);
    expect(offering.body.offered.map((r: any) => r.id), JSON.stringify(offering.body.notAvailable)).toContain(interpretRule.id);
    expect(offering.body.offered.map((r: any) => r.id)).not.toContain(offSurfaceRule.id);
    const withheld = JSON.stringify(offering.body.notAvailable ?? offering.body);
    expect(withheld).toContain(offSurfaceRule.id);
    expect(withheld).toMatch(/cd8_t_cell_fraction.*not on the binding surface/);

    const direct = await api.post('/api/v1/rule-runs', interpretation(offSurfaceRule.id, baselineSnapshotId), tenant.headers);
    expect(direct.status, JSON.stringify(direct.body)).toBe(400);
    expect(JSON.stringify(direct.body)).toMatch(/cd8_t_cell_fraction.*not on the binding surface/);
  });

  test('AC10 FR20 EC10 (Scenario 2): a missing node attribute BLOCKs naming it, and writes no run and no draft @SI-017 @SI-016', async () => {
    const preflight = await api.post('/api/v1/rule-runs/preflight', interpretation(interpretRule.id, baselineSnapshotId), tenant.headers);
    expect(preflight.status, JSON.stringify(preflight.body)).toBeLessThan(300);
    expect(preflight.body.blocks.map((b: any) => b.id)).toEqual([`input_missing:${CATEGORY}`]);
    expect(preflight.body.blocks[0].description).toContain(CATEGORY);

    const refused = await api.post('/api/v1/rule-runs', interpretation(interpretRule.id, baselineSnapshotId), tenant.headers);
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(JSON.stringify(refused.body)).toContain(CATEGORY);

    expect((await runsOf(api, tenant, project)).filter((r) => r.runKind === 'INTERPRET')).toEqual([]);
    expect((await decisionsOfProject()).filter((d) => d.type === 'phenotype_classification')).toEqual([]);
  });

  test('AC5 FR18 FR19 O2 (Scenario 3): a bound run proposes exactly ONE draft, DERIVED_FROM the branch and the Feature result @SI-017 @SI-016 @SI-015', async () => {
    await bindOrFail('serum_igg4');
    featureRun = await runToTerminal({
      ruleId: featureRule.id,
      runKind: 'FEATURE',
      projectId: project,
      workspaceId: tenant.workspaceId,
      datasetId,
      snapshotId: baselineSnapshotId,
    });
    expect(featureRun.status, JSON.stringify(featureRun)).toBe('SUCCEEDED');

    const preflight = await api.post('/api/v1/rule-runs/preflight', interpretation(interpretRule.id, baselineSnapshotId), tenant.headers);
    expect(preflight.body.blocks ?? []).toEqual([]);

    firstInterpretation = await runToTerminal(interpretation(interpretRule.id, baselineSnapshotId));
    expect(firstInterpretation.status, JSON.stringify(firstInterpretation)).toBe('SUCCEEDED');
    expect(firstInterpretation.runKind).toBe('INTERPRET');
    const summary = firstInterpretation.summaryJson.interpretation;
    expect(summary).toMatchObject({ stateLabel: 'present', fired: ['e1'], confidence: { estimable: false } });

    const draft = await api.get(`/api/v1/workspaces/${tenant.workspaceId}/decisions/${summary.decisionDraftId}`, tenant.headers);
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    expect(draft.body).toMatchObject({ status: 'draft', type: 'phenotype_classification' });
    expect(draft.body.evidenceValues).toEqual([
      expect.objectContaining({ metric: CATEGORY, value: 'high', sourceSnapshotId: baselineSnapshotId }),
    ]);
    expect((await decisionsOfProject()).filter((d) => d.type === 'phenotype_classification')).toHaveLength(1);

    const g = await graph();
    const decisionNodeId = firstInterpretation.materializedNodeId;
    expect(decisionNodeId).toBe(summary.decisionNodeId);
    const into = g.edges.filter((e: any) => e.targetNodeId === decisionNodeId);
    const sources = new Map(into.map((e: any) => [e.sourceNodeId, e.edgeType]));
    expect(sources.get(nodeOfSnapshot(g, baselineSnapshotId).id)).toBe('DERIVED_FROM');
    expect(sources.get(featureRun.materializedNodeId)).toBe('DERIVED_FROM');
    expect(into.filter((e: any) => e.edgeType === 'CITES')).toEqual([]);
  });

  test('NFR3 O3 (Scenario 4): an identical resubmission dedupes and proposes nothing new @SI-017', async () => {
    const again = await runToTerminal(interpretation(interpretRule.id, baselineSnapshotId));
    expect(again.status, JSON.stringify(again)).toBe('DEDUPED');
    expect(again.dedupedFromRunId).toBe(firstInterpretation.id);
    expect(again.materializedNodeId).toBe(firstInterpretation.materializedNodeId);
    expect((await decisionsOfProject()).filter((d) => d.type === 'phenotype_classification')).toHaveLength(1);
  });

  test('NFR4 EC4 (Scenario 5): interpreting a child cites the attribute version it read, under a new identity @SI-017 @SI-016', async () => {
    const child = await api.post(
      '/api/v1/view-analyses/snapshots',
      { viewAnalysisId: analysisId, datasetId, parentSnapshotId: baselineSnapshotId, origin: 'filter', filters: [{ column: 'arm', operator: 'eq', value: 'B' }] },
      tenant.headers,
    );
    expect(child.status, JSON.stringify(child.body)).toBeLessThan(300);
    const childSnapshotId: string = child.body.id;

    await bindOrFail('igg4_by_arm');
    const overwrite = await runToTerminal({
      ruleId: featureRule.id,
      runKind: 'FEATURE',
      projectId: project,
      workspaceId: tenant.workspaceId,
      datasetId,
      snapshotId: childSnapshotId,
    });
    expect(overwrite.status, JSON.stringify(overwrite)).toBe('SUCCEEDED');

    const childRun = await runToTerminal(interpretation(interpretRule.id, childSnapshotId));
    expect(childRun.status, JSON.stringify(childRun)).toBe('SUCCEEDED');
    const childSummary = childRun.summaryJson.interpretation;
    expect(childSummary.stateLabel).toBe('absent');
    const baselineRecord = firstInterpretation.summaryJson.interpretation.inputs[0].attributeRecordId;
    expect(childSummary.inputs[0]).toMatchObject({ attributeKey: CATEGORY, value: 'normal', origin: 'own' });
    expect(childSummary.inputs[0].attributeRecordId).not.toBe(baselineRecord);
    expect(childRun.runFingerprint ?? null).not.toBe(firstInterpretation.runFingerprint ?? 'unclaimed');
  });
});
