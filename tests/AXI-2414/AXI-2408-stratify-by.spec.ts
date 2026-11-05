import { test, expect } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { compileTemplate, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { answered, askQuestion, choose, gotoSettled, seedScope, stubWizardRoutes } from '../AXI-2308/harness/new-analysis';
import { launchAndDrain, WIZARD_RUNS, wizardBody } from '../AXI-2308/harness/result-page';
import { psql, psqlRows } from '../AXI-1640/harness/seed';

/**
 * AXI-2408 (epic AXI-2414 — FR59, FR20, FR22 amended, NFR10, AC56, EC31, D29, D30): `stratifyBy`
 * repeats a stratifiable template (T2) once per level of a column. Each stratum is its own filter
 * chain with its OWN Kruskal–Wallis and Dunn nodes (Holm per stratum, D29). The chart preset is
 * faceted by the column, one panel per stratum, each citing only its own runs. A stratum that fails
 * is a refused PANEL with its reason (D30). Only every stratum empty refuses the analysis (EC31).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2408 (.1–.8).
 * .9 (the wizard pre-filling the row from "for each <column>") is DEFERRED: the suggestion step
 * needs an LLM recording for a new fixed-dataset question (same limit as AXI-2409.7). The server
 * reading is covered here by .6/.7 and unit-covered by UT-GUIDED-2408-22..25.
 *
 * Fixtures:
 *  - `stratify-tableau1-long-synthetic.csv` (a copy of AXI-2309's `final_tableau1_long_synthetic.csv`,
 *    462 rows): `group` × `reference` (7 levels) × one `isotype`, outcome `pct`. AC56 golden values
 *    from bio-compute on the same file. "CER 215 et 234" is ONE level of `reference`.
 *  - `opening-templates-paul-header.csv` for the UI scenario (.8), reusing AXI-2409.6's recorded
 *    suggestion: T2 on cluster, and `sexe` (F/M) is the column offered for repetition.
 *
 * .5 (EC31/D30) needs declared-but-unobserved `reference` levels, seeded as a direct
 * `dataset_semantic_declarations` row exactly as AXI-2407.4 does (see that spec's header). It runs
 * AFTER the golden scenarios so no default ("every level") compile sees the unobserved levels.
 *
 * Run: `BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway> E2E_TEST_EMAIL=<platform admin>
 *   npx playwright test tests/AXI-2414/AXI-2408-* --project=chromium` (the `setup` project writes `.auth/`).
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const FIXTURE = 'stratify-tableau1-long-synthetic.csv';
const UI_FIXTURE = 'opening-templates-paul-header.csv';
const KW = 'stats.kruskal_wallis';
const DUNN = 'stats.dunn_posthoc';
const SVC = 'organization_svc';
const GROUPS = ['HD', 'IgG4-RD', 'SD'];
const STRATA = ['CER 215 et 234', 'CER 229', 'ENT 059'];
const REFERENCES = ['CER 215 et 234', 'CER 228', 'CER 229', 'ENT 059', 'MAG4 13', 'MAG4 22', 'MAG4 27'];
const UNOBSERVED = ['REF-unobserved-1', 'REF-unobserved-2'];
const QUESTION = 'Does pct differ between HD, IgG4-RD and SD for each reference?';
const PLAIN_QUESTION = 'Does pct differ between HD, IgG4-RD and SD?';
const SPAN = { text: 'for each reference', start: QUESTION.indexOf('for each'), end: QUESTION.indexOf('for each') + 'for each reference'.length };
const CLUSTER = 'cluster_selon_acr_eular_2019';
const UI_QUESTION = 'Does IgG4 differ across clusters?';
const UI_READ = answered(UI_QUESTION, 'compare_groups', [['outcome', 'igg4_g_l', 'IgG4'], ['groupingColumn', CLUSTER, 'clusters']]);

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;

const t2Parameters = (stratifyBy?: unknown) => ({
  datasetId: dataset.datasetId,
  groupingColumn: 'group',
  outcome: 'pct',
  groups: GROUPS,
  ...(stratifyBy !== undefined ? { stratifyBy } : {}),
});
const T2_SLOTS = [{ slot: 'groupingColumn', value: 'group' }, { slot: 'groups', value: GROUPS }, { slot: 'outcome', value: 'pct' }];
const decided = (strata: string[]) => ({ column: 'reference', strata, provenance: 'decided', answeredAt: new Date().toISOString() });
const launchBody = (question: string, stratifyBy: unknown) => ({ ...wizardBody(t, dataset, 'T2', question, 'compare_groups', T2_SLOTS), stratifyBy });

const nodesOf = (plan: any, operationId: string) => plan.nodes.filter((n: any) => n.operation?.operationId === operationId);

/** Every node `id` transitively depends on. */
function ancestorsOf(plan: any, id: string): Set<string> {
  const byId = new Map<string, any>(plan.nodes.map((n: any) => [n.id, n]));
  const seen = new Set<string>();
  const walk = (nodeId: string) => {
    for (const dep of byId.get(nodeId)?.dependsOn ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      walk(dep);
    }
  };
  walk(id);
  return seen;
}

/** The `reference eq <stratum>` filters a node depends on. */
function strataOf(plan: any, id: string): string[] {
  const ancestors = ancestorsOf(plan, id);
  return plan.nodes
    .filter((n: any) => ancestors.has(n.id) && n.nodeType === 'filter' && n.params?.column === 'reference' && n.params?.operator === 'eq')
    .map((n: any) => n.params.value);
}

/** Everything EC31's refusal must not have written: analysis containers, governed runs, wizard records. */
function durableWrites(): { analyses: number; runs: number; records: number } {
  const n = (sql: string) => Number(psqlRows(sql)[0] ?? 'NaN');
  return {
    analyses: n(`SELECT COUNT(*) FROM ${SVC}.view_analyses WHERE project_id = '${t.projectId}'`),
    runs: n(`SELECT COUNT(*) FROM ${SVC}.governed_runs WHERE tenant_id = '${t.workspaceId}'`),
    records: n(`SELECT COUNT(*) FROM ${SVC}.guided_wizard_records WHERE project_id = '${t.projectId}'`),
  };
}

/** Declared `reference` levels with NO current row — seeded directly (see file header). */
function declareUnobservedReferences(): void {
  const table = `${SVC}.dataset_semantic_declarations`;
  const maxRevision = Number(psqlRows(`SELECT COALESCE(MAX(revision), 0) FROM ${table} WHERE dataset_id = '${dataset.datasetId}'`)[0] ?? '0');
  const declaration = JSON.stringify({ scopeRoles: [], templateColumnBindings: [{ column: 'reference', role: 'group', levels: [...REFERENCES, ...UNOBSERVED] }] });
  const inserted = psql(
    `INSERT INTO ${table} (dataset_semantic_declaration_id, workspace_id, dataset_id, revision, declaration, identity_hash, declared_by)
     VALUES (gen_random_uuid()::text, '${t.workspaceId}', '${dataset.datasetId}', ${maxRevision + 1}, '${declaration}'::jsonb, 'e2e-axi-2408', 'e2e-axi-2408')`,
  );
  expect(inserted).toBe(true);
}

async function resultPage(runId: string): Promise<any> {
  const served = await api.get(`/api/v1/projects/${t.projectId}/runs/${runId}/result-page`, t.headers);
  expect(served.status, JSON.stringify(served.body)).toBe(200);
  return served.body;
}

/** The result of `operationId` for one stratum (its label ends with " — <stratum>"). */
const resultFor = (served: any, operationId: string, stratum: string) =>
  served.results.find((r: any) => r.operationId === operationId && String(r.label).endsWith(` — ${stratum}`));

const offer = (templateId: string, question: string) =>
  api.post(`${WIZARD_RUNS}/stratify-by`, { projectId: t.projectId, dataset, question, templateId, groupingColumn: 'group' }, t.headers);

async function recordOf(runId: string): Promise<any> {
  return (await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}&runId=${runId}`, t.headers)).body.records[0];
}

test.describe.serial('AXI-2408 stratifyBy — one run per stratum, a faceted chart @SI-045 @SI-017 @SI-033 @SI-066', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor([KW, DUNN]);
    await silenceTours(await adminToken());
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('FR59 FR20 AC56 D29 — AXI-2408.1 one Kruskal–Wallis + Dunn per stratum, each Holm over its own 3 pairs, and a faceted preset @SI-045 @SI-002', async () => {
    // Act
    const compiled = await compileTemplate(api, t, dataset, 'T2', t2Parameters({ column: 'reference', strata: ['ENT 059', 'CER 229', 'CER 215 et 234'] }));

    // Assert — one chain per stratum, never another stratum's
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);
    const plan = compiled.body.plan;
    for (const op of [KW, DUNN]) {
      const nodes = nodesOf(plan, op);
      expect(nodes).toHaveLength(3);
      expect(nodes.map((n: any) => strataOf(plan, n.id)).flat().sort()).toEqual([...STRATA].sort());
      for (const n of nodes) expect(strataOf(plan, n.id)).toHaveLength(1);
    }
    const groupFilter = plan.nodes.find((n: any) => n.nodeType === 'filter' && n.params?.column === 'group');
    expect(groupFilter?.params).toMatchObject({ operator: 'in', value: GROUPS });
    for (const n of nodesOf(plan, KW)) expect(ancestorsOf(plan, n.id)).toContain(groupFilter.id);
    for (const n of nodesOf(plan, DUNN)) expect(n.params.multipleTesting).toMatchObject({ method: 'holm', declaredFamilySize: 3 });

    // Assert — every preset faceted by reference, one panel per stratum citing its own nodes only
    for (const preset of compiled.body.chartPresets) {
      expect(preset.facetColumn).toBe('reference');
      expect(preset.panels.map((p: any) => p.facet).sort()).toEqual([...STRATA].sort());
      for (const panel of preset.panels) {
        for (const id of panel.citedPlanNodeIds) expect(strataOf(plan, id)).toEqual([panel.facet]);
      }
    }
  });

  test('NFR10 FR59 — AXI-2408.2 strata order does not change the plan; no stratifyBy is the plan as before @SI-045', async () => {
    // Act
    const a = await compileTemplate(api, t, dataset, 'T2', t2Parameters({ column: 'reference', strata: STRATA }));
    const b = await compileTemplate(api, t, dataset, 'T2', t2Parameters({ column: 'reference', strata: [...STRATA].reverse() }));
    const none = await compileTemplate(api, t, dataset, 'T2', t2Parameters());
    const nulled = await compileTemplate(api, t, dataset, 'T2', t2Parameters(null));

    // Assert
    for (const res of [a, b, none, nulled]) expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(b.body.plan.planId).toBe(a.body.plan.planId);
    expect(nulled.body.plan.planId).toBe(none.body.plan.planId);
    expect(none.body.plan.nodes.some((n: any) => n.params?.column === 'reference')).toBe(false);
    for (const preset of none.body.chartPresets) expect(preset).not.toHaveProperty('facetColumn');
  });

  test('FR59 — AXI-2408.3 a non-stratifiable template, the compared column, an unknown or single stratum is GUARD_UNMET stratifyBy — never a 500 @SI-045', async () => {
    // Act
    const refused = await Promise.all([
      compileTemplate(api, t, dataset, 'T1', { datasetId: dataset.datasetId, groupingColumn: 'group', groups: ['HD', 'SD'], outcome: 'pct', stratifyBy: { column: 'reference' } }),
      compileTemplate(api, t, dataset, 'T2', t2Parameters({ column: 'group' })),
      compileTemplate(api, t, dataset, 'T2', t2Parameters({ column: 'reference', strata: ['NOPE', 'ENT 059'] })),
      compileTemplate(api, t, dataset, 'T2', t2Parameters({ column: 'reference', strata: ['ENT 059'] })),
    ]);

    // Assert
    for (const res of refused) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(res.body).toMatchObject({ ok: false, code: 'GUARD_UNMET', ruleIds: ['stratifyBy'] });
    }
  });

  test('AC56 FR59 D29 — AXI-2408.4 a stratified wizard launch answers per stratum with the golden numbers @SI-045 @SI-017 @SI-033 @SI-048', async () => {
    test.setTimeout(420_000);
    // Act
    const runId = await launchAndDrain(api, t, launchBody(PLAIN_QUESTION, decided(STRATA)));
    const served = await resultPage(runId);

    // Assert — every stratum answered on its own rows, with its own Holm family (AC56 golden)
    expect(served.state).toBe('ready');
    expect(Number(resultFor(served, KW, 'ENT 059')?.rows?.[0]?.pValue), JSON.stringify(served.results.map((r: any) => r.label))).toBeCloseTo(0.0039, 3);
    expect(Number(resultFor(served, KW, 'CER 229')?.rows?.[0]?.pValue)).toBeCloseTo(0.0093, 3);
    const ent = resultFor(served, DUNN, 'ENT 059').rows;
    const hdRd = ent.find((r: any) => [r.groupA, r.groupB].sort().join('|') === 'HD|IgG4-RD');
    expect(Number(hdRd.adjustedPValue)).toBeCloseTo(0.0217, 3);
    const cer229 = resultFor(served, DUNN, 'CER 229').rows.filter((r: any) => Math.abs(Number(r.adjustedPValue) - 0.0378) < 0.0005);
    expect(cer229).toHaveLength(2);
    for (const r of resultFor(served, DUNN, 'CER 215 et 234').rows) expect(Number(r.adjustedPValue)).toBeGreaterThanOrEqual(0.05);

    // Assert — one answer sentence per stratum, prefixed with its level; the record carries the answer
    for (const stratum of STRATA) expect(served.answer.some((s: string) => s.startsWith(`reference = ${stratum}:`)), JSON.stringify(served.answer)).toBe(true);
    const record = await recordOf(runId);
    expect(record.stratifyBy).toMatchObject({ column: 'reference', strata: STRATA, provenance: 'decided' });
    expect(record.stratifyBy.answeredBy).toBeTruthy();
  });

  test('FR59 FR49 FR22 — AXI-2408.6 the offer reads "for each <column>" with its words; T1 is offered nothing; no phrase is asked @SI-045 @SI-010', async () => {
    // Act
    const read = await offer('T2', QUESTION);
    const t1 = await offer('T1', QUESTION);
    const plain = await offer('T2', PLAIN_QUESTION);

    // Assert
    expect(read.status, JSON.stringify(read.body)).toBeLessThan(300);
    expect(read.body.wording).toMatchObject({ name: 'Repeated for each', question: 'Do you want to repeat this analysis for each level of a column?' });
    const columns = read.body.options.map((o: any) => o.column);
    expect(columns).toContain('reference');
    expect(columns).not.toContain('group');
    expect(columns).not.toContain('isotype');
    expect(read.body.reading).toEqual({ column: 'reference', sourceSpan: SPAN });
    expect(QUESTION.slice(SPAN.start, SPAN.end)).toBe(SPAN.text);
    expect(t1.body).toMatchObject({ options: [], reading: null });
    expect(plain.body.reading).toBeNull();
  });

  test('FR49 FR59 — AXI-2408.7 a question reading launches with its span; a claim the question does not make is refused, writing nothing @SI-045 @SI-010', async () => {
    test.setTimeout(420_000);
    // Arrange
    const claim = { column: 'reference', provenance: 'question', sourceSpan: SPAN, answeredAt: new Date().toISOString() };

    // Act — the reading the server made
    const runId = await launchAndDrain(api, t, launchBody(QUESTION, claim));

    // Assert
    expect((await recordOf(runId)).stratifyBy).toMatchObject({ column: 'reference', provenance: 'question', sourceSpan: SPAN });

    // Act — the same claim on a question that does not say it
    const before = durableWrites();
    const unread = await api.post(WIZARD_RUNS, launchBody(PLAIN_QUESTION, claim), t.headers);

    // Assert
    expect(unread.status, JSON.stringify(unread.body)).toBe(200);
    expect(unread.body).toMatchObject({ ok: false, code: 'ANSWERS_REFUSED', ruleIds: ['WIZ_STRATIFY_BY_NOT_READ'] });
    expect(durableWrites()).toEqual(before);
  });

  test('EC31 D30 FR59 — AXI-2408.5 one empty stratum is a refused panel; every stratum empty refuses and writes nothing @SI-045 @SI-047 @SI-017 @SI-033 @SI-066', async ({ page }) => {
    test.setTimeout(420_000);
    // Arrange
    declareUnobservedReferences();

    // Act — one observed stratum, one empty
    const runId = await launchAndDrain(api, t, launchBody(PLAIN_QUESTION, decided(['ENT 059', UNOBSERVED[0]])));
    const served = await resultPage(runId);

    // Assert — the page answers; the empty stratum is a refused panel with a reason, never a blank
    expect(served.state).toBe('ready');
    expect(resultFor(served, KW, 'ENT 059')).toBeTruthy();
    expect(resultFor(served, KW, UNOBSERVED[0])).toBeUndefined();
    const preset = resultFor(served, KW, 'ENT 059').preset;
    expect(preset.facetColumn).toBe('reference');
    const empty = preset.panels.find((p: any) => p.facet === UNOBSERVED[0]);
    expect(empty).toMatchObject({ chartRuleRunId: null });
    expect(String(empty.refusal ?? '')).not.toBe('');
    expect(preset.panels.find((p: any) => p.facet === 'ENT 059')).toMatchObject({ refusal: null });

    // Assert — the browser lists the refused stratum with its reason under the figure
    await seedScope(page, t);
    await gotoSettled(page, `/projects/${t.projectId}/runs/${runId}`);
    await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
    const refused = page.locator(`[data-testid="rp-refused-panel"][data-facet="${UNOBSERVED[0]}"]`);
    await expect(refused).toBeVisible({ timeout: 60_000 });
    await expect(refused).toContainText(empty.refusal);

    // Act — every stratum empty
    const before = durableWrites();
    const allEmpty = await api.post(WIZARD_RUNS, launchBody(PLAIN_QUESTION, decided(UNOBSERVED)), t.headers);

    // Assert
    expect(allEmpty.status, JSON.stringify(allEmpty.body)).toBe(200);
    expect(allEmpty.body).toMatchObject({ ok: false, code: 'EMPTY_FILTER_RESULT' });
    expect(durableWrites()).toEqual(before);
  });

  test('FR59 FR22 FR24 — AXI-2408.8 Ready shows "Repeated for each"; Change asks in plain words; Run sends the decided column @SI-066 @SI-010', async ({ page }) => {
    test.setTimeout(240_000);
    // Arrange — the AXI-2409.6 recipe on the paul-header fixture (its suggestion is recorded)
    const uiDatasetId = await ingestCsvFixture(api, t, UI_FIXTURE);
    const uiDataset = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId: uiDatasetId });
    if (!uiDataset) throw new Error('UI fixture dataset could not be anchored');
    const suggested = await api.post('/api/v1/guided-analysis/intent-prefill/suggest', { projectId: t.projectId, question: UI_QUESTION, datasets: [uiDataset] }, t.headers);
    expect(suggested.body, JSON.stringify(suggested.body)).toMatchObject({ status: 'answered' });
    await seedScope(page, t);
    await stubWizardRoutes(page, { suggestion: { kind: 'answer', body: { ...UI_READ, callId: suggested.body.callId } } });
    await gotoSettled(page, `/new-analysis?datasetId=${uiDatasetId}`);
    await askQuestion(page, UI_QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await choose(page, 'na-choice-T2');
    await choose(page, 'na-read-confirm');
    // AXI-2411: the question names no post-hoc, so T2 asks "Pairwise follow-up" first — pick "Always"
    await expect(page.getByTestId('na-step-decide-posthoc')).toBeVisible({ timeout: 30_000 });
    await choose(page, 'na-choice-0');
    await expect(page.getByTestId('na-step-ready')).toBeVisible();

    // Assert — nothing repeats until asked
    const row = page.getByTestId('na-ready-row-stratifyBy');
    await expect(row).toContainText('Repeated for each', { timeout: 30_000 });
    await expect(page.getByTestId('na-stratify-by-value')).toHaveText('Run once, on every row');

    // Act — Change: plain words, the compared column is never offered
    await page.getByTestId('na-change-stratifyBy').click();
    await expect(page.getByTestId('na-stratify-by-ask')).toContainText('Do you want to repeat this analysis for each level of a column?');
    await expect(page.getByTestId('na-stratify-by-once')).toBeVisible();
    await expect(page.getByTestId(`na-stratify-by-column-${CLUSTER}`)).toHaveCount(0);
    await page.getByTestId('na-stratify-by-column-sexe').click();
    await expect(page.getByTestId('na-stratify-by-level-F')).toBeChecked();
    await expect(page.getByTestId('na-stratify-by-level-M')).toBeChecked();
    await page.getByTestId('na-stratify-by-level-M').uncheck();
    await expect(page.getByTestId('na-stratify-by-keep')).toBeDisabled();
    await expect(page.getByTestId('na-stratify-by-too-few')).toHaveText('Keep between 2 and 8 levels.');
    await page.getByTestId('na-stratify-by-level-M').check();
    await page.getByTestId('na-stratify-by-keep').click();
    await expect(page.getByTestId('na-stratify-by-value')).toHaveText('sexe: F, M');
    const launched = page.waitForResponse((r) => r.url().endsWith(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    const response = await launched;
    const answer = await response.json();

    // Assert — every level is sent as no strata, decided, without a span; the server accepts it
    const sent = response.request().postDataJSON().stratifyBy;
    expect(sent).toMatchObject({ column: 'sexe', provenance: 'decided' });
    expect(sent).not.toHaveProperty('strata');
    expect(sent).not.toHaveProperty('sourceSpan');
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
  });
});
