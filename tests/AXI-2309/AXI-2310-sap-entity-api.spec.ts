import { test, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  access,
  neverCreatedProjectId,
  refusalOf,
} from '../AXI-2265/private-projects-fixtures';
import { newProject, openAmendmentDraft, primaryQuestion, provisionSap, type SapRunChildWorld } from './harness/sap-run-child';

/**
 * AXI-2310 (epic AXI-2309 Platform Opening: Headless) — the SAP (Statistical Analysis Plan)
 * entity & its READ API: read / list / versions and deny-by-default access (NFR1). API-level by design.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2310 — SAP entity & API" (AXI-2310.1 .. AXI-2310.6).
 *
 * REWRITTEN by AXI-2480 (epic AXI-2455). The free-text SAP writes (`POST …/saps`, `…/versions`)
 * answer 410 SAP_FREE_TEXT_RETIRED since AXI-2438, so this spec no longer creates a SAP that way: the
 * SAP version under test is minted by draft + finalise (AXI-2439) with the harness (one primary T1
 * question, the NEWEST T1 version the catalog lists). Per scenario:
 *   .1 .2 .3 .6  REWRITTEN on a finalised structured SAP (read back, list, amendment retains the
 *                prior version, read access deny-by-default);
 *   .4           REWRITTEN — the SAP no longer carries `linkedMethods`; a question pins a template
 *                version from the registry. EC12's "reported, never guessed" is now asked of that pin:
 *                an UNKNOWN version of a KNOWN template (T1) is refused by completeness (CC3) and at
 *                finalise, and is never replaced by the newest T1 version;
 *   .5           RETIRED — a run is no longer bound to a SAP version: `sapVersionId` on POST /rule-runs
 *                is 422 SAP_BINDING_RETIRED (AXI-2443.2) and an unbound run proceeds (AXI-2443.3).
 * The write-side access matrix (403 without the SAP write right — sap:create/sap:update since AXI-2532, smuggled bodies) is AXI-2438.7 / AXI-2439.8.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const TAGS = { tag: ['@SI-065', '@SI-010', '@SI-002', '@SI-017'] };
const QUESTION = 'Does arm A differ from arm B? (AXI-2310)';

let world: PrivateProjectsWorld;
let w: SapRunChildWorld;
let editor: Actor;
let viewer: Actor;
let stranger: Actor;
let outsider: Actor;
let projectA: string;
let projectB: string;
let privateProject: string;
let sapA: any;
let sapB: any;
let datasetB: string;
let t1Version: string;

const saps = (projectId: string, suffix = '') => apiUrl(`/api/v1/projects/${projectId}/saps${suffix}`);

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  viewer = await world.actor('viewer');
  stranger = await world.actor('stranger');
  outsider = await world.actor('outsider');
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  await world.addMember(stranger, 'editor');
  await world.leaveWorkspace();
  w = { world, editor };
  const a = await provisionSap(w, `2310a-${Date.now()}`, 'A', QUESTION);
  const b = await provisionSap(w, `2310b-${Date.now()}`, 'B', QUESTION);
  projectA = a.project;
  projectB = b.project;
  sapA = a.sap;
  sapB = b.sap;
  datasetB = b.dataset;
  t1Version = b.t1Version;
  privateProject = await newProject(w, 'private');
  expect((await access.visibility(editor, privateProject, 'private')).status()).toBe(200);
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2310 — SAP entity & API', TAGS, () => {
  test('AC1, AC2 — AXI-2310.1: a finalised SAP is read back verbatim with every contract field', async () => {
    // Act
    const read = await editor.api.get(saps(projectA, `/${sapA.id}`));

    // Assert
    expect(sapA).toMatchObject({
      id: expect.any(String),
      projectId: projectA,
      version: 1,
      status: 'final',
      contentHashVersion: 2,
      finalisedByUserId: editor.userId,
      supersededBy: null,
    });
    expect(sapA.contentHash).toMatch(/^[0-9a-f]{64}$/);
    for (const key of ['sapVersionId', 'title', 'plan', 'finalisedAt', 'analysisDatasetId']) {
      expect(sapA, key).toHaveProperty(key);
    }
    expect(sapA.plan.questions).toHaveLength(1);
    expect(sapA.plan.questions[0].text).toBe(QUESTION);
    expect(read.status()).toBe(200);
    const body = await read.json();
    expect(body.sapVersionId).toBe(sapA.sapVersionId);
    expect(body.contentHash).toBe(sapA.contentHash);
    expect(body.version).toBe(1);
    expect(JSON.stringify(body.plan)).toBe(JSON.stringify(sapA.plan));
  });

  // A project holds exactly ONE SAP (AXI-2338), so A's list is its one SAP at its latest version.
  test('AC1 — AXI-2310.2: the list is per project — A\'s one SAP at its latest version, never B\'s', async () => {
    // Act
    const res = await editor.api.get(saps(projectA, '?page=1&limit=100'));

    // Assert
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = body.data.map((s: { id: string }) => s.id);
    expect(ids).toEqual([sapA.id]);
    expect(ids).not.toContain(sapB.id);
    expect(body.meta).toMatchObject({ total: 1, page: 1, limit: 100 });
  });

  test('AC1 — AXI-2310.3: an amendment creates version 2; version 1 is retained unchanged and points at it', async () => {
    // Arrange — the amendment draft copies version 1 and must pass the completeness check
    const draft = await openAmendmentDraft(w, projectA, sapA.id, 1);

    // Act
    const amended = await editor.api.post(saps(projectA, `/${draft.sapId}/draft/finalise`), {
      data: { basedOnRevision: draft.revision, basedOnVersion: 1, amendmentReason: 'AXI-2310.3 amendment' },
    });
    const v2 = await amended.json();
    const v1 = await (await editor.api.get(saps(projectA, `/${sapA.id}/versions/1`))).json();
    const all = await (await editor.api.get(saps(projectA, `/${sapA.id}/versions`))).json();
    const latest = await (await editor.api.get(saps(projectA, `/${sapA.id}`))).json();
    const list = await (await editor.api.get(saps(projectA, '?limit=100'))).json();

    // Assert
    expect(amended.status(), JSON.stringify(v2)).toBe(201);
    expect(v2).toMatchObject({ id: sapA.id, version: 2, status: 'final', supersededBy: null, amendmentReason: 'AXI-2310.3 amendment' });
    expect(v2.sapVersionId).not.toBe(sapA.sapVersionId);
    expect(v1).toMatchObject({ sapVersionId: sapA.sapVersionId, contentHash: sapA.contentHash, supersededBy: v2.sapVersionId });
    expect(JSON.stringify(v1.plan)).toBe(JSON.stringify(sapA.plan));
    expect(all.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(latest.version).toBe(2);
    expect(list.meta.total).toBe(1);
    expect(list.data[0]).toMatchObject({ id: sapA.id, version: 2 });
    // The stale-base finalise (409 SAP_VERSION_CONFLICT) is AXI-2439.5.
  });

  test('AC1, EC12 — AXI-2310.4: an unknown version of a known template is reported and refused, never replaced by the newest version', async () => {
    // Arrange — an amendment draft of B's SAP, with a second question pinned to a T1 version the registry does not hold
    const unknownVersion = `${t1Version}.9999`;
    const draft = await openAmendmentDraft(w, projectB, sapB.id, 1);
    const added = await editor.api.post(saps(projectB, `/${sapB.id}/draft/questions`), {
      data: { basedOnRevision: draft.revision, analysisDatasetId: datasetB, question: { ...primaryQuestion(unknownVersion, 'Unknown T1 version (AXI-2310.4)'), role: 'secondary' } },
    });
    const addedBody = await added.json();

    // Act
    const report = await (await editor.api.get(saps(projectB, `/${sapB.id}/draft/completeness`))).json();
    const finalise = await editor.api.post(saps(projectB, `/${sapB.id}/draft/finalise`), {
      data: { basedOnRevision: addedBody.revision, basedOnVersion: 1, amendmentReason: 'AXI-2310.4 must be refused' },
    });
    const finaliseBody = await finalise.json();
    const stillOpen = await (await editor.api.get(saps(projectB, `/${sapB.id}/draft`))).json();
    const latest = await (await editor.api.get(saps(projectB, `/${sapB.id}`))).json();
    const discarded = await editor.api.delete(saps(projectB, `/${sapB.id}/draft?basedOnRevision=${stillOpen.revision}`));

    // Assert — the pin is stored as written, reported unresolved, and nothing is finalised
    expect(added.status(), JSON.stringify(addedBody)).toBe(201);
    const pins = stillOpen.plan.questions.map((q: any) => q.template);
    expect(pins).toEqual([{ templateId: 'T1', templateVersion: t1Version }, { templateId: 'T1', templateVersion: unknownVersion }]);
    const cc3 = report.results.filter((r: any) => r.checkId === 'CC3' && r.status === 'fail');
    expect(cc3, JSON.stringify(report.results)).toHaveLength(1);
    expect(cc3[0].message).toContain(`T1@${unknownVersion}`);
    expect(finalise.status(), JSON.stringify(finaliseBody)).toBe(422);
    expect(finaliseBody.errorCode).toBe('SAP_INCOMPLETE');
    expect(finaliseBody.errors.map((e: any) => e.checkId)).toContain('CC3');
    expect(latest).toMatchObject({ sapVersionId: sapB.sapVersionId, version: 1 });
    expect(discarded.status(), await discarded.text()).toBe(204);
  });

  test('AC16 — AXI-2310.6: read access is server-side and deny-by-default, a refusal never says whether the SAP exists', async () => {
    // Arrange
    const anonymous = await apiRequest.newContext({ extraHTTPHeaders: { 'X-Workspace-Id': world.workspaceId } });
    const ghost = neverCreatedProjectId();
    const ghostSap = neverCreatedProjectId();
    const before = (await (await editor.api.get(saps(projectA, '?limit=100'))).json()).meta.total;

    // Act
    const noToken = await anonymous.get(saps(projectA));
    const strangerCalls = [
      [await stranger.api.get(saps(privateProject)), await stranger.api.get(saps(ghost))],
      [await stranger.api.get(saps(privateProject, `/${ghostSap}`)), await stranger.api.get(saps(ghost, `/${ghostSap}`))],
      [await stranger.api.get(saps(privateProject, `/${ghostSap}/versions`)), await stranger.api.get(saps(ghost, `/${ghostSap}/versions`))],
    ];
    const outsiderCalls = [await outsider.api.get(saps(projectA)), await outsider.api.get(saps(ghost))];
    const viewerList = await viewer.api.get(saps(projectA));
    const viewerRead = await viewer.api.get(saps(projectA, `/${sapA.id}`));
    const crossPath = await editor.api.get(saps(projectB, `/${sapA.id}`));
    const crossVersions = await editor.api.get(saps(projectB, `/${sapA.id}/versions`));
    const after = (await (await editor.api.get(saps(projectA, '?limit=100'))).json()).meta.total;

    // Assert
    expect(noToken.status()).toBe(401);
    for (const [real, never] of strangerCalls) {
      const [r, n] = [await refusalOf(real), await refusalOf(never)];
      expect(r.status).toBe(404);
      expect(r).toEqual(n);
    }
    const [o, on] = [await refusalOf(outsiderCalls[0]), await refusalOf(outsiderCalls[1])];
    expect(o.status).toBe(404);
    expect(o).toEqual(on);
    expect(viewerList.status()).toBe(200);
    expect(viewerRead.status()).toBe(200);
    expect(crossPath.status()).toBe(404);
    expect(crossVersions.status()).toBe(404);
    expect(after).toBe(before);
    await anonymous.dispose();
  });
});
