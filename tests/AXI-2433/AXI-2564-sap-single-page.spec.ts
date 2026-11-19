import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { apiCallOf, pinNewestT1, questionInput, uploadArmScoreDataset, type ApiCall, SapApiStub } from './harness/sap-api-stub';

/**
 * AXI-2564 (epic AXI-2433 — Structured Statistical Analysis Plan) — the Investigator SAP
 * surface becomes one page (owner ask, modelled on the Dataset Tables page, AXI-2538): no
 * Plan/Runs tab strip, the plan (current version + questions table) and its Runs section both
 * render on the one page, the header is built on the shared `PageHeader` component, and the
 * plan's earlier versions move off this page onto a new, dedicated, paginated
 * `/…/sap/versions` page with a read-only per-version detail view.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md`
 * § AXI-2564 (AXI-2564.1 … AXI-2564.9 — .8/.9 added bounce #2, FR96: create-plan-first
 * ordering — "first someone with the permission [to create] must be allowed to create the
 * title, objective and plan; once saved [...] questions might be added" (owner ask 2026-11-15)).
 *
 * E2E CONTRACT — every route REAL on the demo gateway, same shape and fixtures as AXI-2552's
 * spec (sign-in, fixture workspace, project, dataset, caller permissions, the real SAP
 * draft/finalise/completeness/run API — nothing doubled). `SapApiStub` is used only as the thin
 * API-call helper + write-observer this suite already established.
 *
 * STATUS AT HAND-OFF: run headless against this story's own front-end (a standalone dev-server
 * process on a free port, never the shared W5-validation stack) over the existing :3001 backend
 * — see the handoff report for the pass count. AXI-2564.9's original "sap:read, no sap:create"
 * reader half is DESCOPED from automation (identity wall — see the test's own comment and the
 * handoff report); the rest of AXI-2564.9 and all other scenarios are automated here.
 *
 * REWORK #3 (owner-approved, test-only): AXI-2564.7 was mis-authored, not a server gap. A
 * project created with no `visibility` defaults to `public` (UT-ORG-2267-36), under which ANY
 * workspace member holding `sap:read` (the outsider's INVESTIGATOR_ROLE_ID) passes the
 * front-end's SapReadGate too — both gates were correctly letting him in. The server DOES
 * enforce project-level access (`saps.controller.ts`'s controller-level `ProjectAccessGuard` →
 * `ProjectAccessPredicate.accessArms`, `project-access.predicate.ts:84`); AXI-2564.7 now
 * creates the target project `visibility: 'private'` and asserts the real server-denied state
 * (404, `ProjectAccessNotFound`'s `project-not-found` testid) instead of the front-end's own
 * `sap-read-denied` gate (testing THAT gate would need an actor with project access but no
 * `sap:read`, which hits the same identity wall as AXI-2564.9b and is left manual for the
 * same reason).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2564-e2e-pw!';

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;
/** AXI-2564.7 — a workspace member (sap:read via INVESTIGATOR_ROLE_ID) never granted
 *  access to the PRIVATE project under test; the server's own ProjectAccessGuard refuses. */
let outsider: Person;
let datasetId: string;
let call: ApiCall;

interface Fixture {
  project: { id: string; name: string };
  stub: SapApiStub;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2564-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2564', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

async function newProject(label: string, visibility?: 'public' | 'private'): Promise<Fixture> {
  const name = `E2E AXI-2564 ${label} ${Date.now()}`;
  const data: Record<string, unknown> = { name, workspaceId: world.workspaceId };
  if (visibility) data.visibility = visibility;
  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const grant = await access.grant(projectOwner, id, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
  const link = await projectOwner.api.post(apiUrl(`/api/v1/projects/${id}/datasets`), { data: { datasetId } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  return { project: { id, name }, stub: new SapApiStub(id, investigator.userId, datasetId) };
}

/** Same session/scope precedent as AXI-2552's `openInvestigatorSap`. */
async function openInvestigatorSap(page: Page, stub: SapApiStub, projectId: string): Promise<void> {
  await stub.install(page);
  await page.addInitScript(
    ([org, ws, p]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', p);
    },
    [world.orgId, world.workspaceId, projectId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
  await gotoSettled(page, `/investigator/projects/${projectId}/sap`);
  await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  projectOwner = await world.actor('owner');
  await world.addMember(projectOwner, 'editor');
  outsider = await person('outsider', world.workspaceId);
  await world.addMember(outsider, { roleId: INVESTIGATOR_ROLE_ID });
  // Every `world.addMember`/`world.workspaceRole` call must happen BEFORE the admin leaves the
  // workspace below — the admin's own membership is what authorizes it to add/create on this
  // workspace at all; afterwards those routes 404 "Workspace not found" for it (AXI-2267).
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  datasetId = await uploadArmScoreDataset(world, investigator.api, 'axi2564');
  call = apiCallOf(investigator.api);
  await pinNewestT1(call, (await newProject('catalogue')).project.id);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await outsider?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2564 Investigator SAP page: single page, no tabs, dedicated versions page @SI-031 @SI-066', () => {
  test('AXI-2564.1 no tab strip — the current version and its runs render on one page', async ({ page }) => {
    // Arrange
    const { project, stub } = await newProject('single-page');
    await stub.seedFinal(call, 'Plan single-page', [questionInput(1, 'primary')]);
    await call('POST', `/projects/${project.id}/sap-runs`, { version: 1, datasetVersionId: datasetId });

    // Act
    await openInvestigatorSap(page, stub, project.id);

    // Assert
    await expect(page.getByTestId('sap-current')).toBeVisible();
    await expect(page.getByTestId('sap-runs-section')).toBeVisible();
    await expect(page.getByTestId('sap-tab-plan')).toHaveCount(0);
    await expect(page.getByTestId('sap-tab-runs')).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]tab=/);
  });

  test('AXI-2564.2 the PageHeader carries Run plan / Add question; both still work', async ({ page }) => {
    // Arrange
    const { project, stub } = await newProject('header-actions');
    await stub.seedFinal(call, 'Plan header-actions', [questionInput(1, 'primary')]);

    // Act
    await openInvestigatorSap(page, stub, project.id);

    // Assert
    await expect(page.getByRole('heading', { name: 'Statistical plan' })).toBeVisible();
    const run = page.getByTestId('sap-run');
    await expect(run).toBeEnabled();
    await run.click();
    await expect(page).toHaveURL(/\/sap\?run=new$/);
    await expect(page).not.toHaveURL(/[?&]tab=/);
  });

  test('AXI-2564.3 the Runs section hides its own Run button — only the header\'s remains', async ({ page }) => {
    // Arrange
    const { project, stub } = await newProject('hide-run-button');
    await stub.seedFinal(call, 'Plan hide-run-button', [questionInput(1, 'primary')]);

    // Act
    await openInvestigatorSap(page, stub, project.id);

    // Assert — exactly one "Run"-labelled control for the whole page (the header's)
    await expect(page.getByTestId('sap-run')).toHaveCount(1);
    await expect(page.getByTestId('sap-runs-run')).toHaveCount(0);
  });

  test('AXI-2564.4 the inline version selector is gone; "Version history" links to the dedicated page', async ({ page }) => {
    // Arrange
    const { project, stub } = await newProject('versions-link');
    await stub.seedFinal(call, 'Plan versions-link', [questionInput(1, 'primary')]);

    // Act
    await openInvestigatorSap(page, stub, project.id);

    // Assert
    await expect(page.getByTestId('sap-history-table')).toHaveCount(0);
    const link = page.getByTestId('sap-versions-link');
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${project.id}/sap/versions$`));
    await expect(page.getByTestId('sap-versions-table')).toBeVisible();
  });

  test('AXI-2564.5 the version-history page paginates past 10 versions, newest first', async ({ page }) => {
    // Arrange — v1 real final, then 10 superseding amendments so there are 11 versions total
    const { project, stub } = await newProject('pagination');
    await stub.seedFinal(call, 'Plan pagination v1', [questionInput(1, 'primary')]);
    for (let i = 2; i <= 11; i += 1) {
      // No new question: the amendment draft already carries v1's question forward (CC12
      // refuses a duplicate question text), only the title changes per version.
      const amendment = await stub.seedDraft(call, [], `Plan pagination v${i}`);
      const finalised = await call(
        'POST',
        `/projects/${project.id}/saps/${amendment.sapId}/draft/finalise`,
        { basedOnRevision: amendment.revision, basedOnVersion: amendment.basedOnVersion ?? null, amendmentReason: `amendment ${i}` },
      );
      if (finalised.status !== 201) throw new Error(`finalise v${i}: expected 201, got ${finalised.status} ${JSON.stringify(finalised.body)}`);
    }

    // Act — sign in (the init script setting the active org/workspace/project must be
    // registered BEFORE the first navigation, or it never takes effect) then go straight to
    // the versions page.
    await stub.install(page);
    await page.addInitScript(
      ([org, ws, p]) => {
        localStorage.setItem('axiome-top-org', org);
        localStorage.setItem('axiome-active-workspace', ws);
        localStorage.setItem('axiome-active-project', p);
      },
      [world.orgId, world.workspaceId, project.id] as const,
    );
    await gotoSettled(page, '/login');
    await page.locator('input[type="email"]').fill(investigator.email);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
    await gotoSettled(page, `/investigator/projects/${project.id}/sap/versions`);

    // Assert
    await expect(page.getByTestId('sap-versions-page-count')).toHaveText('Page 1 of 2');
    await expect(page.getByTestId('sap-versions-row-11')).toBeVisible();
    await page.getByTestId('sap-versions-next').click();
    await expect(page.getByTestId('sap-versions-page-count')).toHaveText('Page 2 of 2');
    await expect(page.getByTestId('sap-versions-row-1')).toBeVisible();
  });

  test('AXI-2564.6 opening a version from the history page shows its read-only detail', async ({ page }) => {
    // Arrange
    const { project, stub } = await newProject('version-detail');
    await stub.seedFinal(call, 'Plan version-detail', [questionInput(1, 'primary')]);

    // Act
    await openInvestigatorSap(page, stub, project.id);
    await page.getByTestId('sap-versions-link').click();
    await page.getByTestId('sap-versions-row-1').click();

    // Assert
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${project.id}/sap/versions/[^/]+$`));
    await expect(page.getByRole('heading', { name: 'Version 1' })).toBeVisible();
    await expect(page.getByTestId('sap-version-detail')).toBeVisible();
  });

  test('AXI-2564.7 (AXI-2532 FR78) a PRIVATE project new route 404s for a caller with no project access', async ({ page }) => {
    // Arrange — a PRIVATE project (rework #3: server access control is real —
    // ProjectAccessGuard/ProjectAccessPredicate.accessArms, saps.controller.ts — a
    // default-visibility (public) project lets ANY workspace member with sap:read in,
    // which is exactly why this scenario needs an explicitly private one). The outsider
    // (created in beforeAll) is a workspace member holding sap:read via INVESTIGATOR_ROLE_ID
    // but is never granted access to THIS project, so ProjectAccessPredicate refuses him.
    const { project, stub } = await newProject('no-access', 'private');
    await stub.seedFinal(call, 'Plan no-access', [questionInput(1, 'primary')]);

    // Act — the outsider (not granted project access) hits the versions page directly
    await stub.install(page);
    await page.addInitScript(
      ([org, ws, p]) => {
        localStorage.setItem('axiome-top-org', org);
        localStorage.setItem('axiome-active-workspace', ws);
        localStorage.setItem('axiome-active-project', p);
      },
      [world.orgId, world.workspaceId, project.id] as const,
    );
    await gotoSettled(page, '/login');
    await page.locator('input[type="email"]').fill(outsider.email);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
    await gotoSettled(page, `/investigator/projects/${project.id}/sap/versions`);

    // Assert — the server refuses project access itself (404, rendered by
    // `ProjectAccessNotFound`), not the front-end's own `sap-read-denied` gate (that gate
    // is a SEPARATE assertion left manual, same identity-wall reason as AXI-2564.9b: it
    // would need an actor holding project access but lacking `sap:read`, and no such
    // actor is constructible without a System-Admin-only custom role).
    await expect(page.getByTestId('project-not-found')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sap-versions-table')).toHaveCount(0);
    await expect(page.getByTestId('sap-read-denied')).toHaveCount(0);
  });

  test('AXI-2564.8 (owner ask 2026-11-15, FR96; superseded by AXI-2657 owner rulings 2026-11-18) no protocol — no plan; saving the protocol, then the first question, starts it', async ({ page }) => {
    // Arrange — a fresh project with no SAP and no protocol at all
    const { project, stub } = await newProject('create-plan-first');

    // Act
    await openInvestigatorSap(page, stub, project.id);

    // Assert — no protocol saved yet: no add-question entry, no plan, no run
    await expect(page.getByTestId('sap-empty-state')).toBeVisible();
    await expect(page.getByTestId('sap-plan-add-question')).toHaveCount(0);
    await expect(page.getByTestId('sap-plan-add-primary-question')).toHaveCount(0);
    await expect(page.getByTestId('sap-run')).toHaveCount(0);
    await expect(page.getByTestId('sap-plan-questions-table')).toHaveCount(0);

    // Act — save the protocol (the real route the dedicated protocol page writes to; AXI-2657
    // removed the plan page's own "Create plan" form, which used to collect this content itself)
    const saved = await call('PUT', `/projects/${project.id}/study/protocol`, {
      title: 'AXI-2564.8 plan', objective: 'Does marker 1 differ between arms?',
      studyPopulation: 'All randomised subjects', text: '',
    });
    expect(saved.status, JSON.stringify(saved.body)).toBeLessThan(300);
    await page.reload();
    await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });

    // Assert — protocol saved, still no plan: the empty state is gone, the protocol card reads
    // it back, and "Add question" is now live (AXI-2657: the first question starts the plan).
    await expect(page.getByTestId('sap-empty-state')).toHaveCount(0);
    await expect(page.getByTestId('sap-protocol-summary')).toContainText('AXI-2564.8 plan');
    const addQuestion = page.getByTestId('sap-plan-add-primary-question');
    await expect(addQuestion).toBeVisible();

    // Act — the first question starts the plan (no separate "Create plan" step any more)
    await addQuestion.click();
    await expect(page.getByTestId('sap-add-question-modal')).toBeVisible();
    await page.getByTestId('sap-add-question-text').fill('Does marker 1 differ between arms?');
    await page.getByTestId('sap-add-question-submit').click();

    // Assert — the plan now exists: the question is on the table, the modal is gone.
    await expect(page.getByTestId('sap-add-question-modal')).toHaveCount(0);
    await expect(page.getByTestId('sap-plan-questions-row-Q1')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('sap-plan-questions-row-Q1')).toContainText('Does marker 1 differ between arms?');
  });

  // AXI-2564.9 (FR96) originally also covered the "sap:read, no sap:create" reader on
  // the empty state. That half is DESCOPED from automation, not silently dropped: the
  // `/investigator/*` route guard itself only admits the Investigator persona (bound to
  // the one custom `INVESTIGATOR_ROLE_ID`, whose role bundle includes `sap:create` too —
  // see SAP_AUTHOR_PERMISSIONS in axiome-back/libs/common/src/permissions/permissions.constants.ts).
  // No legacy role (viewer/editor/approver/admin) reaches that route at all (confirmed:
  // a 'viewer' member who logs in and navigates there never renders `project-sap-page`).
  // Minting an Investigator-persona actor that holds `sap:read` without `sap:create`
  // needs a CUSTOM role, i.e. `world.workspaceRole()` → `POST /api/v1/roles`, which is
  // System-Admin-only and the fixture's available account (`admin@cro-one.com`) is not
  // one — the identity-wall condition this rework was told to stop and report rather than
  // work around (never create/promote an account). The gating LOGIC is still covered, by
  // unit test (UT-FE-SHELL-9930..9934 in axiome-front's `ProjectSap.test.tsx`, mocking
  // `capabilities.canCreate = false`); the manual-e2e doc marks this half `automation:
  // manual` with this exact reason. See the handoff report.
  test('AXI-2564.9 (owner ask 2026-11-15, FR96) Add question never re-creates the plan on a finalised plan', async ({ page }) => {
    // Arrange/Act — on a project where the plan already exists (finalised), Add question
    // starts the next-version draft (an amendment, FR85) — exactly one draft-create write,
    // never a second "first plan" create.
    //
    // Note: the investigator page's own header never carried an "Add question" action
    // (`sap-header-add-question` does not exist on this surface — it belongs to the team's
    // `ProjectSapPlanTab`); for a finalised v1 plan the entry point is the rail's own
    // "Add question" pill (`investigator-add-question`, AXI-2555 §5, `SidebarAddQuestionButton`),
    // which drives the SAME `useAddQuestionToPlan` act this assertion is really about.
    const { project: existingProject, stub: existingStub } = await newProject('investigator-existing-plan');
    await existingStub.seedFinal(call, 'Plan existing', [questionInput(1, 'primary')]);
    await openInvestigatorSap(page, existingStub, existingProject.id);
    await page.getByTestId('investigator-add-question').click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${existingProject.id}/sap/questions/new`));
    const draftCreateWrites = existingStub.pageWrites.filter((w) => w.method === 'POST' && /\/draft$/.test(w.path));
    expect(draftCreateWrites.length).toBe(1);
  });

});
