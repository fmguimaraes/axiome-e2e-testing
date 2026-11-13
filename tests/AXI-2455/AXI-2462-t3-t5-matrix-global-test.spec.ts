import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { compileTemplate, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { registryApiAs, type RegistryApi } from '../AXI-2422/harness/registry-api';

/**
 * AXI-2462 (epic AXI-2455; TPL FR55, FR57, FR58, FR59, FR30; AC23, AC25; @SI-069, @SI-045). T3
 * (correlation family) and T5 (correlation heatmap) accept the same one-sided `alternative` as
 * T1/T4 (AXI-2461), forwarded into the compiled `stats.correlation_matrix` node's
 * `operationParams` only when supplied (FR31). Their new `0.4` composition-backed version also
 * adds a `globalTest` step (`stats.matrix_global_test`, AXI-2460) reading the `correlate` step's
 * output columns, and declares `global_p` as the version's main result — the confirmatory
 * verdict over the WHOLE matrix, never one cell (`cellBound: false`, AC25).
 *
 * Fixture: `opening-templates-paul-header.csv` (reused from AXI-2308/AXI-2453/AXI-2461).
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2462.
 * Run: `BASE_URL=http://127.0.0.1:5173 API_BASE_URL=http://localhost:3000 npx playwright test tests/AXI-2455/AXI-2462-*`
 * Authored, NOT run against the demo stack — owner override (no e2e runs for epic AXI-2455).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const T2 = { outcome: 'igg4_g_l', groupingColumn: 'cluster_selon_acr_eular_2019' };
const T3 = { x: 'igg4_g_l', y: ['microbiote_igg4_mag4_27'] };
// T5's guards require at least two columns on EACH side (`T5.references` / `T5.y`, minColumns 2).
const T5 = {
  references: ['microbiote_igg4_mag4_27', 'microbiote_igg4_mag4_22'],
  y: ['microbiote_igg4_mag4_13', 'igg4_g_l'],
};

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let registry: RegistryApi;

const opNodeOf = (plan: any) => plan.nodes.find((n: any) => n.operation);

/** The 0.4 `globalTest` step must read `correlate`'s raw p-values and leave `alpha` settable (SAP FR73). */
function expectGlobalTestStep(composition: any) {
  const step = composition?.steps?.find((s: any) => s.stepId === 'globalTest');
  expect(step?.operationId).toBe('stats.matrix_global_test');
  expect(step?.roles?.find((r: any) => r.role === 'pValueColumn')?.sources).toEqual([
    { kind: 'step_output', stepId: 'correlate', column: 'pValue' },
  ]);
  expect(step?.parameters).toEqual([{ key: 'alpha', mode: 'user_settable' }]);
}

test.describe.serial('AXI-2462 - T3/T5 alternative + matrix global test (TPL FR55, FR57, AC23, AC25) @SI-069 @SI-045', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    registry = await registryApiAs('user');
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
    await registry?.dispose();
  });

  test('AXI-2462.1 FR55 - T3 compiles a one-sided alternative into the correlation-matrix node, forwarded alongside method/familyScope', async () => {
    // Act
    const greater = await compileTemplate(api, t, dataset, 'T3', {
      datasetId: dataset.datasetId,
      ...T3,
      alternative: 'greater',
    });
    const absent = await compileTemplate(api, t, dataset, 'T3', { datasetId: dataset.datasetId, ...T3 });
    // Assert
    expect(greater.body.ok, JSON.stringify(greater.body)).toBe(true);
    expect(opNodeOf(greater.body.plan)?.operation).toMatchObject({
      operationId: 'stats.correlation_matrix',
      operationParams: { method: 'spearman', familyScope: 'global', alternative: 'greater' },
    });
    // FR31: the default (no alternative) path stays byte-identical to before this story.
    expect(absent.body.ok, JSON.stringify(absent.body)).toBe(true);
    expect(opNodeOf(absent.body.plan)?.operation?.operationParams).toEqual({
      method: 'spearman',
      familyScope: 'global',
    });
  });

  test('AXI-2462.2 FR55 - T5 compiles a one-sided alternative into the correlation-matrix node, forwarded alongside method/familyScope', async () => {
    // Act
    const less = await compileTemplate(api, t, dataset, 'T5', {
      datasetId: dataset.datasetId,
      ...T5,
      alternative: 'less',
    });
    // Assert
    expect(less.body.ok, JSON.stringify(less.body)).toBe(true);
    expect(opNodeOf(less.body.plan)?.operation).toMatchObject({
      operationId: 'stats.correlation_matrix',
      operationParams: { method: 'spearman', familyScope: 'global', alternative: 'less' },
    });
  });

  test('AXI-2462.3 FR57, FR59, AC25 - T3 @0.4 resolves with a global_p main result over the whole matrix, never one cell', async () => {
    // Act
    const resolved = await registry.resolve('T3', '0.4');
    // Assert
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expectGlobalTestStep(resolved.body.composition);
    expect(resolved.body.mainResult).toMatchObject({
      output: 'global_p',
      pValueField: 'global_p',
      signedEffectField: null,
      cellBound: false,
    });
  });

  test('AXI-2462.4 FR57, FR59, AC25 - T5 @0.4 resolves with the same global_p main-result shape as T3', async () => {
    // Act
    const resolved = await registry.resolve('T5', '0.4');
    // Assert
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expectGlobalTestStep(resolved.body.composition);
    expect(resolved.body.mainResult).toMatchObject({
      output: 'global_p',
      pValueField: 'global_p',
      signedEffectField: null,
      cellBound: false,
    });
  });

  test('AXI-2462.5 FR58 - the immutable T3 0.2/0.3 resolve with NO main-result declaration (regression)', async () => {
    // Act
    const recipe = await registry.resolve('T3', '0.2');
    const composed = await registry.resolve('T3', '0.3');
    // Assert
    expect(recipe.status, JSON.stringify(recipe.body)).toBe(200);
    expect(composed.status, JSON.stringify(composed.body)).toBe(200);
    expect(recipe.body).not.toHaveProperty('mainResult');
    expect(composed.body).not.toHaveProperty('mainResult');
  });

  test('AXI-2462.6 EC28 - T2 still refuses an alternative parameter it never declared, naming the slot (regression)', async () => {
    // Act
    const res = await compileTemplate(api, t, dataset, 'T2', {
      datasetId: dataset.datasetId,
      ...T2,
      alternative: 'greater',
    });
    // Assert
    expect(res.body).toMatchObject({ ok: false, code: 'GUARD_UNMET', ruleIds: ['alternative'] });
    expect((res.body.messages ?? []).join(' ')).toContain("the T2 template takes no 'alternative' choice");
  });
});
