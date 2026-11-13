import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { compileTemplate, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';

/**
 * AXI-2461 (epic AXI-2455; TPL FR55, FR58, FR59, FR31, EC28; @SI-069, @SI-045). T1 (Mann-Whitney U)
 * and T4 (adjusted correlation) accept a one-sided `alternative` (`two_sided` default/absent,
 * `greater`, `less`), forwarded into the compiled plan's `operationParams` only when supplied
 * (FR31: the default path is byte-identical to before this story). T2 declares no `alternative`
 * choice slot and is refused when given one (EC28).
 *
 * Fixture: `opening-templates-paul-header.csv` (reused from AXI-2308/AXI-2453).
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2461.
 * Run: `BASE_URL=http://127.0.0.1:5173 API_BASE_URL=http://localhost:3000 npx playwright test tests/AXI-2455/AXI-2461-*`
 * Authored, NOT run against the demo stack — owner override (no e2e runs for epic AXI-2455).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const T1 = { outcome: 'igg4_g_l', groupingColumn: 'sexe', groups: ['F', 'M'] };
const T2 = { outcome: 'igg4_g_l', groupingColumn: 'cluster_selon_acr_eular_2019' };
const T4 = { x: 'microbiote_igg4_mag4_27', y: ['igg4_g_l'], adjustFor: 'age' };

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;

const opNodeOf = (plan: any) => plan.nodes.find((n: any) => n.operation);

test.describe.serial('AXI-2461 - T1/T4 alternative (TPL FR55, AC23) @SI-069 @SI-045', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2461.1 FR55 - T1 compiles a one-sided alternative into the Mann-Whitney node, forwarded alongside groupFrom/groupTo', async () => {
    // Act
    const greater = await compileTemplate(api, t, dataset, 'T1', {
      datasetId: dataset.datasetId,
      ...T1,
      alternative: 'greater',
    });
    const absent = await compileTemplate(api, t, dataset, 'T1', { datasetId: dataset.datasetId, ...T1 });
    // Assert
    expect(greater.body.ok, JSON.stringify(greater.body)).toBe(true);
    expect(opNodeOf(greater.body.plan)?.operation).toMatchObject({
      operationId: 'stats.mann_whitney_u',
      operationParams: { groupFrom: 'F', groupTo: 'M', alternative: 'greater' },
    });
    // FR31: the default (no alternative) path stays byte-identical to before this story.
    expect(absent.body.ok, JSON.stringify(absent.body)).toBe(true);
    expect(opNodeOf(absent.body.plan)?.operation?.operationParams).toEqual({
      groupFrom: 'F',
      groupTo: 'M',
    });
  });

  test('AXI-2461.2 FR55 - T4 compiles a one-sided alternative into the partial-correlation node, forwarded alongside method', async () => {
    // Act
    const less = await compileTemplate(api, t, dataset, 'T4', {
      datasetId: dataset.datasetId,
      ...T4,
      alternative: 'less',
    });
    // Assert
    expect(less.body.ok, JSON.stringify(less.body)).toBe(true);
    expect(opNodeOf(less.body.plan)?.operation).toMatchObject({
      operationId: 'stats.partial_correlation',
      operationParams: { method: 'spearman', alternative: 'less' },
    });
  });

  test('AXI-2461.3 EC28 - T2 refuses an alternative parameter it never declared, naming the slot', async () => {
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
