import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { compileTemplate, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { registryApiAs, type RegistryApi } from './harness/registry-api';
import { compositionApiAs, type CompositionApi } from './harness/composition-api';

/**
 * AXI-2431 (epic AXI-2422 — Analysis Template Library, story F — FR29–FR32, NFR6; AC10, EC15).
 * T1, T3, T4 and T5 gain a composition-backed system version `0.3` (T2 is blocked — composition v1
 * has no ordering edge for its Dunn-after-Kruskal-Wallis post-hoc); `0.2` is untouched and the
 * guided wizard compiles T1–T5 exactly as before. Scenario doc:
 * `axiome-docs/manual-e2e/AXI-2422-Analysis-Template-Library.md` § AXI-2431 (F1–F4).
 *
 * API-only, no LLM anywhere on these paths (the wizard compile and the composition compile are
 * deterministic); the stack runs `GUIDED_ANALYSIS_LLM_TRANSPORT=recorded` regardless. Login is the
 * platform admin over the API. Nothing is submitted or run: this spec writes only the tenant's
 * fixture dataset (idempotent), never a template.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (synthetic, the
 * investigator's header shape). Its second column is avoided (the profiler types it timepoint —
 * see AXI-2339's spec header).
 *
 * STATUS: RUN headless, 4/4 green (2026-11-06) against the demo stack (gateway :3000) after
 * AXI-2431's merge, with migration `20261106170000_analysis_template_version_composition` applied
 * and organization-service restarted (the boot seed wrote the `0.3` rows). Run:
 * `API_BASE_URL=<gateway> npx playwright test tests/AXI-2422/AXI-2431-*`
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const MAG4 = ['microbiote_igg4_mag4_27', 'microbiote_igg4_mag4_22', 'microbiote_igg4_mag4_13'];
const CLUSTER = 'cluster_selon_acr_eular_2019';
const MIGRATED = ['T1', 'T3', 'T4', 'T5'] as const;

let api: Api;
let t: Tenant;
let datasetId: string;
let dataset: AnchoredDataset;
let registry: RegistryApi;
let compositions: CompositionApi;

function wizardParams(templateId: string): Record<string, unknown> {
  const byTemplate: Record<string, Record<string, unknown>> = {
    T1: { outcome: MAG4[0], groupingColumn: 'sexe', groups: ['F', 'M'] },
    // No explicit set (AXI-2453): the default is the OBSERVED levels, so a declared-but-unobserved
    // cluster level on a shared tenant (AXI-2407's `C5-unobserved`) no longer trips I05.
    T2: { outcome: 'igg4_g_l', groupingColumn: CLUSTER },
    T3: { x: 'igg4_g_l', y: MAG4 },
    T4: { x: MAG4[0], y: ['igg4_g_l'], adjustFor: 'age' },
    T5: { references: MAG4.slice(0, 2), y: [MAG4[2], 'igg4_g_l'] },
  };
  return { datasetId, ...byTemplate[templateId] };
}

/** The composition bindings the wizard's parameters map to (the back's `openingCompositionBindings`). */
function bindingsFor(templateId: string, p: any) {
  const slots: Record<string, Array<{ slotId: string; columns: string[] }>> = {
    T1: [{ slotId: 'groupingColumn', columns: [p.groupingColumn] }, { slotId: 'outcome', columns: [p.outcome] }],
    T3: [{ slotId: 'x', columns: [p.x] }, { slotId: 'y', columns: p.y }],
    T4: [{ slotId: 'x', columns: [p.x] }, { slotId: 'y', columns: [p.y?.[0]] }, { slotId: 'adjustFor', columns: [p.adjustFor] }],
    T5: [{ slotId: 'references', columns: p.references }, { slotId: 'y', columns: p.y }],
  };
  const parameters = templateId === 'T1'
    ? [{ stepId: 'compare', key: 'groupFrom', value: p.groups[0] }, { stepId: 'compare', key: 'groupTo', value: p.groups[1] }]
    : [];
  return { slots: slots[templateId], parameters };
}

const asList = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

/** What executes in a wizard plan: per operation node, operation, role → columns, params, edges. */
function wizardSurface(plan: any) {
  const ops = (plan.nodes as any[]).filter((n) => n.operation);
  const position = new Map(ops.map((n, i) => [n.id, i]));
  return ops.map((n) => ({
    operationId: n.operation.operationId,
    roles: Object.fromEntries(Object.entries(n.operation.roleBindings ?? {}).map(([k, v]) => [k, asList(v as any)])),
    parameters: n.operation.operationParams ?? {},
    dependsOn: (n.dependsOn as string[]).filter((d) => position.has(d)).map((d) => position.get(d)),
  }));
}

function governedSurface(plan: any) {
  const position = new Map((plan.nodes as any[]).map((n, i) => [n.nodeId, i]));
  return (plan.nodes as any[]).map((n) => ({
    operationId: n.operationId,
    roles: Object.fromEntries(n.roleBindings.map((b: any) => [b.role, b.sources.map((s: any) => s.column)])),
    parameters: Object.fromEntries(n.parameters.map((x: any) => [x.key, x.value])),
    dependsOn: (n.dependsOn as string[]).map((d) => position.get(d)),
  }));
}

async function wizardCompile(templateId: string) {
  const res = await compileTemplate(api, t, dataset, templateId, wizardParams(templateId));
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
  return res.body;
}

test.describe.serial('AXI-2431 — T1–T5 migration to composition data (AC10, EC15) @SI-069 @SI-045', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    registry = await registryApiAs('admin');
    compositions = await compositionApiAs('admin');
  });

  test.afterAll(async () => {
    await registry?.dispose();
    await compositions?.dispose();
    await api?.ctx.dispose();
  });

  test('AXI-2431.F1 AC10 — T1/T3/T4/T5 list 0.2 + 0.3 and 0.3 serves its composition; T2 stays 0.2 only; 0.2 carries no composition', async () => {
    // Act
    const list = await registry.list();
    // Assert
    expect(list.status).toBe(200);
    const versions = Object.fromEntries(list.body.map((e: any) => [e.templateId, e.versions]));
    for (const id of MIGRATED) expect(versions[id], id).toEqual(['0.2', '0.3']);
    expect(versions.T2).toEqual(['0.2']);
    for (const id of MIGRATED) {
      const v3 = await registry.resolve(id, '0.3');
      const v2 = await registry.resolve(id, '0.2');
      expect(v3.status, id).toBe(200);
      expect(v3.body).toMatchObject({ templateId: id, templateVersion: '0.3', recipeKey: id });
      expect(v3.body.composition.steps.length, id).toBeGreaterThan(0);
      expect({ ...v3.body, templateVersion: '0.2', composition: undefined }).toEqual({ ...v2.body, composition: undefined });
      expect(v2.body).not.toHaveProperty('composition');
    }
    expect((await registry.resolve('T2', '0.3')).status).toBe(404);
  });

  test('AXI-2431.F2 AC10 — the wizard compiles T1–T5 as before: ok, the same planId on recompile, templateRef @0.2', async () => {
    for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) {
      // Act
      const first = await wizardCompile(id);
      const again = await wizardCompile(id);
      // Assert
      expect(again.plan.planId, id).toBe(first.plan.planId);
      expect(first.plan.templateRef, id).toMatchObject({ templateId: `OPENING-${id}`, templateVersion: '0.2' });
    }
  });

  test('AXI-2431.F3 AC10 NFR6 — each migrated 0.3 composition compiles to the wizard plan\'s execution surface', async () => {
    for (const id of MIGRATED) {
      // Arrange
      const composition = (await registry.resolve(id, '0.3')).body.composition;
      const wizard = await wizardCompile(id);
      // Act
      const res = await compositions.compile({
        template: { templateId: id, templateVersion: '0.3' },
        composition,
        bindings: bindingsFor(id, wizardParams(id)),
      });
      // Assert
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status, JSON.stringify(res.body)).toBe('compiled');
      expect(governedSurface(res.body.plan), id).toEqual(wizardSurface(wizard.plan));
    }
  });

  test('AXI-2431.F4 AC10 — AUTOMATIC_TEMPLATE_IDS is preserved: T5@0.3 is guided-only, T1@0.3 is not', async () => {
    // Act
    const t5 = await registry.resolve('T5', '0.3');
    const t1 = await registry.resolve('T1', '0.3');
    // Assert
    expect(t5.body.guidedOnly).toBe(true);
    expect(t1.body.guidedOnly).toBe(false);
  });
});
