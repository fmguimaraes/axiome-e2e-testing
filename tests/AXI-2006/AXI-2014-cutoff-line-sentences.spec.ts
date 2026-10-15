import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureDefaultAnalysis, ingestFixture, pollRunTerminal, type Tenant } from '../AXI-1474/harness/seed';
import {
  COMPLETE_GUIDANCE,
  deleteFixtureRules,
  send as fixtureSend,
  trackFixtureRule,
  type RuleResponse,
  ReviewWorld,
} from '../AXI-1762/AXI-1765-rule-review-fixtures';
import { queryDataset, snapshotsOf } from './harness/feature-run';
import { thresholdsOf, waitForRecommendedSpecs, waitForRunDecisions } from './harness/feature-result';

/**
 * AXI-2014 (epic AXI-2006 — FR14, FR15, AC4; SI-016, SI-018, SI-048, SI-013, SI-033, and
 * SI-017 / SI-015 touched): a succeeded row-scope Feature run gets a recommended box plot
 * with its declared cutoff drawn as a governed, read-only reference line, and a
 * deterministic sentence on a descriptive_summary Decision — and both cite the SAME run.
 *
 * Scenario doc: manual-e2e/AXI-2006-Reasoning-Branch-Executors.md "AXI-2014".
 *
 * Fixture: the AXI-2012 one — a published tagless system FEATURE_RULE `bx_level`
 * (`high` = `> 2.5`, `normal` = `<= 2.5`) bound to `biomarker_x` of the AXI-1474
 * `qc_sample.csv`, in a throwaway organization + workspace + project.
 *
 * AUTHORED, NOT RUN: no stack serves this story's axiome-back branch (the shared demo
 * stack serves `main`, and its database must not be migrated from a worktree). Do not
 * report `e2e-pass` until it has run green against a stack carrying the AXI-2008..AXI-2014
 * backend and the AXI-2014 front.
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
const OUTPUT_NAME = 'bx_level';
const VARIABLE = 'biomarker_x';

const DECLARATION = {
  outputScope: 'row',
  outputName: OUTPUT_NAME,
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

const OUTPUT_FIELDS = [
  { key: `${OUTPUT_NAME}_category`, type: 'string', description: 'Category label assigned by the cutoff' },
  { key: `${OUTPUT_NAME}_status`, type: 'string', description: 'applied | not_applicable | unit_mismatch | missing' },
];

/** The status clauses, in the contract's order, as the renderer phrases them (count-agnostic). */
const STATUS_CLAUSES: Array<[string, (n: number, breakdown: string) => string]> = [
  ['applied', (n, breakdown) => ` Rows assigned a category: ${n} (${breakdown}).`],
  ['not_applicable', (n) => ` Rows in no declared group, left without a category: ${n}.`],
  ['unit_mismatch', (n) => ` Rows whose unit does not match the declared unit, left without a category: ${n}.`],
  ['missing', (n) => ` Rows with no value for ${VARIABLE}, left without a category: ${n}.`],
];

function tally(values: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) if (v !== null && v !== undefined && String(v) !== '') counts[String(v)] = (counts[String(v)] ?? 0) + 1;
  return counts;
}

/** The exact sentence the table's OWN tallies imply — the run's stamp must agree with its table. */
function expectedSentence(code: string, version: number, rows: Array<Record<string, unknown>>): string {
  const statuses = tally(rows.map((r) => r[`${OUTPUT_NAME}_status`]));
  const categories = tally(rows.map((r) => r[`${OUTPUT_NAME}_category`]));
  const breakdown = Object.keys(categories)
    .sort()
    .map((c) => `${c} (${categories[c]})`)
    .join(', ');
  const lead = `${OUTPUT_NAME} (${code} v${version}) evaluated ${VARIABLE}. Rows evaluated: ${rows.length}.`;
  return lead + STATUS_CLAUSES.map(([s, clause]) => (statuses[s] ? clause(statuses[s], breakdown) : '')).join('');
}

test.describe.serial('AXI-2014 — Feature cutoff reference line and Feature sentence', () => {
  let world: ReviewWorld;
  let api: Api;
  let tenant: Tenant;
  let project: string;
  let analysisId: string;
  let datasetId: string;
  let rule: RuleResponse;
  let run: any;
  let resultDatasetId: string;
  let spec: any;
  let governed: any;

  async function approve(id: string): Promise<RuleResponse> {
    const before = (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
    const res = await world.admin.post(apiUrl(`/api/v1/rules/${id}/approve`), {
      data: { note: 'AXI-2014 e2e fixture', expectedContentHash: before.review?.contentHash },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
  }

  async function publishedCategorical(): Promise<RuleResponse> {
    const created = await fixtureSend(world.admin, 'post', '/api/v1/rules', {
      code: unique('AXI-2014-cut').toUpperCase().slice(0, 60),
      title: 'AXI-2014 cutoff-line fixture',
      category: 'phenotype_detection',
      protocolType: 'FEATURE_RULE',
      signals: [`marker:${VARIABLE}`],
      scope: 'system',
      featureDeclaration: DECLARATION,
    });
    trackFixtureRule(created.id);
    const checked = await fixtureSend(world.admin, 'patch', `/api/v1/rules/${created.id}`, {
      outputFields: OUTPUT_FIELDS,
      guidance: COMPLETE_GUIDANCE,
    });
    expect(checked.status, 'fixture rule must pass the FR9 gate').toBe('checked');
    const submitted = await fixtureSend(world.admin, 'post', `/api/v1/rules/${created.id}/submit-for-review`);
    expect(submitted.status).toBe('in_review');
    return approve(created.id);
  }

  test.beforeAll(async () => {
    world = await ReviewWorld.create();
    api = await adminApi();
    await world.grant(world.adminUserId, await world.role('AXI-2014 publisher', ['rule:read', 'rule:publish']));

    const org = await api.post('/api/v1/organizations', { name: unique('AXI-2014 Org'), type: 'biotech' });
    expect(org.status, JSON.stringify(org.body)).toBeLessThan(300);
    const ws = await api.post('/api/v1/workspaces', {
      name: unique('AXI-2014 WS'),
      description: 'AXI-2014 Feature cutoff line E2E fixture',
      type: 'internal',
      ownerOrganizationId: org.body.id,
    });
    expect(ws.status, JSON.stringify(ws.body)).toBeLessThan(300);
    tenant = { orgId: org.body.id, workspaceId: ws.body.id, headers: { 'X-Workspace-Id': ws.body.id } };

    const proj = await api.post(
      '/api/v1/projects',
      { name: unique('AXI-2014 Project'), workspaceId: tenant.workspaceId },
      tenant.headers,
    );
    expect(proj.status, JSON.stringify(proj.body)).toBeLessThan(300);
    project = proj.body.id;
    datasetId = await ingestFixture(api, tenant);
    analysisId = await ensureDefaultAnalysis(api, tenant, project, datasetId);

    rule = await publishedCategorical();
    const bound = await api.post(
      `/api/v1/workspaces/${tenant.workspaceId}/projects/${project}/feature-rule-bindings`,
      { ruleId: rule.id, variable: VARIABLE, rationale: `AXI-2014 e2e: ${VARIABLE} is the bound variable here.` },
      tenant.headers,
    );
    expect(bound.status, JSON.stringify(bound.body)).toBe(201);

    const submitted = await api.post(
      '/api/v1/rule-runs',
      { ruleId: rule.id, runKind: 'FEATURE', projectId: project, workspaceId: tenant.workspaceId, datasetId },
      tenant.headers,
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
    run = await pollRunTerminal(api, tenant, submitted.body.ruleRunId);
    expect(run.status, JSON.stringify(run)).toBe('SUCCEEDED');

    const derived = (await snapshotsOf(api, tenant, analysisId)).filter(
      (s) => s.origin === 'rule_derived' && s.ruleRunId === run.id,
    );
    expect(derived, 'exactly one rule_derived snapshot for the run').toHaveLength(1);
    resultDatasetId = derived[0].datasetId;
  });

  test.afterAll(async () => {
    if (world) await deleteFixtureRules(world.admin);
    await api?.ctx.dispose();
    await world?.dispose();
  });

  test('AC4 FR14 (Scenario 1): the recommended box plot lists ONE governed cutoff, badged with the rule version and the producing run @SI-016 @SI-018 @SI-017 @SI-015', async () => {
    const recommended = await waitForRecommendedSpecs(api, tenant, resultDatasetId);
    expect(recommended, JSON.stringify(recommended)).toHaveLength(1);
    spec = recommended[0];
    expect(spec.templateId).toBe('boxplot_v1');
    expect(spec.bindings).toEqual({
      y: { column_id: `col_${VARIABLE}` },
      group: { column_id: `col_${OUTPUT_NAME}_category` },
    });

    const listed = await thresholdsOf(api, tenant, spec.id);
    const governedRows = listed.filter((t: any) => t.governedBy);
    expect(governedRows, JSON.stringify(listed)).toHaveLength(1);
    governed = governedRows[0];
    expect({ field: governed.field, operator: governed.operator, value: governed.value, status: governed.status }).toEqual({
      field: `col_${VARIABLE}`,
      operator: '>',
      value: CUT_POINT,
      status: 'active',
    });
    expect(governed.governedBy).toEqual({
      ruleCode: rule.code,
      ruleVersion: rule.version,
      provenance: 'published_rule_version',
      ruleRunId: run.id,
    });
  });

  test('FR14 (Scenario 2): the governed cutoff cannot be archived by hand — 404, and it still lists @SI-015 @SI-016', async () => {
    const res = await api.post(`/api/v1/thresholds/${governed.id}/archive`, {}, tenant.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(404);

    const after = (await thresholdsOf(api, tenant, spec.id)).filter((t: any) => t.governedBy);
    expect(after.map((t: any) => t.id)).toEqual([governed.id]);
  });

  test('AC4 FR15 (Scenario 3): the run raises ONE Feature sentence whose counts are the table\'s, citing the SAME run as the line @SI-048 @SI-013 @SI-015', async () => {
    const decisions = await waitForRunDecisions(api, tenant, project, run.id);
    expect(decisions, JSON.stringify(decisions)).toHaveLength(1);
    const decision = decisions[0];
    const sentence = decision.context.resultSentence;

    expect({ kind: sentence.kind, language: sentence.language, status: sentence.status }).toEqual({
      kind: 'feature',
      language: 'en',
      status: 'reported',
    });
    expect({ ruleCode: sentence.ruleCode, ruleVersion: sentence.ruleVersion, outputName: sentence.outputName }).toEqual({
      ruleCode: rule.code,
      ruleVersion: rule.version,
      outputName: OUTPUT_NAME,
    });

    const table = await queryDataset(api, tenant, resultDatasetId);
    expect(sentence.text).toBe(expectedSentence(rule.code, rule.version, table.rows));

    expect(decision.evidenceLinks?.[0]?.evidenceId, JSON.stringify(decision.evidenceLinks)).toBeTruthy();
    expect(decision.context.ruleRunId).toBe(governed.governedBy.ruleRunId);
  });

  test('AC4 FR14 (Scenario 4): the chart page draws the cutoff and badges it in the Thresholds tab @SI-033', async ({ page }) => {
    await page.goto(`/datasets/${resultDatasetId}/chart/${spec.id}`);
    await expect(page.locator('.js-plotly-plot').first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => page.locator('.shapelayer path').count(), { timeout: 30_000 }).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Thresholds' }).click();
    await expect(page.getByText(`${rule.code} v${rule.version}`)).toBeVisible();
  });
});
