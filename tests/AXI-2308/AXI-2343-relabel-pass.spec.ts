import { Page, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from './harness/new-analysis';

/**
 * AXI-2343 (epic AXI-2308 — FR45, NFR9, AC35; SI-066, SI-035) — the relabel pass, the LAST
 * build story: "SAP" for project, "Analysis" for rule, everywhere on the Investigator's
 * surface; internal terms (`project`, `Rule`) are UNCHANGED in code, routes, DB columns and
 * API fields — this is a copy pass over screens every earlier story already built.
 *
 * Audit finding: most of the surface was already correctly labelled by earlier stories
 * (the review base, the uploads page, Settings, the result page's answer sentence). The
 * leaks this story fixes are: (1) the scope-bar project selector said "Project"
 * (`InvestigatorScopeBar.tsx`); (2) the setup wizard's Plan/Data/Template/Ready steps and the
 * "no active study" guard said "project" in plain sentences (`PlanStep`, `DataStep`,
 * `TemplateStep`, `NewAnalysis.tsx`, `stepModels.ts`, `sapRead.ts`); (3) the SAME SAP panel
 * and "not found" refusal, shared with Project Settings, said "project" on the Investigator's
 * Statistical plan page (`ProjectSapTab.tsx`, `ProjectAccessNotFound.tsx`); (4) the result
 * page's footnote and evidence line said "rule"/"Rule version" (`resultPageView.ts`) — this one
 * is shared by BOTH surfaces (SI-035: "the relabel of 'Rule' -> 'Analysis' where team
 * components are reused") so it changed globally, not conditionally. Every other site is
 * surface-conditional (`useReviewSurface().kind`): the team surface is byte-for-byte UNCHANGED.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2343.
 *
 * Run: `BASE_URL=<worktree Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2343-* --project=chromium --no-deps`.
 * Self-provisioned (PrivateProjectsWorld): a fresh fixture workspace + two throwaway people
 * (a membership-only Investigator, a team Editor for API cross-checks). No seeded/demo data.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2343-e2e-pw!';

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let editor: Actor;
let soleProjectId: string;
let secondProjectId: string;

function unique(label: string): string {
  return `axi2343-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2343', lastName: label },
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

async function newProject(label: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2343 ${label} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function signIn(page: Page, project: string | null): Promise<void> {
  await page.addInitScript(
    ([org, ws, p]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      if (p) localStorage.setItem('axiome-active-project', p);
    },
    [world.orgId, world.workspaceId, project] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
}

/** A minimal, valid `ResultPage` stub (AXI-2327 contract) — no governed run needed for a copy check. */
function stubResultPage(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'GR-00000001',
    projectId: soleProjectId,
    state: 'ready',
    question: 'Does IgG4 differ by sex?',
    templateId: 'T1',
    analysisKind: 'exploratory',
    answer: ['igg4_g_l: F (n = 12) vs M (n = 12); Mann-Whitney U = 40.5, p = 0.012.'],
    canStartAnalysis: true,
    results: [
      {
        nodeId: 'n1',
        ruleRunId: 'r1',
        operationId: 'stats.mann_whitney_u',
        label: 'Mann-Whitney U test',
        chart: null,
        style: null,
        rows: [{ statistic: 40.5, pValue: 0.012 }],
        summary: null,
        run: { snapshotId: null, workspaceId: world.workspaceId, operandRoles: null, operationParams: null },
        evidence: {
          groupNs: [{ group: 'F', n: 12 }, { group: 'M', n: 12 }],
          method: 'Mann-Whitney U test',
          whyChosen: ['Two groups', 'One outcome'],
          parameters: [],
          familySize: 'not applicable',
          dataHash: 'sha256:stub',
          datasetVersion: '1',
          ruleVersion: 'OP-MWU v1',
          mode: 'guided (template T1)',
        },
      },
    ],
    ...overrides,
  };
}

async function stubResultPageRoute(page: Page, body: Record<string, unknown>): Promise<void> {
  await page.route(/\/api\/v1\/projects\/[^/]+\/runs\/[^/]+\/result-page(\?|$)/, (r) => r.fulfill({ status: 200, json: body }));
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  editor = await world.actor('editor');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(editor, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  soleProjectId = await newProject('sole');
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2343 relabel pass — last build story @SI-066 @SI-035', () => {
  test('AC35 NFR9 AXI-2343.2: with two projects the scope selector reads "SAP", never "Project" @SI-066', async ({ page }) => {
    // Arrange — a second project makes the count rule show a selector (AC7/EC1, AXI-2323)
    secondProjectId = await newProject('second');

    // Act
    await signIn(page, null);

    // Assert — the selector's accessible name and placeholder say "SAP"; no "Project" anywhere
    const select = page.getByTestId('investigator-project-select');
    await expect(select).toBeVisible();
    await expect(select).toHaveAccessibleName('SAP');
    await expect(page.getByTestId('investigator-scope')).not.toContainText('Project');
    await expect(page.getByTestId('investigator-scope')).toContainText('SAP');
  });

  // The team surface's SAME guard is unit-pinned unchanged (UT-INVESTIGATOR-7029,
  // `src/pages/NewAnalysis.test.tsx`) — this spec drives only the Investigator's browser,
  // per the epic's one-throwaway-person-per-spec footprint convention.
  test('AC35 NFR9 AXI-2343.3: the setup wizard — plan step and the "no active study" guard never say "project" @SI-066', async ({ page }) => {
    // Act — no active study yet (zero scope)
    await signIn(page, null);
    await gotoSettled(page, '/investigator/new-analysis');

    // Assert — the guard reads "SAP", never "project"
    const guard = page.getByTestId('na-no-project');
    await expect(guard).toBeVisible();
    await expect(guard).not.toContainText(/\bproject\b/i);
    await expect(guard).toContainText('SAP');
  });

  test('AC35 NFR9 AXI-2343.4: the Investigator\'s Statistical plan empty state never says "project" @SI-066 @SI-031', async ({ page }) => {
    // Act
    await signIn(page, soleProjectId);
    await gotoSettled(page, '/investigator');
    await page.getByTestId('investigator-nav-statistical-plan').click();
    await expect(page).toHaveURL(/\/investigator\/statistical-plan$/);

    // Assert — the empty state keeps the same facts, worded without "project"
    const plan = page.getByTestId('investigator-statistical-plan');
    await expect(plan).not.toContainText(/\bproject\b/i);
    await expect(page.getByTestId('sap-empty-state')).toContainText('no statistical analysis plan');
    await expect(page.getByTestId('sap-empty-state')).toContainText('labelled exploratory');
  });

  test('AC35 NFR9 AXI-2343.4b: a SAP he cannot open reads "not found" without "Project", and the way back stays on his surface @SI-066 @SI-031', async ({ page }) => {
    // Arrange — a project id he has no membership path to (the count rule never offers it)
    const { randomUUID } = await import('crypto');

    // Act
    await signIn(page, randomUUID());
    await gotoSettled(page, '/investigator');
    await page.getByTestId('investigator-nav-statistical-plan').click();
    await expect(page).toHaveURL(/\/investigator\/statistical-plan$/);

    // Assert — the refusal never says "Project", and the way back stays on his surface
    await expect(page.getByTestId('project-not-found')).toBeVisible();
    await expect(page.getByTestId('project-not-found')).not.toContainText(/\bproject\b/i);
    await expect(page.getByTestId('project-not-found-return')).toHaveText('Return to my study');
    await page.getByTestId('project-not-found-return').click();
    await expect(page).toHaveURL(/\/investigator$/);
  });

  test('AC35 NFR9 AXI-2343.5: the result page\'s evidence reads "Analysis version", never "Rule version" — both surfaces @SI-066 @SI-033 @SI-034', async ({ page }) => {
    // Act — the Investigator's own result page (network stubbed — no governed run needed)
    await signIn(page, soleProjectId);
    await stubResultPageRoute(page, stubResultPage());
    await gotoSettled(page, `/investigator/projects/${soleProjectId}/runs/GR-00000001`);

    // Assert
    await expect(page.getByTestId('rp-answer')).toBeVisible();
    await page.getByTestId('rp-evidence').click();
    await expect(page.getByTestId('rp-evidence-analysis-version')).toHaveText('OP-MWU v1');
    await expect(page.getByTestId('rp-evidence-rule-version')).toHaveCount(0);
    await expect(page.getByTestId('rp-page')).not.toContainText(/\brule\b/i);
  });
});
