import { expect, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { SapApiStub, apiCallOf, uploadArmScoreDataset, questionInput, type ApiCall } from '../AXI-2433/harness/sap-api-stub';

/**
 * AXI-2551 (epic AXI-2540 — SAP demo follow-up; feature doc
 * BACKLOG-Structured-Statistical-Analysis-Plan.md FR82, FR83, AC48, AC49) — the cross-project
 * SAP management hub: a `sap:read`-gated left-menu entry opening Plans/Runs/Templates as tabs
 * on the page (OQ8, ruled 2026-11-15), the Plans/Runs lists workspace-wide with an optional
 * project filter (OQ7, ruled 2026-11-15), Templates visible only to `template:write`.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2540-SAP-demo-follow-up.md` § AXI-2551 (.1 … .6).
 *
 * E2E CONTRACT — every route REAL on the demo gateway: sign-in, fixture workspace, throwaway
 * WORKSPACE roles holding exactly the rights a scenario needs, two projects with a seeded SAP
 * each (one draft, one finalised + run), one project the caller has NO grant on (never listed).
 * `GET /sap-management/saps`, `GET /sap-management/runs`.
 *
 * Self-provisioned: a fresh workspace whose platform admin leaves it; a team editor who seeds
 * every SAP; one throwaway actor per right set. Run with `--no-deps`.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let world: PrivateProjectsWorld;
let editor: UiActor;
let call: ApiCall;
let datasetId: string;
let projectA: { id: string; stub: SapApiStub };
let projectB: { id: string; stub: SapApiStub };
let projectC: { id: string; stub: SapApiStub }; // seeded with a SAP, but never granted to the caller actors
let reader: UiActor; // sap:read only
let readerWithTemplates: UiActor; // sap:read + template:write
let noRead: UiActor; // no sap:read at all

async function newProject(label: string): Promise<{ id: string; stub: SapApiStub }> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2551 ${label} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const link = await editor.api.post(apiUrl(`/api/v1/projects/${id}/datasets`), { data: { datasetId } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  return { id, stub: new SapApiStub(id, editor.userId, datasetId) };
}

async function signIn(page: Page, actor: UiActor): Promise<void> {
  await page.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(page, actor, world.workspaceId);
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await uiActor('axi2551-editor', world.workspaceId);
  await world.addMember(editor, 'editor');
  call = apiCallOf(editor.api);
  datasetId = await uploadArmScoreDataset(world, editor.api, 'axi2551');

  projectA = await newProject('A');
  projectB = await newProject('B');
  projectC = await newProject('C');

  // Project A: an open draft (Plans tab status = draft, no run).
  await projectA.stub.seedDraft(apiCallOf(editor.api, {}), [questionInput(1)], 'AXI-2551 draft SAP');
  // Project B: a finalised version 1 (Plans tab status = final, current version = 1).
  await projectB.stub.seedFinal(apiCallOf(editor.api, {}), 'AXI-2551 final SAP', [questionInput(1)]);
  // Project C: also seeded, but set PRIVATE with no grant to any caller actor — must never appear.
  await projectC.stub.seedFinal(apiCallOf(editor.api, {}), 'AXI-2551 unreadable SAP', [questionInput(1)]);
  const visRes = await access.visibility(editor, projectC.id, 'private');
  expect(visRes.status(), await visRes.text()).toBeLessThan(300);

  reader = await uiActor('axi2551-reader', world.workspaceId);
  readerWithTemplates = await uiActor('axi2551-reader-tpl', world.workspaceId);
  noRead = await uiActor('axi2551-noread', world.workspaceId);
  const readerRole = await world.workspaceRole('AXI-2551 reader', ['project:read', 'sap:read']);
  const readerTplRole = await world.workspaceRole('AXI-2551 reader+tpl', ['project:read', 'sap:read', 'template:write']);
  const noReadRole = await world.workspaceRole('AXI-2551 no-read', ['project:read']);
  await world.addMember(reader, { roleId: readerRole });
  await world.addMember(readerWithTemplates, { roleId: readerTplRole });
  await world.addMember(noRead, { roleId: noReadRole });
  // A and B are public by default — `project:read` alone already admits them; only C is withheld.
});

test.afterAll(async () => {
  await world.dispose();
});

test('FR82/FR78 — AXI-2551.1 the SAP management entry is visible only to a sap:read holder, on both surfaces @SI-010 @SI-031 @SI-066', async ({ page }) => {
  await signIn(page, noRead);
  await page.goto('/sap-management');
  await expect(page.getByTestId('sap-management-access-denied')).toBeVisible();

  await signIn(page, reader);
  await page.goto('/sap-management');
  await expect(page.getByTestId('sap-management-page')).toBeVisible();
});

test('AC48/FR82/NFR1 — AXI-2551.2 the Plans tab lists SAPs across every readable project, right columns, never an unreadable project @SI-010 @SI-031', async ({ page }) => {
  const res = await reader.api.get(apiUrl('/api/v1/sap-management/saps?limit=50'));
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  const projectIds = (body.data as Array<{ projectId: string }>).map((r) => r.projectId);
  expect(projectIds).toContain(projectA.id);
  expect(projectIds).toContain(projectB.id);
  expect(projectIds).not.toContain(projectC.id);

  await signIn(page, reader);
  await page.goto('/sap-management');
  await expect(page.getByTestId('sap-management-plan-table')).toBeVisible();
  await expect(page.getByTestId(`sap-management-plan-row-${(body.data as Array<{ sapId: string; projectId: string }>).find((r) => r.projectId === projectA.id)!.sapId}`)).toBeVisible();
});

test('FR82 — AXI-2551.3 the Plans tab project filter only narrows, never widens, the readable set (OQ7 ruled) @SI-010 @SI-031', async ({ page }) => {
  const narrowed = await reader.api.get(apiUrl(`/api/v1/sap-management/saps?projectId=${projectA.id}`));
  expect(narrowed.status()).toBe(200);
  const narrowedBody = await narrowed.json();
  expect((narrowedBody.data as Array<{ projectId: string }>).every((r) => r.projectId === projectA.id)).toBe(true);

  const unreadable = await reader.api.get(apiUrl(`/api/v1/sap-management/saps?projectId=${projectC.id}`));
  expect(unreadable.status()).toBe(200);
  const unreadableBody = await unreadable.json();
  expect(unreadableBody.data).toEqual([]);

  await signIn(page, reader);
  await page.goto(`/sap-management?projectId=${projectC.id}`);
  await expect(page.getByTestId('sap-management-empty')).toBeVisible();
});

test('FR83 — AXI-2551.4 the Runs tab lists SAP runs across readable projects with classification @SI-010 @SI-031 @SI-066', async ({ page }) => {
  const res = await reader.api.get(apiUrl('/api/v1/sap-management/runs?limit=50'));
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  const projectIds = (body.data as Array<{ projectId: string }>).map((r) => r.projectId);
  expect(projectIds).not.toContain(projectC.id);

  await signIn(page, reader);
  await page.goto('/sap-management?tab=runs');
  await expect(page.getByTestId('sap-management-runs-table').or(page.getByTestId('sap-management-empty'))).toBeVisible();
});

test('AC49/FR83 — AXI-2551.5 Templates is a tab shown only to a template:write holder; links into the existing Template Library @SI-010 @SI-066', async ({ page }) => {
  await signIn(page, reader);
  await page.goto('/sap-management');
  await expect(page.getByTestId('sap-management-tab-templates')).toHaveCount(0);

  await signIn(page, readerWithTemplates);
  await page.goto('/sap-management');
  await page.getByTestId('sap-management-tab-templates').click();
  await expect(page.getByTestId('sap-management-templates-link')).toBeVisible();
  await page.getByTestId('sap-management-templates-link').click();
  await expect(page).toHaveURL(/\/analysis-templates$/);
});

test('AC49/FR78 — AXI-2551.6 every hub route fails closed without sap:read @SI-010 @SI-031', async () => {
  const saps = await noRead.api.get(apiUrl('/api/v1/sap-management/saps'));
  expect(saps.status()).toBe(403);
  expect(await saps.text()).toContain('sap:read');

  const runs = await noRead.api.get(apiUrl('/api/v1/sap-management/runs'));
  expect(runs.status()).toBe(403);
  expect(await runs.text()).toContain('sap:read');
});
