import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { compileTemplate, ingestCsvFixture, OPENING_TEMPLATES_PATH } from '../AXI-2308/harness/opening-templates';
import { WIZARD_RUNS, wizardBody } from '../AXI-2308/harness/result-page';
import { psql, psqlRows } from '../AXI-1640/harness/seed';

/**
 * AXI-2453 (epic AXI-2455; TPL FR53, EC24; @SI-045). T2's comparison set and intent rule I05 share
 * one source of truth - the OBSERVED levels:
 *  - a declared level with no rows never enters the default set (headless default AND the wizard's
 *    "All N groups", which the server now builds from `candidates.grouping[].observedLevels`);
 *  - an explicit set naming it is still refused under I05;
 *  - an observed level that is NOT declared (observed ⊄ declared) is narrowed away by an `in`
 *    filter, so the default and the explicit full declared set both compile.
 *
 * Setup: a semantic declaration appended by direct `psql` (the same real-path escape hatch AXI-2407
 * uses - a declared level with no row cannot be produced by the profiler). The table is
 * APPEND-ONLY, so teardown restores the dataset's pre-spec declaration by appending a revision
 * equal to it (or an empty declaration when there was none) - never by deleting.
 *
 * Fixture: `opening-templates-paul-header.csv` (cluster C1..C4 observed, 24 rows).
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2453.
 * Run: `BASE_URL=http://127.0.0.1:5173 API_BASE_URL=http://localhost:3000 npx playwright test tests/AXI-2455/AXI-2453-*`
 * (the demo must serve the AXI-2453 back; on main .1/.4/.5/.6 refuse I05 by construction).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const UNOBSERVED = 'C5-unobserved';
const OBSERVED = ['C1', 'C2', 'C3', 'C4'];
const TABLE = 'organization_svc.dataset_semantic_declarations';
const T2 = { outcome: 'igg4_g_l', groupingColumn: CLUSTER };
const MARK = 'e2e-axi-2453';

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
/** The dataset's current declaration revision before this spec appended anything (0 = none). */
let priorRevision = 0;

const maxRevision = (): number =>
  Number(psqlRows(`SELECT COALESCE(MAX(revision), 0) FROM ${TABLE} WHERE dataset_id = '${dataset.datasetId}'`)[0] ?? '0');

function declareClusterLevels(levels: string[]): void {
  const declaration = JSON.stringify({ scopeRoles: [], templateColumnBindings: [{ column: CLUSTER, role: 'group', levels }] });
  const inserted = psql(
    `INSERT INTO ${TABLE} (dataset_semantic_declaration_id, workspace_id, dataset_id, revision, declaration, identity_hash, declared_by)
     VALUES (gen_random_uuid()::text, '${t.workspaceId}', '${dataset.datasetId}', ${maxRevision() + 1}, '${declaration}'::jsonb, '${MARK}', '${MARK}')`,
  );
  expect(inserted).toBe(true);
}

/** Teardown: the pre-spec declaration becomes current again, as a NEW revision equal to it. */
function restorePriorDeclaration(): void {
  const next = maxRevision() + 1;
  const restored = priorRevision > 0
    ? psql(`INSERT INTO ${TABLE} (dataset_semantic_declaration_id, workspace_id, dataset_id, revision, declaration, identity_hash, declared_by)
            SELECT gen_random_uuid()::text, workspace_id, dataset_id, ${next}, declaration, identity_hash, declared_by
            FROM ${TABLE} WHERE dataset_id = '${dataset.datasetId}' AND revision = ${priorRevision}`)
    : psql(`INSERT INTO ${TABLE} (dataset_semantic_declaration_id, workspace_id, dataset_id, revision, declaration, identity_hash, declared_by)
            VALUES (gen_random_uuid()::text, '${t.workspaceId}', '${dataset.datasetId}', ${next}, '{"scopeRoles":[],"templateColumnBindings":[]}'::jsonb, '${MARK}-restore', '${MARK}-restore')`);
  if (!restored) throw new Error(`AXI-2453 teardown could not restore declaration revision ${priorRevision} of ${dataset.datasetId}`);
}

const compileT2 = (extra: Record<string, unknown> = {}) =>
  compileTemplate(api, t, dataset, 'T2', { datasetId: dataset.datasetId, ...T2, ...extra });

const inFilter = (levels: string[]) => [{ column: CLUSTER, operator: 'in', value: levels }];

test.describe.serial('AXI-2453 - T2 default groups agree with I05 (FR53, EC24) @SI-045', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    priorRevision = maxRevision();
    declareClusterLevels([...OBSERVED, UNOBSERVED]);
  });

  test.afterAll(async () => {
    if (dataset) restorePriorDeclaration();
    await api?.ctx.dispose();
  });

  test('AXI-2453.1 FR53 - T2 with no explicit groups compiles on a column with a declared but unobserved level, over the observed levels only', async () => {
    // Act
    const res = await compileT2();
    // Assert
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.intents?.[0]?.groups).toEqual(OBSERVED);
    expect(JSON.stringify(res.body.intents)).not.toContain(UNOBSERVED);
  });

  test("AXI-2453.2 EC24 - an explicit set naming the unobserved level is still refused under I05, naming the group", async () => {
    // Act
    const res = await compileT2({ groups: ['C1', 'C2', UNOBSERVED] });
    // Assert
    expect(res.body).toMatchObject({ ok: false, code: 'INTENT_REFUSED' });
    expect(res.body.ruleIds).toContain('I05');
    expect((res.body.messages ?? []).join(' ')).toContain(`group '${UNOBSERVED}'`);
  });

  test('AXI-2453.3 FR53 - an explicit observed subset [C1,C2,C3] compiles, narrowed by an `in` filter', async () => {
    // Act
    const res = await compileT2({ groups: ['C1', 'C2', 'C3'] });
    // Assert
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.intents?.[0]?.groups).toEqual(['C1', 'C2', 'C3']);
    expect(res.body.intents?.[0]?.filters).toEqual(inFilter(['C1', 'C2', 'C3']));
  });

  test('AXI-2453.4 FR53 - the wizard: candidates carry the observed levels, and T2 launched with the default "All groups" is not refused I05', async () => {
    // Arrange - what the wizard reads (`/match`) and builds "All N groups" from
    const match = await api.post(`${OPENING_TEMPLATES_PATH}/match`, { projectId: t.projectId, dataset }, t.headers);
    expect(match.status, JSON.stringify(match.body)).toBeLessThan(300);
    const t2 = (match.body as any[]).find((m) => m.templateId === 'T2');
    const cluster = t2?.candidates?.grouping?.find((g: any) => g.column === CLUSTER);
    expect(cluster, JSON.stringify(t2)).toMatchObject({ levels: [...OBSERVED, UNOBSERVED], observedLevels: OBSERVED });
    const allGroups = (cluster.levels as string[]).filter((l) => (cluster.observedLevels as string[]).includes(l));
    expect(allGroups).toEqual(OBSERVED);
    const body = wizardBody(t, dataset, 'T2', 'Does IgG4 differ between the clusters?', 'compare_groups', [
      { slot: 'groupingColumn', value: CLUSTER },
      { slot: 'outcome', value: 'igg4_g_l' },
      { slot: 'groups', value: allGroups },
    ] as never);
    // The data settled the set (the front's `profile` provenance), as the wizard sends it.
    body.slots = body.slots.map((s: any) => (s.slot === 'groups' ? { ...s, provenance: 'profile' } : s));
    // Act
    const res = await api.post(WIZARD_RUNS, body, t.headers);
    // Assert
    expect(JSON.stringify(res.body)).not.toContain('I05');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.runId).toBeTruthy();
  });

  test('AXI-2453.5 FR53 - observed not a subset of declared (declared C1..C3, observed C1..C4): the default compiles over C1..C3 with an `in` filter', async () => {
    // Arrange
    declareClusterLevels(['C1', 'C2', 'C3']);
    // Act
    const res = await compileT2();
    // Assert
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.intents?.[0]?.groups).toEqual(['C1', 'C2', 'C3']);
    expect(res.body.intents?.[0]?.filters).toEqual(inFilter(['C1', 'C2', 'C3']));
  });

  test('AXI-2453.6 FR53 - observed not a subset of declared: the explicit full declared set compiles to the same plan; naming C4 is refused by the guard', async () => {
    // Act
    const explicit = await compileT2({ groups: ['C3', 'C1', 'C2'] });
    const byDefault = await compileT2();
    const c4 = await compileT2({ groups: ['C1', 'C2', 'C4'] });
    // Assert
    expect(explicit.body.ok, JSON.stringify(explicit.body)).toBe(true);
    expect(explicit.body.intents?.[0]?.filters).toEqual(inFilter(['C1', 'C2', 'C3']));
    expect(explicit.body.plan?.planId).toBe(byDefault.body.plan?.planId);
    expect(c4.body).toMatchObject({ ok: false, code: 'GUARD_UNMET' });
  });
});
