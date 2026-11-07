import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { compileTemplate, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { psql, psqlRows } from '../AXI-1640/harness/seed';

/**
 * AXI-2453 (epic AXI-2455; TPL FR53, EC24; @SI-045). T2's default comparison set and intent rule
 * I05 share one source of truth - the OBSERVED levels. A declared level with no rows never enters
 * the default set; an explicit set naming it is still refused under I05.
 *
 * Setup: a semantic declaration (direct `psql`, the same real-path escape hatch AXI-2407 uses) that
 * declares the cluster column's levels as C1..C4 + `C5-unobserved`; the fixture carries C1..C4 only.
 *
 * Run: `BASE_URL=http://127.0.0.1:5173 API_BASE_URL=http://localhost:3000 npx playwright test tests/AXI-2455/AXI-2453-*`
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const UNOBSERVED = 'C5-unobserved';
const SVC = 'organization_svc';
const T2 = { outcome: 'igg4_g_l', groupingColumn: CLUSTER };

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;

function declareUnobservedClusterLevel(): void {
  const table = `${SVC}.dataset_semantic_declarations`;
  const maxRevision = Number(psqlRows(`SELECT COALESCE(MAX(revision), 0) FROM ${table} WHERE dataset_id = '${dataset.datasetId}'`)[0] ?? '0');
  const declaration = JSON.stringify({
    scopeRoles: [],
    templateColumnBindings: [{ column: CLUSTER, role: 'group', levels: ['C1', 'C2', 'C3', 'C4', UNOBSERVED] }],
  });
  const inserted = psql(
    `INSERT INTO ${table} (dataset_semantic_declaration_id, workspace_id, dataset_id, revision, declaration, identity_hash, declared_by)
     VALUES (gen_random_uuid()::text, '${t.workspaceId}', '${dataset.datasetId}', ${maxRevision + 1}, '${declaration}'::jsonb, 'e2e-axi-2453', 'e2e-axi-2453')`,
  );
  expect(inserted).toBe(true);
}

test.describe.serial('AXI-2453 - T2 default groups agree with I05 (FR53, EC24) @SI-045', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    declareUnobservedClusterLevel();
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2453.1 FR53 - T2 with no explicit groups compiles on a column with a declared but unobserved level, over the observed levels only', async () => {
    // Act
    const res = await compileTemplate(api, t, dataset, 'T2', { datasetId: dataset.datasetId, ...T2 });
    // Assert
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const groups = JSON.stringify(res.body.intents?.[0]?.groups ?? res.body.plan);
    expect(groups).not.toContain(UNOBSERVED);
    expect(res.body.intents?.[0]?.groups).toEqual(['C1', 'C2', 'C3', 'C4']);
  });

  test('AXI-2453.2 EC24 - an explicit set naming the unobserved level is still refused under I05', async () => {
    // Act
    const res = await compileTemplate(api, t, dataset, 'T2', { datasetId: dataset.datasetId, ...T2, groups: ['C1', 'C2', UNOBSERVED] });
    // Assert
    expect(res.body).toMatchObject({ ok: false, code: 'INTENT_REFUSED' });
    expect(res.body.ruleIds).toContain('I05');
  });
});
