import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2442 (epic AXI-2433 Structured SAP) — SAP-run evaluation and run reads.
 * There is no new route: the AXI-2441 list / detail / start answers are reconciled on
 * read — once every child governed run has settled, the run is evaluated through SI-071
 * and stored ONCE — and carry per-question results, each child's live progress, and a
 * reproduction mismatch when there is one. API-level by design (the Runs tab is AXI-2446).
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md
 * § "AXI-2442 — SAP-run evaluation and run reads" (AXI-2442.1 .. AXI-2442.5).
 *
 * World: the AXI-2265 `PrivateProjectsWorld` (platform admin admin@cro-one.com) — editor
 * (governed_execution:submit + the six SAP rights, AXI-2532), viewer (sap:read only), outsider (no project access).
 * The SAP pins the NEWEST T1 version the project's `/sap-templates` lists — never a
 * hard-coded version. AXI-2442.3–.5 need AXI-2442 on the target backend.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-071', '@SI-047', '@SI-002'] };
const READY_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 180_000;
const SETUP_TIMEOUT_MS = 6 * 60_000;
const VERDICTS = ['met', 'not_met', 'not_tested', 'failed_to_run'];

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let outsider: Actor;
let project: string;
let otherProject: string;
let ingestion: string;
let sapId: string;
let t1Version: string;
let started: any;
let evaluated: any;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const runsPath = (projectId: string, sap: string, suffix = '') => `${base(projectId)}/saps/${sap}/runs${suffix}`;
const requestId = (label: string) => `axi2442-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** The newest published T1 version on this project's catalog (pinNewestT1). */
async function pinNewestT1(projectId: string): Promise<string> {
  const res = await editor.api.get(`${base(projectId)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: any) => e.templateId === 'T1' && e.isNewest);
  expect(newest, 'the catalog lists a newest T1').toBeTruthy();
  return newest.templateVersion;
}

function t1Analysis() {
  return {
    template: { templateId: 'T1', templateVersion: t1Version },
    bindings: [
      { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
      { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
  };
}

function primaryQuestion() {
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
    ...t1Analysis(),
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [{ label: 'Welch', ...t1Analysis() }],
  };
}

async function newProject(name: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2442 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

/** Fully separated arms (every A score above every B score) — a clearly rejected T1. */
async function uploadSeparatedDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2442-${Date.now()}.csv`, contentType: 'text/csv' },
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const rows = Array.from({ length: 16 }, (_, i) => {
    const arm = i % 2 === 0 ? 'A' : 'B';
    const score = arm === 'A' ? 20 + i * 0.7 : 5 + i * 0.3;
    return `S${i + 1},${arm},${score.toFixed(1)}`;
  });
  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: `subject_id,arm,score\n${rows.join('\n')}\n`,
  });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await editor.api.patch(`${datasets}/${created.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return created.id;
}

async function link(projectId: string, datasetId: string): Promise<void> {
  const res = await editor.api.post(`${base(projectId)}/datasets`, { data: { datasetId } });
  expect(res.status(), await res.text()).toBeLessThan(300);
}

async function readyIngestion(datasetId: string): Promise<string> {
  const path = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${datasetId}`);
  let id = '';
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(path);
        const latest = res.ok() ? (await res.json()).latestIngestion : null;
        if (latest?.status === 'ready') id = latest.id;
        return latest?.status ?? 'none';
      },
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toBe('ready');
  return id;
}

async function finaliseSap(projectId: string, datasetId: string): Promise<any> {
  const draft = await (await editor.api.post(`${base(projectId)}/saps/draft`)).json();
  const titled = await editor.api.put(`${base(projectId)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: 'AXI-2442 evaluation plan' },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await editor.api.post(`${base(projectId)}/saps/${draft.sapId}/draft/questions`, {
    data: { basedOnRevision: (await titled.json()).revision, analysisDatasetId: datasetId, question: primaryQuestion() },
  });
  expect(added.status(), await added.text()).toBe(201);
  const complete = await added.json();
  await expect
    .poll(
      async () => {
        const report = await (await editor.api.get(`${base(projectId)}/saps/${draft.sapId}/draft/completeness`)).json();
        return report.results.filter((r: any) => r.status === 'fail').map((r: any) => r.checkId);
      },
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toEqual([]);
  const finalised = await editor.api.post(`${base(projectId)}/saps/${draft.sapId}/draft/finalise`, {
    data: { basedOnRevision: complete.revision, basedOnVersion: null },
  });
  expect(finalised.status(), await finalised.text()).toBe(201);
  return finalised.json();
}

/** Polls the detail until the run has left `running` (the reads reconcile it). */
async function evaluatedRun(sapRunId: string): Promise<any> {
  let latest: any = null;
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(runsPath(project, sapId, `/${sapRunId}`));
        latest = res.ok() ? await res.json() : null;
        return latest?.status ?? `http ${res.status()}`;
      },
      { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] },
    )
    .not.toBe('running');
  return latest;
}

/** The evaluation's stored fields only — the live child statuses may still move. */
function storedResult(run: any) {
  return {
    status: run.status,
    completedAt: run.completedAt,
    engineVersion: run.engineVersion,
    reproductionMismatch: run.reproductionMismatch,
    questions: run.questions.map((q: any) => ({
      questionId: q.questionId,
      mainPValue: q.mainPValue,
      effectSign: q.effectSign,
      rejected: q.rejected,
      verdict: q.verdict,
      descriptiveOnly: q.descriptiveOnly,
      sensitivityResults: q.sensitivityResults.map((s: any) => ({ label: s.label, childRunId: s.childRunId, estimate: s.estimate, pValue: s.pValue })),
    })),
  };
}

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS);
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  viewer = await world.actor('viewer');
  outsider = await world.actor('outsider');
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  await world.leaveWorkspace();
  project = await newProject('evaluate');
  otherProject = await newProject('other');
  t1Version = await pinNewestT1(project);
  const dataset = await uploadSeparatedDataset();
  await link(project, dataset);
  ingestion = await readyIngestion(dataset);
  sapId = (await finaliseSap(project, dataset)).id;
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2442 — SAP-run evaluation and run reads', TAGS, () => {
  test('FR47, AC21 — AXI-2442.1: while running, the run reads show every child run and its live progress', async () => {
    // Act
    const res = await editor.api.post(runsPath(project, sapId), {
      data: { datasetVersionId: ingestion, clientRequestId: requestId('first') },
    });
    expect(res.status(), await res.text()).toBe(201);
    started = await res.json();
    const detail = await (await editor.api.get(runsPath(project, sapId, `/${started.sapRunId}`))).json();

    // Assert
    expect(['running', 'completed', 'failed']).toContain(started.status);
    expect(started.questions).toHaveLength(1);
    const [question] = started.questions;
    expect(question.childRunId).toEqual(expect.any(String));
    expect(question.childRunStatus).not.toBe('not_submitted');
    expect(question.sensitivityResults[0]).toMatchObject({ label: 'Welch', childRunId: expect.any(String) });
    expect(question.sensitivityResults[0].childRunStatus).not.toBe('not_submitted');
    expect(detail.questions[0].childRunId).toBe(question.childRunId);
    expect(detail.questions[0].sensitivityResults[0].childRunId).toBe(question.sensitivityResults[0].childRunId);
  });

  test('AC30, EC31, NFR1 — AXI-2442.2: without project access the run reads are 404; the viewer reads them', async () => {
    // Act
    const outsiderCalls = [
      await outsider.api.get(runsPath(project, sapId)),
      await outsider.api.get(runsPath(project, sapId, `/${started.sapRunId}`)),
    ];
    const crossProject = [
      await editor.api.get(runsPath(otherProject, sapId)),
      await editor.api.get(runsPath(otherProject, sapId, `/${started.sapRunId}`)),
    ];
    const viewerList = await viewer.api.get(runsPath(project, sapId));
    const viewerDetail = await viewer.api.get(runsPath(project, sapId, `/${started.sapRunId}`));

    // Assert
    for (const res of [...outsiderCalls, ...crossProject]) expect(res.status()).toBe(404);
    expect(viewerList.status()).toBe(200);
    expect(viewerDetail.status()).toBe(200);
    expect((await viewerDetail.json()).sapRunId).toBe(started.sapRunId);
  });

  test('FR39–FR42, FR46, AC14, AC17 — AXI-2442.3: once every child settles the run is evaluated: p, sign, rejection, verdict and the sensitivity estimate', async () => {
    test.setTimeout(EVALUATION_WAIT_MS + 30_000);
    // Act
    evaluated = await evaluatedRun(started.sapRunId);

    // Assert
    expect(evaluated.status).toBe('completed');
    expect(evaluated.completedAt).toEqual(expect.any(String));
    expect(evaluated.engineVersion).toEqual(expect.any(String));
    const [question] = evaluated.questions;
    expect(question.mainPValue).toBeGreaterThanOrEqual(0);
    expect(question.mainPValue).toBeLessThanOrEqual(0.05);
    expect(['positive', 'negative']).toContain(question.effectSign);
    expect(VERDICTS).toContain(question.verdict);
    expect(question).toMatchObject({ rejected: true, verdict: 'met', descriptiveOnly: false });
    const [welch] = question.sensitivityResults;
    expect(welch.pValue).toBeGreaterThanOrEqual(0);
    expect(welch.pValue).toBeLessThanOrEqual(1);
    expect(welch.estimate).toEqual(expect.any(Number));
    expect(evaluated).not.toHaveProperty('reproductionMismatch');
  });

  test('FR39, FR46, NFR5 — AXI-2442.4: the evaluation is stored once — every later read is identical', async () => {
    // Act
    const again = await (await editor.api.get(runsPath(project, sapId, `/${started.sapRunId}`))).json();
    const listed = await (await editor.api.get(runsPath(project, sapId))).json();
    const fromList = listed.data.find((r: any) => r.sapRunId === started.sapRunId);

    // Assert
    expect(storedResult(again)).toEqual(storedResult(evaluated));
    expect(storedResult(fromList)).toEqual(storedResult(evaluated));
  });

  test('FR43, FR44, AC18, EC20, NFR5 — AXI-2442.5: a reproduction is compared with the run it reproduces — identical results, no mismatch', async () => {
    test.setTimeout(EVALUATION_WAIT_MS + 30_000);
    // Arrange
    const res = await editor.api.post(runsPath(project, sapId), {
      data: { datasetVersionId: ingestion, clientRequestId: requestId('reproduction') },
    });
    expect(res.status(), await res.text()).toBe(201);
    const reproduction = await res.json();

    // Act
    const done = await evaluatedRun(reproduction.sapRunId);

    // Assert
    expect(reproduction.classification).toBe('reproduction');
    expect(done.status).toBe('completed');
    expect(done.questions[0].mainPValue).toBe(evaluated.questions[0].mainPValue);
    expect(done.questions[0].verdict).toBe(evaluated.questions[0].verdict);
    expect(done).not.toHaveProperty('reproductionMismatch');
  });
});
