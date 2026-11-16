import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, access } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2579 (epic AXI-2433) — the back half of the Investigator Study page (Human-Guided FR99, FR100):
 * the Investigator reviews his own completed SAP run's questions through Plan Before Data's AXI-2572
 * review routes ("Question answered" -> `answered`, "Needs a follow-up" -> `follow_up`), and every run
 * question serves a `guardReason` (null unless an analysis guard refused it). API-level by design:
 * the Study page that calls these routes is AXI-2576.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md § "AXI-2579"
 * (AXI-2579.1 .. .6; .5 is manual — no T1–T5 operation declares a counted BLOCK today, unit-covered).
 *
 * World: the AXI-2265 `PrivateProjectsWorld` — editor (owns the private project and builds the run),
 * investigator (the seeded Investigator role, granted the project only after AXI-2579.3), viewer (no
 * `sap:run`, granted viewer access). Setup mirrors AXI-2572's spec: a v1 SAP with one primary T1
 * question finalised against a ready dataset, then one SAP run evaluated to `completed`.
 *
 * The tests run serially in the order .3 (no access yet) -> .1 -> .2 -> .4 -> .6.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-010', '@SI-002'] };
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const READY_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 180_000;
const SETUP_TIMEOUT_MS = 8 * 60_000;

let world: PrivateProjectsWorld;
let editor: Actor;
let investigator: Actor;
let viewer: Actor;
let project: string;
let sap: any;
let t1Version: string;
let sapRunId: string;
let questionId: string;
let followUp: any;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const runsPath = (suffix = '') => `${base(project)}/saps/${sap.id}/runs${suffix}`;
const reviewsPath = () => runsPath(`/${sapRunId}/question-reviews`);
const amendmentPath = (reviewId: string) => `${reviewsPath()}/${reviewId}/amendment`;
const requestId = (label: string) => `axi2579-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pinNewestT1(): Promise<string> {
  const res = await editor.api.get(`${base(project)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: any) => e.templateId === 'T1' && e.isNewest);
  expect(newest, 'the catalog lists a newest T1').toBeTruthy();
  return newest.templateVersion;
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
    template: { templateId: 'T1', templateVersion: t1Version },
    bindings: [
      { slot: 'groupingColumn', column: 'arm', semanticRole: 'grouping_two_levels' },
      { slot: 'outcome', column: 'score', semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
  };
}

async function privateProject(): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2579 study ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  expect((await access.visibility(editor, id, 'private')).status()).toBe(200);
  return id;
}

async function uploadDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2579-${Date.now()}.csv`, contentType: 'text/csv' },
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

async function finaliseSap(datasetId: string): Promise<any> {
  const draft = await (await editor.api.post(`${base(project)}/saps/draft`)).json();
  const titled = await editor.api.put(`${base(project)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: 'AXI-2579 study plan' },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await editor.api.post(`${base(project)}/saps/${draft.sapId}/draft/questions`, {
    data: { basedOnRevision: (await titled.json()).revision, analysisDatasetId: datasetId, question: primaryQuestion() },
  });
  expect(added.status(), await added.text()).toBe(201);
  const complete = await added.json();
  await expect
    .poll(
      async () => {
        const report = await (await editor.api.get(`${base(project)}/saps/${draft.sapId}/draft/completeness`)).json();
        return report.results.filter((r: any) => r.status === 'fail').map((r: any) => r.checkId);
      },
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toEqual([]);
  const finalised = await editor.api.post(`${base(project)}/saps/${draft.sapId}/draft/finalise`, {
    data: { basedOnRevision: complete.revision, basedOnVersion: null },
  });
  expect(finalised.status(), await finalised.text()).toBe(201);
  return finalised.json();
}

async function completedRun(id: string): Promise<any> {
  let latest: any = null;
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(runsPath(`/${id}`));
        latest = res.ok() ? await res.json() : null;
        return latest?.status ?? `http ${res.status()}`;
      },
      { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] },
    )
    .not.toBe('running');
  return latest;
}

async function historyLength(): Promise<number> {
  const res = await editor.api.get(reviewsPath());
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).questions[0].history.length;
}

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS);
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  investigator = await world.actor('investigator');
  viewer = await world.actor('viewer');
  await world.addMember(editor, 'editor');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(viewer, 'viewer');
  project = await privateProject();
  expect((await access.grant(editor, project, viewer.userId, 'viewer')).status()).toBeLessThan(300);
  t1Version = await pinNewestT1();
  const dataset = await uploadDataset();
  const linked = await editor.api.post(`${base(project)}/datasets`, { data: { datasetId: dataset } });
  expect(linked.status(), await linked.text()).toBeLessThan(300);
  const ingestion = await readyIngestion(dataset);
  sap = await finaliseSap(dataset);
  const started = await editor.api.post(runsPath(), {
    data: { datasetVersionId: ingestion, clientRequestId: requestId('run') },
  });
  expect(started.status(), await started.text()).toBe(201);
  sapRunId = (await started.json()).sapRunId;
  const run = await completedRun(sapRunId);
  expect(run.status, 'the SAP run completes before it can be reviewed').toBe('completed');
  questionId = run.questions[0].questionId;
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2579 — Investigator Study page, back half', TAGS, () => {
  test('FR100 — AXI-2579.3: the Investigator cannot read or review a private project he was not granted; nothing is written', async () => {
    // Act
    const read = await investigator.api.get(reviewsPath());
    const write = await investigator.api.post(reviewsPath(), { data: { questionId, outcome: 'answered' } });

    // Assert
    expect(read.status(), await read.text()).toBe(404);
    expect([403, 404], await write.text()).toContain(write.status());
    expect(await historyLength()).toBe(0);
  });

  test('FR100, FR36, FR37 — AXI-2579.1: the Investigator records "Needs a follow-up" (follow_up) then "Question answered" (answered) on his own run', async () => {
    // Arrange — now granted the project
    expect((await access.grant(editor, project, investigator.userId, 'editor')).status()).toBeLessThan(300);
    const listed = await investigator.api.get(reviewsPath());
    expect(listed.status(), await listed.text()).toBe(200);
    expect((await listed.json()).questions).toEqual([{ questionId, latest: null, history: [] }]);

    // Act
    const first = await investigator.api.post(reviewsPath(), { data: { questionId, outcome: 'follow_up' } });
    expect(first.status(), await first.text()).toBe(201);
    followUp = await first.json();
    const second = await investigator.api.post(reviewsPath(), { data: { questionId, outcome: 'answered' } });
    expect(second.status(), await second.text()).toBe(201);
    const answered = await second.json();

    // Assert — reviewer from the token, interim right recorded, supersession chain
    expect(followUp).toMatchObject({ questionId, outcome: 'follow_up', reviewerUserId: investigator.userId, exercisedRight: 'sap:run', supersedesReviewId: null });
    expect(answered).toMatchObject({ outcome: 'answered', reviewerUserId: investigator.userId, supersedesReviewId: followUp.reviewId });
    const timeline = (await (await investigator.api.get(reviewsPath())).json()).questions[0];
    expect(timeline.history).toEqual([answered, followUp]);
  });

  test('FR100, FR39 — AXI-2579.2: the Investigator starts an amendment from his own follow-up', async () => {
    // Arrange — a fresh follow-up as the head
    const fresh = await investigator.api.post(reviewsPath(), { data: { questionId, outcome: 'follow_up' } });
    expect(fresh.status(), await fresh.text()).toBe(201);
    const head = await fresh.json();

    // Act
    const res = await investigator.api.post(amendmentPath(head.reviewId));

    // Assert
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.draft.sapId).toBe(sap.id);
    expect(body.stub).toMatchObject({ originReviewId: head.reviewId, sourceQuestionId: questionId });
  });

  test('FR99 — AXI-2579.4: every run question serves guardReason; a completed question serves null (detail and list)', async () => {
    // Act
    const detail = await investigator.api.get(runsPath(`/${sapRunId}`));
    const list = await investigator.api.get(runsPath());

    // Assert
    expect(detail.status(), await detail.text()).toBe(200);
    const questions = (await detail.json()).questions;
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q).toHaveProperty('guardReason');
      expect(q.guardReason).toBeNull();
    }
    expect(list.status(), await list.text()).toBe(200);
    const run = (await list.json()).data.find((r: any) => r.sapRunId === sapRunId);
    expect(run, 'the run is listed').toBeTruthy();
    expect(run.questions.map((q: any) => q.guardReason)).toEqual(questions.map(() => null));
  });

  test('FR100 — AXI-2579.6: a reviewer without sap:run (plain viewer) cannot record; nothing is written', async () => {
    // Arrange
    const before = await historyLength();

    // Act
    const res = await viewer.api.post(reviewsPath(), { data: { questionId, outcome: 'answered' } });

    // Assert
    expect(res.status(), await res.text()).toBe(403);
    expect(await historyLength()).toBe(before);
  });
});
