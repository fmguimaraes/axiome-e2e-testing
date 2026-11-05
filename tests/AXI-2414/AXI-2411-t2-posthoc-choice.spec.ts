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
 * AXI-2411 (epic AXI-2414 — FR62, FR20, FR22 amended, AC59, D34): T2 takes a `posthoc` choice,
 * one of `always` | `if_significant` | `never`, as a generic `choice` slot kind. If it is absent, the
 * value is `always`, today's plan with the same `planId`.
 * - `never` compiles the omnibus alone: no Dunn node, a family of one, multiple testing `none`, no
 *   pairwise preset, so no brackets (AC60 panel C).
 * - `if_significant` stamps `posthocWhen` on the Dunn node. At run time the Dunn step reads its
 *   Kruskal–Wallis parent's OWN omnibus p. It runs Dunn when p < 0.05. Otherwise it SUCCEEDS
 *   without a rule run, as `posthoc_withheld`.
 * The wizard reads the choice from the question only through the options' declared phrases, with
 * exactly one option named. Otherwise it asks, as a plain enum with no filter table.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2414-Guided-Wizard-Follow-up.md` § AXI-2411 (.1–.7).
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic,
 * 24 rows, `cluster_selon_acr_eular_2019` C1–C4, six rows each). Its Kruskal–Wallis p is whatever
 * the fixture holds. .5 reads it from the run and asserts the branch that p implies; it never
 * hard-codes a p.
 *
 * .5 reads the Dunn step's recorded output from the append-only `governed_run_events` log through
 * `psql` on the stack's Postgres container (`E2E_PG_CONTAINER`), because the status read carries
 * no step output.
 *
 * Run: `BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway> E2E_TEST_EMAIL=<platform admin>
 *   npx playwright test tests/AXI-2414/AXI-2411-* --project=chromium` (the `setup` project writes `.auth/`).
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const CLUSTER = 'cluster_selon_acr_eular_2019';
const OUTCOME = 'igg4_g_l';
const KW = 'stats.kruskal_wallis';
const DUNN = 'stats.dunn_posthoc';
const SVC = 'organization_svc';
const ALPHA = 0.05;
const ALPHA_ORIGIN = 'platform_default_awaiting_confirmation';
const QUESTION = `Does ${OUTCOME} differ across the clusters?`;
const UI_QUESTION = 'Does IgG4 differ across clusters?';
const UI_READ = answered(UI_QUESTION, 'compare_groups', [['outcome', OUTCOME, 'IgG4'], ['groupingColumn', CLUSTER, 'clusters']]);

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;

const t2Parameters = (posthoc?: string) => ({
  datasetId: dataset.datasetId,
  groupingColumn: CLUSTER,
  outcome: OUTCOME,
  ...(posthoc ? { posthoc } : {}),
});
const t2Slots = (posthoc: string) => [
  { slot: 'groupingColumn', value: CLUSTER },
  { slot: 'outcome', value: OUTCOME },
  { slot: 'posthoc', value: posthoc },
];

const nodeOf = (plan: any, operationId: string) => plan.nodes.find((n: any) => n.operation?.operationId === operationId);
const operationsOf = (plan: any) => plan.nodes.filter((n: any) => n.operation).map((n: any) => n.operation.operationId);

/** `text`'s first offsets in `question`, as a `QuestionSourceSpan`. */
function spanOf(question: string, text: string) {
  const start = question.indexOf(text);
  if (start < 0) throw new Error(`"${text}" is not in the question`);
  return { text, start, end: start + text.length };
}

/** A wizard body whose `posthoc` answer is a `question` claim citing `span`. */
function questionClaimBody(question: string, value: string, span: { text: string; start: number; end: number }) {
  const body = wizardBody(t, dataset, 'T2', question, 'compare_groups', t2Slots(value));
  body.slots = body.slots.map((s: any) => (s.slot === 'posthoc' ? { ...s, provenance: 'question', sourceSpan: span } : s));
  return body;
}

async function resultPage(runId: string): Promise<any> {
  const served = await api.get(`/api/v1/projects/${t.projectId}/runs/${runId}/result-page`, t.headers);
  expect(served.status, JSON.stringify(served.body)).toBe(200);
  return served.body;
}

/** Every recorded step output of the run's node for `planNodeId` (`StepSucceeded`/`StepReused`), oldest first. */
function recordedOutputs(runId: string, planNodeId: string): any[] {
  const sql =
    `SELECT payload->'output' FROM ${SVC}.governed_run_events WHERE run_id = '${runId}' ` +
    `AND node_id = '${runId}__${planNodeId}' AND kind IN ('StepSucceeded', 'StepReused') ORDER BY seq`;
  return psqlRows(sql).map((row) => JSON.parse(row));
}

test.describe.serial('AXI-2411 T2 post-hoc choice — always / only if significant / never @SI-045 @SI-017 @SI-066', () => {
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

  test('FR62 AC59 AC60 — AXI-2411.1 never compiles the omnibus alone: no Dunn node, family of one, no pairwise preset @SI-045 @SI-002', async () => {
    // Act
    const compiled = await compileTemplate(api, t, dataset, 'T2', t2Parameters('never'));

    // Assert
    expect(compiled.body.ok, JSON.stringify(compiled.body)).toBe(true);
    const plan = compiled.body.plan;
    expect(operationsOf(plan)).toEqual([KW]);
    expect(compiled.body.familySize).toBe(1);
    expect(compiled.body.multipleTesting).toMatchObject({ method: 'none' });
    const kwId = nodeOf(plan, KW).id;
    expect(compiled.body.chartPresets.map((p: any) => p.presetKey)).not.toContain('pairwise');
    for (const preset of compiled.body.chartPresets) {
      for (const panel of preset.panels) expect(panel.citedPlanNodeIds).toEqual([kwId]);
    }
  });

  test('FR62 NFR10 — AXI-2411.2 absent and always are today\'s plan; if_significant stamps the condition on Dunn @SI-045', async () => {
    // Act
    const absent = await compileTemplate(api, t, dataset, 'T2', t2Parameters());
    const always = await compileTemplate(api, t, dataset, 'T2', t2Parameters('always'));
    const conditional = await compileTemplate(api, t, dataset, 'T2', t2Parameters('if_significant'));

    // Assert
    for (const res of [absent, always, conditional]) expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(always.body.plan.planId).toBe(absent.body.plan.planId);
    expect(nodeOf(absent.body.plan, DUNN).params.posthocWhen).toBeUndefined();
    expect(conditional.body.plan.planId).not.toBe(absent.body.plan.planId);
    expect(nodeOf(conditional.body.plan, DUNN).params.posthocWhen).toEqual({ omnibusPValueBelow: ALPHA, origin: ALPHA_ORIGIN });
    expect(nodeOf(conditional.body.plan, DUNN).dependsOn).toContain(nodeOf(conditional.body.plan, KW).id);
  });

  test('FR62 — AXI-2411.3 an undeclared post-hoc value, or posthoc on T1, is GUARD_UNMET before compile — never a 500 @SI-045', async () => {
    // Act
    const unknown = await compileTemplate(api, t, dataset, 'T2', t2Parameters('sometimes'));
    const onT1 = await compileTemplate(api, t, dataset, 'T1', { datasetId: dataset.datasetId, groupingColumn: CLUSTER, groups: ['C1', 'C2'], outcome: OUTCOME, posthoc: 'never' });

    // Assert
    for (const res of [unknown, onT1]) {
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect(res.body).toMatchObject({ ok: false, code: 'GUARD_UNMET' });
    }
    expect(unknown.body.ruleIds).toContain('T2.posthoc');
    expect(onT1.body.ruleIds).toContain('posthoc');
  });

  test('AC59 AC60 FR62 FR22 — AXI-2411.4 a wizard launch with never runs Kruskal–Wallis only: no Dunn result, no brackets @SI-045 @SI-017 @SI-066', async () => {
    test.setTimeout(300_000);
    // Act
    const runId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', QUESTION, 'compare_groups', t2Slots('never')));

    // Assert
    const served = await resultPage(runId);
    const kw = served.results.find((r: any) => r.operationId === KW);
    expect(kw?.ruleRunId, JSON.stringify(served.results)).toBeTruthy();
    expect(served.results.filter((r: any) => r.operationId === DUNN)).toEqual([]);
    expect(kw.preset?.annotations?.pairwise ?? []).toEqual([]);
    expect(served.state).toBe('ready');
    expect(served.answer).toHaveLength(1);
    expect(served.answer[0]).toContain('Kruskal–Wallis');
    expect(served.answer[0]).not.toContain('Dunn');
    const records = (await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}&runId=${runId}`, t.headers)).body.records;
    expect(records[0].slots.find((s: any) => s.slot === 'posthoc')).toMatchObject({ value: 'never', provenance: 'decided' });
  });

  test('AC59 FR62 NFR10 — AXI-2411.5 if_significant runs Dunn exactly when the omnibus p is below 0.05 @SI-045 @SI-047 @SI-017', async () => {
    test.setTimeout(300_000);
    // Arrange
    const compiled = await compileTemplate(api, t, dataset, 'T2', t2Parameters('if_significant'));
    const dunnPlanNodeId = nodeOf(compiled.body.plan, DUNN).id;

    // Act
    const runId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', QUESTION, 'compare_groups', t2Slots('if_significant')));

    // Assert — the branch the run's OWN omnibus p implies
    const served = await resultPage(runId);
    const kw = served.results.find((r: any) => r.operationId === KW);
    const p = Number(kw?.rows?.[0]?.pValue);
    expect(Number.isFinite(p), JSON.stringify(served.results)).toBe(true);
    const outputs = recordedOutputs(runId, dunnPlanNodeId);
    expect(outputs.length, `no recorded Dunn output for ${runId}__${dunnPlanNodeId}`).toBeGreaterThan(0);
    const output = outputs[outputs.length - 1];
    const dunn = served.results.find((r: any) => r.operationId === DUNN);
    if (p < ALPHA) {
      expect(output.posthocCondition).toMatchObject({ met: true, omnibusPValue: p, alpha: ALPHA, omnibusRuleRunId: kw.ruleRunId });
      expect(dunn?.rows ?? [], JSON.stringify(served.results)).toHaveLength(6); // k(k-1)/2 over C1–C4
      return;
    }
    expect(output).toMatchObject({ kind: 'posthoc_withheld', ran: false, met: false, omnibusPValue: p, alpha: ALPHA, alphaOrigin: ALPHA_ORIGIN });
    expect(dunn?.ruleRunId ?? null).toBeNull();
    expect(kw.preset?.annotations?.pairwise ?? []).toEqual([]);
    expect(served.state).toBe('ready'); // a withheld step is settled, never "running" forever
    expect(served.answer.join(' ')).not.toContain('Dunn');
  });

  test('AC59 FR22 FR24 — AXI-2411.6 the wizard asks "Pairwise follow-up" in plain words; Never drops the Holm line; Run sends it @SI-066', async ({ page }) => {
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

    // Assert — the question named no post-hoc: asked, three plain choices, in the served order
    const decide = page.getByTestId('na-step-decide-posthoc');
    await expect(decide).toBeVisible({ timeout: 30_000 });
    await expect(decide).toContainText('Do you also compare the groups two by two?');
    await expect(page.getByTestId('na-choice-0')).toContainText('Always');
    await expect(page.getByTestId('na-choice-1')).toContainText('Only if the overall test is significant');
    await expect(page.getByTestId('na-choice-2')).toContainText('Never');

    // Act
    await choose(page, 'na-choice-2');

    // Assert — Ready reads it in plain words and claims no Holm correction
    await expect(page.getByTestId('na-step-ready')).toBeVisible();
    const row = page.getByTestId('na-ready-row-posthoc');
    await expect(row).toContainText('Pairwise follow-up');
    await expect(row).toContainText('Never');
    await expect(page.getByTestId('na-ready-row-multipleTesting')).toHaveCount(0);
    const launched = page.waitForResponse((r) => r.url().endsWith(WIZARD_RUNS) && r.request().method() === 'POST');
    await choose(page, 'na-run');
    const response = await launched;
    const answer = await response.json();

    // Assert — the launch carried the decided choice, and the server accepted it
    const sent = response.request().postDataJSON().slots.find((s: any) => s.slot === 'posthoc');
    expect(sent).toMatchObject({ value: 'never', provenance: 'decided' });
    expect(answer.ok, JSON.stringify(answer)).toBe(true);
  });

  test('FR22 FR49 FR62 — AXI-2411.7 "without post-hoc" is read with its words; a claim the server does not read is refused @SI-066 @SI-045', async () => {
    // Arrange
    const question = `Does ${OUTCOME} differ across the clusters, without post-hoc?`;
    const words = spanOf(question, 'without post-hoc');
    const twoNamed = `Does ${OUTCOME} differ across the clusters with post-hoc, or no post-hoc?`;

    // Act
    const read = await api.post(WIZARD_RUNS, questionClaimBody(question, 'never', words), t.headers);
    const misread = await api.post(WIZARD_RUNS, questionClaimBody(question, 'always', words), t.headers);
    const ambiguous = await api.post(WIZARD_RUNS, questionClaimBody(twoNamed, 'always', spanOf(twoNamed, 'with post-hoc')), t.headers);

    // Assert
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.ok, JSON.stringify(read.body)).toBe(true);
    for (const refused of [misread, ambiguous]) {
      expect(refused.status, JSON.stringify(refused.body)).toBe(200);
      expect(refused.body).toMatchObject({ ok: false, code: 'ANSWERS_REFUSED', slots: ['posthoc'] });
      expect(refused.body.ruleIds).toContain('WIZ_CHOICE_NOT_READ');
    }
  });
});
