import { test, expect } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { compileTemplate, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';
import { answered, askQuestion, choose, gotoSettled, seedScope, stubWizardRoutes } from '../AXI-2308/harness/new-analysis';
import { launchAndDrain, WIZARD_RUNS, wizardBody } from '../AXI-2308/harness/result-page';
import { psqlRows } from '../AXI-1640/harness/seed';

/**
 * AXI-2409 (epic AXI-2414 — FR60, FR20, FR22 amended, AC57): T2 (Kruskal–Wallis, then Dunn with
 * Holm) takes an optional `groups` slot, a `level_set_of` the grouping column with at least three
 * levels. Absent means every level. A STRICT subset compiles to one `in` filter on the grouping
 * column ahead of BOTH operations, so both compare exactly the chosen groups, and the Holm family is
 * k(k-1)/2 of the chosen k. The full set, in any order, builds no filter: same plan, same `planId`
 * (NFR10). Fewer than three, a foreign level, or a duplicate is refused (`GUARD_UNMET T2.grouping`
 * at compile; `WIZ_TOO_FEW_GROUPS` and siblings through the wizard, naming the `groups` slot).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2409 (.1–.6).
 * .7 (the set read from the question's words) is DEFERRED: it needs a fixed-dataset `reading/1`
 * LLM recording naming the groups, the same limit as AXI-2410.1/.2. It is unit-covered by
 * UT-INVESTIGATOR-7953.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic,
 * 24 rows). `cluster_selon_acr_eular_2019` C1–C4, six rows each, so three clusters are 18 rows.
 *
 * Run: `BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway> E2E_TEST_EMAIL=<platform admin>
 *   npx playwright test tests/AXI-2414/AXI-2409-* --project=chromium` (the `setup` project writes `.auth/`).
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const OUTCOME = 'igg4_g_l';
const KW = 'stats.kruskal_wallis';
const DUNN = 'stats.dunn_posthoc';
const SVC = 'organization_svc';
const CHOSEN = ['C1', 'C2', 'C4'];
const QUESTION = `Does ${OUTCOME} differ across the clusters?`;
const UI_QUESTION = 'Does IgG4 differ across clusters?';
const UI_READ = answered(UI_QUESTION, 'compare_groups', [['outcome', OUTCOME, 'IgG4'], ['groupingColumn', CLUSTER, 'clusters']]);

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;

const t2Parameters = (groups?: string[]) => ({
  datasetId: dataset.datasetId,
  groupingColumn: CLUSTER,
  outcome: OUTCOME,
  ...(groups ? { groups } : {}),
});
const t2Slots = (groups?: string[]) => [
  { slot: 'groupingColumn', value: CLUSTER },
  ...(groups ? [{ slot: 'groups', value: groups }] : []),
  { slot: 'outcome', value: OUTCOME },
];

const nodeOf = (plan: any, operationId: string) => plan.nodes.find((n: any) => n.operation?.operationId === operationId);

/** Every node `id` transitively depends on. */
function ancestorsOf(plan: any, id: string): Set<string> {
  const byId = new Map<string, any>(plan.nodes.map((n: any) => [n.id, n]));
  const seen = new Set<string>();
  const walk = (nodeId: string) => {
    for (const dep of byId.get(nodeId)?.dependsOn ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        walk(dep);
      }
    }
  };
  walk(id);
  return seen;
}

/** What a refused wizard launch must not have written: analysis containers and wizard records. */
function durableWrites(): { analyses: number; records: number } {
  const n = (sql: string) => Number(psqlRows(sql)[0] ?? 'NaN');
  return {
    analyses: n(`SELECT COUNT(*) FROM ${SVC}.view_analyses WHERE project_id = '${t.projectId}'`),
    records: n(`SELECT COUNT(*) FROM ${SVC}.guided_wizard_records WHERE project_id = '${t.projectId}'`),
  };
}

async function resultPage(runId: string): Promise<any> {
  const served = await api.get(`/api/v1/projects/${t.projectId}/runs/${runId}/result-page`, t.headers);
  expect(served.status, JSON.stringify(served.body)).toBe(200);
  return served.body;
}

test.describe.serial('AXI-2409 T2 groups — compare three or more chosen levels @SI-045 @SI-017 @SI-066', () => {
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

  test('FR60 FR20 AC57 — AXI-2409.1 three of four levels compile to one in filter ahead of Kruskal–Wallis and Dunn; Holm family 3 @SI-045', async () => {
    // Act
    const compiled = await compileTemplate(api, t, dataset, 'T2', t2Parameters(['C4', 'C1', 'C2']));

    // Assert
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);
    const plan = compiled.body.plan;
    const filters = plan.nodes.filter((n: any) => n.nodeType === 'filter');
    expect(filters).toHaveLength(1);
    expect(filters[0].params).toMatchObject({ column: CLUSTER, operator: 'in', value: CHOSEN });
    for (const op of [KW, DUNN]) expect(ancestorsOf(plan, nodeOf(plan, op).id)).toContain(filters[0].id);
    expect(nodeOf(plan, DUNN).params.multipleTesting).toMatchObject({ method: 'holm', declaredFamilySize: 3 });
    expect(compiled.body.familySize).toBe(3);
  });

  test('FR60 NFR10 — AXI-2409.2 the full set in any order is the plan with no groups at all; a subset in another order is the same plan @SI-045', async () => {
    // Act
    const none = await compileTemplate(api, t, dataset, 'T2', t2Parameters());
    const all = await compileTemplate(api, t, dataset, 'T2', t2Parameters(['C4', 'C3', 'C2', 'C1']));
    const subset = await compileTemplate(api, t, dataset, 'T2', t2Parameters(['C2', 'C1', 'C4']));
    const reordered = await compileTemplate(api, t, dataset, 'T2', t2Parameters(['C4', 'C2', 'C1']));

    // Assert
    for (const res of [none, all, subset, reordered]) expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(all.body.plan.planId).toBe(none.body.plan.planId);
    expect(all.body.plan.nodes.some((n: any) => n.nodeType === 'filter')).toBe(false);
    expect(none.body.familySize).toBe(6);
    expect(reordered.body.plan.planId).toBe(subset.body.plan.planId);
    expect(subset.body.plan.planId).not.toBe(none.body.plan.planId);
  });

  test('FR60 AC57 — AXI-2409.3 fewer than three, an unknown level or a duplicate is GUARD_UNMET T2.grouping — never a 500 @SI-045', async () => {
    // Act
    const refused = await Promise.all(
      [['C1', 'C2'], ['C1', 'C2', 'NOPE'], ['C1', 'C1', 'C2']].map((groups) => compileTemplate(api, t, dataset, 'T2', t2Parameters(groups))),
    );

    // Assert
    for (const res of refused) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(res.body).toMatchObject({ ok: false, code: 'GUARD_UNMET', ruleIds: ['T2.grouping'] });
    }
  });

  test('AC57 FR60 FR22 — AXI-2409.4 a wizard launch over three chosen groups runs Kruskal–Wallis and Dunn over exactly those groups @SI-045 @SI-017 @SI-066', async () => {
    test.setTimeout(300_000);
    // Act
    const runId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', QUESTION, 'compare_groups', t2Slots(CHOSEN)));

    // Assert — the results of THIS run (never a deduped neighbour): 3 groups over 18 rows, 3 pairs, no C3
    const served = await resultPage(runId);
    const kw = served.results.find((r: any) => r.operationId === KW);
    const dunn = served.results.find((r: any) => r.operationId === DUNN);
    expect(kw?.rows?.[0], JSON.stringify(served.results)).toMatchObject({ nGroups: 3, n: 18 });
    const pairs = dunn.rows.map((r: any) => [r.groupA, r.groupB].sort().join('|')).sort();
    expect(pairs).toEqual(['C1|C2', 'C1|C4', 'C2|C4']);
    const records = (await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}&runId=${runId}`, t.headers)).body.records;
    expect(records[0].slots.find((s: any) => s.slot === 'groups')).toMatchObject({ value: CHOSEN, provenance: 'decided' });
  });

  test('AC57 EC26 — AXI-2409.5 fewer than three groups through the wizard is refused on the groups slot, writing nothing @SI-045 @SI-066', async () => {
    // Arrange
    const before = durableWrites();

    // Act
    const res = await api.post(WIZARD_RUNS, wizardBody(t, dataset, 'T2', QUESTION, 'compare_groups', t2Slots(['C1', 'C2'])), t.headers);

    // Assert
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: false, code: 'ANSWERS_REFUSED', ruleIds: ['WIZ_TOO_FEW_GROUPS'], slots: ['groups'] });
    expect(durableWrites()).toEqual(before);
  });

  test('AC57 FR22 FR24 — AXI-2409.6 Ready shows every group by default; Change keeps three of four; Run sends them @SI-066', async ({ page }) => {
    test.setTimeout(240_000);
    // Arrange — a real suggestion call id, so the question-read slots are citable (AXI-2327's recipe)
    const suggested = await api.post('/api/v1/guided-analysis/intent-prefill/suggest', { projectId: t.projectId, question: UI_QUESTION, datasets: [dataset] }, t.headers);
    expect(suggested.body, JSON.stringify(suggested.body)).toMatchObject({ status: 'answered' });
    await seedScope(page, t);
    await stubWizardRoutes(page, { suggestion: { kind: 'answer', body: { ...UI_READ, callId: suggested.body.callId } } });
    await gotoSettled(page, `/new-analysis?datasetId=${dataset.datasetId}`);
    await askQuestion(page, UI_QUESTION);
    await choose(page, 'na-choice-compare_groups');
    await choose(page, 'na-choice-T2');
    await choose(page, 'na-read-confirm');
    // AXI-2411: the question names no post-hoc, so T2 asks "Pairwise follow-up" first — pick "Always"
    await expect(page.getByTestId('na-step-decide-posthoc')).toBeVisible({ timeout: 30_000 });
    await choose(page, 'na-choice-0');
    await expect(page.getByTestId('na-step-ready')).toBeVisible();

    // Assert — every group, pre-filled from the data, under its served name
    const row = page.getByTestId('na-ready-row-groups');
    await expect(row).toContainText('Groups compared', { timeout: 30_000 });
    for (const level of ['C1', 'C2', 'C3', 'C4']) await expect(row).toContainText(level);

    // Act — Change: every level checked; below three, Next is refused in plain words
    await page.getByTestId('na-change-groups').click();
    await expect(page.getByTestId('na-level-set')).toBeVisible();
    for (const level of ['C1', 'C2', 'C3', 'C4']) await expect(page.getByTestId(`na-level-set-${level}`)).toBeChecked();
    await page.getByTestId('na-level-set-C3').uncheck();
    await page.getByTestId('na-level-set-C4').uncheck();
    await expect(page.getByTestId('na-decide-next')).toBeDisabled();
    await expect(page.getByTestId('na-level-set-summary')).toHaveText('Keep at least 3 groups — 1 more to go.');
    await page.getByTestId('na-level-set-C4').check();
    await expect(page.getByTestId('na-level-set-summary')).toHaveText('3 of 4 groups compared.');
    await page.getByTestId('na-decide-next').click();
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    await expect(row).toContainText('C4');
    await expect(row).not.toContainText('C3');
    const launched = page.waitForResponse((r) => r.url().endsWith(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    const response = await launched;
    const answer = await response.json();

    // Assert — the launch carried the decided set, in the column's order, and the server accepted it
    const sent = response.request().postDataJSON().slots.find((s: any) => s.slot === 'groups');
    expect(sent).toMatchObject({ value: CHOSEN, provenance: 'decided' });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
  });
});
