import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { silenceTours } from '../AXI-1904/harness/tours';
import { PASSWORD, type Person } from '../AXI-2308/harness/result-page';
import {
  addInvestigator,
  createProject,
  createWorkspace,
  investigatorPerson,
  type FixtureProject,
  type FixtureWorkspace,
} from './harness/project-switch-fixtures';

/**
 * AXI-2656 (epic AXI-2630) — the top-menu/study-switcher project switch keeps the page on the
 * selected project (owner bug 2026-11-18): a team project page stays on the SAME page of the
 * new project; an entity-detail URL never carries the old project's entity id into the new
 * project (it lands on that entity's list instead); a route with no list equivalent falls back
 * to the surface home (`/overview` on the team surface, `/investigator` on the Investigator
 * surface); the Investigator surface never leaves itself on a switch, and a published result
 * returns to the results list; a workspace/study switch leaves every page of the old project.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2630-AXI-2656-Project-Switch.md`.
 *
 * Fixtures: every org/workspace/project is additive, created fresh by the admin fixture
 * (never a seeded/shared project). The Investigator identity is a throwaway self-registered
 * person granted the workspace Investigator role by the admin fixture — its password is set by
 * the fixture at registration (same pattern as AXI-2603's
 * `tests/AXI-2308/harness/result-page.ts#person`), never a shared/seeded account's credential.
 * The team-surface tests reuse the `chromium` project's default admin `storageState` (no UI
 * login needed — `playwright.config.ts`'s `setup` project signs it in once from
 * `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD`, config/roles.ts).
 *
 * RUN STATUS (rework session, 2026-11-18): authored and `tsc --noEmit` clean, but NOT executed
 * end to end against a running stack. `npx playwright test tests/AXI-2630/AXI-2656-*` was
 * attempted (front worktree served on :5175, `VITE_API_URL` pointed at the running :3001
 * gateway) and failed at the suite's shared `setup` project — `tests/setup/auth.setup.ts`'s
 * "authenticate admin" step — because neither `E2E_TEST_EMAIL` nor `E2E_TEST_PASSWORD` was set
 * in this session and the sandbox's own permission system refused every attempt to supply or
 * substitute a credential (the documented local-dev default, a copied `.auth/admin.json`, and a
 * `--no-deps` run against it were all denied as credential-bypass attempts — correctly, per the
 * standing "never guess/mint a credential" rule). Result with the admin identity unavailable:
 * `authenticate user` (self-register) PASS, `authenticate admin` FAIL, this spec's 6 tests
 * "did not run" (blocked by the failed shared dependency, not by anything in this spec). Run it
 * for real the first time `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD` are set in the running session.
 */

let api: Api;
let teamWs: FixtureWorkspace;
let projectA: FixtureProject;
let projectB: FixtureProject;
let studyA: FixtureWorkspace;
let studyB: FixtureWorkspace;
let projectPA1: FixtureProject;
let projectPA2: FixtureProject;
let investigator: Person;

const FAKE_ID = '00000000-0000-4000-8000-000000000001';

async function seedTeamScope(page: Page, orgId: string, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ([org, ws]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [orgId, workspaceId] as const,
  );
}

/** Opens `landing` signed in as the throwaway Investigator, his study already in scope. */
async function openAsInvestigator(page: Page, landing: string): Promise<void> {
  await page.addInitScript(
    ([org, ws]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [studyA.orgId, studyA.id] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  await gotoSettled(page, landing);
}

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.beforeAll(async () => {
  api = await adminApi();
  await silenceTours(await adminToken());

  // Team surface fixture: one workspace, two projects.
  teamWs = await createWorkspace(api, 'team');
  projectA = await createProject(api, teamWs, 'team-a');
  projectB = await createProject(api, teamWs, 'team-b');

  // Investigator surface fixture: two studies; Study A holds two projects (for the
  // project-level switch scenarios), Study B holds none (only used for the study switch).
  studyA = await createWorkspace(api, 'study-a');
  studyB = await createWorkspace(api, 'study-b');
  projectPA1 = await createProject(api, studyA, 'pa-1');
  projectPA2 = await createProject(api, studyA, 'pa-2');

  investigator = await investigatorPerson('axi2656', studyA);
  await addInvestigator(api, studyA, investigator);
  await addInvestigator(api, studyB, investigator);
  await silenceTours(investigator.accessToken);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await api?.ctx.dispose();
});

test.describe('AXI-2656 team surface @SI-030', () => {
  test('AXI-2656.1 AC1 a team project page stays on the same page of the new project @SI-030', async ({ page }) => {
    await seedTeamScope(page, teamWs.orgId, teamWs.id);
    await gotoSettled(page, `/projects/${projectA.id}/sap`);

    await page.getByTestId('scope-dropdown-project').click();
    await page.getByRole('button', { name: projectB.name }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${projectB.id}/sap$`));
  });

  test("AXI-2656.2 AC2 an entity-detail URL drops the old project's entity id and lands on the new project's list @SI-030", async ({ page }) => {
    await seedTeamScope(page, teamWs.orgId, teamWs.id);
    await gotoSettled(page, `/projects/${projectA.id}/view-analyses/${FAKE_ID}`);

    await page.getByTestId('scope-dropdown-project').click();
    await page.getByRole('button', { name: projectB.name }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${projectB.id}/view-analyses$`));
    expect(page.url()).not.toContain(FAKE_ID);
  });

  test('AXI-2656.3 AC3 a route with no list equivalent falls back to the team surface home @SI-030', async ({ page }) => {
    await seedTeamScope(page, teamWs.orgId, teamWs.id);
    await gotoSettled(page, `/projects/${projectA.id}/runs/${FAKE_ID}`);

    await page.getByTestId('scope-dropdown-project').click();
    await page.getByRole('button', { name: projectB.name }).click();

    await expect(page).toHaveURL(/\/overview$/);
  });
});

test.describe('AXI-2656 Investigator surface @SI-066', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('AXI-2656.3b AC3 a route with no list equivalent falls back to the Investigator surface home @SI-066', async ({ page }) => {
    await openAsInvestigator(page, `/investigator/projects/${projectPA1.id}/runs/${FAKE_ID}`);
    await expect(page.getByTestId('investigator-surface')).toBeVisible();

    await page.getByTestId('investigator-project-select').click();
    await page.getByTestId(`investigator-project-select-option-${projectPA2.id}`).click();

    await expect(page).toHaveURL(/\/investigator\/?$/);
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
  });

  test('AXI-2656.4 AC4 the Investigator surface stays on its surface, and a published result returns to the results list @SI-066', async ({ page }) => {
    await openAsInvestigator(page, `/investigator/results/${FAKE_ID}`);
    await expect(page.getByTestId('investigator-surface')).toBeVisible();

    await page.getByTestId('investigator-project-select').click();
    await page.getByTestId(`investigator-project-select-option-${projectPA2.id}`).click();

    await expect(page).toHaveURL(/\/investigator\/results$/);
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
  });

  test('AXI-2656.5 AC5 a study (workspace) switch leaves the old project @SI-066', async ({ page }) => {
    await openAsInvestigator(page, `/investigator/projects/${projectPA1.id}/sap`);
    await expect(page.getByTestId('investigator-surface')).toBeVisible();

    await page.getByTestId('investigator-workspace-select').click();
    await page.getByRole('option', { name: studyB.name }).click();

    await expect(page).toHaveURL(/\/investigator\/?$/);
    expect(page.url()).not.toContain(projectPA1.id);
  });
});
