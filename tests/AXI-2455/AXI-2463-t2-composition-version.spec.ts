import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { compileTemplate, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { compositionApiAs, type CompositionApi } from '../AXI-2422/harness/composition-api';
import { registryApiAs, type RegistryApi } from '../AXI-2422/harness/registry-api';

/**
 * AXI-2463 (epic AXI-2455; TPL FR54, FR52, FR53, FR58, FR59, FR31; EC15, EC23, EC24; AC22;
 * @SI-069, @SI-045). T2 gains its composition-backed version `0.3`: a Kruskal-Wallis `omnibus`
 * step, a Dunn `pairwise` step that runs after it and is declared its post-hoc, the template-level
 * post-hoc choice (defaulted `always`), the comparison set over the `groupingColumn` slot, and the
 * omnibus p-value as the version's main result. T2 never gets a `0.4` (it takes no `alternative`,
 * EC28). The `0.2` recipe row is immutable and keeps resolving with no main result.
 *
 * Fixture: `opening-templates-paul-header.csv` (reused from AXI-2308/AXI-2462).
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2463.
 * Run: `BASE_URL=http://127.0.0.1:5173 API_BASE_URL=http://localhost:3000 npx playwright test tests/AXI-2455/AXI-2463-*`
 * Authored, NOT run against the demo stack — owner override (no e2e runs for epic AXI-2455).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const T2 = { outcome: 'igg4_g_l', groupingColumn: 'cluster_selon_acr_eular_2019' };
const LEVELS = ['C1', 'C2', 'C3', 'C4'];
const OMNIBUS_MAIN_RESULT = {
  output: 'omnibus_p_value',
  pValueField: 'pValue',
  signedEffectField: null,
  cellBound: false,
};

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let registry: RegistryApi;
let compositions: CompositionApi;

const stepOf = (composition: any, stepId: string) => composition?.steps?.find((s: any) => s.stepId === stepId);
const opNodes = (plan: any) => plan.nodes.filter((n: any) => n.operation);
/** A governed (composition) plan's operation ids — its nodes carry `operationId` at top level. */
const governedOps = (plan: any) => (plan?.nodes ?? []).map((n: any) => n.operationId);

/** A dry-run compile of T2@0.3's composition with the given post-hoc choice and comparison set. */
function compileBody(composition: any, posthoc: string, groups: string[]): any {
  return {
    template: null,
    composition,
    bindings: {
      slots: [
        { slotId: 'groupingColumn', columns: [T2.groupingColumn] },
        { slotId: 'outcome', columns: [T2.outcome] },
      ],
      parameters: [],
      posthoc,
      comparisonSet: { declaredLevels: LEVELS, observedLevels: LEVELS, groups },
    },
  };
}

test.describe.serial('AXI-2463 - T2 composition-backed version 0.3 (TPL FR54, FR58, FR31, AC22) @SI-069 @SI-045', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    registry = await registryApiAs('user');
    compositions = await compositionApiAs('user');
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
    await registry?.dispose();
    await compositions?.dispose();
  });

  test('FR54, FR52, FR53 - AXI-2463.1 T2 @0.3 resolves with the omnibus -> post-hoc composition and the comparison set', async () => {
    // Act
    const resolved = await registry.resolve('T2', '0.3');
    // Assert
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const composition = resolved.body.composition;
    expect(stepOf(composition, 'omnibus')?.operationId).toBe('stats.kruskal_wallis');
    expect(stepOf(composition, 'pairwise')).toMatchObject({
      operationId: 'stats.dunn_posthoc',
      runsAfter: ['omnibus'],
      posthocOf: 'omnibus',
    });
    expect(composition.posthoc).toEqual({ mode: 'defaulted', value: 'always' });
    expect(composition.comparisonSet).toEqual({ slotId: 'groupingColumn' });
  });

  test('FR58, FR59 - AXI-2463.2 T2 @0.3 declares the omnibus p-value as its main result; the immutable 0.2 declares none', async () => {
    // Act
    const recipe = await registry.resolve('T2', '0.2');
    const composed = await registry.resolve('T2', '0.3');
    // Assert
    expect(recipe.status, JSON.stringify(recipe.body)).toBe(200);
    expect(composed.status, JSON.stringify(composed.body)).toBe(200);
    expect(composed.body.mainResult).toEqual(OMNIBUS_MAIN_RESULT);
    expect(recipe.body).not.toHaveProperty('mainResult');
    // FR31: same recipe, same parameter schema — 0.3 adds composition data, never a new choice.
    expect(composed.body.parameters).toEqual(recipe.body.parameters);
  });

  test('FR54, EC28 - AXI-2463.3 the registry lists T2 0.2 + 0.3 and T2 has no 0.4', async () => {
    // Act
    const list = await registry.list();
    const v04 = await registry.resolve('T2', '0.4');
    // Assert
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const t2 = list.body.find((e: any) => e.templateId === 'T2');
    expect(t2?.versions).toEqual(['0.2', '0.3']);
    expect(v04.status).toBe(404);
  });

  test('AC22, EC23 - AXI-2463.4 the resolved T2 @0.3 composition validates PASS and compiles the post-hoc choice', async () => {
    // Arrange
    const composition = (await registry.resolve('T2', '0.3')).body.composition;
    // Act
    const validated = await compositions.validate({ composition });
    const always = await compositions.compile(compileBody(composition, 'always', ['C1', 'C2', 'C3']));
    const never = await compositions.compile(compileBody(composition, 'never', ['C1', 'C2', 'C3']));
    // Assert
    expect(validated.body.verdict, validated.text).toBe('PASS');
    expect(always.body.status, always.text).toBe('compiled');
    expect(governedOps(always.body.plan)).toEqual(['stats.kruskal_wallis', 'stats.dunn_posthoc']);
    expect(never.body.status, never.text).toBe('compiled');
    expect(governedOps(never.body.plan)).toEqual(['stats.kruskal_wallis']);
  });

  test('FR53, EC24 - AXI-2463.5 a one-level comparison set is refused, never compiled', async () => {
    // Arrange
    const composition = (await registry.resolve('T2', '0.3')).body.composition;
    // Act
    const res = await compositions.compile(compileBody(composition, 'always', ['C1']));
    // Assert
    expect(res.status, res.text).toBe(200);
    expect(res.body.status, res.text).toBe('refused');
    expect(res.body.plan).toBeUndefined();
  });

  test('FR31 - AXI-2463.6 the wizard compile of T2 (if_significant, explicit groups) still compiles omnibus then Dunn (regression)', async () => {
    // Act
    const res = await compileTemplate(api, t, dataset, 'T2', {
      datasetId: dataset.datasetId,
      ...T2,
      posthoc: 'if_significant',
      groups: ['C1', 'C2', 'C3'],
    });
    // Assert
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(opNodes(res.body.plan).map((n: any) => n.operation.operationId)).toEqual([
      'stats.kruskal_wallis',
      'stats.dunn_posthoc',
    ]);
  });
});
