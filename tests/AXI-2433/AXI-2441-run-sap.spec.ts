import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { apiCallOf, pinNewestT1, t1Version } from './harness/sap-api-stub';
import {
  Actor,
  PrivateProjectsWorld,
  uploadCsvDataset,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2441 (epic AXI-2433 Structured SAP) — Run SAP: pre-flight of every
 * question on a dataset version, the classified SAP run and its ◆ SAP analysis,
 * one governed run per question and per sensitivity analysis, idempotency on
 * `clientRequestId`, the run list/detail reads the Runs tab (AXI-2446) polls,
 * and the access boundary. API-level by design: no screen in this story;
 * verdicts are AXI-2442.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md
 * § "AXI-2441 — Run SAP: pre-flight, SAP run and child runs" (AXI-2441.1 .. AXI-2441.7).
 *
 * World: the AXI-2265 `PrivateProjectsWorld` (provisioned by the platform admin
 * admin@cro-one.com) — editor (governed_execution:submit + sap:write), viewer
 * (neither), outsider (no project access). Requires AXI-2441 on the target
 * backend; the setup waits (bounded) for each uploaded dataset's ingestion to be
 * ready and profiled, because pre-flight reads the MEASURED columns.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-071', '@SI-047', '@SI-002'] };
const READY_WAIT_MS = 120_000;
const SETUP_TIMEOUT_MS = 6 * 60_000;

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let outsider: Actor;
let project: string;
let otherProject: string;
let draftOnlyProject: string;
let ingestion: string;
let foreignIngestion: string;
let otherProjectIngestion: string;
let sapId: string;
let draftOnlySapId: string;
let v1: any;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const runsPath = (projectId: string, sap: string, suffix = '') => `${base(projectId)}/saps/${sap}/runs${suffix}`;
const requestId = (label: string) => `axi2441-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

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

/** One primary T1 question with one sensitivity analysis → 2 governed runs. */
function t1QuestionWithSensitivity() {
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
    data: { name: `E2E AXI-2441 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

/** A two-level `arm` and a numeric `score` — what T1's guards bind. */
async function uploadArmScoreDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2441-${Date.now()}.csv`, contentType: 'text/csv' },
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const rows = Array.from({ length: 12 }, (_, i) => `S${i + 1},${i % 2 === 0 ? 'A' : 'B'},${(i * 1.7 + 3).toFixed(1)}`);
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

/** The dataset's READY ingestion id — the `datasetVersionId` a run names. */
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

/** Draft → title → one T1 question (+ Welch) → wait for completeness → version 1. */
async function finaliseSap(projectId: string, datasetId: string): Promise<any> {
  const draft = await (await editor.api.post(`${base(projectId)}/saps/draft`)).json();
  const titled = await editor.api.put(`${base(projectId)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: 'Primary analysis plan' },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await editor.api.post(`${base(projectId)}/saps/${draft.sapId}/draft/questions`, {
    data: { basedOnRevision: (await titled.json()).revision, analysisDatasetId: datasetId, question: t1QuestionWithSensitivity() },
  });
  expect(added.status(), await added.text()).toBe(201);
  const complete = await added.json();
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(`${base(projectId)}/saps/${draft.sapId}/draft/completeness`);
        const report = await res.json();
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

async function listRuns(a: Actor, query = '') {
  return a.api.get(runsPath(project, sapId, query));
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
  project = await newProject('run');
  await pinNewestT1(apiCallOf(editor.api), project); // never a hard-coded T1 version
  otherProject = await newProject('other');
  draftOnlyProject = await newProject('draft-only');

  const dataset = await uploadArmScoreDataset();
  await link(project, dataset);
  ingestion = await readyIngestion(dataset);

  // Another dataset of the SAME project (pre-flight: dataset_version_of_another_dataset).
  const foreign = await uploadCsvDataset(world, editor);
  await link(project, foreign);
  foreignIngestion = await readyIngestion(foreign);

  // A dataset linked to the OTHER project only (NFR1: 404, never confirmed).
  const elsewhere = await uploadArmScoreDataset();
  await link(otherProject, elsewhere);
  otherProjectIngestion = await readyIngestion(elsewhere);

  v1 = await finaliseSap(project, dataset);
  sapId = v1.id;
  draftOnlySapId = (await (await editor.api.post(`${base(draftOnlyProject)}/saps/draft`)).json()).sapId;
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2441 — Run SAP: pre-flight, SAP run and child runs', TAGS, () => {
  let first: any;

  test('AC9, EC5, EC6 — AXI-2441.1: no final version is 422 SAP_VERSION_NOT_FINAL; no dataset version is 400 SAP_DATASET_VERSION_REQUIRED; nothing is written', async () => {
    // Act
    const notFinal = await editor.api.post(runsPath(draftOnlyProject, draftOnlySapId), {
      data: { datasetVersionId: ingestion, clientRequestId: requestId('not-final') },
    });
    const noDataset = await editor.api.post(runsPath(project, sapId), { data: { clientRequestId: requestId('no-dataset') } });
    const listed = await listRuns(editor);

    // Assert
    expect(notFinal.status()).toBe(422);
    expect((await notFinal.json()).errorCode).toBe('SAP_VERSION_NOT_FINAL');
    expect(noDataset.status()).toBe(400);
    expect((await noDataset.json()).errorCode).toBe('SAP_DATASET_VERSION_REQUIRED');
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toMatchObject({ data: [], meta: { total: 0 } });
  });

  test('AC10, EC7, EC8 — AXI-2441.2: a failing pre-flight is 422 SAP_RUN_PREFLIGHT_FAILED listing every problem; nothing is written', async () => {
    // Act
    const res = await editor.api.post(runsPath(project, sapId), {
      data: { datasetVersionId: foreignIngestion, clientRequestId: requestId('preflight') },
    });
    const listed = await listRuns(editor);

    // Assert
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe('SAP_RUN_PREFLIGHT_FAILED');
    expect(body.errors.map((e: any) => e.reason)).toContain('dataset_version_of_another_dataset');
    for (const e of body.errors) expect(Object.keys(e)).toEqual(expect.arrayContaining(['questionId', 'reason', 'message']));
    expect((await listed.json()).meta.total).toBe(0);
  });

  test('AC11, AC19, EC27, NFR13 — AXI-2441.3: a passing run is classified, stamped, and submits one governed run per question and sensitivity analysis', async () => {
    // Act
    const res = await editor.api.post(runsPath(project, sapId), {
      data: { version: 1, datasetVersionId: ingestion, clientRequestId: requestId('first') },
    });

    // Assert
    expect(res.status(), await res.text()).toBe(201);
    first = await res.json();
    expect(first).toMatchObject({
      replayed: false,
      projectId: project,
      sapId,
      sapVersionId: expect.any(String),
      datasetVersionId: ingestion,
      classification: 'planned_final_look',
      status: 'running',
      startedByUserId: editor.userId,
      completedAt: null,
    });
    expect(first.startedAt).toEqual(expect.any(String));
    expect(first.viewAnalysisId).toEqual(expect.any(String));
    expect(first.questions).toHaveLength(1);
    const [question] = first.questions;
    expect(question).toMatchObject({ role: 'primary', position: 1, verdict: null });
    expect(question.childRunId).toEqual(expect.any(String));
    expect(question.childRunStatus).not.toBe('not_submitted');
    expect(question.sensitivityResults).toHaveLength(1);
    expect(question.sensitivityResults[0]).toMatchObject({ label: 'Welch', childRunId: expect.any(String) });
    expect(question.sensitivityResults[0].childRunStatus).not.toBe('not_submitted');
    expect(question.sensitivityResults[0].childRunId).not.toBe(question.childRunId);
  });

  test('AC20, EC22 — AXI-2441.4: the same clientRequestId within 24 h returns the SAME run, replayed', async () => {
    // Act
    const again = await editor.api.post(runsPath(project, sapId), {
      data: { version: 1, datasetVersionId: ingestion, clientRequestId: first.clientRequestId },
    });
    const listed = await listRuns(editor);

    // Assert
    expect(again.status(), await again.text()).toBe(201);
    const replay = await again.json();
    expect(replay).toMatchObject({ sapRunId: first.sapRunId, replayed: true, viewAnalysisId: first.viewAnalysisId });
    expect(replay.questions[0].childRunId).toBe(first.questions[0].childRunId);
    expect((await listed.json()).meta.total).toBe(1);
  });

  test('FR46 — AXI-2441.5: the list is newest first and paged; the detail is the same record', async () => {
    // Arrange
    const second = await (await editor.api.post(runsPath(project, sapId), {
      data: { datasetVersionId: ingestion, clientRequestId: requestId('second') },
    })).json();

    // Act
    const all = await (await listRuns(editor)).json();
    const one = await (await listRuns(editor, '?page=1&limit=1')).json();
    const detail = await editor.api.get(runsPath(project, sapId, `/${first.sapRunId}`));

    // Assert
    expect(all.meta.total).toBe(2);
    expect(all.data.map((r: any) => r.sapRunId)).toEqual([second.sapRunId, first.sapRunId]);
    expect(one).toMatchObject({ meta: { total: 2, page: 1, limit: 1 } });
    expect(one.data).toHaveLength(1);
    expect(detail.status()).toBe(200);
    const { replayed: _replayed, questions: _q, ...record } = first;
    expect(await detail.json()).toMatchObject({ ...record, status: expect.any(String) });
  });

  test('AC30, NFR1, EC31 — AXI-2441.6: 403 without governed_execution:submit, 404 without access, cross-project SAP or dataset version', async () => {
    // Act
    const viewerStart = await viewer.api.post(runsPath(project, sapId), {
      data: { datasetVersionId: ingestion, clientRequestId: requestId('viewer') },
    });
    const viewerList = await listRuns(viewer);
    const outsiderCalls = [
      await outsider.api.post(runsPath(project, sapId), { data: { datasetVersionId: ingestion, clientRequestId: requestId('outsider') } }),
      await outsider.api.get(runsPath(project, sapId)),
      await outsider.api.get(runsPath(project, sapId, `/${first.sapRunId}`)),
    ];
    const crossSap = [
      await editor.api.post(runsPath(otherProject, sapId), { data: { datasetVersionId: ingestion, clientRequestId: requestId('cross') } }),
      await editor.api.get(runsPath(otherProject, sapId)),
      await editor.api.get(runsPath(otherProject, sapId, `/${first.sapRunId}`)),
    ];
    const crossDataset = await editor.api.post(runsPath(project, sapId), {
      data: { datasetVersionId: otherProjectIngestion, clientRequestId: requestId('cross-dataset') },
    });

    // Assert
    expect(viewerStart.status()).toBe(403);
    expect(viewerList.status()).toBe(200);
    for (const res of outsiderCalls) expect(res.status()).toBe(404);
    for (const res of crossSap) expect(res.status()).toBe(404);
    expect(crossDataset.status()).toBe(404);
  });

  test('EC23 — AXI-2441.7: amending the SAP after the run started changes nothing on that run', async () => {
    // Arrange
    const amend = await (await editor.api.post(`${base(project)}/saps/draft`)).json();
    const amended = await editor.api.post(`${base(project)}/saps/${sapId}/draft/finalise`, {
      data: { basedOnRevision: amend.revision, basedOnVersion: 1, amendmentReason: 'AXI-2441 EC23 check' },
    });
    expect(amended.status(), await amended.text()).toBe(201);

    // Act
    const detail = await (await editor.api.get(runsPath(project, sapId, `/${first.sapRunId}`))).json();

    // Assert
    expect(detail.sapVersionId).toBe(first.sapVersionId);
    expect(detail.questions.map((q: any) => [q.questionId, q.childRunId])).toEqual(
      first.questions.map((q: any) => [q.questionId, q.childRunId]),
    );
  });
});
