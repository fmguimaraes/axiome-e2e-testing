import { test, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  PrivateProjectsWorld,
  access,
  neverCreatedProjectId,
  refusalOf,
} from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2310 (epic AXI-2309 Platform Opening: Headless) — the SAP (Statistical
 * Analysis Plan) entity & API: create / read / list / re-plan, the run → SAP
 * binding refusal (EC7), linked-method resolution (EC12) and deny-by-default
 * access (NFR1). API-level by design: this epic builds no client screen.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2310 — SAP entity & API" (AXI-2310.1 .. AXI-2310.6).
 *
 * Requires organization-service with `SAP_RUN_BINDING` unset (fail-closed
 * default) — the demo-only `off` hatch turns §.5 red, correctly.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-065', '@SI-010', '@SI-002', '@SI-017'] };
const REGISTERED_OP = 'stats.mann_whitney_u';
const PLAN_TEXT = 'Primary: Mann–Whitney U on CD8⁺ µ%, α = 0.05, two-sided.\n  Secondary: n ≥ 12 per arm — café.  \n';
const QUESTION = '  Does arm A differ from arm B?\n';

let world: PrivateProjectsWorld;
let editor: Actor;
let viewer: Actor;
let stranger: Actor;
let outsider: Actor;
let projectA: string;
let projectB: string;
let privateProject: string;

function content(overrides: Record<string, unknown> = {}) {
  return {
    title: `E2E AXI-2310 SAP ${Date.now()}`,
    questionText: QUESTION,
    planText: PLAN_TEXT,
    linkedMethods: [{ operationId: REGISTERED_OP }],
    ...overrides,
  };
}

const saps = (projectId: string, suffix = '') => apiUrl(`/api/v1/projects/${projectId}/saps${suffix}`);

async function createSap(a: Actor, projectId: string, body = content()) {
  const res = await a.api.post(saps(projectId), { data: body });
  expect(res.status(), await res.text()).toBe(201);
  return res.json();
}

async function newProject(name: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2310 ${name} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  viewer = await world.actor('viewer');
  stranger = await world.actor('stranger');
  outsider = await world.actor('outsider');
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  await world.addMember(stranger, 'editor');
  await world.leaveWorkspace();
  projectA = await newProject('A');
  projectB = await newProject('B');
  privateProject = await newProject('private');
  expect((await access.visibility(editor, privateProject, 'private')).status()).toBe(200);
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2310 — SAP entity & API', TAGS, () => {
  let created: any;

  test('AC1, AC2 — AXI-2310.1: a SAP is created and read back verbatim with every contract field', async () => {
    // Act
    created = await createSap(editor, projectA);
    const read = await editor.api.get(saps(projectA, `/${created.id}`));

    // Assert
    expect(created).toMatchObject({
      projectId: projectA,
      version: 1,
      questionText: QUESTION,
      planText: PLAN_TEXT,
      linkedMethods: [{ operationId: REGISTERED_OP }],
      authorUserId: editor.userId,
      supersededBy: null,
    });
    expect(created.contentHash).toMatch(/^[0-9a-f]{64}$/);
    for (const key of ['id', 'sapVersionId', 'title', 'createdAt', 'updatedAt', 'linkedMethodResolution']) {
      expect(created).toHaveProperty(key);
    }
    expect(read.status()).toBe(200);
    const body = await read.json();
    expect(body.sapVersionId).toBe(created.sapVersionId);
    expect(body.contentHash).toBe(created.contentHash);
    expect(body.planText).toBe(PLAN_TEXT);
  });

  test('AC1 — AXI-2310.2: the list is per project — the latest version of each of A\'s SAPs, never B\'s', async () => {
    // Arrange
    const second = await createSap(editor, projectA);
    const ofB = await createSap(editor, projectB);

    // Act
    const res = await editor.api.get(saps(projectA, '?page=1&limit=100'));

    // Assert
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = body.data.map((s: { id: string }) => s.id);
    expect(ids.sort()).toEqual([created.id, second.id].sort());
    expect(ids).not.toContain(ofB.id);
    expect(body.meta).toMatchObject({ total: 2, page: 1, limit: 100 });
  });

  test('AC1 — AXI-2310.3: re-plan creates version 2; version 1 is retained unchanged and points at it; stale re-plan is 409', async () => {
    // Act
    const replan = await editor.api.post(saps(projectA, `/${created.id}/versions`), {
      data: { ...content({ planText: `${PLAN_TEXT}Amended: Holm correction.` }), basedOnVersion: 1 },
    });
    const v2 = await replan.json();
    const v1 = await (await editor.api.get(saps(projectA, `/${created.id}/versions/1`))).json();
    const all = await (await editor.api.get(saps(projectA, `/${created.id}/versions`))).json();
    const latest = await (await editor.api.get(saps(projectA, `/${created.id}`))).json();
    const stale = await editor.api.post(saps(projectA, `/${created.id}/versions`), {
      data: { ...content(), basedOnVersion: 1 },
    });

    // Assert
    expect(replan.status()).toBe(201);
    expect(v2).toMatchObject({ id: created.id, version: 2, supersededBy: null });
    expect(v2.sapVersionId).not.toBe(created.sapVersionId);
    expect(v2.contentHash).not.toBe(created.contentHash);
    expect(v1).toMatchObject({
      sapVersionId: created.sapVersionId,
      planText: PLAN_TEXT,
      contentHash: created.contentHash,
      supersededBy: v2.sapVersionId,
    });
    expect(all.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(latest.version).toBe(2);
    expect(stale.status()).toBe(409);
    expect((await stale.json()).errorCode).toBe('SAP_VERSION_CONFLICT');
  });

  test('AC1, EC12 — AXI-2310.4: an unresolvable linked method is reported in order, never guessed or replaced', async () => {
    // Arrange
    const missingRule = { ruleId: neverCreatedProjectId(), ruleVersion: 1 };
    const refs = [{ operationId: REGISTERED_OP }, { operationId: 'stats.not_a_registered_operation' }, missingRule];

    // Act
    const sap = await createSap(editor, projectA, content({ linkedMethods: refs }));

    // Assert
    expect(sap.linkedMethods).toEqual(refs);
    expect(sap.linkedMethodResolution).toEqual([
      { index: 0, ref: refs[0], status: 'resolved' },
      { index: 1, ref: refs[1], status: 'unresolved', reason: 'operation_not_registered' },
      { index: 2, ref: refs[2], status: 'unresolved', reason: 'rule_version_not_found' },
    ]);
  });

  test('AC1, EC7 — AXI-2310.5: a run with no bound SAP version (or another project\'s) is refused; nothing executes', async () => {
    // Arrange
    const ofB = await createSap(editor, projectB);
    const run = (extra: Record<string, unknown>) =>
      editor.api.post(apiUrl('/api/v1/rule-runs'), {
        data: { ruleId: neverCreatedProjectId(), projectId: projectA, workspaceId: world.workspaceId, ...extra },
      });

    // Act
    const unbound = await run({});
    const foreign = await run({ sapVersionId: ofB.sapVersionId });
    const own = await run({ sapVersionId: created.sapVersionId });

    // Assert
    expect(unbound.status()).toBe(422);
    const unboundBody = await unbound.json();
    expect(unboundBody.errorCode).toBe('SAP_VERSION_REQUIRED');
    expect(unboundBody).not.toHaveProperty('ruleRunId');
    expect(foreign.status()).toBe(422);
    expect((await foreign.json()).errorCode).toBe('SAP_VERSION_NOT_FOUND');
    const ownBody = await own.json().catch(() => ({}));
    expect(String(ownBody.errorCode ?? '')).not.toMatch(/^SAP_/);
  });

  test('AC16 — AXI-2310.6: access is server-side and deny-by-default, tenancy never from the body', async () => {
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
      [await stranger.api.post(saps(privateProject), { data: content() }), await stranger.api.post(saps(ghost), { data: content() })],
    ];
    const outsiderCalls = [await outsider.api.get(saps(projectA)), await outsider.api.get(saps(ghost))];
    const viewerRead = await viewer.api.get(saps(projectA));
    const viewerWrite = await viewer.api.post(saps(projectA), { data: content() });
    const smuggled = await Promise.all(
      [{ projectId: projectB }, { authorUserId: viewer.userId }, { version: 7 }].map((extra) =>
        editor.api.post(saps(projectA), { data: { ...content(), ...extra } }),
      ),
    );
    const crossPath = await editor.api.get(saps(projectB, `/${created.id}`));
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
    expect(viewerRead.status()).toBe(200);
    expect(viewerWrite.status()).toBe(403);
    for (const res of smuggled) expect(res.status()).toBe(400);
    expect(crossPath.status()).toBe(404);
    expect(after).toBe(before);
    await anonymous.dispose();
  });
});
