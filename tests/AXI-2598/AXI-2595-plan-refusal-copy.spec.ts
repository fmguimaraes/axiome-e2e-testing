import { test, expect, request as apiRequest, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld, access } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';

/**
 * AXI-2595 (epic AXI-2598) — a state-4 refusal caused by the plan/a template (pre-flight
 * reason `template_unresolved` | `template_compile_refused` | `template_main_result_not_run` |
 * `slot_unbound`) is never shown as "Data · blocking issue" with "Upload corrected file" (FR17,
 * AC8). Scenario doc: axiome-docs/manual-e2e/AXI-2598-Investigator-Handover.md § 4.1.
 *
 * Real reproduction of the AXI-2594 defect: T3 ("Correlation")'s newest published version
 * declares its main result on `stats.matrix_global_test`, which the compiled analysis does not
 * run for a single x/y binding — the SAME refusal the investigator campaign (AXI-2576) found.
 * A v1 plan with one primary T3 question, bound to a dataset carrying exactly the columns it
 * needs, reaches state 4 through the real pre-flight the moment the Study page loads — no run
 * is ever attempted, and nothing is doubled.
 */

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const READY_WAIT_MS = 120_000;
const SETUP_TIMEOUT_MS = 5 * 60_000;

let world: PrivateProjectsWorld;
let editor: Actor;
let investigator: Actor;
let project: string;
let investigatorLogin: { email: string; password: string; accessToken: string };

const base = (projectId: string) => apiUrl(`/api/v1/projects/${projectId}`);

/** The registry's newest published T3 version — the AXI-2594 defect reproduces at whichever
 *  version is currently newest (0.4 at the time of writing); never hard-coded. */
async function pinNewestT3(): Promise<string> {
  const res = await editor.api.get(`${base(project)}/sap-templates`);
  expect(res.status(), await res.text()).toBe(200);
  const newest = (await res.json()).find((e: { templateId: string; isNewest: boolean }) => e.templateId === 'T3' && e.isNewest);
  expect(newest, 'the catalog lists a newest T3').toBeTruthy();
  return newest.templateVersion;
}

function correlationQuestion(templateVersion: string) {
  return {
    text: 'Does biomarker X move together with biomarker Y?',
    role: 'primary',
    estimand: {
      population: 'All enrolled subjects',
      variable: 'Biomarker X vs biomarker Y',
      intercurrentEvents: 'Treatment policy',
      populationSummary: 'Spearman correlation',
      treatmentComparison: 'Not applicable (single-arm correlation)',
    },
    template: { templateId: 'T3', templateVersion },
    bindings: [
      { slot: 'x', column: 'biomarker_x', semanticRole: 'continuous' },
      { slot: 'y', column: 'biomarker_y', semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
  };
}

async function privateProject(): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2595 plan refusal ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id;
  expect((await access.visibility(editor, id, 'private')).status()).toBe(200);
  return id;
}

/** Two continuous columns only — exactly what T3's `x`/`y` slots bind to. */
async function uploadXYDataset(): Promise<string> {
  const datasets = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets`);
  const init = await editor.api.post(datasets, {
    data: { organizationId: world.orgId, originalFilename: `axi2595-${Date.now()}.csv`, contentType: 'text/csv' },
  });
  expect(init.status(), await init.text()).toBeLessThan(300);
  const { dataset: created, presignedUrl } = await init.json();
  const rows = Array.from({ length: 16 }, (_, i) => `S${i + 1},${(10 + i * 0.4).toFixed(1)},${(5 + i * 0.7).toFixed(1)}`);
  const put = await fetch(presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: `subject_id,biomarker_x,biomarker_y\n${rows.join('\n')}\n`,
  });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const finalize = await editor.api.patch(`${datasets}/${created.id}/finalize`);
  expect(finalize.status(), await finalize.text()).toBeLessThan(300);
  return created.id;
}

async function readyIngestion(datasetId: string): Promise<string> {
  const path = apiUrl(`/api/v1/workspaces/${world.workspaceId}/datasets/${datasetId}`);
  let id = '';
  await expect
    .poll(
      async () => {
        const res = await editor.api.get(path);
        const latest = res.ok() ? (await res.json()).latestIngestion : null;
        if (latest?.status === 'ready') id = latest.id;
        return latest?.status ?? 'none';
      },
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toBe('ready');
  return id;
}

/** A real final v1 version holding the one T3 correlation question (AXI-2438/AXI-2439). */
async function finaliseSap(datasetId: string, templateVersion: string): Promise<void> {
  const draft = await (await editor.api.post(`${base(project)}/saps/draft`)).json();
  const titled = await editor.api.put(`${base(project)}/saps/${draft.sapId}/draft`, {
    data: { basedOnRevision: draft.revision, title: 'AXI-2595 correlation plan' },
  });
  expect(titled.status(), await titled.text()).toBe(200);
  const added = await editor.api.post(`${base(project)}/saps/${draft.sapId}/draft/questions`, {
    data: {
      basedOnRevision: (await titled.json()).revision,
      analysisDatasetId: datasetId,
      question: correlationQuestion(templateVersion),
    },
  });
  expect(added.status(), await added.text()).toBe(201);
  const complete = await added.json();
  await expect
    .poll(
      async () => {
        const report = await (await editor.api.get(`${base(project)}/saps/${draft.sapId}/draft/completeness`)).json();
        return report.results.filter((r: { status: string }) => r.status === 'fail').map((r: { checkId: string }) => r.checkId);
      },
      { timeout: READY_WAIT_MS, intervals: [2_000, 5_000] },
    )
    .toEqual([]);
  const finalised = await editor.api.post(`${base(project)}/saps/${draft.sapId}/draft/finalise`, {
    data: { basedOnRevision: complete.revision, basedOnVersion: null },
  });
  expect(finalised.status(), await finalised.text()).toBe(201);
}

/** The investigator, self-registered so the spec keeps real login credentials. */
async function investigatorActor(): Promise<Actor> {
  const email = `axi2595-investigator-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const password = 'AXI2595-e2e-pw!';
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password, firstName: 'AXI2595', lastName: 'Investigator' },
  });
  expect(registered.status(), await registered.text()).toBeLessThan(300);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(login.status(), await login.text()).toBeLessThan(300);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': world.workspaceId },
  });
  const me = await api.get(apiUrl('/api/v1/auth/me'));
  expect(me.status(), await me.text()).toBe(200);
  investigatorLogin = { email, password, accessToken };
  return { userId: (await me.json()).id, api };
}

async function openStudyPage(page: Page): Promise<void> {
  await silenceTours(investigatorLogin.accessToken);
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(investigatorLogin.email);
  await page.locator('input[type="password"]').fill(investigatorLogin.password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.evaluate(([orgId, workspaceId, projectId]) => {
    localStorage.setItem('axiome-top-org', orgId as string);
    localStorage.setItem('axiome-active-workspace', workspaceId as string);
    localStorage.setItem('axiome-active-project', projectId as string);
  }, [world.orgId, world.workspaceId, project]);
  await page.goto('/investigator');
  await expect(page.getByTestId('investigator-home')).toBeVisible({ timeout: 30_000 });
}

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  test.setTimeout(SETUP_TIMEOUT_MS);
  world = await PrivateProjectsWorld.create();
  editor = await world.actor('editor');
  investigator = await investigatorActor();
  await world.addMember(editor, 'editor');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  project = await privateProject();
  expect((await access.grant(editor, project, investigator.userId, 'editor')).status()).toBeLessThan(300);
  const templateVersion = await pinNewestT3();
  const dataset = await uploadXYDataset();
  const linked = await editor.api.post(`${base(project)}/datasets`, { data: { datasetId: dataset } });
  expect(linked.status(), await linked.text()).toBeLessThan(300);
  await readyIngestion(dataset);
  await finaliseSap(dataset, templateVersion);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2595 — a plan/template refusal is never shown as a data problem', { tag: ['@SI-066'] }, () => {
  test('AC8 — a T3@newest main-result-not-run refusal reads state 4 as a plan problem: "Plan · blocking issue", the question named, no "Upload corrected file"', async ({ page }) => {
    // Act
    await openStudyPage(page);

    // Assert — state 4, "0 of 1 questions can run" (the one question is blocked)
    const statusBlock = page.getByTestId('study-status-block');
    await expect(statusBlock).toHaveAttribute('data-study-state', '4', { timeout: 30_000 });
    await expect(statusBlock).toContainText('0 of 1 questions can run');

    // Assert — the chip names the PLAN, never "Data · blocking issue"
    const chips = page.getByTestId('study-status-chips');
    await expect(chips).toContainText('Plan · blocking issue');
    await expect(chips).not.toContainText('Data · blocking issue');

    // Assert — the sentence names the question and says the plan needs changing
    await expect(statusBlock).toContainText('Primary question:');
    await expect(statusBlock).toContainText('plan needs changing');

    // Assert — "Upload corrected file" is never offered as the primary action
    await expect(page.getByTestId('study-primary-action')).toHaveCount(0);
    await expect(statusBlock).not.toContainText('Upload corrected file');
  });
});
