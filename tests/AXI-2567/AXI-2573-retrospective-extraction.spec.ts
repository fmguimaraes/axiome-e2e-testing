import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2573 (epic AXI-2567 Plan Before Data — FR42, FR43, FR44, FR12, FR33; AC9) — retrospective
 * extraction of a v2 draft's data specification from one dataset version, and the explicit
 * v1 → v2 conversion of a finalised v1 SAP. API-level by design: the "Extract from dataset…" and
 * "Convert" controls belong to the front story (AXI-2569) and are not built yet, so these
 * scenarios drive exactly the gateway routes that UI will call:
 *   POST /projects/:projectId/saps/:sapId/draft/extraction  (sap:read + sap:update) → 200 draft
 *   POST /projects/:projectId/saps/:sapId/conversion        (sap:read + sap:create) → 201 draft
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2567-AXI-2573-Retrospective-Extraction.md
 * (AXI-2573.1 .. AXI-2573.5).
 *
 * E2E CONTRACT — every route REAL on the gateway (no double): sign-in, the AXI-2265
 * `PrivateProjectsWorld` (editor holds the six SAP rights; viewer holds sap:read only; outsider
 * has no project access), project + dataset upload + ingestion, the SAP draft / question /
 * finalise / versions / data-bindings routes and the two AXI-2573 routes.
 *
 * Data assumption: the `arm,score` CSV is measured with `arm` grouping_two_levels (A, B) and
 * `score` continuous on its ready ingestion — the same facts a data binding is judged on.
 *
 * STATUS: authored by the story developer, NOT executed (no isolated stack for this branch —
 * wt-up.sh is blocked for story-developer agents); never report e2e-pass from this file until
 * it has been run green against a stack serving AXI-2573.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-071', '@SI-002', '@SI-010'] };
const READY_WAIT_MS = 120_000;
const SETUP_TIMEOUT_MS = 6 * 60_000;
const CONVERSION_REASON = 'Converted from a schemaVersion 1 plan to a data specification extracted from its analysis dataset';

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let outsider: Actor;
let dataset: string;
let ingestion: string;
let t1Version: string;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const sapPath = (projectId: string, sapId: string, suffix = '') => `${base(projectId)}/saps/${sapId}${suffix}`;

const ESTIMAND = {
  population: 'All randomised subjects',
  variable: 'Score at week 12',
  intercurrentEvents: 'Treatment policy',
  populationSummary: 'Difference in medians',
  treatmentComparison: 'Arm A vs arm B',
};

function v1Question() {
  return {
    text: 'Does arm A change the score compared with arm B?',
    role: 'primary',
    estimand: ESTIMAND,
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

function v2Question(armField: string, scoreField: string, role: string) {
  return {
    ...v1Question(),
    role,
    bindings: [
      { slot: 'groupingColumn', field: armField },
      { slot: 'outcome', field: scoreField },
    ],
  };
}

async function newProject(name: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2573 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const linked = await editor.api.post(`${base(id)}/datasets`, { data: { datasetId: dataset } });
  expect(linked.status(), await linked.text()).toBeLessThan(300);
  return id;
}

async function pinNewestT1(projectId: string): Promise<string> {
  const res = await editor.api.get(`${base(projectId)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: any) => e.templateId === 'T1' && e.isNewest);
  expect(newest, 'the catalog lists a newest T1').toBeTruthy();
  return newest.templateVersion;
}

async function uploadDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2573-${Date.now()}.csv`, contentType: 'text/csv' },
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

async function startDraft(projectId: string, planSchemaVersion?: number): Promise<any> {
  const res = await editor.api.post(`${base(projectId)}/saps/draft`, { data: planSchemaVersion ? { planSchemaVersion } : {} });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

async function titled(projectId: string, draft: any, extra: Record<string, unknown> = {}): Promise<any> {
  const res = await editor.api.put(sapPath(projectId, draft.sapId, '/draft'), {
    data: { basedOnRevision: draft.revision, title: 'AXI-2573 plan', questionText: 'Objective', ...extra },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function finalise(projectId: string, draft: any, basedOnVersion: number | null): Promise<any> {
  const res = await editor.api.post(sapPath(projectId, draft.sapId, '/draft/finalise'), {
    data: { basedOnRevision: draft.revision, basedOnVersion },
  });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

async function finalisedV1(projectId: string): Promise<any> {
  const draft = await titled(projectId, await startDraft(projectId));
  const added = await editor.api.post(sapPath(projectId, draft.sapId, '/draft/questions'), {
    data: { basedOnRevision: draft.revision, analysisDatasetId: dataset, question: v1Question() },
  });
  expect(added.status(), await added.text()).toBe(201);
  return finalise(projectId, await added.json(), null);
}

function extract(actor: Actor, projectId: string, draft: any, body: Record<string, unknown> = {}) {
  return actor.api.post(sapPath(projectId, draft.sapId, '/draft/extraction'), {
    data: { basedOnRevision: draft.revision, datasetVersionId: ingestion, columns: ['arm', 'score'], ...body },
  });
}

function fieldNamed(plan: any, name: string): any {
  return plan.dataSpecification.fields.find((f: any) => f.name === name);
}

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS);
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  viewer = await world.actor('viewer');
  outsider = await world.actor('outsider');
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  dataset = await uploadDataset();
  ingestion = await readyIngestion(dataset);
  t1Version = await pinNewestT1(await newProject('pin-t1'));
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2573 — Retrospective extraction and v1 → v2 conversion', TAGS, () => {
  test('FR42, FR12 — AXI-2573.1: extraction fills a v2 draft from the dataset version; finalise freezes it after_data with its identity binding', async () => {
    // Arrange — an empty declared v2 draft
    const project = await newProject('extract');
    const draft = await titled(project, await startDraft(project, 2), { studyPopulation: 'Adults' });
    // Act — extract two columns
    const res = await extract(editor, project, draft);
    // Assert — one field per column, measured role/levels, the plan names its dataset
    expect(res.status(), await res.text()).toBe(200);
    const extracted = await res.json();
    expect(extracted.plan).toMatchObject({ schemaVersion: 2, specificationSource: 'extracted', analysisDatasetId: dataset });
    expect(fieldNamed(extracted.plan, 'arm')).toMatchObject({ semanticRole: 'grouping_two_levels', levels: ['A', 'B'] });
    expect(fieldNamed(extracted.plan, 'score')).toMatchObject({ semanticRole: 'continuous' });
    // Act — a post-data (exploratory, FR33) question on the extracted fields, then finalise
    const arm = fieldNamed(extracted.plan, 'arm').fieldId;
    const score = fieldNamed(extracted.plan, 'score').fieldId;
    const added = await editor.api.post(sapPath(project, draft.sapId, '/draft/questions'), {
      data: { basedOnRevision: extracted.revision, question: v2Question(arm, score, 'exploratory') },
    });
    expect(added.status(), await added.text()).toBe(201);
    const version = await finalise(project, await added.json(), null);
    // Assert — after_data, and the identity binding exists for that version
    expect(version).toMatchObject({ version: 1, planTiming: 'after_data', contentHashVersion: 3 });
    const bindings = await editor.api.get(sapPath(project, draft.sapId, '/data-bindings'));
    expect(bindings.status(), await bindings.text()).toBe(200);
    const [binding] = await bindings.json();
    expect(binding).toMatchObject({ sapVersionId: version.sapVersionId, datasetId: dataset, ingestionId: ingestion, confirmedByUserId: editor.userId });
    expect(binding.mapping).toEqual(
      [
        { fieldId: arm, column: 'arm' },
        { fieldId: score, column: 'score' },
      ].sort((a, b) => a.fieldId.localeCompare(b.fieldId)),
    );
  });

  test('FR42, FR12, NFR1 — AXI-2573.2: extraction refuses a declared spec, a stale revision, an unknown column, and a caller without sap:update', async () => {
    // Arrange — a v2 draft with a declared field
    const project = await newProject('extract-refusals');
    const started = await titled(project, await startDraft(project, 2));
    const declared = await titled(project, started, {
      dataSpecification: { fields: [{ name: 'arm', label: 'Arm', semanticRole: 'grouping_two_levels', levels: ['A', 'B'], required: true }] },
    });
    // Act / Assert — a declared (prospective) spec is never overwritten
    expect((await extract(editor, project, declared)).status()).toBe(422);
    // Act / Assert — stale revision
    expect((await extract(editor, project, { ...declared, revision: declared.revision - 1 })).status()).toBe(409);
    // Act / Assert — viewer (sap:read only) is 403 naming sap:update; outsider is 404
    const denied = await extract(viewer, project, declared);
    expect(denied.status()).toBe(403);
    expect(await denied.text()).toContain('sap:update');
    expect((await extract(outsider, project, declared)).status()).toBe(404);
    // Act / Assert — an empty declared draft refuses a column that is not in the dataset version
    const other = await newProject('extract-unknown');
    const empty = await titled(other, await startDraft(other, 2));
    const unknown = await extract(editor, other, empty, { columns: ['no_such_column'] });
    expect(unknown.status(), await unknown.text()).toBe(422);
    expect(await unknown.text()).toContain('no_such_column');
  });

  test('FR43, AC9 — AXI-2573.3: converting a finalised v1 SAP starts a v2 extracted draft keeping every questionId; the v1 version is untouched', async () => {
    // Arrange — a finalised v1 SAP
    const project = await newProject('convert');
    const v1 = await finalisedV1(project);
    const before = await (await editor.api.get(sapPath(project, v1.id, '/versions/1'))).json();
    // Act
    const res = await editor.api.post(sapPath(project, before.id, '/conversion'), { data: {} });
    // Assert — the one draft, v2 extracted over the bound columns, questions kept by id
    expect(res.status(), await res.text()).toBe(201);
    const draft = await res.json();
    expect(draft).toMatchObject({ basedOnVersion: 1 });
    expect(draft.plan).toMatchObject({ schemaVersion: 2, specificationSource: 'extracted', analysisDatasetId: dataset });
    expect(draft.plan.dataSpecification.fields.map((f: any) => f.name).sort()).toEqual(['arm', 'score']);
    expect(draft.plan.questions.map((q: any) => q.questionId)).toEqual(before.plan.questions.map((q: any) => q.questionId));
    // Assert — NFR3: the v1 version (and its hash) is byte-identical
    const after = await (await editor.api.get(sapPath(project, before.id, '/versions/1'))).json();
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.plan).toEqual(before.plan);
  });

  test('FR43, FR70, FR33 — AXI-2573.4: the first v2 version of a converted SAP carries the system reason, keeps its primary question, and is after_data', async () => {
    // Arrange — a converted SAP, study population filled by the author
    const project = await newProject('convert-finalise');
    const v1 = await finalisedV1(project);
    const sapId = v1.id;
    const converted = await (await editor.api.post(sapPath(project, sapId, '/conversion'), { data: {} })).json();
    const ready = await titled(project, converted, { studyPopulation: 'Adults' });
    // Act / Assert — an author reason is refused (the system supplies it)
    const withReason = await editor.api.post(sapPath(project, sapId, '/draft/finalise'), {
      data: { basedOnRevision: ready.revision, basedOnVersion: 1, amendmentReason: 'mine' },
    });
    expect(withReason.status(), await withReason.text()).toBe(422);
    // Act — finalise without a reason
    const version = await finalise(project, ready, 1);
    // Assert
    expect(version).toMatchObject({ version: 2, amendmentReason: CONVERSION_REASON, planTiming: 'after_data', contentHashVersion: 3 });
    expect(version.plan.questions[0].role).toBe('primary');
  });

  test('FR43 — AXI-2573.5: conversion refuses an open draft (409), an already-v2 SAP (422) and a caller without sap:create (403)', async () => {
    // Arrange
    const project = await newProject('convert-refusals');
    const v1 = await finalisedV1(project);
    const sapId = v1.id;
    // Act / Assert — viewer lacks sap:create
    const denied = await viewer.api.post(sapPath(project, sapId, '/conversion'), { data: {} });
    expect(denied.status()).toBe(403);
    expect(await denied.text()).toContain('sap:create');
    // Act / Assert — a second conversion while the first draft is open
    const first = await editor.api.post(sapPath(project, sapId, '/conversion'), { data: {} });
    expect(first.status(), await first.text()).toBe(201);
    expect((await editor.api.post(sapPath(project, sapId, '/conversion'), { data: {} })).status()).toBe(409);
    // Act / Assert — after the v2 version is final, converting again is 422
    const ready = await titled(project, await first.json(), { studyPopulation: 'Adults' });
    await finalise(project, ready, 1);
    expect((await editor.api.post(sapPath(project, sapId, '/conversion'), { data: {} })).status()).toBe(422);
  });
});
