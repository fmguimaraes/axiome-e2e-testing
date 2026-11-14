import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, type Actor } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { SapApiStub, apiCallOf, pinNewestT1, questionInput, uploadArmScoreDataset, type ApiCall } from '../AXI-2433/harness/sap-api-stub';

/**
 * AXI-2532 (epic AXI-2455 — SAP & Template Library Follow-ups; feature doc
 * BACKLOG-Structured-Statistical-Analysis-Plan.md FR16, FR77–FR79, EC42, AC44–AC46) —
 * the single `sap:write` permission is split into six: `sap:read` (every SAP GET),
 * `sap:create` (start a draft / amend), `sap:update` (save the draft, add / edit / remove /
 * reorder questions), `sap:delete` (discard), `sap:finalise` and `sap:run` (with
 * `governed_execution:submit`). Every SAP write also needs `sap:read`. ProjectAccessGuard
 * still decides WHICH project (no access is 404, never 403).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md`
 * § AXI-2532 (AXI-2532.1 … AXI-2532.6; .5 and .6 are `manual`, reasons stated there).
 *
 * E2E CONTRACT — every route REAL on the demo gateway: sign-in, fixture workspace, throwaway
 * WORKSPACE roles holding exactly the rights a scenario needs, projects, dataset, every SAP
 * route, `GET /workspace-permissions/me`, `GET /roles/:id`. No double.
 *
 * Self-provisioned: a fresh workspace whose platform admin leaves it; a team editor (who
 * seeds every SAP), one throwaway actor per right set. Run with `--no-deps`.
 *
 * Owner override for AXI-2455 (2026-11-07): authored, NOT executed by the story developer.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const SAP_RIGHTS = ['sap:read', 'sap:create', 'sap:update', 'sap:delete', 'sap:finalise', 'sap:run'] as const;
/** The seeded fixed WORKSPACE roles (`scripts/seed_workspace_roles.sql`) and the demo Super Admin custom role. */
const SEEDED_ROLES = {
  viewer: '00000000-0000-0000-0000-000000000100',
  sponsorViewer: '00000000-0000-0000-0000-000000000101',
  editor: '00000000-0000-0000-0000-000000000102',
  approver: '00000000-0000-0000-0000-000000000103',
  admin: '00000000-0000-0000-0000-000000000104',
  investigator: '00000000-0000-0000-0000-000000000105',
} as const;
const SUPER_ADMIN_ROLE_ID = '17cdcae3-7939-40be-baf2-584f9c995023';

let world: PrivateProjectsWorld;
let editor: UiActor;
let call: ApiCall;
let datasetId: string;
/** One actor per right set — `project:read` always, so the project is visible and only the SAP right is under test. */
const actors: Record<string, UiActor> = {};
const RIGHT_SETS: Record<string, string[]> = {
  none: ['project:read'],
  reader: ['project:read', 'sap:read'],
  createWithoutRead: ['project:read', 'sap:create', 'sap:update', 'sap:delete', 'sap:finalise', 'sap:run', 'governed_execution:submit'],
  creator: ['project:read', 'sap:read', 'sap:create'],
  updater: ['project:read', 'sap:read', 'sap:update'],
  deleter: ['project:read', 'sap:read', 'sap:delete'],
  finaliser: ['project:read', 'sap:read', 'sap:finalise'],
  runnerWithoutSubmit: ['project:read', 'sap:read', 'sap:run'],
};

const base = (projectId: string) => `/api/v1/projects/${projectId}`;

async function newProject(label: string): Promise<{ id: string; stub: SapApiStub }> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2532 ${label} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const link = await editor.api.post(apiUrl(`${base(id)}/datasets`), { data: { datasetId } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  return { id, stub: new SapApiStub(id, editor.userId, datasetId) };
}

async function permissionsOf(actor: Actor): Promise<string[]> {
  const res = await actor.api.get(apiUrl('/api/v1/workspace-permissions/me'));
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return (body.permissions ?? body) as string[];
}

async function expectRefusedFor(res: APIResponse, permission: string, what: string): Promise<void> {
  const text = await res.text();
  expect(res.status(), `${what}: ${text}`).toBe(403);
  expect(text, what).toContain(permission);
}

async function signIn(page: Page, actor: UiActor): Promise<void> {
  await page.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(page, actor, world.workspaceId);
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await uiActor('editor', world.workspaceId);
  await world.addMember(editor, 'editor');
  for (const [label, permissions] of Object.entries(RIGHT_SETS)) {
    const roleId = await world.workspaceRole(`AXI-2532 ${label}`, permissions);
    actors[label] = await uiActor(label, world.workspaceId);
    await world.addMember(actors[label], { roleId });
  }
  await world.leaveWorkspace();
  datasetId = await uploadArmScoreDataset(world, editor.api, 'axi2532');
  call = apiCallOf(editor.api);
  await pinNewestT1(call, (await newProject('catalogue')).id); // seeds pin the registry's newest T1
});

test.afterAll(async () => {
  for (const a of [editor, ...Object.values(actors)]) await a?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2532 SAP CRUD permissions @SI-010 @SI-031 @SI-065', () => {
  test('FR77 FR78 AC45 AXI-2532.1 without sap:read every SAP GET is 403 naming sap:read; with it every GET answers @SI-010', async () => {
    // Arrange — a final version 1 (so the run reads exist) plus an open amendment draft
    const { id, stub } = await newProject('reads');
    const final = await stub.seedFinal(call, 'Plan reads', [questionInput(1, 'primary')]);
    const sapId = final.sapId ?? final.id;
    await stub.seedAmendment(call);
    const reads = [
      `${base(id)}/saps`,
      `${base(id)}/saps/${sapId}`,
      `${base(id)}/saps/${sapId}/versions`,
      `${base(id)}/saps/${sapId}/versions/1`,
      `${base(id)}/sap-draft`,
      `${base(id)}/saps/${sapId}/draft`,
      `${base(id)}/saps/${sapId}/draft/completeness`,
      `${base(id)}/sap-templates`,
      `${base(id)}/saps/${sapId}/runs`,
      `${base(id)}/saps/${sapId}/run-classification-preview`,
    ];

    // Act
    const withoutRead = await Promise.all(reads.map((path) => actors.none.api.get(apiUrl(path))));
    const withRead = await Promise.all(reads.map((path) => actors.reader.api.get(apiUrl(path))));

    // Assert
    expect(await permissionsOf(actors.none)).not.toContain('sap:read');
    for (const [i, res] of withoutRead.entries()) await expectRefusedFor(res, 'sap:read', reads[i]);
    for (const [i, res] of withRead.entries()) expect(res.status(), `${reads[i]}: ${await res.text()}`).not.toBe(403);
    expect(withRead[4].status()).toBe(200); // GET sap-draft
    expect(withRead[0].status()).toBe(200); // GET saps
  });

  test('FR77 AC44 EC42 AXI-2532.2 each SAP write is admitted by its own right only, and every write also needs sap:read @SI-010 @SI-065', async () => {
    // Arrange — the editor opens a draft with one question
    const { id, stub } = await newProject('writes');
    const draft = await stub.seedDraft(call, [questionInput(1, 'primary')], 'Draft writes');
    const sapId = draft.sapId;
    const qid = draft.plan.questions[0].questionId;
    const rev = draft.revision;
    const save = { basedOnRevision: rev, title: 'retitled' };
    const as = (label: string) => actors[label].api;

    // Act — every refused act first (nothing changes), then the admitted ones
    const saveWithoutRead = await as('createWithoutRead').put(apiUrl(`${base(id)}/saps/${sapId}/draft`), { data: save });
    const discardWithoutRead = await as('createWithoutRead').delete(apiUrl(`${base(id)}/saps/${sapId}/draft?basedOnRevision=${rev}`));
    const startByReader = await as('reader').post(apiUrl(`${base(id)}/saps/draft`));
    const saveByCreator = await as('creator').put(apiUrl(`${base(id)}/saps/${sapId}/draft`), { data: save });
    const saveByDeleter = await as('deleter').put(apiUrl(`${base(id)}/saps/${sapId}/draft`), { data: save });
    const removeQuestionByFinaliser = await as('finaliser').delete(
      apiUrl(`${base(id)}/saps/${sapId}/draft/questions/${qid}?basedOnRevision=${rev}`),
    );
    const discardByUpdater = await as('updater').delete(apiUrl(`${base(id)}/saps/${sapId}/draft?basedOnRevision=${rev}`));
    const finaliseByUpdater = await as('updater').post(apiUrl(`${base(id)}/saps/${sapId}/draft/finalise`), { data: {} });
    const finaliseByDeleter = await as('deleter').post(apiUrl(`${base(id)}/saps/${sapId}/draft/finalise`), { data: {} });
    const unchanged = await call('GET', `/projects/${id}/saps/${sapId}/draft`);

    const saveByUpdater = await as('updater').put(apiUrl(`${base(id)}/saps/${sapId}/draft`), { data: save });
    const saved = await saveByUpdater.json();
    const discardByDeleter = await as('deleter').delete(apiUrl(`${base(id)}/saps/${sapId}/draft?basedOnRevision=${saved.revision}`));
    const startByCreator = await as('creator').post(apiUrl(`${base(id)}/saps/draft`));

    // Assert
    await expectRefusedFor(saveWithoutRead, 'sap:read', 'PUT draft without sap:read');
    await expectRefusedFor(discardWithoutRead, 'sap:read', 'DELETE draft without sap:read');
    await expectRefusedFor(startByReader, 'sap:create', 'POST saps/draft by a reader');
    await expectRefusedFor(saveByCreator, 'sap:update', 'PUT draft by sap:create only');
    await expectRefusedFor(saveByDeleter, 'sap:update', 'PUT draft by sap:delete only');
    await expectRefusedFor(removeQuestionByFinaliser, 'sap:update', 'DELETE question by sap:finalise only');
    await expectRefusedFor(discardByUpdater, 'sap:delete', 'DELETE draft by sap:update only');
    await expectRefusedFor(finaliseByUpdater, 'sap:finalise', 'finalise by sap:update only');
    await expectRefusedFor(finaliseByDeleter, 'sap:finalise', 'finalise by sap:delete only');
    expect(unchanged.body).toMatchObject({ revision: rev, title: 'Draft writes' });

    expect(saveByUpdater.status(), JSON.stringify(saved)).toBe(200);
    expect(saved.title).toBe('retitled');
    expect(discardByDeleter.status(), await discardByDeleter.text()).toBe(204);
    expect(startByCreator.status(), await startByCreator.text()).toBe(201);
  });

  test('FR77 FR64 NFR1 AC44 AXI-2532.3 Run SAP needs sap:run AND governed_execution:submit; a finaliser cannot run @SI-010 @SI-065', async () => {
    // Arrange
    const { id, stub } = await newProject('run');
    const final = await stub.seedFinal(call, 'Plan run', [questionInput(1, 'primary')]);
    const sapId = final.sapId ?? final.id;

    // Act
    const byRunnerWithoutSubmit = await actors.runnerWithoutSubmit.api.post(apiUrl(`${base(id)}/saps/${sapId}/runs`), { data: {} });
    const byFinaliser = await actors.finaliser.api.post(apiUrl(`${base(id)}/saps/${sapId}/runs`), { data: {} });
    const runs = await call('GET', `/projects/${id}/saps/${sapId}/runs`);

    // Assert
    await expectRefusedFor(byRunnerWithoutSubmit, 'governed_execution:submit', 'POST runs with sap:run only');
    await expectRefusedFor(byFinaliser, 'sap:run', 'POST runs by sap:finalise only');
    expect(runs.status).toBe(200);
    expect(JSON.stringify(runs.body)).not.toContain('"sapRunId"');
  });

  test('FR78 AC45 AXI-2532.4 without sap:read the SAP page renders no plan, only the sap:read notice, and reads no SAP route @SI-031', async ({ page }) => {
    // Arrange
    const { id, stub } = await newProject('ui-denied');
    await stub.seedFinal(call, 'Plan hidden', [questionInput(1, 'primary')]);
    const sapReads: string[] = [];
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname;
      if (r.method() === 'GET' && (/\/saps(\/|$)/.test(path) || /\/sap-(draft|templates)$/.test(path))) sapReads.push(path);
    });
    await signIn(page, actors.none);

    // Act
    await page.goto(`/projects/${id}/sap`);

    // Assert
    await expect(page.getByTestId('project-sap-page')).toBeVisible();
    await expect(page.getByTestId('sap-read-denied')).toContainText('sap:read');
    for (const tid of ['sap-plan-tab', 'sap-tab-plan', 'sap-tab-runs', 'sap-final-title', 'sap-start-draft', 'sap-run']) {
      await expect(page.getByTestId(tid), tid).toHaveCount(0);
    }
    expect(sapReads).toEqual([]);
  });

  test('FR77 AC44 AXI-2532.5 on the Plan tab each control shows only for its own right: an updater edits but cannot finalise, discard or start @SI-031', async ({ page }) => {
    // Arrange — an open first draft with one question
    const { id, stub } = await newProject('ui-updater');
    await stub.seedDraft(call, [questionInput(1, 'primary')], 'Draft updater');
    await signIn(page, actors.updater);

    // Act
    await page.goto(`/projects/${id}/sap`);

    // Assert
    await expect(page.getByTestId('sap-plan-tab')).toBeVisible();
    await expect(page.getByTestId('sap-add-question')).toBeVisible();
    await expect(page.getByTestId('sap-draft-title')).toBeVisible();
    for (const tid of ['sap-finalise', 'sap-discard-draft', 'sap-start-draft', 'sap-amend', 'sap-run', 'sap-read-only-note']) {
      await expect(page.getByTestId(tid), tid).toHaveCount(0);
    }
  });

  test('FR79 AC46 AXI-2532.6 after the migration every seeded role and Super Admin hold the SAP rights they need and no role holds sap:write @SI-010', async () => {
    // Arrange
    const read = async (roleId: string): Promise<string[]> => {
      const res = await world.admin.get(apiUrl(`/api/v1/roles/${roleId}`));
      expect(res.status(), `${roleId}: ${await res.text()}`).toBe(200);
      return (await res.json()).permissions as string[];
    };

    // Act
    const roles = Object.fromEntries(
      await Promise.all(Object.entries(SEEDED_ROLES).map(async ([name, id]) => [name, await read(id)] as const)),
    );
    const superAdmin = await read(SUPER_ADMIN_ROLE_ID);

    // Assert
    for (const name of ['editor', 'approver', 'admin', 'investigator'] as const) {
      expect(roles[name], name).toEqual(expect.arrayContaining([...SAP_RIGHTS]));
    }
    for (const name of ['viewer', 'sponsorViewer'] as const) {
      expect(roles[name], name).toContain('sap:read');
      for (const right of SAP_RIGHTS.slice(1)) expect(roles[name], `${name} ${right}`).not.toContain(right);
    }
    expect(superAdmin).toEqual(expect.arrayContaining([...SAP_RIGHTS]));
    for (const perms of [...Object.values(roles), superAdmin]) expect(perms).not.toContain('sap:write');
  });
});
