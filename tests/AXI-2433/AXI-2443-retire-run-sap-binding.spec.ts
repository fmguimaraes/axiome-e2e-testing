import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { apiUrl } from '../../config/env';
import { adminApi, asList, type Api } from '../AXI-1400/harness/api';
import { carrierRuleId, ensureAnalysis, ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { actorApi, settledGovernedRun } from '../AXI-2308/harness/actor-api';
import { drainGoverned, ingestCsvFixture } from '../AXI-2308/harness/opening-templates';

/**
 * AXI-2443 (epic AXI-2433 Structured SAP — FR52–FR55, AC24–AC27, EC24, EC26, EC28): the per-run
 * SAP binding is retired. A SAP is run only through Run SAP (AXI-2441); every other way of binding
 * a run to a SAP version is refused 422 `SAP_BINDING_RETIRED` with a message naming Run SAP, and
 * writes nothing. `skip` / an absent choice is a no-op. Ordinary runs record no binding and read
 * `sapBinding: null, sapVersionId: null, sapRun: null`; a SAP-run child reads its `sapRun`
 * reference; a replay of a SAP-run child is UNBOUND and carries `replayOfRuleRunId`.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md
 * § "AXI-2443 — Retire the per-run SAP binding" (AXI-2443.1 .. .4; .5 is `manual`).
 *
 * API-level by design: the only screen change (the wizard's launch body carries no `sapChoice`)
 * is asserted in AXI-2437.2.
 *
 * Two worlds:
 *  (A) the admin harness tenant + the synthetic Paul-header CSV, for the wizard / governed /
 *      direct rule-run paths (T1 `sexe` × `microbiote_igg4_mag4_27`, carrier `stats.mann_whitney_u`);
 *  (B) a fresh AXI-2265 `PrivateProjectsWorld` (the admin STAYS a member: the rule-run reads and
 *      the replay are made as the workspace admin, because a self-registered actor's org is not
 *      entitled to the SYSTEM carrier — AXI-1290 run-hiding) with the AXI-2441 `subject_id,arm,score`
 *      dataset and a finalised one-question SAP (no sensitivity analysis, so the child's rule run
 *      is never deduped onto a sibling and stays replayable).
 *
 * .4 is the SAP-run child's `sapRun` read; .5 / .6 are the replay and its lineage read (.6 was fixme
 * until AXI-2452 stamped the replay row with the caller's verified workspace).
 * Run: `API_BASE_URL=<gateway serving the AXI-2443 branch> npx playwright test tests/AXI-2433/AXI-2443-*`.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-047', '@SI-017', '@SI-065', '@SI-002', '@SI-010'] };
const RETIRED = 'SAP_BINDING_RETIRED';
const RUN_SAP_ROUTE = /Run SAP \(POST \/api\/v1\/projects\/:projectId\/saps\/:sapId\/runs\)/;
const MWU = 'stats.mann_whitney_u';
const CORRELATION = 'stats.correlation';
const RULE_RUN_WAIT_MS = 120_000;
const READY_WAIT_MS = 120_000;
const SETUP_TIMEOUT_MS = 6 * 60_000;
const NOT_BOUND = { sapBinding: null, sapVersionId: null, sapRun: null };

// ── world A — the admin harness tenant ─────────────────────────────────────────────────────────
const WIZARD_RUNS = '/api/v1/guided-analysis/wizard-runs';
const FIXTURE = 'opening-templates-paul-header.csv';
const OUTCOME = 'microbiote_igg4_mag4_27';
const QUESTION = `Does ${OUTCOME} differ between F and M?`;

let api: Api;
let t: Tenant;
let datasetId: string;
let dataset: AnchoredDataset;

function wizardBody(patch: Record<string, unknown> = {}) {
  const at = new Date().toISOString();
  return {
    projectId: t.projectId,
    dataset,
    question: QUESTION,
    intent: 'compare_groups',
    intentSource: 'chosen',
    templateId: 'T1',
    slots: [
      { slot: 'groupingColumn', value: 'sexe', provenance: 'decided', answeredAt: at },
      { slot: 'groups', value: ['F', 'M'], provenance: 'decided', answeredAt: at },
      { slot: 'outcome', value: OUTCOME, provenance: 'decided', answeredAt: at },
    ],
    ...patch,
  };
}

/** A one-node inline governed plan (Mann–Whitney U of the fixture's outcome by `sexe`). */
function inlinePlan(label: string) {
  return {
    planId: `PL-AXI-2443-${label}-${Date.now()}`,
    revision: 1,
    question: QUESTION,
    sendData: false,
    reasoning: { restatedQuestion: QUESTION, whyThisApproach: 'Two groups', whatThisWillNotEstablish: 'Causality', alternativesConsidered: [] },
    datasetsUsed: [],
    datasetsAvailableNotUsed: [],
    declaredFamily: null,
    nodes: [
      {
        id: 'n1',
        nodeType: 'compare_groups',
        stepLabel: 'Compare F vs M',
        clinicalQuestion: QUESTION,
        why: 'AXI-2443 retired-binding probe',
        dependsOn: [],
        params: {},
        expectedEvidence: { effect_measure: 'difference', report_ci: false },
        visualisation: null,
        proposedClaimCeiling: 'exploratory',
        familyId: null,
        operation: {
          operationId: MWU,
          roleBindings: { groupColumn: 'sexe' },
          pivot: { valueColumns: [OUTCOME] },
          operationParams: { groupFrom: 'F', groupTo: 'M' },
        },
      },
    ],
  };
}

async function analysesTotal(): Promise<number> {
  const res = await api.get(`/api/v1/view-analyses?projectId=${t.projectId}&limit=100`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body?.meta?.total ?? asList(res.body).length;
}

async function ruleRunsTotal(): Promise<number> {
  const res = await api.get(`/api/v1/rule-runs?workspaceId=${t.workspaceId}&limit=1`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.total;
}

/** The refusal every retired binding path answers. */
function expectRetired(res: { status: number; body: any }) {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body.errorCode).toBe(RETIRED);
  expect(String(res.body.message)).toMatch(RUN_SAP_ROUTE);
}

/** One analysis as the list AND the detail read serve it. */
async function analysisReads(viewAnalysisId: string): Promise<{ list: any; detail: any }> {
  const listed = await api.get(`/api/v1/view-analyses?projectId=${t.projectId}&limit=100`, t.headers);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const detail = await api.get(`/api/v1/view-analyses/${viewAnalysisId}`, t.headers);
  expect(detail.status, JSON.stringify(detail.body)).toBe(200);
  return { list: asList(listed.body).find((r: any) => r.id === viewAnalysisId), detail: detail.body };
}

/** A rule run read until it is terminal (SUCCEEDED / FAILED / DEDUPED). */
async function settledRuleRun(ruleRunId: string): Promise<any> {
  let body: any = null;
  await expect
    .poll(async () => {
      const res = await api.get(`/api/v1/rule-runs/${ruleRunId}`, t.headers);
      body = res.body;
      return res.status === 200 ? body?.status : `HTTP ${res.status}`;
    }, { timeout: RULE_RUN_WAIT_MS, intervals: [1_000, 2_000, 5_000] })
    .toMatch(/^(SUCCEEDED|FAILED|DEDUPED)$/);
  return body;
}

/** A SUCCEEDED, unbound, replayable run (`stats.correlation`: xColumn / yColumn only — see .5). */
async function replayableOriginal(): Promise<{ originalId: string; original: any }> {
  await approveCarriersFor([CORRELATION]);
  const analysis = await ensureAnalysis(api, t, 'AXI-2443 replay lineage', datasetId);
  const submitted = await api.post('/api/v1/rule-runs', {
    ruleId: await carrierRuleId(CORRELATION), runKind: 'STATISTICAL', operationId: CORRELATION,
    roleBindings: { xColumn: OUTCOME, yColumn: 'igg4_g_l' }, operationParams: {},
    projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
    snapshotId: analysis.snapshotId, viewAnalysisId: analysis.analysisId, scope: 'FILTERED',
  }, t.headers);
  expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
  const first = await settledRuleRun(submitted.body.ruleRunId);
  const originalId: string = first.dedupedFromRunId ?? first.id;
  const original = await settledRuleRun(originalId);
  expect(original.status, JSON.stringify(original)).toBe('SUCCEEDED');
  return { originalId, original };
}

// ── world B — a fresh private-projects workspace with a finalised SAP ─────────────────────────
let world: PrivateProjectsWorld;
let editor: Actor;
let sapProject: string;
let sapId: string;
let ingestion: string;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);

function t1Question() {
  return {
    text: 'Does arm A change the score compared with arm B?',
    role: 'primary',
    estimand: {
      population: 'All randomised subjects',
      variable: 'Score at week 12',
      intercurrentEvents: 'Treatment policy',
      populationSummary: 'Difference in medians',
      treatmentComparison: 'Arm A vs arm B',
    },
    template: { templateId: 'T1', templateVersion: '0.2' },
    bindings: [
      { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
      { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
  };
}

async function uploadArmScoreDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2443-${Date.now()}.csv`, contentType: 'text/csv' },
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const rows = Array.from({ length: 12 }, (_, i) => `S${i + 1},${i % 2 === 0 ? 'A' : 'B'},${(i * 1.7 + 3).toFixed(1)}`);
  const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: `subject_id,arm,score\n${rows.join('\n')}\n` });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await editor.api.patch(`${datasets}/${created.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return created.id;
}

async function readyIngestion(id: string): Promise<string> {
  const path = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${id}`);
  let ready = '';
  await expect
    .poll(async () => {
      const res = await editor.api.get(path);
      const latest = res.ok() ? (await res.json()).latestIngestion : null;
      if (latest?.status === 'ready') ready = latest.id;
      return latest?.status ?? 'none';
    }, { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] })
    .toBe('ready');
  return ready;
}

async function finaliseSap(projectId: string, linkedDatasetId: string): Promise<any> {
  const draft = await (await editor.api.post(`${base(projectId)}/saps/draft`)).json();
  const titled = await editor.api.put(`${base(projectId)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: 'AXI-2443 plan' },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await editor.api.post(`${base(projectId)}/saps/${draft.sapId}/draft/questions`, {
    data: { basedOnRevision: (await titled.json()).revision, analysisDatasetId: linkedDatasetId, question: t1Question() },
  });
  expect(added.status(), await added.text()).toBe(201);
  const complete = await added.json();
  await expect
    .poll(async () => {
      const report = await (await editor.api.get(`${base(projectId)}/saps/${draft.sapId}/draft/completeness`)).json();
      return report.results.filter((r: any) => r.status === 'fail').map((r: any) => r.checkId);
    }, { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] })
    .toEqual([]);
  const finalised = await editor.api.post(`${base(projectId)}/saps/${draft.sapId}/draft/finalise`, {
    data: { basedOnRevision: complete.revision, basedOnVersion: null },
  });
  expect(finalised.status(), await finalised.text()).toBe(201);
  return finalised.json();
}

/** Read as the workspace admin member (AXI-1290: the SYSTEM carrier hides the row from an actor). */
async function adminRuleRun(ruleRunId: string): Promise<any> {
  const res = await world.admin.get(apiUrl(`/api/v1/rule-runs/${ruleRunId}`), { headers: { 'X-Workspace-Id': world.workspaceId } });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test.describe.serial('AXI-2443 — Retire the per-run SAP binding', TAGS, () => {
  test.beforeAll(async () => {
    test.setTimeout(SETUP_TIMEOUT_MS); // hooks are governed by setTimeout, never describe.configure
    await approveCarriersFor([MWU]);

    // world A
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;

    // world B
    world = await PrivateProjectsWorld.create();
    editor = await world.actor('editor');
    await world.addMember(editor, 'editor');
    const created = await editor.api.post(apiUrl('/api/v1/projects'), {
      data: { name: `E2E AXI-2443 sap-run ${Date.now()}`, workspaceId: world.workspaceId },
    });
    expect(created.status(), await created.text()).toBe(201);
    sapProject = (await created.json()).id;
    const armScore = await uploadArmScoreDataset();
    const linked = await editor.api.post(`${base(sapProject)}/datasets`, { data: { datasetId: armScore } });
    expect(linked.status(), await linked.text()).toBeLessThan(300);
    ingestion = await readyIngestion(armScore);
    sapId = (await finaliseSap(sapProject, armScore)).id;
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
    await world?.dispose();
  });

  test('AC25, EC24, FR53 — AXI-2443.1: sap "bind" on the governed submit and sapChoice "bind" on the wizard are 422 SAP_BINDING_RETIRED naming Run SAP; nothing is written', async () => {
    // Arrange
    const analysesBefore = await analysesTotal();
    const recordsBefore = (await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}`, t.headers)).body.records.length;

    // Act
    const governed = await api.post('/api/v1/governed-execution/submit', {
      projectId: t.projectId, workspaceId: t.workspaceId, datasetId, plan: inlinePlan('bind'), sap: 'bind',
    }, t.headers);
    const wizard = await api.post(WIZARD_RUNS, wizardBody({ sapChoice: 'bind' }), t.headers);

    // Assert
    expectRetired(governed);
    expectRetired(wizard);
    expect(await analysesTotal()).toBe(analysesBefore);
    expect((await api.get(`${WIZARD_RUNS}?projectId=${t.projectId}`, t.headers)).body.records).toHaveLength(recordsBefore);
  });

  test('AC25, FR54 — AXI-2443.2: a sapVersionId on POST /rule-runs is 422 SAP_BINDING_RETIRED; no rule run is created', async () => {
    // Arrange
    const before = await ruleRunsTotal();

    // Act
    const res = await api.post('/api/v1/rule-runs', {
      runKind: 'STATISTICAL', operationId: MWU, projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
      roleBindings: { groupColumn: 'sexe' }, pivot: { valueColumns: [OUTCOME] }, operationParams: { groupFrom: 'F', groupTo: 'M' },
      sapVersionId: randomUUID(),
    }, t.headers);

    // Assert
    expectRetired(res);
    expect(await ruleRunsTotal()).toBe(before);
  });

  test('AC24, AC25, AC26, FR52, FR57 — AXI-2443.3: an ordinary run (no choice, or "skip") records no binding; its status, rule-run and analysis reads are null/null/null', async () => {
    // Act
    const absent = await api.post(WIZARD_RUNS, wizardBody(), t.headers);
    const skipped = await api.post(WIZARD_RUNS, wizardBody({ sapChoice: 'skip' }), t.headers);
    const governedSkip = await api.post('/api/v1/governed-execution/submit', {
      projectId: t.projectId, workspaceId: t.workspaceId, datasetId, plan: inlinePlan('skip'), sap: 'skip',
    }, t.headers);

    // Assert
    for (const res of [absent, skipped]) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    }
    expect(governedSkip.status, JSON.stringify(governedSkip.body)).toBeLessThan(300);
    for (const { runId, viewAnalysisId } of [absent.body, skipped.body, governedSkip.body]) {
      const status: any = await drainGoverned(api, t, runId);
      expect(status).toMatchObject({ ...NOT_BOUND, sapAnalysis: false });
      const reads = await analysisReads(viewAnalysisId);
      expect(reads.list, 'the run\'s analysis is listed').toBeTruthy();
      expect(reads.list).toMatchObject({ ...NOT_BOUND, sapAnalysis: false });
      expect(reads.detail).toMatchObject({ ...NOT_BOUND, sapAnalysis: false });
      if (status.ruleRunId) {
        const ruleRun = await api.get(`/api/v1/rule-runs/${status.ruleRunId}`, t.headers);
        expect(ruleRun.status, JSON.stringify(ruleRun.body)).toBe(200);
        expect(ruleRun.body).toMatchObject({ sapVersionId: null, sapRun: null });
      }
    }
    expect(absent.body.record.sapChoice).toBeNull();
    expect(skipped.body.record.sapChoice).toBe('skip');
  });

  test('AC26, FR57 — AXI-2443.4: a SAP-run child reads sapRun on its status and on its rule run', async () => {
    // Arrange — run the SAP (AXI-2441)
    const started = await editor.api.post(`${base(sapProject)}/saps/${sapId}/runs`, {
      data: { datasetVersionId: ingestion, clientRequestId: `axi2443-${Date.now()}` },
    });
    expect(started.status(), await started.text()).toBe(201);
    const sapRun = await started.json();
    const [question] = sapRun.questions;
    const child: any = await settledGovernedRun(actorApi(editor), sapProject, question.childRunId);

    // Assert — the child's status read
    const reference = { sapRunId: sapRun.sapRunId, questionId: question.questionId, sensitivityIndex: null, role: 'primary' };
    expect(child.sapRun).toEqual(reference);
    expect(child.sapVersionId).toBe(sapRun.sapVersionId);
    expect(child.ruleRunId, JSON.stringify(child.nodes)).toEqual(expect.any(String));

    // Assert — the child's rule run
    const original = await adminRuleRun(child.ruleRunId);
    expect(original).toMatchObject({ status: 'SUCCEEDED', sapVersionId: sapRun.sapVersionId, sapRun: reference, replayOfRuleRunId: null });
  });

  // The replay half of AC27 / EC28 runs on a direct `stats.correlation` run (xColumn / yColumn only).
  // Until AXI-2451 (epic AXI-2455) a `valueColumns` run (T1 / Mann–Whitney, direct or SAP-run child)
  // could not be replayed at all — `reExecuteFromRecord` dropped the recorded `pivot`; that replay is
  // now AXI-2451.1 (tests/AXI-2455/). The "a SAP child's replay never copies its sapVersionId" half
  // is pinned at unit level (UT-RULES-2310-002).
  test('AC27, EC28, FR55 — AXI-2443.5: an unbound run is replayed as a NEW run; the original is unchanged', async () => {
    // Arrange — a direct correlation run on the world-A tenant (its canonical, if deduped onto an earlier run)
    const { originalId, original } = await replayableOriginal();

    // Act
    const replayed = await api.post(`/api/v1/rule-runs/${originalId}/re-execute`, { projectId: t.projectId }, t.headers);

    // Assert
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(201);
    expect(replayed.body.ruleRunId).toEqual(expect.any(String));
    expect(replayed.body.ruleRunId).not.toBe(originalId);
    // the original reads exactly as before the replay (on a reused tenant it may itself be an
    // earlier replay, so its own lineage is compared, never assumed null)
    expect(await settledRuleRun(originalId)).toMatchObject({
      status: 'SUCCEEDED', sapVersionId: original.sapVersionId, replayOfRuleRunId: original.replayOfRuleRunId,
    });
    expect(original.sapVersionId).toBeNull();
  });

  // AXI-2452 (epic AXI-2455) — was `test.fixme`: a replay row now carries the caller's VERIFIED
  // workspace (the original's data workspace, checked against the caller), so the workspace-scoped
  // `GET /rule-runs/:id` serves it.
  test('AC27, EC28, FR55 — AXI-2443.6: the replay reads sapVersionId null, sapRun null and replayOfRuleRunId = the original', async () => {
    const { originalId } = await replayableOriginal();
    const replayed = await api.post(`/api/v1/rule-runs/${originalId}/re-execute`, { projectId: t.projectId }, t.headers);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(201);
    expect(await settledRuleRun(replayed.body.ruleRunId)).toMatchObject({ sapVersionId: null, sapRun: null, replayOfRuleRunId: originalId });
  });
});
