import { test, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { apiCallOf, pinNewestT1, t1Version } from './harness/sap-api-stub';
import {
  Actor,
  PrivateProjectsWorld,
  neverCreatedProjectId,
  refusalOf,
  uploadCsvDataset,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2438 (epic AXI-2433 Structured SAP) — the SAP draft and question-edit
 * API: start / read / save / discard a draft, add / edit / reorder / remove a
 * question under `basedOnRevision`, the per-field limits refusal, the two
 * retired free-text writes (410) and deny-by-default access. API-level by
 * design: the Plan tab that drives these routes is AXI-2445.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md
 * § "AXI-2438 — SAP draft and question-edit API" (AXI-2438.1 .. AXI-2438.7).
 *
 * Requires the AXI-2434 migration (sap_drafts) on the target database.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-010', '@SI-002'] };

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let outsider: Actor;
let project: string;
let linkedDataset: string;
let foreignDataset: string;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const draftOf = (projectId: string, sapId: string, suffix = '') =>
  `${base(projectId)}/saps/${sapId}/draft${suffix}`;

function question(text = 'Does arm A differ from arm B?') {
  return {
    text,
    role: 'primary',
    estimand: {
      population: 'All randomised subjects',
      variable: 'CD8 fraction at week 12',
      intercurrentEvents: 'Treatment policy',
      populationSummary: 'Difference in medians',
      treatmentComparison: 'Arm A vs arm B',
    },
    template: { templateId: 'T1', templateVersion: t1Version },
    bindings: [{ slot: 'outcome', column: 'value', semanticRole: 'measurement' }],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
  };
}

async function newProject(name: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2438 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function startDraft(projectId: string) {
  const res = await editor.api.post(`${base(projectId)}/saps/draft`);
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  viewer = await world.actor('viewer');
  outsider = await world.actor('outsider');
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  await world.leaveWorkspace();
  project = await newProject('draft');
  await pinNewestT1(apiCallOf(editor.api), project); // never a hard-coded T1 version
  linkedDataset = await uploadCsvDataset(world, editor);
  foreignDataset = await uploadCsvDataset(world, editor);
  const link = await editor.api.post(`${base(project)}/datasets`, { data: { datasetId: linkedDataset } });
  expect(link.status(), await link.text()).toBeLessThan(300);
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2438 — SAP draft and question-edit API', TAGS, () => {
  let draft: any;

  test('AC1 — AXI-2438.1: a draft starts EMPTY on a project with no SAP and reads back on both read routes', async () => {
    // Act
    draft = await startDraft(project);
    const byProject = await editor.api.get(`${base(project)}/sap-draft`);
    const bySap = await editor.api.get(draftOf(project, draft.sapId));

    // Assert
    expect(draft).toMatchObject({
      projectId: project,
      title: '',
      questionText: '',
      planText: '',
      plan: { schemaVersion: 1, analysisDatasetId: null, questions: [] },
      revision: 1,
      basedOnVersion: null,
      updatedBy: editor.userId,
    });
    for (const key of ['draftId', 'sapId', 'createdAt', 'updatedAt']) expect(draft).toHaveProperty(key);
    expect(byProject.status()).toBe(200);
    expect(bySap.status()).toBe(200);
    expect((await byProject.json()).draftId).toBe(draft.draftId);
    expect((await bySap.json()).draftId).toBe(draft.draftId);
  });

  test('EC4 — AXI-2438.2: a second start while a draft is open is 409 SAP_DRAFT_EXISTS', async () => {
    // Act
    const again = await editor.api.post(`${base(project)}/saps/draft`);

    // Assert
    expect(again.status()).toBe(409);
    expect((await again.json()).errorCode).toBe('SAP_DRAFT_EXISTS');
  });

  test('AC2, NFR13, EC2 — AXI-2438.3: add / edit / reorder / remove a question, each a revision; a stale revision is 409', async () => {
    // Act — add two
    const addA = await editor.api.post(draftOf(project, draft.sapId, '/questions'), {
      data: { basedOnRevision: draft.revision, analysisDatasetId: linkedDataset, question: question('first') },
    });
    const afterA = await addA.json();
    const addB = await editor.api.post(draftOf(project, draft.sapId, '/questions'), {
      data: { basedOnRevision: afterA.revision, analysisDatasetId: linkedDataset, question: question('second') },
    });
    const afterB = await addB.json();

    // Assert — server ids, last position, dataset set, actor stamped
    expect(addA.status(), JSON.stringify(afterA)).toBe(201);
    expect(addB.status(), JSON.stringify(afterB)).toBe(201);
    expect(afterA.addedQuestionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(afterB.revision).toBe(draft.revision + 2);
    expect(afterB.plan.analysisDatasetId).toBe(linkedDataset);
    expect(afterB.updatedBy).toBe(editor.userId);
    expect(afterB.plan.questions.map((q: any) => [q.questionId, q.position, q.text])).toEqual([
      [afterA.addedQuestionId, 1, 'first'],
      [afterB.addedQuestionId, 2, 'second'],
    ]);

    // Act — edit the first: text moves, id and position do not
    const edit = await editor.api.put(draftOf(project, draft.sapId, `/questions/${afterA.addedQuestionId}`), {
      data: { basedOnRevision: afterB.revision, analysisDatasetId: linkedDataset, question: question('first, edited') },
    });
    const afterEdit = await edit.json();
    expect(edit.status(), JSON.stringify(afterEdit)).toBe(200);
    expect(afterEdit.plan.questions[0]).toMatchObject({
      questionId: afterA.addedQuestionId,
      position: 1,
      text: 'first, edited',
    });

    // Act — a stale save is refused and changes nothing
    const stale = await editor.api.put(draftOf(project, draft.sapId), {
      data: { basedOnRevision: afterB.revision, title: 'stale' },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).errorCode).toBe('SAP_DRAFT_CONFLICT');
    const unchanged = await (await editor.api.get(draftOf(project, draft.sapId))).json();
    expect(unchanged).toMatchObject({ revision: afterEdit.revision, title: '' });

    // Act — swap the two by positions
    const swap = await editor.api.put(draftOf(project, draft.sapId), {
      data: {
        basedOnRevision: afterEdit.revision,
        title: 'Primary plan',
        positions: [
          { questionId: afterA.addedQuestionId, position: 2 },
          { questionId: afterB.addedQuestionId, position: 1 },
        ],
      },
    });
    const afterSwap = await swap.json();
    expect(swap.status(), JSON.stringify(afterSwap)).toBe(200);
    expect(afterSwap.title).toBe('Primary plan');
    expect(afterSwap.plan.questions.map((q: any) => q.questionId)).toEqual([
      afterB.addedQuestionId,
      afterA.addedQuestionId,
    ]);

    // Act — remove one
    const remove = await editor.api.delete(
      draftOf(project, draft.sapId, `/questions/${afterA.addedQuestionId}?basedOnRevision=${afterSwap.revision}`),
    );
    const afterRemove = await remove.json();
    expect(remove.status(), JSON.stringify(afterRemove)).toBe(200);
    expect(afterRemove.revision).toBe(afterSwap.revision + 1);
    expect(afterRemove.plan.questions.map((q: any) => q.questionId)).toEqual([afterB.addedQuestionId]);
    draft = afterRemove;
  });

  test('AC32, NFR9 — AXI-2438.4: over-limit content is 400 SAP_CONTENT_INVALID per field; a foreign dataset is refused', async () => {
    // Act
    const bad = {
      ...question('x'.repeat(2001)),
      template: { templateId: 'T9', templateVersion: '0.2' },
      parameters: { alpha: 0.2, sidedness: 'two_sided' },
    };
    const overLimit = await editor.api.post(draftOf(project, draft.sapId, '/questions'), {
      data: { basedOnRevision: draft.revision, analysisDatasetId: linkedDataset, question: bad },
    });
    const foreign = await editor.api.post(draftOf(project, draft.sapId, '/questions'), {
      data: { basedOnRevision: draft.revision, analysisDatasetId: foreignDataset, question: question() },
    });
    const after = await (await editor.api.get(draftOf(project, draft.sapId))).json();

    // Assert
    expect(overLimit.status()).toBe(400);
    const body = await overLimit.json();
    expect(body.errorCode).toBe('SAP_CONTENT_INVALID');
    const fields = (body.errors ?? []).map((e: { field: string }) => e.field);
    for (const f of ['question.text', 'question.template.templateId', 'question.parameters.alpha']) {
      expect(fields).toContain(f);
    }
    expect(foreign.status()).toBe(400);
    const foreignBody = await foreign.json();
    expect(foreignBody.errorCode).toBe('SAP_CONTENT_INVALID');
    expect(foreignBody.errors.map((e: { field: string }) => e.field)).toContain('analysisDatasetId');
    expect(after.revision).toBe(draft.revision);
  });

  test('AC30, EC31, EC32, NFR1 — AXI-2438.7: 403 for every draft write without sap:write; 404 for every route without project access', async () => {
    // Arrange
    const qid = draft.plan.questions[0].questionId;
    const rev = `?basedOnRevision=${draft.revision}`;
    const write = { basedOnRevision: draft.revision, analysisDatasetId: linkedDataset, question: question() };
    const calls = (a: Actor, projectId: string) => [
      a.api.post(`${base(projectId)}/saps/draft`),
      a.api.put(draftOf(projectId, draft.sapId), { data: { basedOnRevision: draft.revision, title: 'x' } }),
      a.api.delete(draftOf(projectId, draft.sapId, rev)),
      a.api.post(draftOf(projectId, draft.sapId, '/questions'), { data: write }),
      a.api.put(draftOf(projectId, draft.sapId, `/questions/${qid}`), { data: write }),
      a.api.delete(draftOf(projectId, draft.sapId, `/questions/${qid}${rev}`)),
    ];
    const ghost = neverCreatedProjectId();
    const anonymous = await apiRequest.newContext();

    // Act
    const viewerWrites = await Promise.all(calls(viewer, project));
    const viewerRead = await viewer.api.get(draftOf(project, draft.sapId));
    const outsiderReads = [
      await outsider.api.get(`${base(project)}/sap-draft`),
      await outsider.api.get(draftOf(project, draft.sapId)),
    ];
    const ghostRead = await outsider.api.get(`${base(ghost)}/sap-draft`);
    const outsiderWrites = await Promise.all(calls(outsider, project));
    const smuggled = await editor.api.put(draftOf(project, draft.sapId), {
      data: { basedOnRevision: draft.revision, projectId: ghost },
    });
    const noToken = await anonymous.get(`${base(project)}/sap-draft`);
    const after = await (await editor.api.get(draftOf(project, draft.sapId))).json();

    // Assert
    for (const res of viewerWrites) expect(res.status(), await res.text()).toBe(403);
    expect(viewerRead.status()).toBe(200);
    const ghostRefusal = await refusalOf(ghostRead);
    expect(ghostRefusal.status).toBe(404);
    for (const res of outsiderReads) expect(res.status()).toBe(404);
    expect(await refusalOf(outsiderReads[0])).toEqual(ghostRefusal);
    // ProjectAccessGuard (class) runs before SapWriteGuard (method): no project access is 404, never 403.
    for (const res of outsiderWrites) expect(res.status()).toBe(404);
    expect(smuggled.status()).toBe(400);
    expect(noToken.status()).toBe(401);
    expect(after.revision).toBe(draft.revision);
    await anonymous.dispose();
  });

  test('FR12, FR64 — AXI-2438.5: discard is 204, the draft is gone, and a new start is allowed', async () => {
    // Act
    const stale = await editor.api.delete(draftOf(project, draft.sapId, `?basedOnRevision=${draft.revision + 5}`));
    const discard = await editor.api.delete(draftOf(project, draft.sapId, `?basedOnRevision=${draft.revision}`));
    const gone = await editor.api.get(draftOf(project, draft.sapId));
    const goneByProject = await editor.api.get(`${base(project)}/sap-draft`);
    const restarted = await startDraft(project);

    // Assert
    expect(stale.status()).toBe(409);
    expect(discard.status()).toBe(204);
    expect(gone.status()).toBe(404);
    expect(goneByProject.status()).toBe(404);
    expect(restarted).toMatchObject({ sapId: draft.sapId, revision: 1, basedOnVersion: null });
    expect(restarted.draftId).not.toBe(draft.draftId);
    draft = restarted;
  });

  test('AC28, EC25 — AXI-2438.6: the free-text create and re-plan answer 410 SAP_FREE_TEXT_RETIRED and write nothing', async () => {
    // Arrange
    const legacyBody = {
      title: 'legacy',
      questionText: 'Does arm A differ?',
      planText: 'Mann–Whitney U, α = 0.05',
      linkedMethods: [],
    };

    // Act
    const responses = [
      await editor.api.post(`${base(project)}/saps`, { data: legacyBody }),
      await editor.api.post(`${base(project)}/saps`),
      await editor.api.post(`${base(project)}/saps/${draft.sapId}/versions`, { data: { ...legacyBody, basedOnVersion: 1 } }),
      await editor.api.post(`${base(project)}/saps/${draft.sapId}/versions`),
    ];
    const versions = await editor.api.get(`${base(project)}/saps/${draft.sapId}/versions`);

    // Assert
    for (const res of responses) {
      expect(res.status(), await res.text()).toBe(410);
      expect((await res.json()).errorCode).toBe('SAP_FREE_TEXT_RETIRED');
    }
    // A draft-only SAP has no version row, so its versions list is a 404 — never a version 1.
    expect(versions.status()).toBe(404);
  });
});
