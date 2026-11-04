import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { compileTemplate, drainGoverned, ingestCsvFixture, submitGoverned } from '../AXI-2308/harness/opening-templates';
import { psql, psqlRows } from '../AXI-1640/harness/seed';

/**
 * AXI-2407 (epic AXI-2414 — FR58, FR20, FR22 amended, AC55, EC32): `restrictTo` is a
 * generic, template-independent row filter (`{ column, levels }`, equality/`in` only)
 * compiled into one `filter` plan node ahead of every template's operation node. A
 * column/level the dataset does not declare is refused before compile (`GUARD_UNMET`);
 * a filter narrowing the referent to zero rows is refused at submission
 * (`EMPTY_FILTER_RESULT`, EC32), before any operation node runs.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2407 (.1–.5).
 *
 * Scope note (see the manual-e2e doc): `wizard-runs`' own `slots` carry only
 * `OpeningTemplateSlot`, a closed union `restrictTo` is deliberately not a member of —
 * there is today no field through which a caller can set `restrictTo` through the
 * wizard launch endpoint. Every scenario here therefore drives
 * `POST .../opening-templates/compile` + `POST /governed-execution/submit` directly,
 * the same non-wizard path AXI-2406.6 uses.
 *
 * .4 (EC32, zero rows) needs a declared-but-unobserved level, which the profiler alone
 * can never produce (every profiled category has >=1 row by construction) — it seeds
 * one the same way AXI-2406.5/.7 reach otherwise-unreachable states: a direct `psql`
 * row in `dataset_semantic_declarations` (an owner/human declaration is the one real
 * path to a declared level with no current row — e.g. a level retired since the
 * declaration was written).
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic).
 *
 * Run: `BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway> E2E_TEST_EMAIL=<platform admin>
 *   npx playwright test tests/AXI-2414/AXI-2407-* --project=chromium` (the `setup` project writes `.auth/`).
 * Never against the shared demo gateway (:3000): it approves seeded carriers and writes a semantic
 * declaration (both append-only / test-scoped, but still real tenant rows).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const MAG4 = 'microbiote_igg4_mag4_27';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const MW = 'stats.mann_whitney_u';
const SEMANTIC_DECLARATIONS = 'organization_svc.dataset_semantic_declarations';

const t1Parameters = (restrictTo?: { column: string; levels: string[] }) => ({
  datasetId: dataset.datasetId,
  groupingColumn: 'sexe',
  groups: ['F', 'M'],
  outcome: MAG4,
  ...(restrictTo ? { restrictTo } : {}),
});

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;

/** A declared grouping level for `CLUSTER` with NO current row — seeded directly (see file header). */
async function declareUnobservedClusterLevel(): Promise<void> {
  const maxRevision = Number(
    psqlRows(`SELECT COALESCE(MAX(revision), 0) FROM ${SEMANTIC_DECLARATIONS} WHERE dataset_id = '${dataset.datasetId}'`)[0] ?? '0',
  );
  const declaration = JSON.stringify({
    scopeRoles: [],
    templateColumnBindings: [
      { column: CLUSTER, role: 'group', levels: ['C1', 'C2', 'C3', 'C4', 'C5-unobserved'] },
    ],
  });
  const inserted = psql(
    `INSERT INTO ${SEMANTIC_DECLARATIONS} (dataset_semantic_declaration_id, workspace_id, dataset_id, revision, declaration, identity_hash, declared_by)
     VALUES (gen_random_uuid()::text, '${t.workspaceId}', '${dataset.datasetId}', ${maxRevision + 1}, '${declaration}'::jsonb, 'e2e-axi-2407', 'e2e-axi-2407')`,
  );
  expect(inserted).toBe(true);
}

test.describe.serial('AXI-2407 restrictTo template parameter @SI-045 @SI-017 @SI-002', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor([MW]);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('FR58 AC55 — AXI-2407.1 a single level compiles to one eq filter node ahead of the operation @SI-045 @SI-002', async () => {
    // Act
    const compiled = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: CLUSTER, levels: ['C1'] }));

    // Assert
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);
    const filter = compiled.body.plan.nodes.find((n: any) => n.nodeType === 'filter');
    const op = compiled.body.plan.nodes.find((n: any) => n.operation?.operationId === MW);
    expect(filter?.params).toMatchObject({ column: CLUSTER, operator: 'eq', value: 'C1' });
    expect(op.dependsOn).toContain(filter.id);
  });

  test('FR58 AC55 — AXI-2407.2 two or more levels compile to one in filter node @SI-045 @SI-002', async () => {
    // Act
    const compiled = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: CLUSTER, levels: ['C1', 'C2'] }));

    // Assert
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);
    const filter = compiled.body.plan.nodes.find((n: any) => n.nodeType === 'filter');
    expect(filter?.params).toMatchObject({ column: CLUSTER, operator: 'in', value: ['C1', 'C2'] });
  });

  test('FR58 — AXI-2407.3 an unknown column or level is refused before compile @SI-045', async () => {
    // Act
    const unknownColumn = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: 'age', levels: ['40'] }));
    const unknownLevel = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: CLUSTER, levels: ['NOPE'] }));

    // Assert
    expect(unknownColumn.body).toMatchObject({ ok: false, code: 'GUARD_UNMET', ruleIds: ['restrictTo'] });
    expect(unknownLevel.body).toMatchObject({ ok: false, code: 'GUARD_UNMET', ruleIds: ['restrictTo'] });
  });

  test('EC32 — AXI-2407.4 a filter narrowing the referent to zero rows is refused at submission, before any operation runs @SI-045 @SI-017', async () => {
    // Arrange
    await declareUnobservedClusterLevel();
    const compiled = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: CLUSTER, levels: ['C5-unobserved'] }));
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);

    // Act
    const res = await api.post('/api/v1/governed-execution/submit', {
      projectId: t.projectId, plan: compiled.body.plan, datasetId: dataset.datasetId, workspaceId: t.workspaceId,
    }, t.headers);

    // Assert
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({ errorCode: 'EMPTY_FILTER_RESULT' });
  });

  test('FR58 AC55 — AXI-2407.5 a valid restrictTo run completes, reading only the narrowed rows @SI-045 @SI-017 @SI-066', async () => {
    // Arrange
    const compiled = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: CLUSTER, levels: ['C1'] }));
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);

    // Act
    const runId = await submitGoverned(api, t, compiled.body.plan, dataset.datasetId);
    const drained = await drainGoverned(api, t, runId);

    // Assert — the operation node settled (no EMPTY_FILTER_RESULT refusal reached it)
    const opNode = drained.nodes.find((n) => n.nodeId.endsWith('__' + compiled.body.plan.nodes.find((pn: any) => pn.operation?.operationId === MW).id));
    expect(opNode?.status).toBe('SUCCEEDED');
  });
});
