import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, uploadCsvDataset, type Actor } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { SapApiStub, apiCallOf, questionInput, type ApiCall } from './harness/sap-api-stub';

/**
 * AXI-2445 (epic AXI-2433 — Structured Statistical Analysis Plan) — the SAP surface: the
 * `/projects/:id/sap` page (Plan + Runs tabs, breadcrumb, no back button), the Plan tab
 * (final version, open draft with its controls and completeness panel, history), the
 * permission split (`sap:write` → write controls; governed-submit → Run SAP) and the two
 * entry points (Project Settings → Statistical, Investigator → Statistical plan), which
 * summarise and link instead of editing.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md`
 * § AXI-2445 (AXI-2445.1 … AXI-2445.12).
 *
 * E2E CONTRACT — REAL on the demo gateway: sign-in, fixture workspace, projects, dataset,
 * caller permissions (`GET /workspace-permissions/me`) and every AXI-2438 draft route (start,
 * `GET …/sap-draft`, read, save text / positions, add / remove question, discard). DOUBLED
 * (`harness/sap-api-stub.ts`) until AXI-2439 is deployed: completeness, finalise and
 * `/sap-templates`, plus the version reads a doubled finalise implies. Drop the double then;
 * no assertion depends on it.
 *
 * Self-provisioned: a fresh workspace whose platform admin leaves it; a team editor, a team
 * viewer and an Investigator, all throwaway self-registered users. Run with `--no-deps`.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2445-e2e-pw!';
const HONEST_WORDING = /proven|confirmed effect/i;

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let editor: UiActor;
let viewer: UiActor;
let investigator: Person;
let datasetId: string;
let call: ApiCall;

interface Fixture {
  project: { id: string; name: string };
  stub: SapApiStub;
}

/** A project with the fixture dataset linked, and its SAP double. */
async function newWorld(label: string): Promise<Fixture> {
  const name = `E2E AXI-2445 ${label} ${Date.now()}`;
  const res = await editor.api.post(apiUrl('/api/v1/projects'), { data: { name, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  const link = await editor.api.post(apiUrl(`/api/v1/projects/${id}/datasets`), { data: { datasetId } });
  expect(link.status(), await link.text()).toBeLessThan(300);
  return { project: { id, name }, stub: new SapApiStub(id, editor.userId, datasetId) };
}

/** A project whose final version 1 holds `questions`; optionally an open amendment draft. */
async function finalWorld(label: string, withDraft: boolean, questions = [questionInput(1, 'primary')]): Promise<Fixture> {
  const f = await newWorld(label);
  await f.stub.seedFinal(call, `Plan ${label}`, questions);
  if (withDraft) await f.stub.seedAmendment(call);
  return f;
}

async function permissionsOf(actor: Actor): Promise<string[]> {
  const res = await actor.api.get(apiUrl('/api/v1/workspace-permissions/me'));
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  return (body.permissions ?? body) as string[];
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2445-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2445', lastName: label },
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

/**
 * Session + scope. With no active ORGANIZATION the shell auto-selects one at boot and that
 * clears the workspace, so the fixture's org is seeded too (AXI-2350 precedent).
 */
async function signIn(page: Page, actor: UiActor): Promise<void> {
  await page.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(page, actor, world.workspaceId);
}

async function openSap(page: Page, actor: UiActor, stub: SapApiStub, query = ''): Promise<void> {
  await stub.install(page);
  await signIn(page, actor);
  await page.goto(`/projects/${stub.projectId}/sap${query}`);
  await expect(page.getByTestId('project-sap-page')).toBeVisible();
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await uiActor('editor', world.workspaceId);
  viewer = await uiActor('viewer', world.workspaceId);
  investigator = await person('investigator', world.workspaceId);
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  datasetId = await uploadCsvDataset(world, editor);
  call = apiCallOf(editor.api);
});

test.afterAll(async () => {
  for (const a of [editor, viewer, investigator]) await a?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2445 SAP surface: Plan tab and entry points @SI-031 @SI-030', () => {
  // First: while the workspace holds ONE project the shell's scope-count rule (AXI-2323) makes it his study.
  test('FR66 AC29 NFR12 AXI-2445.10 the Investigator\'s Statistical plan summarises and links to the SAP page on his surface @SI-066', async ({ page }) => {
    // Arrange
    const { project, stub } = await finalWorld('investigator', false);
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
    await gotoSettled(page, '/investigator');

    // Act
    await page.getByTestId('investigator-nav-statistical-plan').click();

    // Assert
    const panel = page.getByTestId('investigator-statistical-plan');
    await expect(page.getByTestId('sap-summary-final')).toContainText('Version 1 · Plan investigator · 1 question(s)');
    await expect(page.getByTestId('sap-summary-draft')).toHaveText('No draft open');
    await expect(panel.locator('input, textarea, select')).toHaveCount(0);
    await expect(page.getByTestId('sap-open-page')).toHaveAttribute('href', `/investigator/projects/${project.id}/sap`);
    await page.getByTestId('sap-open-page').click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${project.id}/sap$`));
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
    await expect(page.getByTestId('sap-final-title')).toHaveText('Plan investigator');
  });

  test('FR62 NFR12 AC33 AXI-2445.1 the SAP page: Plan by default, Runs deep-links, breadcrumb names the project, no back button @SI-030 @SI-031', async ({ page }) => {
    // Arrange
    const { project, stub } = await newWorld('page');

    // Act
    await openSap(page, editor, stub);

    // Assert
    await expect(page.getByRole('heading', { level: 1, name: 'Statistical Analysis Plan' })).toBeVisible();
    await expect(page.getByTestId('sap-tab-plan')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('sap-empty-state')).toContainText('There is no statistical analysis plan yet.');
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs).toContainText('Projects');
    await expect(crumbs).toContainText(project.name);
    await expect(crumbs).toContainText('Statistical Analysis Plan');
    await expect(crumbs.getByRole('link', { name: project.name })).toHaveAttribute('href', `/projects/${project.id}`);
    await expect(page.getByTestId('project-sap-page').getByRole('button', { name: /back/i })).toHaveCount(0);

    await page.getByTestId('sap-tab-runs').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/sap\\?tab=runs$`));
    await page.reload();
    await expect(page.getByTestId('sap-tab-runs')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('sap-runs-tab')).toBeVisible();
  });

  test('AC1 FR64 AXI-2445.2 Start draft opens a new draft whose completeness shows CC1, CC13 and CC14 failing @SI-031', async ({ page }) => {
    // Arrange
    expect(await permissionsOf(editor)).toContain('sap:write');
    const { stub } = await newWorld('new-draft');
    await openSap(page, editor, stub);
    await expect(page.getByTestId('sap-empty-state')).toBeVisible();

    // Act
    await page.getByTestId('sap-start-draft').click();

    // Assert
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 1');
    await expect(page.getByTestId('sap-draft-no-questions')).toHaveText('No questions yet.');
    await expect(page.getByTestId('sap-check-fail-CC1')).toContainText('No question has role primary.');
    await expect(page.getByTestId('sap-check-fail-CC13')).toContainText('The plan has 0 questions.');
    await expect(page.getByTestId('sap-check-fail-CC14')).toContainText('The title is blank.');
    await expect(page.getByTestId('sap-completeness-not-checked')).toBeVisible();
    await expect(page.getByTestId('sap-finalise')).toBeDisabled();
    await expect(page.getByTestId('sap-start-draft')).toHaveCount(0);
    expect(stub.pageWrites).toEqual([{ method: 'POST', path: '/saps/draft', body: {} }]);
  });

  test('FR64 EC4 AXI-2445.3 a draft-only SAP is shown after a reload, never a second Start @SI-031', async ({ page }) => {
    // Arrange — a SAP that holds only a draft (no version row)
    const { stub } = await newWorld('ec4');
    await stub.seedDraft(call, [], 'Draft-only plan');

    // Act
    await openSap(page, editor, stub);

    // Assert
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 2');
    await expect(page.getByTestId('sap-draft-title')).toHaveValue('Draft-only plan');
    await expect(page.getByTestId('sap-start-draft')).toHaveCount(0);
    await expect(page.getByTestId('sap-amend')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 2');
    await expect(page.getByTestId('sap-start-draft')).toHaveCount(0);
    expect(stub.pageWrites).toEqual([]);
  });

  test('FR63 FR64 AXI-2445.4 move up, join, split and remove re-render the order and families against the current revision @SI-031', async ({ page }) => {
    // Arrange — a real draft with three questions (revision 4)
    const { stub } = await newWorld('layout');
    const seeded = await stub.seedDraft(call, [questionInput(1, 'primary'), questionInput(2, 'key_secondary'), questionInput(3, 'secondary')]);
    const idOf = (n: number) => seeded.plan.questions.find((q: { text: string }) => q.text === `Does marker ${n} differ between arms?`).questionId;
    page.on('dialog', (d) => void d.accept());
    await openSap(page, editor, stub);
    const row = (key: string) => page.getByTestId(`sap-draft-questions-row-${key}`);
    const family = (key: string) => page.getByTestId(`sap-draft-questions-family-${key}`);
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 4');

    // Act + Assert — move marker 3 above marker 2
    await page.getByTestId('sap-question-move_up-Q3').click();
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 5');
    await expect(row('Q2')).toContainText('Does marker 3 differ between arms?');
    await expect(row('Q3')).toContainText('Does marker 2 differ between arms?');

    // join marker 3 (now Q2) with the previous family
    await page.getByTestId('sap-question-join_previous-Q2').click();
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 6');
    await expect(family('Q1')).toHaveText('1 (shared)');
    await expect(family('Q2')).toHaveText('1 (shared)');
    await expect(family('Q3')).toHaveText('2');

    // split it again
    await page.getByTestId('sap-question-split-Q2').click();
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 7');
    await expect(family('Q1')).toHaveText('1');
    await expect(family('Q2')).toHaveText('2');
    await expect(family('Q3')).toHaveText('3');

    // remove marker 2 (Q3)
    await page.getByTestId('sap-question-remove-Q3').click();
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 8');
    await expect(page.getByTestId('sap-draft-questions').locator('tbody tr')).toHaveCount(2);
    await expect(row('Q2')).toContainText('Does marker 3 differ between arms?');

    // The wire: positions only, each write against the revision on screen
    expect(stub.pageWrites).toEqual([
      { method: 'PUT', path: `/saps/${seeded.sapId}/draft`, body: { basedOnRevision: 4, positions: [
        { questionId: idOf(1), position: 1 }, { questionId: idOf(3), position: 2 }, { questionId: idOf(2), position: 3 }] } },
      { method: 'PUT', path: `/saps/${seeded.sapId}/draft`, body: { basedOnRevision: 5, positions: [
        { questionId: idOf(1), position: 1 }, { questionId: idOf(3), position: 1 }, { questionId: idOf(2), position: 2 }] } },
      { method: 'PUT', path: `/saps/${seeded.sapId}/draft`, body: { basedOnRevision: 6, positions: [
        { questionId: idOf(1), position: 1 }, { questionId: idOf(3), position: 2 }, { questionId: idOf(2), position: 3 }] } },
      { method: 'DELETE', path: `/saps/${seeded.sapId}/draft/questions/${idOf(2)}?basedOnRevision=7`, body: undefined },
    ]);
  });

  test('FR63 FR64 AC1 AXI-2445.5 finalise version 1, then amend with a reason; history lists both with the reason @SI-031', async ({ page }) => {
    // Arrange — a real draft with one primary question and no title (revision 2)
    const { stub } = await newWorld('finalise');
    const seeded = await stub.seedDraft(call, [questionInput(1, 'primary')]);
    await openSap(page, editor, stub);
    await expect(page.getByTestId('sap-check-fail-CC14')).toBeVisible();

    // Act — write the title (autosave on blur), then finalise
    await page.getByTestId('sap-draft-title').fill('Plan AXI-2445 finalise');
    await page.getByTestId('sap-draft-questionText').click();
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 3');
    await expect(page.getByTestId('sap-completeness-all-pass')).toBeVisible();
    await page.getByTestId('sap-finalise').click();
    await expect(page.getByTestId('sap-finalise-reason')).toHaveCount(0);
    await expect(page.getByTestId('sap-finalise-confirm')).toHaveText('Finalise version 1');
    await page.getByTestId('sap-finalise-confirm').click();

    // Assert — version 1
    await expect(page.getByTestId('sap-final-title')).toHaveText('Plan AXI-2445 finalise');
    await expect(page.getByTestId('sap-final-version')).toHaveText('Version 1');
    await expect(page.getByTestId('sap-final-hash')).toHaveText('1a2b3c4d5e6f');
    await expect(page.getByTestId('sap-final-finalised')).toContainText('Finalised');
    await expect(page.getByTestId('sap-final-questions-row-Q1')).toContainText('Does marker 1 differ between arms?');
    await expect(page.getByTestId('sap-final-questions-row-Q1')).toContainText('p ≤ 0.05');
    await expect(page.getByTestId('sap-draft')).toHaveCount(0);
    expect(stub.writes.at(-1)).toEqual({ method: 'POST', path: `/saps/${seeded.sapId}/draft/finalise`, body: { basedOnRevision: 3, basedOnVersion: null } });

    // Act — amend: a new title, a reason
    await page.getByTestId('sap-amend').click();
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 3 · amends version 1');
    await expect(page.getByTestId('sap-draft-title')).toHaveValue('Plan AXI-2445 finalise');
    await page.getByTestId('sap-draft-title').fill('Plan AXI-2445 amended');
    await page.getByTestId('sap-draft-questionText').click();
    await expect(page.getByTestId('sap-draft-revision')).toHaveText('revision 4 · amends version 1');
    await page.getByTestId('sap-finalise').click();
    await expect(page.getByTestId('sap-finalise-confirm')).toHaveText('Finalise version 2');
    await expect(page.getByTestId('sap-finalise-confirm')).toBeDisabled();
    await page.getByTestId('sap-finalise-reason').fill('Added the secondary endpoint per protocol v3.');
    await page.getByTestId('sap-finalise-confirm').click();

    // Assert — version 2 current, both in history
    await expect(page.getByTestId('sap-final-version')).toHaveText('Version 2');
    await expect(page.getByTestId('sap-final-title')).toHaveText('Plan AXI-2445 amended');
    await expect(page.getByTestId('sap-final-reason')).toContainText('Added the secondary endpoint per protocol v3.');
    await expect(page.getByTestId('sap-history-table').locator('tbody tr')).toHaveCount(2);
    await expect(page.getByTestId('sap-history-reason-2')).toHaveText('Added the secondary endpoint per protocol v3.');
    await expect(page.getByTestId('sap-history-reason-1')).toHaveText('—');
    expect(stub.writes.at(-1)).toEqual({
      method: 'POST', path: `/saps/${seeded.sapId}/draft/finalise`,
      body: { basedOnRevision: 4, basedOnVersion: 1, amendmentReason: 'Added the secondary endpoint per protocol v3.' },
    });
  });

  test('FR63 EC10 AXI-2445.6 a question bound to an older template version is flagged "newer version available" @SI-031', async ({ page }) => {
    // Arrange — both questions pin 0.2; the registry's newest T1 is 0.3, T2 is still 0.2
    const { stub } = await finalWorld('ec10', false, [
      questionInput(1, 'primary'),
      questionInput(2, 'secondary', { template: { templateId: 'T2', templateVersion: '0.2' } }),
    ]);
    stub.newestTemplates = { T1: '0.3', T2: '0.2' };

    // Act
    await openSap(page, editor, stub);

    // Assert
    await expect(page.getByTestId('sap-final-questions-newer-Q1')).toHaveText('newer version available');
    await expect(page.getByTestId('sap-final-questions-row-Q2')).toBeVisible();
    await expect(page.getByTestId('sap-final-questions-newer-Q2')).toHaveCount(0);
  });

  test('AC30 EC32 AXI-2445.7 without sap:write the Plan tab is read only: no write or run control @SI-031', async ({ page }) => {
    // Arrange
    const perms = await permissionsOf(viewer);
    expect(perms).not.toContain('sap:write');
    expect(perms).not.toContain('governed_execution:submit');
    const { stub } = await finalWorld('viewer', true, [questionInput(1, 'primary'), questionInput(2, 'secondary')]);
    const open = await call('GET', `/projects/${stub.projectId}/sap-draft`);
    await call('PUT', `/projects/${stub.projectId}/saps/${open.body.sapId}/draft`, { basedOnRevision: open.body.revision, title: 'Draft title the viewer reads' });

    // Act
    await openSap(page, viewer, stub);

    // Assert
    await expect(page.getByTestId('sap-read-only-note')).toContainText('sap:write');
    await expect(page.getByTestId('sap-final-title')).toHaveText('Plan viewer');
    await expect(page.getByTestId('sap-draft-title-text')).toHaveText('Draft title the viewer reads');
    await expect(page.getByTestId('sap-draft-questions-row-Q2')).toBeVisible();
    for (const id of ['sap-start-draft', 'sap-amend', 'sap-run', 'sap-add-question', 'sap-finalise', 'sap-discard-draft', 'sap-draft-title']) {
      await expect(page.getByTestId(id), id).toHaveCount(0);
    }
    await expect(page.locator('[data-testid^="sap-question-"]')).toHaveCount(0);
    expect(stub.pageWrites).toEqual([]);
  });

  test('FR64 AXI-2445.8 Run SAP needs the governed-submit permission and a final version; it opens the Runs tab @SI-031', async ({ page }) => {
    // Arrange
    expect(await permissionsOf(editor)).toContain('governed_execution:submit');
    const empty = await newWorld('run-empty');
    await openSap(page, editor, empty.stub);

    // Assert — no final version: disabled
    await expect(page.getByTestId('sap-run')).toBeDisabled();
    await expect(page.getByTestId('sap-run')).toHaveAttribute('title', 'Run SAP needs a final version');

    // Act — a project with a final version
    const { project, stub } = await finalWorld('run-final', false);
    await stub.install(page);
    await page.goto(`/projects/${project.id}/sap`);
    await expect(page.getByTestId('sap-run')).toBeEnabled();
    await expect(page.getByTestId('sap-run')).toHaveAttribute('title', 'Run version 1');
    await page.getByTestId('sap-run').click();

    // Assert
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/sap\\?tab=runs&run=new$`));
    await expect(page.getByTestId('sap-runs-tab')).toHaveAttribute('data-run-requested', 'true');
  });

  test('FR66 AC29 AXI-2445.9 Settings → Statistical summarises the plan, edits nothing, and links to the SAP page @SI-031', async ({ page }) => {
    // Arrange — final version 1 + an open amendment draft (start, copied text, copied question: revision 3)
    const { project, stub } = await finalWorld('settings', true);
    await stub.install(page);
    await signIn(page, editor);

    // Act
    await page.goto(`/projects/${project.id}/settings?tab=statistical`);

    // Assert
    const tab = page.getByTestId('project-settings-statistical-tab');
    await expect(page.getByTestId('sap-summary-final')).toContainText('Version 1 · Plan settings · 1 question(s)');
    await expect(page.getByTestId('sap-summary-draft')).toHaveText('Draft open (revision 3)');
    await expect(tab.locator('input, textarea, select')).toHaveCount(0);
    await expect(tab.getByRole('button')).toHaveCount(0);
    await page.getByTestId('sap-open-page').click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/sap$`));
    await expect(page.getByTestId('sap-current')).toBeVisible();
    expect(stub.pageWrites).toEqual([]);
  });

  test('NFR8 AC32 AXI-2445.11 a 50-question plan renders all rows in under one second @SI-031', async ({ page }) => {
    // Arrange
    const questions = Array.from({ length: 50 }, (_, i) => questionInput(i + 1, i === 0 ? 'primary' : 'secondary'));
    const { stub } = await finalWorld('fifty', false, questions);
    const versions = page.waitForResponse((r) => /\/saps\/[^/]+\/versions$/.test(new URL(r.url()).pathname));

    // Act
    await openSap(page, editor, stub);
    await versions;
    const start = Date.now();
    await expect(page.getByTestId('sap-final-questions-row-Q50')).toBeVisible();
    const elapsed = Date.now() - start;

    // Assert
    await expect(page.getByTestId('sap-final-questions').locator('tbody tr')).toHaveCount(50);
    expect(elapsed).toBeLessThan(1000);
  });

  test('NFR11 AC33 AXI-2445.12 honest wording: no "proven" or "confirmed effect"; the criterion reads p ≤ α @SI-031', async ({ page }) => {
    // Arrange
    const { stub } = await finalWorld('wording', true, [
      questionInput(1, 'primary'),
      questionInput(2, 'secondary', { decisionCriterion: { kind: 'p_at_or_below_alpha', direction: 'positive' } }),
    ]);

    // Act
    await openSap(page, editor, stub);

    // Assert
    await expect(page.getByTestId('sap-final-questions-row-Q1')).toContainText('p ≤ 0.05');
    await expect(page.getByTestId('sap-final-questions-row-Q2')).toContainText('p ≤ 0.05, positive effect');
    await expect(page.getByTestId('sap-draft')).toBeVisible();
    expect(await page.getByTestId('project-sap-page').innerText()).not.toMatch(HONEST_WORDING);
  });
});
