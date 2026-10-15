import { test, expect, type Page } from '@playwright/test';
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
import { ingestCsv, runsOf, snapshotsOf } from './harness/feature-run';

/**
 * AXI-2016 (epic AXI-2006 — FR1..FR4, FR13, FR20, AC2, AC8, NFR4; SI-035, SI-030):
 * the screen side of the Feature and Interpretation executors. The Feature card on
 * the rule page, the declaration editor on Create Rule, the per-project binding
 * section (append-only history), the picker's `binding_missing` remedy, the
 * FEATURE / INTERPRET run modal over the shared preflight panel, and the
 * provenance inspector's node attribute panel.
 *
 * Scenario doc: manual-e2e/AXI-2006-Reasoning-Branch-Executors.md "AXI-2016".
 * Scenarios 8 and 10 are `manual` (unit-covered); see the doc for why.
 *
 * Fixtures (as in AXI-2013/AXI-2015): `feature_node.csv`, a published system
 * node-scope FEATURE_RULE `igg4_node` (cut-point 2.5), a published system
 * INTERPRET_RULE `e1: igg4_node_category == "high"`, and a draft FEATURE_RULE with
 * no declaration. Self-contained: a throwaway organization + workspace + project.
 * Bindings and attributes are append-only by design and stay in that project.
 *
 * Serial: Scenario 6 (the Interpretation's missing input) must run before the
 * Feature run of Scenario 7 writes that input, and Scenario 5's re-binding to
 * `serum_igg4` is what makes Scenario 7 runnable.
 *
 * RUN 2026-10-16: 8/8 (+2 auth setup) green, twice, headless, against an isolated
 * stack (compose project `axi2016e2e`: its own Postgres/Mongo/RabbitMQ/Redis/MinIO,
 * axiome-back origin/main e458fe68, axiome-bio-compute origin/main 0eaa3e4, front
 * on the AXI-2016 branch). Environment: BASE_URL=http://localhost:5186,
 * API_BASE_URL=http://localhost:3116, admin test@axiomebio.com.
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

const FEATURE_OUTPUT_FIELDS = [
  { key: CATEGORY, type: 'string', description: 'Category label assigned by the cutoff' },
  { key: STATUS, type: 'string', description: 'applied | not_applicable | unit_mismatch | missing' },
];

/** The INTERPRET_RULE contract outputs (`PROTOCOL_REGISTRY.INTERPRET_RULE.requiredOutputFields`). */
const INTERPRET_OUTPUT_FIELDS = [
  { key: 'output_type', type: 'string', description: 'state_label' },
  { key: 'confidence', type: 'number', description: 'Confidence score (0-1)' },
  { key: 'evidence_refs', type: 'string[]', description: 'Node attributes the label was derived from' },
  { key: 'scoring_schema', type: 'string', description: '{"expression":"LEAF e1"}' },
];

/** The app reads the active workspace/org from localStorage, not the URL (as in the AXI-1772 spec). */
async function primeWorkspace(page: Page, t: Tenant): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [t.workspaceId, t.orgId] as const,
  );
}

/** Every onboarding tour, skipped: a fresh user's tour navigate()s away from any page. */
const TOUR_IDS = ['orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions', 'graph-rules', 'charts-views', 'help', 'admin', 'collaboration'];

test.describe.serial('AXI-2016 — Feature card, binding, attribute panel and run preflight UI', () => {
  let world: ReviewWorld;
  let api: Api;
  let tenant: Tenant;
  let project: string;
  let analysisId: string;
  let datasetId: string;
  let featureRule: RuleResponse;
  let interpretRule: RuleResponse;
  let undeclaredRuleId: string;
  let featureRunId: string;
  let referentSnapshotId: string;

  async function approve(id: string): Promise<RuleResponse> {
    const before = (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
    const res = await world.admin.post(apiUrl(`/api/v1/rules/${id}/approve`), {
      data: { note: 'AXI-2016 e2e fixture', expectedContentHash: before.review?.contentHash },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await fixtureSend(world.admin, 'get', `/api/v1/rules/${id}`)) as RuleResponse;
  }

  /**
   * Create → check → submit → approve one published system rule. `advanced` travels on
   * the PATCH, as Create Rule sends it: the create route does not take
   * `attributeEvaluations`/`expression`, so an Interpretation declaration sent on the
   * POST is dropped and the rule is withheld as undecidable.
   */
  async function publish(
    body: Record<string, unknown>,
    outputFields: unknown[],
    advanced: Record<string, unknown> = {},
  ): Promise<RuleResponse> {
    const created = await fixtureSend(world.admin, 'post', '/api/v1/rules', { scope: 'system', ...body });
    trackFixtureRule(created.id);
    const checked = await fixtureSend(world.admin, 'patch', `/api/v1/rules/${created.id}`, {
      ...advanced,
      outputFields,
      guidance: COMPLETE_GUIDANCE,
    });
    expect(checked.status, 'fixture rule must pass the FR9 gate').toBe('checked');
    const submitted = await fixtureSend(world.admin, 'post', `/api/v1/rules/${created.id}/submit-for-review`);
    expect(submitted.status).toBe('in_review');
    return approve(created.id);
  }

  async function graph(): Promise<any> {
    const res = await api.get(`/api/v1/view-analyses/${analysisId}/provenance-graph`, tenant.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  async function snapshotNodeId(snapshotId: string): Promise<string> {
    const g = await graph();
    const node = g.nodes.find((n: any) => n.nodeType === 'ViewAnalysisSnapshot' && n.referenceId === snapshotId);
    expect(node, `snapshot ${snapshotId} has a provenance node in the analysis graph`).toBeTruthy();
    return node.id;
  }

  async function openPicker(page: Page): Promise<void> {
    await primeWorkspace(page, tenant);
    await page.goto(`/projects/${project}/view-analyses/${analysisId}`);
    await page.getByRole('button', { name: 'Run rule' }).click();
    await expect(page.getByRole('heading', { name: /Run relationship rule/i })).toBeVisible({ timeout: 30_000 });
  }

  /** Picker → select the offered rule → Adjust parameters → the reasoning run modal. */
  async function openRunModal(page: Page, rule: RuleResponse) {
    await openPicker(page);
    const row = page.getByRole('radiogroup', { name: 'Rules you can run' }).getByRole('radio').filter({ hasText: rule.code });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await row.click();
    await page.getByTestId('rule-detail-pane').getByRole('button', { name: 'Adjust parameters' }).click();
    const modal = page.getByTestId('reasoning-run-modal');
    await expect(modal).toBeVisible({ timeout: 30_000 });
    return modal;
  }

  async function openBindingSection(page: Page): Promise<void> {
    await primeWorkspace(page, tenant);
    await page.goto(`/rules/${featureRule.id}?bindingProject=${project}`);
    await expect(page.getByTestId('feature-binding-section')).toBeVisible({ timeout: 30_000 });
  }

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    world = await ReviewWorld.create();
    api = await adminApi();
    await world.grant(world.adminUserId, await world.role('AXI-2016 publisher', ['rule:read', 'rule:publish']));
    for (const tourId of TOUR_IDS) {
      const res = await api.ctx.put(apiUrl('/api/v1/onboarding-state'), { data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 } });
      expect(res.status(), `skip tour ${tourId}: ${await res.text()}`).toBeLessThan(300);
    }

    const org = await api.post('/api/v1/organizations', { name: unique('AXI-2016 Org'), type: 'biotech' });
    expect(org.status, JSON.stringify(org.body)).toBeLessThan(300);
    const ws = await api.post('/api/v1/workspaces', {
      name: unique('AXI-2016 WS'),
      description: 'AXI-2016 Feature UI E2E fixture',
      type: 'internal',
      ownerOrganizationId: org.body.id,
    });
    expect(ws.status, JSON.stringify(ws.body)).toBeLessThan(300);
    tenant = { orgId: org.body.id, workspaceId: ws.body.id, headers: { 'X-Workspace-Id': ws.body.id } };

    const proj = await api.post('/api/v1/projects', { name: unique('AXI-2016 Project'), workspaceId: tenant.workspaceId }, tenant.headers);
    expect(proj.status, JSON.stringify(proj.body)).toBeLessThan(300);
    project = proj.body.id;
    datasetId = await ingestCsv(api, tenant, 'feature_node.csv');
    analysisId = await ensureDefaultAnalysis(api, tenant, project, datasetId);

    featureRule = await publish(
      {
        code: unique('AXI-2016-feat').toUpperCase().slice(0, 60),
        title: 'AXI-2016 node-scope feature fixture',
        category: 'phenotype_detection',
        protocolType: 'FEATURE_RULE',
        signals: ['marker:serum_igg4'],
        featureDeclaration: NODE_DECLARATION,
      },
      FEATURE_OUTPUT_FIELDS,
    );
    interpretRule = await publish(
      {
        code: unique('AXI-2016-int').toUpperCase().slice(0, 60),
        title: 'AXI-2016 IgG4-high phenotype',
        category: 'phenotype_detection',
        protocolType: 'INTERPRET_RULE',
        signals: [`feature:${OUTPUT}`],
      },
      INTERPRET_OUTPUT_FIELDS,
      {
        attributeEvaluations: [{ id: 'e1', attributeKey: CATEGORY, operator: '==', value: 'high', valueType: 'string' }],
        expression: { type: 'LEAF', evaluationId: 'e1' },
      },
    );
    const undeclared = await fixtureSend(world.admin, 'post', '/api/v1/rules', {
      code: unique('AXI-2016-legacy').toUpperCase().slice(0, 60),
      title: 'AXI-2016 undeclared feature fixture',
      category: 'phenotype_detection',
      protocolType: 'FEATURE_RULE',
      scope: 'system',
    });
    trackFixtureRule(undeclared.id);
    undeclaredRuleId = undeclared.id;
  });

  test.afterAll(async () => {
    if (world) await deleteFixtureRules(world.admin);
    await api?.ctx.dispose();
    await world?.dispose();
  });

  test('FR1 FR2 FR3 (Scenario 1): a Feature rule authored with a declaration shows it on its Feature card @SI-035 @SI-030', async ({ page }) => {
    await primeWorkspace(page, tenant);
    await page.goto('/rules/new');
    await page.getByRole('button').filter({ has: page.getByRole('heading', { name: 'Feature Rule', exact: true }) }).click();

    const code = unique('AXI-2016-UI').toUpperCase().slice(0, 40);
    await page.getByPlaceholder('e.g., IMM-ACT-01').fill(code);
    await page.getByPlaceholder('e.g., Evidence of immune activation').fill('AXI-2016 authored feature');

    await page.getByTestId('feature-declare-toggle').check();
    await page.getByTestId('feature-scope-select').selectOption('node');
    await page.getByTestId('feature-output-name-input').fill('ki67');
    const target: Record<string, string> = { entity: 'tumor', measure: 'ki67_index', unit: 'percent', assay: 'IHC', matrix: 'FFPE', population: 'adult' };
    for (const [key, value] of Object.entries(target)) await page.getByTestId(`feature-target-${key}-input`).fill(value);
    await page.getByTestId('feature-shape-select').selectOption('categorical');
    await page.getByTestId('feature-cutoff-kind').selectOption('numeric');
    await page.getByTestId('feature-group-id').first().fill('high');
    await page.getByTestId('feature-group-min').first().fill('20');
    await page.getByTestId('feature-group-min-side').first().selectOption('inclusive');

    const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v1\/rules$/.test(r.url()));
    await page.getByRole('button', { name: 'Create Rule' }).click();
    const createdBody = await (await created).json();
    expect(createdBody.id, JSON.stringify(createdBody)).toBeTruthy();
    trackFixtureRule(createdBody.id);
    await page.waitForURL(new RegExp(`/rules/${createdBody.id}$`));

    const card = page.getByTestId('feature-card');
    await expect(card).toHaveAttribute('data-state', 'declared', { timeout: 30_000 });
    await expect(card.getByTestId('feature-scope')).toHaveText(/^Node/);
    await expect(card.getByTestId('feature-output-name')).toHaveText('ki67');
    await expect(card.getByTestId('feature-output-keys')).toContainText('ki67_category, ki67_status');
    await expect(card.getByTestId('feature-target-unit')).toHaveText('percent');
    await expect(card.getByTestId('feature-cutoff')).toContainText('≥ 20');

    // Stored as declared — the card is a reader of the server's record, not of the form.
    const stored = (await fixtureSend(world.admin, 'get', `/api/v1/rules/${createdBody.id}`)) as any;
    expect(stored.featureDeclaration).toMatchObject({
      outputScope: 'node',
      outputName: 'ki67',
      bindingTarget: { entity: 'tumor', measure: 'ki67_index', unit: 'percent', context: { assay: 'IHC', matrix: 'FFPE', population: 'adult' } },
      output: { shape: 'categorical', cutoff: { kind: 'numeric', groups: [{ id: 'high', min: 20, min_inclusive: true }] } },
    });
  });

  test('FR2 O1 (Scenario 2): an undeclared Feature rule states the legacy numeric shape and has no binding section @SI-035', async ({ page }) => {
    await primeWorkspace(page, tenant);
    await page.goto(`/rules/${undeclaredRuleId}`);
    const card = page.getByTestId('feature-card');
    await expect(card).toHaveAttribute('data-state', 'absent', { timeout: 30_000 });
    await expect(card).toContainText('feature_name, value');
    await expect(page.getByTestId('feature-binding-section')).toHaveCount(0);
  });

  test('AC8 FR4 (Scenario 3): an unbound rule is listed Not available as binding_missing, with a link to its binding @SI-035', async ({ page }) => {
    await openPicker(page);
    const offered = page.getByRole('radiogroup', { name: 'Rules you can run' }).getByRole('radio').filter({ hasText: featureRule.code });
    const notAvailable = page.getByTestId('rule-picker-not-available').locator('li').filter({ hasText: featureRule.title });
    await expect(notAvailable).toHaveCount(1, { timeout: 30_000 });
    await expect(offered).toHaveCount(0);
    await expect(notAvailable).toHaveAttribute('data-reason-code', 'binding_missing');

    const remedy = notAvailable.getByTestId('rule-picker-binding-remedy');
    await expect(remedy).toHaveAttribute('href', `/rules/${featureRule.id}?bindingProject=${project}`);
    await remedy.click();
    await expect(page.getByTestId('feature-binding-status')).toHaveAttribute('data-state', 'binding_missing', { timeout: 30_000 });
  });

  test('FR20 AC10 (Scenario 6): an Interpretation run with a missing input names it, offers no binding remedy, and cannot run @SI-035', async ({ page }) => {
    let runPosts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/v1\/rule-runs$/.test(r.url())) runPosts++;
    });
    const offering = await api.get(
      `/api/v1/rule-runs/offered-rules?workspaceId=${tenant.workspaceId}&projectId=${project}&datasetId=${datasetId}`,
      tenant.headers,
    );
    expect(offering.status, JSON.stringify(offering.body)).toBe(200);
    expect(
      offering.body.offered.map((r: any) => r.id),
      `served runnability: ${JSON.stringify({ runnable: interpretRule.runnable, runKind: interpretRule.runKind, code: interpretRule.runnabilityReasonCode, reason: interpretRule.runnabilityReason })}`,
    ).toContain(interpretRule.id);

    const modal = await openRunModal(page, interpretRule);
    await expect(modal).toHaveAttribute('data-run-kind', 'INTERPRET');

    const blocks = modal.getByTestId('preflight-blocks').locator('[data-block-code]');
    await expect(blocks).toHaveCount(1, { timeout: 30_000 });
    await expect(blocks.first()).toHaveAttribute('data-block-code', 'input_missing');
    await expect(blocks.first()).toContainText(CATEGORY);
    await expect(modal.getByTestId('preflight-block-remedy')).toHaveCount(0);
    await expect(modal.getByTestId('reasoning-run-confirm')).toBeDisabled();

    expect(runPosts).toBe(0);
    expect((await runsOf(api, tenant, project)).filter((r) => r.runKind === 'INTERPRET')).toEqual([]);
  });

  test('AC8 FR4 (Scenario 4): a reviewer records a binding; the history shows who, when and rationale, with no edit control @SI-035 @SI-030', async ({ page }) => {
    await openBindingSection(page);
    await expect(page.getByTestId('feature-binding-status')).toHaveAttribute('data-state', 'binding_missing', { timeout: 30_000 });

    await page.getByTestId('feature-binding-variable').fill('igg4_by_arm');
    await page.getByTestId('feature-binding-rationale').fill('AXI-2016 e2e: the per-arm IgG4 column, first reading.');
    await expect(page.getByTestId('feature-binding-submit')).toHaveText('Record binding');
    await page.getByTestId('feature-binding-submit').click();

    await expect(page.getByTestId('feature-binding-status')).toHaveAttribute('data-state', 'bound', { timeout: 30_000 });
    const rows = page.getByTestId('feature-binding-row');
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row).toHaveAttribute('data-current', 'true');
    await expect(row.locator('[data-field="variable"]')).toHaveText('igg4_by_arm');
    await expect(row.locator('[data-field="rationale"]')).toHaveText('AXI-2016 e2e: the per-arm IgG4 column, first reading.');
    await expect(row.locator('[data-field="boundBy"]')).not.toBeEmpty();
    await expect(row.locator('[data-field="boundAt"]')).not.toBeEmpty();
    await expect(row.getByRole('button')).toHaveCount(0);
  });

  test('AC8 (Scenario 5): a re-binding appends a new record; the earlier one stays, unchanged and superseded @SI-035 @SI-030', async ({ page }) => {
    await openBindingSection(page);
    await expect(page.getByTestId('feature-binding-row')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('feature-binding-submit')).toHaveText('Record re-binding');

    await page.getByTestId('feature-binding-variable').fill('serum_igg4');
    await page.getByTestId('feature-binding-rationale').fill('AXI-2016 e2e: serum IgG4 is the measured variable.');
    await page.getByTestId('feature-binding-submit').click();

    const rows = page.getByTestId('feature-binding-row');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    const current = rows.filter({ has: page.locator('[data-field="variable"]', { hasText: 'serum_igg4' }) });
    const earlier = rows.filter({ has: page.locator('[data-field="variable"]', { hasText: 'igg4_by_arm' }) });
    await expect(current).toHaveAttribute('data-current', 'true');
    await expect(current.locator('[data-field="status"]')).toContainText('replaces igg4_by_arm');
    await expect(earlier).toHaveAttribute('data-current', 'false');
    await expect(earlier.locator('[data-field="rationale"]')).toHaveText('AXI-2016 e2e: the per-arm IgG4 column, first reading.');
    await expect(earlier.locator('[data-field="status"]')).toContainText('Superseded');
    await expect(page.getByTestId('feature-binding-status')).toContainText('serum_igg4');

    const listed = await api.get(
      `/api/v1/workspaces/${tenant.workspaceId}/projects/${project}/feature-rule-bindings?ruleId=${featureRule.id}`,
      tenant.headers,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const byVariable = Object.fromEntries(listed.body.bindings.map((b: any) => [b.variable, b]));
    expect(listed.body.bindings).toHaveLength(2);
    expect(byVariable.serum_igg4.supersedesId).toBe(byVariable.igg4_by_arm.id);
    expect(byVariable.igg4_by_arm.current).toBe(false);
  });

  test('FR13 (Scenario 7): a bound Feature rule runs from the modal, which shows its binding and a clear preflight @SI-035 @SI-030', async ({ page }) => {
    const modal = await openRunModal(page, featureRule);
    await expect(modal).toHaveAttribute('data-run-kind', 'FEATURE');
    await expect(modal.getByTestId('reasoning-run-binding')).toHaveAttribute('data-state', 'bound', { timeout: 30_000 });
    await expect(modal.getByTestId('reasoning-run-binding')).toContainText('serum_igg4');
    await expect(modal.getByTestId('reasoning-run-confirm')).toBeEnabled({ timeout: 30_000 });
    await expect(modal.locator('[data-block-code]')).toHaveCount(0);

    const submitted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/v1\/rule-runs$/.test(r.url()));
    await modal.getByTestId('reasoning-run-confirm').click();
    const response = await submitted;
    const body = await response.json();
    expect(response.status(), JSON.stringify(body)).toBeLessThan(300);
    expect(response.request().postDataJSON()).toMatchObject({ ruleId: featureRule.id, runKind: 'FEATURE', projectId: project });

    const run = await pollRunTerminal(api, tenant, body.ruleRunId);
    expect(run.status, JSON.stringify(run)).toBe('SUCCEEDED');
    expect(run.runKind).toBe('FEATURE');
    featureRunId = run.id;
    referentSnapshotId = run.snapshotId;
    expect(referentSnapshotId, 'the run names its referent snapshot').toBeTruthy();
  });

  test('AC2 NFR4 (Scenario 9): the node attribute panel shows own values on the referent and inherited ones on a child @SI-035', async ({ page }) => {
    test.skip(!featureRunId, 'Scenario 7 produced no run');
    const referentNode = await snapshotNodeId(referentSnapshotId);

    const child = await api.post(
      '/api/v1/view-analyses/snapshots',
      { viewAnalysisId: analysisId, datasetId, parentSnapshotId: referentSnapshotId, origin: 'filter', filters: [{ column: 'igg4_by_arm', operator: 'lt', value: 2.0 }] },
      tenant.headers,
    );
    expect(child.status, JSON.stringify(child.body)).toBeLessThan(300);
    const childNode = await snapshotNodeId(child.body.id);
    expect((await snapshotsOf(api, tenant, analysisId)).map((s) => s.id)).toContain(child.body.id);

    await primeWorkspace(page, tenant);
    await page.goto(`/projects/${project}/view-analyses/${analysisId}/provenance`);

    await page.locator(`.react-flow__node[data-id="${referentNode}"]`).click({ timeout: 30_000 });
    const panel = page.getByTestId('node-attribute-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    for (const [key, value] of [[CATEGORY, 'high'], [STATUS, 'applied']] as const) {
      const row = panel.locator(`[data-testid="node-attribute-row"][data-attribute-key="${key}"]`);
      await expect(row).toHaveAttribute('data-origin', 'own');
      await expect(row.locator('[data-field="value"]')).toHaveText(value);
      await expect(row.locator('[data-field="source"]')).toContainText(`${featureRule.code} v${featureRule.version}`);
      await expect(row.locator('[data-field="ruleRunId"]')).toHaveText(featureRunId);
    }

    await page.locator(`.react-flow__node[data-id="${childNode}"]`).click();
    const inherited = page.getByTestId('node-attribute-panel').locator(`[data-testid="node-attribute-row"][data-attribute-key="${CATEGORY}"]`);
    await expect(inherited).toHaveAttribute('data-origin', 'inherited', { timeout: 30_000 });
    await expect(inherited.locator('[data-field="value"]')).toHaveText('high');
    await expect(inherited.locator('[data-field="inherited"]')).toContainText('Inherited from');
    await expect(inherited.locator('[data-field="ruleRunId"]')).toHaveText(featureRunId);
  });
});
