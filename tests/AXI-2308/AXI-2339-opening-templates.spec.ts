import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import {
  OPENING_TEMPLATES_PATH,
  compileTemplate,
  drainGoverned,
  ingestCsvFixture,
  submitGoverned,
} from './harness/opening-templates';

/**
 * AXI-2339 (epic AXI-2308 — FR20, NFR10, AC14, AC36): the four opening templates
 * (T1 Mann–Whitney, T2 Kruskal–Wallis + Dunn/Holm, T3 Spearman + BH within the run,
 * T4 partial Spearman) turn `{ templateId, parameters }` into a submit-ready plan
 * through validateIntent → compileIntent → validatePlan, with NO LLM call, and the
 * plan runs on the governed engine.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md`
 * § AXI-2339.3–.10. API-level (no browser): the guided screen is AXI-2328's.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` — synthetic,
 * 24 rows, the investigator's header shape; no patient value.
 *
 * Its SECOND column (`microbiote_igg4_cer_228`) is deliberately one no template
 * here reads: the guided profiler (`profiling/structure-profiler.service.ts`,
 * `detectTimepoint`) falls back to `columns[1]` as the TIMEPOINT when no header
 * matches /time|visit|timepoint|tp/, so on the investigator's real header the first
 * microbiote column is typed `timepoint` and drops out of the continuous candidates.
 * That is a profiler defect outside AXI-2339's boundary, reported to the lead; this
 * spec does not assert it either way.
 *
 * No planner provider is reachable from this path: the stack runs with
 * `GUIDED_ANALYSIS_LLM_TRANSPORT=recorded` and no provider key, so any planner call
 * would fail loudly rather than spend.
 *
 * STATUS: RUN headless, 8/8 green (2026-10-29), against an ISOLATED stack serving this
 * story's branch: a throwaway Postgres migrated from the branch's own history, an own
 * RabbitMQ vhost / Mongo DB / Redis index, and gateway + user/event/organization
 * sidecars mounting the AXI-2339 worktree; the demo bio-compute computed the five
 * operations (one rule run each, all SUCCEEDED). Never the shared demo DB.
 *
 * Run: `API_BASE_URL=<gateway serving the AXI-2339 branch> npx playwright test tests/AXI-2308/AXI-2339-*`.
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const MAG4 = ['microbiote_igg4_mag4_27', 'microbiote_igg4_mag4_22', 'microbiote_igg4_mag4_13'];
const CLUSTER = 'cluster_selon_acr_eular_2019';
const OPERATIONS = [
  'stats.mann_whitney_u',
  'stats.kruskal_wallis',
  'stats.dunn_posthoc',
  'stats.correlation_matrix',
  'stats.partial_correlation',
];

let api: Api;
let t: Tenant;
let datasetId: string;
let dataset: AnchoredDataset;

const operationNodes = (plan: any) => (plan.nodes as any[]).filter((n) => n.operation);

async function compiledOk(templateId: string, parameters: Record<string, unknown>) {
  const res = await compileTemplate(api, t, dataset, templateId, parameters);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
  return res.body;
}

/**
 * Submit and drain. Every OPERATION node must produce (or reuse) its result; a plan's
 * human `interpretation` gate settles at AWAITING_APPROVAL by design (it is the
 * investigator's act, never the engine's) and nothing may FAIL or BLOCK.
 */
async function runsGreen(plan: any) {
  const runId = await submitGoverned(api, t, plan, datasetId);
  const status = await drainGoverned(api, t, runId);
  const byPlanNode = new Map(status.nodes.map((n) => [n.nodeId.slice(n.nodeId.indexOf('__') + 2), n]));
  for (const node of operationNodes(plan)) {
    const ran = byPlanNode.get(node.id);
    expect(ran?.status, `${node.id}: ${JSON.stringify(ran)}`).toMatch(/^(SUCCEEDED|REUSED)$/);
  }
  for (const node of status.nodes) {
    expect(node.status, JSON.stringify(node)).toMatch(/^(SUCCEEDED|REUSED|AWAITING_APPROVAL)$/);
  }
  return status;
}

test.describe.serial('AXI-2339 opening templates — intent → plan with no LLM @SI-045 @SI-002 @SI-010', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(OPERATIONS);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2339.3 AC14 — the catalog lists exactly T1–T4 with labels, operations, guards, slots, chart and sentence id', async () => {
    const res = await api.get(OPENING_TEMPLATES_PATH, t.headers);
    expect(res.status).toBe(200);
    const rows = res.body as any[];
    expect(rows.map((r) => r.templateId)).toEqual(['T1', 'T2', 'T3', 'T4']);
    const byId = Object.fromEntries(rows.map((r) => [r.templateId, r]));
    expect(byId.T1.operations).toEqual(['stats.mann_whitney_u']);
    expect(byId.T2.operations).toEqual(['stats.kruskal_wallis', 'stats.dunn_posthoc']);
    expect(byId.T3.operations).toEqual(['stats.correlation_matrix']);
    expect(byId.T3.multipleTesting).toMatchObject({ method: 'benjamini_hochberg', scope: 'run' });
    expect(byId.T4.operations).toEqual(['stats.partial_correlation']);
    for (const row of rows) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.methodSubtitle.length).toBeGreaterThan(0);
      expect(row.bindingGuards.length).toBeGreaterThan(0);
      expect(row.clarificationSlots.length).toBeGreaterThan(0);
      expect(row.defaultChart).toBeTruthy();
      expect(row.answerSentenceTemplateId).toMatch(/^opening\.t[1-4]\./);
    }
  });

  test('AXI-2339.4 AC14 — every template matches the investigator-shaped dataset; candidates offered, none selected', async () => {
    const res = await api.post(`${OPENING_TEMPLATES_PATH}/match`, { projectId: t.projectId, dataset }, t.headers);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const matches = res.body as any[];
    expect(matches.map((m) => [m.templateId, m.eligible, m.unmetGuards])).toEqual([
      ['T1', true, []], ['T2', true, []], ['T3', true, []], ['T4', true, []],
    ]);
    const { candidates } = matches[0];
    const grouping = Object.fromEntries(candidates.grouping.map((g: any) => [g.column, [...g.levels].sort()]));
    expect(grouping.sexe).toEqual(['F', 'M']);
    expect(grouping[CLUSTER]).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(candidates.continuous).toEqual(expect.arrayContaining(['igg4_g_l', 'age', ...MAG4]));
    expect(candidates.continuous).not.toContain('sexe');
    expect(matches[0]).not.toHaveProperty('selected');
  });

  test('AXI-2339.5 AC14 — T1 compiles one Mann–Whitney node and runs green', async () => {
    test.setTimeout(240_000);
    const result = await compiledOk('T1', { datasetId, outcome: MAG4[0], groupingColumn: 'sexe', groups: ['F', 'M'] });
    const nodes = operationNodes(result.plan);
    expect(nodes.map((n) => n.operation.operationId)).toEqual(['stats.mann_whitney_u']);
    expect(nodes[0].operation.operationParams).toEqual({ groupFrom: 'F', groupTo: 'M' });
    expect(result.plan.templateRef.templateId).toBe('OPENING-T1');
    expect(result.familySize).toBe(1);
    expect(result.familyCorrectionApplied).toBe(false);
    await runsGreen(result.plan);
  });

  test('AXI-2339.6 AC14 AC36 — T2 compiles Kruskal–Wallis plus its Dunn/Holm post-hoc and both run green', async () => {
    test.setTimeout(240_000);
    const result = await compiledOk('T2', { datasetId, outcome: 'igg4_g_l', groupingColumn: CLUSTER });
    const [kw, dunn] = operationNodes(result.plan);
    expect(kw.operation.operationId).toBe('stats.kruskal_wallis');
    expect(dunn.operation.operationId).toBe('stats.dunn_posthoc');
    expect(dunn.dependsOn).toEqual([kw.id]);
    expect(dunn.params).toMatchObject({
      posthocOf: kw.id,
      in_correction_family: false,
      multipleTesting: { method: 'holm', scope: 'run', declaredFamilySize: 6 },
    });
    expect(result.plan.declaredFamily.memberNodeIds).toEqual([kw.id]);
    expect(result.familySize).toBe(6);
    await runsGreen(result.plan);
  });

  test('AXI-2339.7 AC14 AC36 — T3 compiles ONE Spearman matrix with BH within the run and runs green', async () => {
    test.setTimeout(240_000);
    const result = await compiledOk('T3', { datasetId, x: 'igg4_g_l', y: MAG4 });
    const nodes = operationNodes(result.plan);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].operation).toMatchObject({
      operationId: 'stats.correlation_matrix',
      operationParams: { method: 'spearman', familyScope: 'global' },
      roleBindings: { referenceColumns: ['igg4_g_l'], variableColumns: MAG4 },
    });
    expect(result.familySize).toBe(3);
    expect(result.familyCorrectionApplied).toBe(true);
    expect(result.plan.familyCorrectionApplied).toBe(true);
    await runsGreen(result.plan);
  });

  test('AXI-2339.8 AC14 — T4 compiles one partial Spearman adjusted for age and runs green', async () => {
    test.setTimeout(240_000);
    const result = await compiledOk('T4', { datasetId, x: MAG4[0], y: ['igg4_g_l'], adjustFor: 'age' });
    const nodes = operationNodes(result.plan);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].operation).toMatchObject({
      operationId: 'stats.partial_correlation',
      operationParams: { method: 'spearman' },
      roleBindings: { xColumn: MAG4[0], yColumn: 'igg4_g_l', covariateColumns: ['age'] },
    });
    expect(result.familyCorrectionApplied).toBe(false);
    await runsGreen(result.plan);
  });

  test('AXI-2339.9 AC14 — an unmet guard or an unknown template refuses by name and returns no plan', async () => {
    const twoLevels = await compileTemplate(api, t, dataset, 'T2', { datasetId, outcome: 'igg4_g_l', groupingColumn: 'sexe' });
    const sameColumn = await compileTemplate(api, t, dataset, 'T4', { datasetId, x: MAG4[0], y: ['igg4_g_l'], adjustFor: MAG4[0] });
    const unknown = await compileTemplate(api, t, dataset, 'T9', { datasetId });
    expect(twoLevels.body).toMatchObject({ ok: false, code: 'GUARD_UNMET', ruleIds: ['T2.grouping'] });
    expect(sameColumn.body).toMatchObject({ ok: false, code: 'GUARD_UNMET', ruleIds: ['T4.distinct'] });
    expect(unknown.body).toMatchObject({ ok: false, code: 'UNKNOWN_TEMPLATE' });
    for (const res of [twoLevels, sameColumn, unknown]) {
      expect(res.status).toBeLessThan(300);
      expect(res.body).not.toHaveProperty('plan');
    }
  });

  test('AXI-2339.10 AC36 NFR10 — the same input compiles to the same plan; a different partner to another', async () => {
    const params = { datasetId, x: 'igg4_g_l', y: MAG4 };
    const first = await compiledOk('T3', params);
    const again = await compiledOk('T3', params);
    const other = await compiledOk('T3', { ...params, y: MAG4.slice(0, 2) });
    expect(again.plan).toEqual(first.plan);
    expect(first.plan.planId).toMatch(/^PL-[0-9a-f]{8}$/);
    expect(other.plan.planId).not.toBe(first.plan.planId);
    expect(other.familySize).toBe(2);
    const reread = await compiledOk('T3', params);
    expect(reread.plan.planId).toBe(first.plan.planId);
  });
});
