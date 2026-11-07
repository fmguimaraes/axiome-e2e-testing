import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { apiCallOf, pinNewestT1, t1Version } from './harness/sap-api-stub';
import {
  Actor,
  PrivateProjectsWorld,
  neverCreatedProjectId,
  refusalOf,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2439 (epic AXI-2433 Structured SAP) — the completeness report, finalise
 * and amend, and the template catalog: the server judges the STORED draft
 * (CC1–CC14, a client report is never read), finalise is one `sap:write`
 * holder with no second approver, an amendment needs its reason, a concurrent
 * second finalise is 409, and every route is project-confined. API-level by
 * design: the Plan tab that drives these routes is AXI-2445.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md
 * § "AXI-2439 — SAP completeness, finalise and amend" (AXI-2439.1 .. AXI-2439.7).
 *
 * Requires the AXI-2434 migration and AXI-2439 on the target backend; the
 * finalise scenarios wait (bounded) for the uploaded dataset to be profiled,
 * because CC4 reads the dataset's MEASURED columns server-side.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-010', '@SI-002'] };
const PROFILE_WAIT_MS = 120_000;

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let outsider: Actor;
let project: string;
let otherProject: string;
let dataset: string;

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);
const sapPath = (projectId: string, sapId: string, suffix = '') => `${base(projectId)}/saps/${sapId}${suffix}`;

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

/** A two-level `arm` and a numeric `score` — what T1's guards bind. */
async function uploadArmScoreDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2439-${Date.now()}.csv`, contentType: 'text/csv' },
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

async function newProject(name: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2439 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function startDraft(projectId: string) {
  const res = await editor.api.post(`${base(projectId)}/saps/draft`);
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

/** Title + one complete T1 question → the draft at its new revision. */
async function completeDraft(draft: any) {
  const titled = await editor.api.put(sapPath(project, draft.sapId, '/draft'), {
    data: { basedOnRevision: draft.revision, title: 'Primary analysis plan' },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const afterTitle = await titled.json();
  if (afterTitle.plan.questions.length > 0) return afterTitle;
  const added = await editor.api.post(sapPath(project, draft.sapId, '/draft/questions'), {
    data: { basedOnRevision: afterTitle.revision, analysisDatasetId: dataset, question: t1Question() },
  });
  expect(added.status(), await added.text()).toBe(201);
  return added.json();
}

async function failingChecks(sapId: string): Promise<string[]> {
  const res = await editor.api.get(sapPath(project, sapId, '/draft/completeness'));
  expect(res.status(), await res.text()).toBe(200);
  const report = await res.json();
  return report.results.filter((r: any) => r.status === 'fail').map((r: any) => r.checkId);
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  viewer = await world.actor('viewer');
  outsider = await world.actor('outsider');
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  await world.leaveWorkspace();
  project = await newProject('finalise');
  await pinNewestT1(apiCallOf(editor.api), project); // never a hard-coded T1 version
  otherProject = await newProject('other');
  dataset = await uploadArmScoreDataset();
  const link = await editor.api.post(`${base(project)}/datasets`, { data: { datasetId: dataset } });
  expect(link.status(), await link.text()).toBeLessThan(300);
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2439 — SAP completeness, finalise and amend', TAGS, () => {
  let draft: any;
  let v1: any;

  test('AC1 — AXI-2439.1: an empty draft reports CC1, CC13 and CC14 failing, stamped with the engine version', async () => {
    // Arrange
    draft = await startDraft(project);

    // Act
    const res = await editor.api.get(sapPath(project, draft.sapId, '/draft/completeness'));

    // Assert
    expect(res.status(), await res.text()).toBe(200);
    const report = await res.json();
    expect(report.engineVersion).toBe('1.1.0');
    const failing = new Set(report.results.filter((r: any) => r.status === 'fail').map((r: any) => r.checkId));
    expect([...failing].sort()).toEqual(['CC1', 'CC13', 'CC14']);
    for (const row of report.results) expect(Object.keys(row)).toEqual(expect.arrayContaining(['checkId', 'status', 'message', 'ruleRef']));
  });

  test('AC4, EC1 — AXI-2439.2: finalising an incomplete draft is 422 SAP_INCOMPLETE listing every failing check; nothing is written', async () => {
    // Act
    const res = await editor.api.post(sapPath(project, draft.sapId, '/draft/finalise'), {
      data: { basedOnRevision: draft.revision, basedOnVersion: null },
    });
    const stillOpen = await editor.api.get(sapPath(project, draft.sapId, '/draft'));

    // Assert
    expect(res.status()).toBe(422);
    const body = await res.json();
    expect(body.errorCode).toBe('SAP_INCOMPLETE');
    expect([...new Set(body.errors.map((e: any) => e.checkId))].sort()).toEqual(['CC1', 'CC13', 'CC14']);
    expect(stillOpen.status()).toBe(200);
    expect((await stillOpen.json()).revision).toBe(draft.revision);
  });

  test('FR14 — AXI-2439.3: a client-supplied completeness report or server fact is refused at the gateway (400)', async () => {
    // Act
    const res = await editor.api.post(sapPath(project, draft.sapId, '/draft/finalise'), {
      data: { basedOnRevision: draft.revision, basedOnVersion: null, report: { results: [], engineVersion: '1.1.0' } },
    });

    // Assert
    expect(res.status()).toBe(400);
  });

  test('AC6 — AXI-2439.4: a complete draft finalises into version 1 (final, hash v2, finaliser stamped) and the draft closes', async () => {
    // Arrange
    draft = await completeDraft(draft);
    await expect
      .poll(() => failingChecks(draft.sapId), { timeout: PROFILE_WAIT_MS, intervals: [2_000, 5_000] })
      .toEqual([]);

    // Act
    const res = await editor.api.post(sapPath(project, draft.sapId, '/draft/finalise'), {
      data: { basedOnRevision: draft.revision, basedOnVersion: null },
    });
    const closed = await editor.api.get(sapPath(project, draft.sapId, '/draft'));

    // Assert
    expect(res.status(), await res.text()).toBe(201);
    v1 = await res.json();
    expect(v1).toMatchObject({
      id: draft.sapId,
      projectId: project,
      version: 1,
      status: 'final',
      contentHashVersion: 2,
      title: 'Primary analysis plan',
      analysisDatasetId: dataset,
      finalisedByUserId: editor.userId,
      amendmentReason: null,
      supersededBy: null,
    });
    expect(v1.plan.questions).toHaveLength(1);
    expect(v1.finalisedAt).toEqual(expect.any(String));
    expect(closed.status()).toBe(404);
  });

  test('EC3 — AXI-2439.5: a second finalise from the same base is 409 SAP_VERSION_CONFLICT', async () => {
    // Act
    const res = await editor.api.post(sapPath(project, draft.sapId, '/draft/finalise'), {
      data: { basedOnRevision: draft.revision, basedOnVersion: null },
    });

    // Assert
    expect(res.status()).toBe(409);
    expect((await res.json()).errorCode).toBe('SAP_VERSION_CONFLICT');
  });

  test('AC7, FR16 — AXI-2439.6: an amendment copies version 1, needs its reason, and supersedes version 1 with version 2', async () => {
    // Arrange
    const amend = await startDraft(project);
    expect(amend).toMatchObject({ sapId: v1.id, basedOnVersion: 1, title: 'Primary analysis plan' });
    expect(amend.plan.questions).toHaveLength(1);

    // Act
    const noReason = await editor.api.post(sapPath(project, amend.sapId, '/draft/finalise'), {
      data: { basedOnRevision: amend.revision, basedOnVersion: 1 },
    });
    const amended = await editor.api.post(sapPath(project, amend.sapId, '/draft/finalise'), {
      data: { basedOnRevision: amend.revision, basedOnVersion: 1, amendmentReason: 'Clarified the estimand' },
    });
    const versions = await editor.api.get(sapPath(project, amend.sapId, '/versions'));

    // Assert
    expect(noReason.status()).toBe(422);
    const refusal = await noReason.json();
    expect(refusal.errorCode).toBe('SAP_CONTENT_INVALID');
    expect(refusal.errors).toEqual([{ field: 'amendmentReason', message: 'is required to amend a SAP (version 2 onward)' }]);
    expect(amended.status(), await amended.text()).toBe(201);
    expect(await amended.json()).toMatchObject({ version: 2, status: 'final', amendmentReason: 'Clarified the estimand' });
    expect(versions.status()).toBe(200);
    const listed = JSON.stringify(await versions.json());
    expect(listed).toContain('"version":2');
  });

  test('FR69, EC10 — AXI-2439.7: the template catalog lists T1–T5 with the newest version flagged', async () => {
    // Act
    const res = await viewer.api.get(`${base(project)}/sap-templates`);

    // Assert
    expect(res.status(), await res.text()).toBe(200);
    const entries = await res.json();
    const ids = new Set(entries.map((e: any) => e.templateId));
    expect([...ids].sort()).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    for (const id of ids) expect(entries.filter((e: any) => e.templateId === id && e.isNewest)).toHaveLength(1);
    const t1 = entries.find((e: any) => e.templateId === 'T1' && e.templateVersion === t1Version);
    expect(t1).toMatchObject({ supportsOneSidedAlternative: false, cellAxisSlots: null });
  });

  test('AC30, NFR1 — AXI-2439.8: 403 without sap:write, 404 without project access or for another project\'s SAP', async () => {
    // Arrange
    const reopened = await startDraft(project);
    const finaliseBody = { data: { basedOnRevision: reopened.revision, basedOnVersion: 2, amendmentReason: 'r' } };
    const ghost = neverCreatedProjectId();

    // Act
    const viewerFinalise = await viewer.api.post(sapPath(project, reopened.sapId, '/draft/finalise'), finaliseBody);
    const viewerRead = await viewer.api.get(sapPath(project, reopened.sapId, '/draft/completeness'));
    const outsiderCalls = [
      await outsider.api.get(sapPath(project, reopened.sapId, '/draft/completeness')),
      await outsider.api.post(sapPath(project, reopened.sapId, '/draft/finalise'), finaliseBody),
      await outsider.api.get(`${base(project)}/sap-templates`),
    ];
    const ghostRead = await outsider.api.get(`${base(ghost)}/sap-templates`);
    const crossProject = await editor.api.post(sapPath(otherProject, reopened.sapId, '/draft/finalise'), finaliseBody);
    const crossRead = await editor.api.get(sapPath(otherProject, reopened.sapId, '/draft/completeness'));

    // Assert
    expect(viewerFinalise.status()).toBe(403);
    expect(viewerRead.status()).toBe(200);
    for (const res of outsiderCalls) expect(res.status()).toBe(404);
    expect(await refusalOf(outsiderCalls[2])).toEqual(await refusalOf(ghostRead));
    expect(crossProject.status()).toBe(404);
    expect(crossRead.status()).toBe(404);
  });
});
