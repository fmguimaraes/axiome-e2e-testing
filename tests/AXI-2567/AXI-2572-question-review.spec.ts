import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2572 (epic AXI-2567 Plan Before Data) — per-question review of a completed SAP run:
 * record an outcome (create-only, superseding for display), list it, and "Create amendment"
 * from a follow-up. API-level by design: the review UI on the SAP-run detail is not built yet,
 * so the scenarios drive exactly the gateway routes that UI will call.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2567-AXI-2572-Question-Review.md (AXI-2572.1 .. .3).
 *
 * World: the AXI-2265 `PrivateProjectsWorld` — editor (the six SAP rights, so `sap:run` and
 * `sap:create`), viewer (no SAP write right), outsider (no project access). Setup mirrors the
 * AXI-2444 spec: a v1 SAP (one primary T1 question) finalised against a ready dataset, then one
 * SAP run evaluated to `completed`.
 *
 * Interim right: recording uses `sap:run` until OQ-rights names the review right (FR40); the
 * row records the right exercised (NFR6), which AXI-2572.1 asserts.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-010', '@SI-002'] };
const READY_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 180_000;
const SETUP_TIMEOUT_MS = 8 * 60_000;
const QUESTION_TEXT = 'Does arm A change the score compared with arm B?';

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let outsider: Actor;
let project: string;
let dataset: string;
let ingestion: string;
let sap: any;
let t1Version: string;
let sapRunId: string;
let questionId: string;
let followUp: any;
let answered: any;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const runsPath = (projectId: string, sapId: string, suffix = '') => `${base(projectId)}/saps/${sapId}/runs${suffix}`;
const reviewsPath = () => runsPath(project, sap.id, `/${sapRunId}/question-reviews`);
const amendmentPath = (reviewId: string) => `${reviewsPath()}/${reviewId}/amendment`;
const requestId = (label: string) => `axi2572-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function pinNewestT1(projectId: string): Promise<string> {
  const res = await editor.api.get(`${base(projectId)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: any) => e.templateId === 'T1' && e.isNewest);
  expect(newest, 'the catalog lists a newest T1').toBeTruthy();
  return newest.templateVersion;
}

function primaryQuestion() {
  return {
    text: QUESTION_TEXT,
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

async function newProject(name: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2572 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function uploadDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2572-${Date.now()}.csv`, contentType: 'text/csv' },
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

async function finaliseSap(projectId: string, datasetId: string): Promise<any> {
  const draft = await (await editor.api.post(`${base(projectId)}/saps/draft`)).json();
  const titled = await editor.api.put(`${base(projectId)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: 'AXI-2572 review plan' },
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

async function completedRun(id: string): Promise<any> {
  let latest: any = null;
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(runsPath(project, sap.id, `/${id}`));
        latest = res.ok() ? await res.json() : null;
        return latest?.status ?? `http ${res.status()}`;
      },
      { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] },
    )
    .not.toBe('running');
  return latest;
}

async function listReviews(actor: Actor = editor) {
  return actor.api.get(reviewsPath());
}

async function timelineOf(qid: string): Promise<any> {
  const res = await listReviews();
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).questions.find((q: any) => q.questionId === qid);
}

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS);
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  viewer = await world.actor('viewer');
  outsider = await world.actor('outsider');
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  project = await newProject('review');
  t1Version = await pinNewestT1(project);
  dataset = await uploadDataset();
  const linked = await editor.api.post(`${base(project)}/datasets`, { data: { datasetId: dataset } });
  expect(linked.status(), await linked.text()).toBeLessThan(300);
  ingestion = await readyIngestion(dataset);
  sap = await finaliseSap(project, dataset);
  const started = await editor.api.post(runsPath(project, sap.id), {
    data: { datasetVersionId: ingestion, clientRequestId: requestId('run') },
  });
  expect(started.status(), await started.text()).toBe(201);
  sapRunId = (await started.json()).sapRunId;
  const run = await completedRun(sapRunId);
  expect(run.status, 'the SAP run completes before it can be reviewed').toBe('completed');
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2572 — Question review', TAGS, () => {
  test('AC8, FR36, FR37, NFR6 — AXI-2572.1: a per-question outcome is recorded create-only; a later review supersedes it for display', async () => {
    // Arrange — the pinned plan's question, unreviewed
    const before = await listReviews();
    expect(before.status(), await before.text()).toBe(200);
    const listed = await before.json();
    expect(listed.sapRunId).toBe(sapRunId);
    expect(listed.questions).toHaveLength(1);
    questionId = listed.questions[0].questionId;
    expect(listed.questions[0]).toEqual({ questionId, latest: null, history: [] });

    // Act — follow_up, then answered
    const first = await editor.api.post(reviewsPath(), {
      data: { questionId, outcome: 'follow_up', note: 'Check the effect in the per-protocol set.' },
    });
    expect(first.status(), await first.text()).toBe(201);
    followUp = await first.json();
    const second = await editor.api.post(reviewsPath(), { data: { questionId, outcome: 'answered' } });
    expect(second.status(), await second.text()).toBe(201);
    answered = await second.json();

    // Assert — the records
    expect(followUp).toMatchObject({
      sapRunId,
      sapId: sap.id,
      questionId,
      outcome: 'follow_up',
      note: 'Check the effect in the per-protocol set.',
      citedDecisionDraftIds: [],
      citedEvidenceIds: [],
      reviewerUserId: editor.userId,
      exercisedRight: 'sap:run',
      supersedesReviewId: null,
    });
    expect(answered).toMatchObject({ outcome: 'answered', note: null, supersedesReviewId: followUp.reviewId });
    // Assert — the timeline: latest = head of the chain, history newest-first, first row unchanged
    const timeline = await timelineOf(questionId);
    expect(timeline.latest).toEqual(answered);
    expect(timeline.history).toEqual([answered, followUp]);
  });

  test('AC8, AC10, FR36, NFR1 — AXI-2572.2: a review of a question outside the plan, a foreign citation, a missing right or no access is refused and writes nothing', async () => {
    // Arrange
    const foreignDecision = randomUUID();

    // Act
    const unknownQuestion = await editor.api.post(reviewsPath(), { data: { questionId: 'not-a-plan-question', outcome: 'answered' } });
    const foreignCitation = await editor.api.post(reviewsPath(), {
      data: { questionId, outcome: 'answered', citedDecisionDraftIds: [foreignDecision] },
    });
    const viewerWrite = await viewer.api.post(reviewsPath(), { data: { questionId, outcome: 'answered' } });
    const outsiderWrite = await outsider.api.post(reviewsPath(), { data: { questionId, outcome: 'answered' } });
    const outsiderRead = await listReviews(outsider);

    // Assert
    expect(unknownQuestion.status(), await unknownQuestion.text()).toBe(422);
    expect(await unknownQuestion.text()).toContain('SAP_CONTENT_INVALID');
    expect(await unknownQuestion.text()).toContain('not-a-plan-question');
    expect(foreignCitation.status(), await foreignCitation.text()).toBe(422);
    expect(await foreignCitation.text()).toContain(foreignDecision);
    expect(viewerWrite.status(), await viewerWrite.text()).toBe(403);
    expect([403, 404], await outsiderWrite.text()).toContain(outsiderWrite.status());
    expect(outsiderRead.status(), await outsiderRead.text()).toBe(404);
    const timeline = await timelineOf(questionId);
    expect(timeline.history).toHaveLength(2);
  });

  test('FR39, EC9 — AXI-2572.3: "Create amendment" from a follow-up starts the draft once, then reuses it; a superseded or answered review is refused', async () => {
    // Arrange — the follow-up is superseded by `answered`; record a fresh follow-up as the head
    const fresh = await editor.api.post(reviewsPath(), { data: { questionId, outcome: 'follow_up' } });
    expect(fresh.status(), await fresh.text()).toBe(201);
    const head = await fresh.json();

    // Act
    const firstCall = await editor.api.post(amendmentPath(head.reviewId));
    const secondCall = await editor.api.post(amendmentPath(head.reviewId));
    const superseded = await editor.api.post(amendmentPath(followUp.reviewId));
    const notFollowUp = await editor.api.post(amendmentPath(answered.reviewId));
    const viewerCall = await viewer.api.post(amendmentPath(head.reviewId));

    // Assert — started, then reused; the stub is proposed, role not defaulted for a v1 plan
    expect(firstCall.status(), await firstCall.text()).toBe(200);
    const started = await firstCall.json();
    expect(started.draftStarted).toBe(true);
    expect(started.draft.sapId).toBe(sap.id);
    expect(started.stub).toEqual({ originReviewId: head.reviewId, sourceQuestionId: questionId, text: QUESTION_TEXT, role: null });
    expect(secondCall.status(), await secondCall.text()).toBe(200);
    const reused = await secondCall.json();
    expect(reused.draftStarted).toBe(false);
    expect(reused.draft.sapId).toBe(sap.id);
    // Assert — refusals
    expect(superseded.status(), await superseded.text()).toBe(409);
    expect(await superseded.text()).toContain('SAP_REVIEW_SUPERSEDED');
    expect(notFollowUp.status(), await notFollowUp.text()).toBe(409);
    expect(await notFollowUp.text()).toContain('SAP_REVIEW_NOT_FOLLOW_UP');
    expect(viewerCall.status(), await viewerCall.text()).toBe(403);
  });
});
