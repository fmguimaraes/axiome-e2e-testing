import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, type Actor } from '../AXI-2265/private-projects-fixtures';
import { signInAs, uiActor, type UiActor } from '../AXI-2265/AXI-2269-helpers';
import { silenceTours } from '../AXI-1904/harness/tours';
import { askQuestion, choose, gotoSettled } from '../AXI-2308/harness/new-analysis';
import { apiCallOf, pinNewestT1, questionInput, type ApiCall, SapApiStub } from './harness/sap-api-stub';

/**
 * AXI-2555 (epic AXI-2433 — Structured Statistical Analysis Plan). Three independent pieces of
 * the MAG4 W5 Plan-page follow-up, specified in `BACKLOG-Structured-Statistical-Analysis-Plan.md`
 * §8.12 (FR87–FR89) and `BACKLOG-Platform-Opening-Human-Guided.md` (FR85–FR87, the generator's
 * guards): the Plan tab's "Suggested from your data" section and its "Add to plan" handoff into
 * a prefilled plan-mode wizard (FR87); the Estimand/Sensitivity defaults-line collapse (FR88);
 * the Investigator rail's "Add question" swap while exploration mode is off (FR89).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md`
 * § AXI-2555 (AXI-2555.1 … AXI-2555.3).
 *
 * E2E CONTRACT: every route real on the demo gateway — sign-in, fixture workspace/project,
 * `GET …/opening-templates/suggestions` (AXI-2555 §2 backend guards), AXI-2438's real draft API
 * (seeding only, through `SapApiStub`), AXI-2439's `GET …/sap-templates`. No route is doubled.
 *
 * Fixture: `opening-templates-paul-header.csv` (the AXI-2342/AXI-2450/AXI-2539 fixture) — carries
 * `sexe` (categorical, two levels) and `igg4_g_l` (continuous), which the opening-template
 * generator binds as T1's top-ranked suggestion; a question is seeded on exactly that binding so
 * scenario 1 also exercises the "hide a suggestion already in the plan" guard (FR87/Human-Guided
 * FR87) on the one suggestion that would otherwise duplicate it.
 *
 * `sap:suggested_questions` is off on every seeded role by default (AXI-2539, FR80) — this spec
 * grants it on a THROWAWAY workspace-scoped role (never the shared, global Investigator role
 * AXI-2539 mutates) so it carries no cross-spec cache-TTL coordination.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const FIXTURE = 'opening-templates-paul-header.csv';
const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-2308', 'fixtures');
const SUGGESTIONS_PATH = '/api/v1/guided-analysis/opening-templates/suggestions';
const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const INVESTIGATOR_PASSWORD = 'AXI2555-e2e-pw!';

// AXI-2555's §8.12 editor role: the built-in Editor's own permission set (ROLE_PERMISSIONS.editor,
// `libs/common/src/permissions/permissions.constants.ts`) plus the one extra, off-by-default right
// this story's section needs — a throwaway custom role, never the shared built-in row.
const EDITOR_PLUS_SUGGESTIONS = [
  'view_analysis:create', 'framing:edit_question', 'framing:add_assumption', 'framing:withdraw_own_assumption',
  'guided_analysis:view', 'guided_analysis:plan', 'guided_analysis:run',
  'governed_execution:view', 'governed_execution:submit',
  'guided_analysis_prompt:view', 'guided_analysis_prompt:manage',
  'mapping:confirm_binding', 'mapping:declare_anchor', 'dataset:api_access',
  'sap:read', 'sap:create', 'sap:update', 'sap:delete', 'sap:finalise', 'sap:run',
  'chart_style:write',
  'sap:suggested_questions',
];

interface InvestigatorPerson extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let editor: UiActor;
let investigator: InvestigatorPerson;
let call: ApiCall;
let datasetId: string;
let datasetColumns: unknown[];
let projectId: string;
let stub: SapApiStub;
let draftSapId: string;
let secondSuggestionTemplateId: string;

/** Signed in as the editor, with the fixture org seeded (the shell would otherwise clear it). */
async function signIn(page: Page): Promise<void> {
  await page.addInitScript(([org]) => {
    localStorage.setItem('axiome-top-org', org as string);
  }, [world.orgId] as const);
  await signInAs(page, editor, world.workspaceId);
}

/** AXI-2553's own pattern: an Investigator can never create a project, only the team editor
 * can — he just needs to be a member of the SAME workspace to open one it already created. */
async function registerInvestigator(label: string, workspaceId: string): Promise<InvestigatorPerson> {
  const email = `axi2555-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: INVESTIGATOR_PASSWORD, firstName: 'AXI2555', lastName: label },
  });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: INVESTIGATOR_PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId },
  });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

/** Signed in as the Investigator — email/password form, never the team UI shortcut. */
async function signInInvestigator(page: Page): Promise<void> {
  await page.addInitScript(
    ([org, ws]) => {
      localStorage.setItem('axiome-top-org', org as string);
      localStorage.setItem('axiome-active-workspace', ws as string);
    },
    [world.orgId, world.workspaceId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(INVESTIGATOR_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
}

async function ingestFixture(admin: Actor['api'], headers: Record<string, string>): Promise<{ datasetId: string; columns: unknown[] }> {
  const bytes = readFileSync(join(FIXTURES_DIR, FIXTURE));
  const init = await admin.post(apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`), {
    data: { organizationId: world.orgId, originalFilename: `axi2555-${FIXTURE}`, contentType: 'text/csv' },
    headers,
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset, presignedUrl } = await init.json();
  const put = await fetch(presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await admin.patch(apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${dataset.id}/finalize`), { headers });
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const read = await admin.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${dataset.id}`), { headers });
    const body = await read.json();
    if (body.latestIngestion?.status === 'ready') {
      return { datasetId: dataset.id, columns: body.semanticSchema?.columns ?? body.columns ?? [] };
    }
    if (body.latestIngestion?.status === 'failed') throw new Error('AXI-2555 fixture ingestion failed');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('AXI-2555 fixture ingestion did not settle Ready within 90s');
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  world = await PrivateProjectsWorld.create();
  const headers = { 'X-Workspace-Id': world.workspaceId };

  const roleId = await world.workspaceRole('AXI-2555 editor+suggestions', EDITOR_PLUS_SUGGESTIONS);
  editor = await uiActor('editor', world.workspaceId);
  await world.addMember(editor, { roleId });
  investigator = await registerInvestigator('investigator', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.leaveWorkspace();
  await silenceTours(editor.accessToken);
  await silenceTours(investigator.accessToken);
  call = apiCallOf(editor.api);

  const ingested = await ingestFixture(world.admin, headers);
  datasetId = ingested.datasetId;
  datasetColumns = ingested.columns;

  const proj = await editor.api.post(apiUrl('/api/v1/projects'), { data: { name: `AXI-2555 ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).id;
  const link = await editor.api.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId } });
  expect(link.status(), await link.text()).toBeLessThan(300);

  await pinNewestT1(call, projectId);
  stub = new SapApiStub(projectId, editor.userId, datasetId);
  // Seed one T1 question on sexe/igg4_g_l — the generator's top suggestion for this fixture — so
  // the "hide a suggestion already in the plan" guard (FR87) excludes it from the section below.
  const seeded = await stub.seedDraft(call, [
    questionInput(1, 'primary', {
      text: 'Does IgG4 differ by sex?',
      bindings: [
        { slot: 'groupingColumn', column: 'sexe', semanticRole: 'grouping_two_levels' },
        { slot: 'outcome', column: 'igg4_g_l', semanticRole: 'continuous' },
      ],
    }),
  ]);
  draftSapId = seeded.sapId;

  // Confirm what the generator actually returns for this project/dataset today, and that the
  // already-planned T1 suggestion on sexe/igg4_g_l is excluded — the live, server-decided input
  // the UI assertions below read off, never hardcoded.
  const res = await editor.api.post(apiUrl(SUGGESTIONS_PATH), { data: { projectId, dataset: { datasetId, columns: datasetColumns } } });
  expect(res.status(), await res.text()).toBe(200);
  const suggestions = await res.json();
  expect(Array.isArray(suggestions) && suggestions.length).toBeTruthy();
  const stillT1 = suggestions.find((s: { templateId: string; parameters: Record<string, unknown> }) =>
    s.templateId === 'T1' && s.parameters.groupingColumn === 'sexe' && s.parameters.outcome === 'igg4_g_l');
  expect(stillT1, 'the already-planned T1 suggestion must be hidden by the FR87 guard').toBeUndefined();
  secondSuggestionTemplateId = suggestions[0].templateId;
});

test.afterAll(async () => {
  await editor?.api.dispose();
  await investigator?.api.dispose();
  await world?.dispose();
});

/** Question → chosen intent → chosen T1 → (what was read) → the first plan step. */
async function throughAnalysis(page: Page): Promise<void> {
  await askQuestion(page, 'Does IgG4 differ between the two MAG4 clusters?');
  await expect(page.getByTestId('na-step-intent')).toBeVisible();
  await choose(page, 'na-choice-compare_groups');
  await expect(page.getByTestId('na-step-template')).toBeVisible();
  await expect(page.getByTestId('na-choice-T1')).toBeVisible({ timeout: 60_000 });
  await choose(page, 'na-choice-T1');
  await settleAnalysis(page);
  await expect(page.getByTestId('na-step-role')).toBeVisible();
}

/** Confirm what the wizard read and answer what it still asks, with the fixture's own fits. */
async function settleAnalysis(page: Page): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    const step = await page.locator('[data-testid^="na-step-"]').first().getAttribute('data-testid');
    if (step === 'na-step-read') await choose(page, 'na-read-confirm');
    else if (step === 'na-step-decide') await choose(page, 'na-decide-next');
    else return;
    await page.waitForTimeout(300);
  }
}

async function next(page: Page, from: string, to: string): Promise<void> {
  await expect(page.getByTestId(`na-step-${from}`)).toBeVisible();
  await choose(page, 'na-plan-next');
  await expect(page.getByTestId(`na-step-${to}`)).toBeVisible();
}

test.describe('AXI-2555 Plan tab suggestions, Estimand/Sensitivity defaults, sidebar Add question @SI-031 @SI-066', () => {
  test('FR87 AXI-2555.1 "Suggested from your data" chip cards, already-planned hidden, "Add to plan" never runs @SI-031 @SI-066', async ({ page }) => {
    const launched: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/guided-analysis/wizard-runs') launched.push(r.url());
    });
    await stub.install(page);
    await signIn(page);
    // DEVIATION (tracked, see manual-e2e doc): the suggestions slot is INVESTIGATOR-surface only
    // (ProjectSapPlanTab.tsx), but `sap:suggested_questions` is deliberately withheld from the
    // real seeded Investigator role (AXI-2539/FR80, "unchanged" by this story) — so no genuine
    // Investigator membership can ever reach this section in this environment. The editor
    // signed in above DOES hold the permission (this spec's own throwaway role), so the surface
    // itself is stubbed to 'investigator' here — every SAP read/write below still goes through
    // the real gateway/organization-service under the editor's own session and permissions.
    await page.route('**/api/v1/surface', (route) => route.fulfill({ json: { surface: 'investigator' } }));

    await gotoSettled(page, `/investigator/projects/${projectId}/sap`);
    await expect(page.getByTestId('sap-suggested-questions')).toBeVisible();
    // The already-planned T1/sexe/igg4_g_l suggestion is excluded server-side (confirmed against
    // the live `suggest` response in `beforeAll`) — this chip is the first one NOT excluded.
    const chip = page.getByTestId(`sap-suggested-question-${secondSuggestionTemplateId}`);
    await expect(chip).toBeVisible();

    await page.getByTestId(`sap-suggested-question-add-${secondSuggestionTemplateId}`).click();

    // Lands on the plan-mode wizard, prefilled — never on a run.
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap/questions/new$`));
    await expect(page.locator('[data-testid^="na-step-"]')).toBeVisible();
    expect(launched).toEqual([]);

    // The draft is unchanged by merely landing on the wizard (no write yet).
    const draftRes = await call('GET', `/projects/${projectId}/sap-draft`);
    expect(draftRes.body.plan.questions).toHaveLength(1);
  });

  test('FR88 AXI-2555.2 Estimand and Sensitivity collapse to a defaults line with Edit — investigator surface only @SI-066', async ({ page }) => {
    await stub.install(page);
    await signInInvestigator(page);
    await gotoSettled(page, `/investigator/projects/${projectId}/sap/questions/new`);
    await throughAnalysis(page);

    // Estimand — untouched defaults collapse to one line; Edit expands the real fields.
    await next(page, 'role', 'estimand');
    await expect(page.getByTestId('na-plan-estimand-defaults')).toBeVisible();
    await expect(page.getByTestId('na-plan-estimand-variable')).toHaveCount(0);
    await page.getByTestId('na-plan-estimand-defaults-edit').click();
    await expect(page.getByTestId('na-plan-estimand-defaults')).toHaveCount(0);
    await expect(page.getByTestId('na-plan-estimand-variable')).toBeVisible();

    // Sensitivity — same collapse/Edit contract, independently of Estimand's own expand.
    await next(page, 'estimand', 'parameters');
    await next(page, 'parameters', 'sensitivity');
    await expect(page.getByTestId('na-plan-sensitivity-defaults')).toBeVisible();
    await page.getByTestId('na-plan-sensitivity-defaults-edit').click();
    await expect(page.getByTestId('na-plan-sensitivity-defaults')).toHaveCount(0);
  });

  test('FR88 AXI-2555.2b the TEAM wizard never collapses — full Estimand fields at the exact same defaults @SI-066', async ({ page }) => {
    await stub.install(page);
    await signIn(page);
    await gotoSettled(page, `/projects/${projectId}/sap/questions/new`);
    await throughAnalysis(page);

    await next(page, 'role', 'estimand');
    await expect(page.getByTestId('na-plan-estimand-variable')).toBeVisible();
    await expect(page.getByTestId('na-plan-estimand-defaults')).toHaveCount(0);
  });

  test('FR89 AXI-2555.3 sidebar reads "Add question" (not "New analysis") on the Investigator rail @SI-066', async ({ page }) => {
    await signInInvestigator(page);
    await gotoSettled(page, `/investigator/projects/${projectId}`);
    await expect(page.getByTestId('investigator-add-question')).toBeVisible();
    await expect(page.getByTestId('investigator-new-analysis')).toHaveCount(0);
    await page.getByTestId('investigator-add-question').click();
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${projectId}/sap/questions/new$`));
  });
});
