import { test, expect } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { compileTemplate, drainGoverned, ingestCsvFixture, submitGoverned } from '../AXI-2308/harness/opening-templates';
import { answered, askQuestion, choose, gotoSettled, seedScope, stubWizardRoutes } from '../AXI-2308/harness/new-analysis';
import { WIZARD_RUNS, wizardBody } from '../AXI-2308/harness/result-page';
import { psql, psqlRows } from '../AXI-1640/harness/seed';

/**
 * AXI-2407 (epic AXI-2414 — FR58, FR20, FR22 amended, FR49, AC55, EC32): `restrictTo` is a
 * generic, template-independent row filter (`{ column, levels }`, equality/`in` only) compiled
 * into one `filter` plan node ahead of every template's operation node. A column/level the
 * dataset does not declare is refused before compile (`GUARD_UNMET`); a filter narrowing the
 * referent to zero rows is refused at submission (`EMPTY_FILTER_RESULT`, EC32) BEFORE anything
 * is written — no analysis container, no governed run, no wizard record.
 *
 * Through the wizard (AC55, review bounce #1 B1): `POST /guided-analysis/wizard-runs/restrict-to`
 * serves the ONE wording, the columns that may be named and what the question says (with its
 * FR49 span); `POST /guided-analysis/wizard-runs` carries the answer (`restrictTo`, provenance
 * `question` or `decided`), re-checks it, compiles it and records it. Ready shows it as a
 * "Limited to" row with a plain-words Change — never a filter table.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2407 (.1–.9).
 *
 * .4/.8 (EC32, zero rows) need a declared-but-unobserved level, which the profiler alone can never
 * produce (every profiled category has >=1 row by construction) — seeded the same way AXI-2406.5/.7
 * reach otherwise-unreachable states: a direct `psql` row in `dataset_semantic_declarations` (an
 * owner declaration is the one real path to a declared level with no current row — e.g. a level
 * retired since the declaration was written). Declared bindings MERGE with the profile
 * (`columnRolesOf`), so `sexe` stays a grouping column afterwards.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic,
 * 24 rows). Cluster x sexe: C1 = 6 F, C2 = 6 F, C3 = 6 M, C4 = 6 M — so a two-sex comparison
 * restricted to ONE cluster has a single group; every restriction here keeps one F and one M
 * cluster (12 rows of 24).
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
const SVC = 'organization_svc';
const UNOBSERVED = 'C5-unobserved';
const ALL_ROWS_N = 24;
const WIZARD_QUESTION = `Does ${MAG4} differ between F and M in C2 or C4?`;
const T1_SLOTS = [{ slot: 'groupingColumn', value: 'sexe' }, { slot: 'groups', value: ['F', 'M'] }, { slot: 'outcome', value: MAG4 }];
const UI_QUESTION = 'Does IgG4 differ by sex in C2 or C4?';
const UI_READ = answered(UI_QUESTION, 'compare_groups', [['outcome', 'igg4_g_l', 'IgG4'], ['groupingColumn', 'sexe', 'by sex']]);

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
  const table = `${SVC}.dataset_semantic_declarations`;
  const maxRevision = Number(psqlRows(`SELECT COALESCE(MAX(revision), 0) FROM ${table} WHERE dataset_id = '${dataset.datasetId}'`)[0] ?? '0');
  const declaration = JSON.stringify({
    scopeRoles: [],
    templateColumnBindings: [{ column: CLUSTER, role: 'group', levels: ['C1', 'C2', 'C3', 'C4', UNOBSERVED] }],
  });
  const inserted = psql(
    `INSERT INTO ${table} (dataset_semantic_declaration_id, workspace_id, dataset_id, revision, declaration, identity_hash, declared_by)
     VALUES (gen_random_uuid()::text, '${t.workspaceId}', '${dataset.datasetId}', ${maxRevision + 1}, '${declaration}'::jsonb, 'e2e-axi-2407', 'e2e-axi-2407')`,
  );
  expect(inserted).toBe(true);
}

/** Everything EC32's refusal must not have written: analysis containers, governed runs, wizard records. */
function durableWrites(): { analyses: number; runs: number; records: number } {
  const n = (sql: string) => Number(psqlRows(sql)[0] ?? 'NaN');
  return {
    analyses: n(`SELECT COUNT(*) FROM ${SVC}.view_analyses WHERE project_id = '${t.projectId}'`),
    runs: n(`SELECT COUNT(*) FROM ${SVC}.governed_runs WHERE tenant_id = '${t.workspaceId}'`),
    records: n(`SELECT COUNT(*) FROM ${SVC}.guided_wizard_records WHERE project_id = '${t.projectId}'`),
  };
}

/** The rule run a settled governed run's operation produced (a reuse reads the canonical run's table). */
async function operationRun(settled: Record<string, unknown>): Promise<{ id: string; tableRunId: string; snapshotId: string }> {
  const id = settled.ruleRunId as string;
  expect(id, JSON.stringify(settled)).toBeTruthy();
  const run = (await api.get(`/api/v1/rule-runs/${id}`, t.headers)).body as { status: string; dedupedFromRunId?: string | null };
  const tableRunId = run.status === 'DEDUPED' && run.dedupedFromRunId ? run.dedupedFromRunId : id;
  const [snapshotId] = psqlRows(`SELECT snapshot_id FROM ${SVC}.rule_runs WHERE id = '${id}'`);
  return { id, tableRunId, snapshotId };
}

/** n of a Mann–Whitney result: both groups' sizes from its result table. */
async function mannWhitneyN(tableRunId: string): Promise<number> {
  const res = await api.get(`/api/v1/rule-runs/${tableRunId}/table`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const row = (res.body.rows ?? [])[0] ?? {};
  return Number(row.nGroupFrom) + Number(row.nGroupTo);
}

/** The analysis's ONE filter snapshot naming `CLUSTER` (the baseline has no filters). */
function clusterFilterSnapshots(viewAnalysisId: string): string[] {
  return psqlRows(
    `SELECT id FROM ${SVC}.view_analysis_snapshots WHERE view_analysis_id = '${viewAnalysisId}' AND origin = 'filter' AND filters::text LIKE '%${CLUSTER}%'`,
  );
}

async function submitRaw(plan: unknown) {
  return api.post('/api/v1/governed-execution/submit', { projectId: t.projectId, plan, datasetId: dataset.datasetId, workspaceId: t.workspaceId }, t.headers);
}

async function offerFor(question: string, groupingColumn: string | null) {
  const res = await api.post(`${WIZARD_RUNS}/restrict-to`, { projectId: t.projectId, dataset, question, groupingColumn }, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

test.describe.serial('AXI-2407 restrictTo template parameter @SI-045 @SI-017 @SI-002 @SI-066 @SI-010', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor([MW]);
    await silenceTours(await adminToken());
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
    const compiled = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: CLUSTER, levels: ['C1', 'C3'] }));

    // Assert
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);
    const filter = compiled.body.plan.nodes.find((n: any) => n.nodeType === 'filter');
    expect(filter?.params).toMatchObject({ column: CLUSTER, operator: 'in', value: ['C1', 'C3'] });
  });

  test('FR58 — AXI-2407.3 an unknown column or level, or a malformed restrictTo, is a GUARD_UNMET refusal — never a 500 @SI-045', async () => {
    // Act
    const unknownColumn = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: 'age', levels: ['40'] }));
    const unknownLevel = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: CLUSTER, levels: ['NOPE'] }));
    const malformed = await Promise.all(
      [{ column: CLUSTER }, { column: CLUSTER, levels: 'C1' }, { column: 3, levels: ['C1'] }, { column: CLUSTER, levels: ['C1', 'C1'] }].map((restrictTo) =>
        compileTemplate(api, t, dataset, 'T1', { ...t1Parameters(), restrictTo }),
      ),
    );

    // Assert
    for (const res of [unknownColumn, unknownLevel, ...malformed]) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(res.body).toMatchObject({ ok: false, code: 'GUARD_UNMET', ruleIds: ['restrictTo'] });
    }
  });

  test('EC32 — AXI-2407.4 a filter narrowing the referent to zero rows is refused at submission before anything is written @SI-045 @SI-017', async () => {
    // Arrange
    await declareUnobservedClusterLevel();
    const compiled = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: CLUSTER, levels: [UNOBSERVED] }));
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);
    const before = durableWrites();

    // Act
    const res = await submitRaw(compiled.body.plan);

    // Assert — refused, and NO analysis container and NO governed run were created for it
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({ errorCode: 'EMPTY_FILTER_RESULT' });
    expect(durableWrites()).toEqual(before);
  });

  test('FR58 AC55 — AXI-2407.5 a valid restrictTo run reads ONLY the narrowed rows: the operation\'s referent is the filter snapshot and its n is below the unfiltered n @SI-045 @SI-017 @SI-066', async () => {
    // Arrange — the same comparison over every row, for the unfiltered n
    const unfiltered = await compileTemplate(api, t, dataset, 'T1', t1Parameters());
    expect(unfiltered.body.ok, JSON.stringify(unfiltered.body)).toBe(true);
    const allRuns = await operationRun(await drainGoverned(api, t, await submitGoverned(api, t, unfiltered.body.plan, dataset.datasetId)));
    const unfilteredN = await mannWhitneyN(allRuns.tableRunId);
    const compiled = await compileTemplate(api, t, dataset, 'T1', t1Parameters({ column: CLUSTER, levels: ['C1', 'C3'] }));
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);

    // Act
    const submitted = await submitRaw(compiled.body.plan);
    expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
    const settled = await drainGoverned(api, t, submitted.body.runId);

    // Assert — the operation settled, on the filter's snapshot, over fewer rows
    const opPlanId = compiled.body.plan.nodes.find((pn: any) => pn.operation?.operationId === MW).id;
    expect(settled.nodes.find((n) => n.nodeId.endsWith('__' + opPlanId))?.status).toBe('SUCCEEDED');
    const filtered = await operationRun(settled);
    const filterSnapshots = clusterFilterSnapshots(submitted.body.viewAnalysisId);
    expect(filterSnapshots).toHaveLength(1);
    expect(filtered.snapshotId).toBe(filterSnapshots[0]);
    expect(unfilteredN).toBe(ALL_ROWS_N);
    expect(await mannWhitneyN(filtered.tableRunId)).toBe(12);
  });

  test('FR58 FR49 AC55 — AXI-2407.6 the wizard offer reads the restriction from the question, with its exact words, in the server\'s one wording @SI-045 @SI-010', async () => {
    // Act
    const offer = await offerFor(WIZARD_QUESTION, 'sexe');
    const silent = await offerFor(`Does ${MAG4} differ between F and M?`, 'sexe');
    // B5: an article or a count is never read as a level — "a", "2" are ordinary words here
    const ordinary = await offerFor(`Is there a difference in ${MAG4} between F and M, comparing 2 groups?`, 'sexe');

    // Assert
    expect(offer.wording).toEqual({
      name: 'Limited to',
      question: 'Do you want to limit this to certain rows?',
      hint: 'Pick a column and the level(s) to keep — e.g. only disease cases, or only one visit.',
    });
    expect(offer.options.map((o: any) => o.column)).toContain(CLUSTER);
    expect(offer.options.map((o: any) => o.column)).not.toContain('sexe');
    expect(offer.reading).toMatchObject({ column: CLUSTER, levels: ['C2', 'C4'], sourceSpan: { text: 'C2 or C4' } });
    expect(WIZARD_QUESTION.slice(offer.reading.sourceSpan.start, offer.reading.sourceSpan.end)).toBe('C2 or C4');
    expect(silent.reading).toBeNull();
    expect(ordinary.reading).toBeNull();
  });

  test('FR58 AC55 — AXI-2407.7 a wizard launch carrying the question\'s restriction compiles the filter, runs on it and records it @SI-045 @SI-017 @SI-010', async () => {
    // Arrange
    const { reading } = await offerFor(WIZARD_QUESTION, 'sexe');
    const restrictTo = { column: reading.column, levels: reading.levels, provenance: 'question', sourceSpan: reading.sourceSpan, answeredAt: new Date().toISOString() };

    // Act
    const res = await api.post(WIZARD_RUNS, { ...wizardBody(t, dataset, 'T1', WIZARD_QUESTION, 'compare_groups', T1_SLOTS), restrictTo }, t.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    const settled = await drainGoverned(api, t, res.body.runId);

    // Assert — the record carries the answer; the operation read the filter's 12 rows
    const records = (await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}&runId=${res.body.runId}`, t.headers)).body.records;
    expect(records[0].restrictTo).toMatchObject({ column: CLUSTER, levels: ['C2', 'C4'], provenance: 'question', sourceSpan: reading.sourceSpan });
    const run = await operationRun(settled);
    expect(clusterFilterSnapshots(res.body.viewAnalysisId)).toEqual([run.snapshotId]);
    expect(await mannWhitneyN(run.tableRunId)).toBe(12);
  });

  test('FR49 — AXI-2407.8 a "question" restriction the question does not say is refused, and a zero-row restriction is EMPTY_FILTER_RESULT — neither writes anything @SI-045 @SI-010', async () => {
    // Arrange
    const before = durableWrites();
    const at = new Date().toISOString();
    const base = wizardBody(t, dataset, 'T1', WIZARD_QUESTION, 'compare_groups', T1_SLOTS);
    const span = { text: 'C2', start: WIZARD_QUESTION.indexOf('C2'), end: WIZARD_QUESTION.indexOf('C2') + 2 };

    // Act
    const unread = await api.post(WIZARD_RUNS, { ...base, restrictTo: { column: CLUSTER, levels: ['C1'], provenance: 'question', sourceSpan: span, answeredAt: at } }, t.headers);
    const empty = await api.post(WIZARD_RUNS, { ...base, restrictTo: { column: CLUSTER, levels: [UNOBSERVED], provenance: 'decided', answeredAt: at } }, t.headers);

    // Assert
    expect(unread.status, JSON.stringify(unread.body)).toBe(200);
    expect(unread.body).toMatchObject({ ok: false, code: 'ANSWERS_REFUSED', ruleIds: ['WIZ_RESTRICT_TO_NOT_READ'] });
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body).toMatchObject({ ok: false, code: 'EMPTY_FILTER_RESULT' });
    expect(durableWrites()).toEqual(before);
  });

  test('AC55 FR22 — AXI-2407.9 Ready shows "Limited to" from the question\'s words, asks in plain words on Change (no filter table), and Run sends it @SI-066 @SI-010', async ({ page }) => {
    // Arrange — a real suggestion call id, so the question-read slots are citable (AXI-2327's recipe)
    const suggested = await api.post('/api/v1/guided-analysis/intent-prefill/suggest', { projectId: t.projectId, question: UI_QUESTION, dataset }, t.headers);
    expect(suggested.body, JSON.stringify(suggested.body)).toMatchObject({ status: 'answered' });
    await seedScope(page, t);
    await stubWizardRoutes(page, { suggestion: { kind: 'answer', body: { ...UI_READ, callId: suggested.body.callId } } });
    await gotoSettled(page, `/new-analysis?datasetId=${dataset.datasetId}`);
    await askQuestion(page, UI_QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await choose(page, `na-choice-T1::${dataset.datasetId}`);
    await choose(page, 'na-read-confirm');
    await expect(page.getByTestId('na-step-ready')).toBeVisible();

    // Act / Assert — the row, then the plain-words ask, then cancel back to the reading
    const row = page.getByTestId('na-ready-row-restrictTo');
    await expect(row).toContainText('Limited to', { timeout: 30_000 });
    await expect(page.getByTestId('na-restrict-to-value')).toHaveText(`${CLUSTER}: C2, C4`);
    await expect(row).toContainText('from C2 or C4');
    await page.getByTestId('na-change-restrictTo').click();
    const ask = page.getByTestId('na-restrict-to-ask');
    await expect(ask).toContainText('Do you want to limit this to certain rows?');
    await expect(ask.locator('table')).toHaveCount(0);
    await page.getByTestId('na-restrict-to-cancel').click();
    const launched = page.waitForResponse((r) => r.url().endsWith(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    const response = await launched;
    const answer = await response.json();

    // Assert — the launch carried the question's restriction with its span, and the server accepted it
    expect(response.request().postDataJSON().restrictTo).toMatchObject({ column: CLUSTER, levels: ['C2', 'C4'], provenance: 'question', sourceSpan: { text: 'C2 or C4' } });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
  });
});
