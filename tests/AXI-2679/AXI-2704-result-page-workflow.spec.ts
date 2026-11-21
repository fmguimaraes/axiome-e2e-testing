import { expect, test, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL, apiUrl } from '../../config/env';

/**
 * AXI-2704 (epic AXI-2679 — Save Analysis As Workflow; bug fix; SI-072, IEC 62304 class C).
 * Scenarios: `axiome-docs/manual-e2e/AXI-2679-Save-Analysis-As-Workflow.md` (AXI-2704 section).
 *
 * Bug: the investigator result page of a study-plan question that runs a SAVED WORKFLOW named
 * and drew the BASE template (e.g. T2), never the workflow itself (T10 and its own recorded
 * graph). Fix: `ResultPageResponse.workflow` (back) + `ResultWorkflowGraphCard` /
 * `WorkflowCompositionView` (front) — the SAME component the workflow's own template page draws
 * its graph with.
 *
 * Drives a real browser against the story's ISOLATED stack (its own Postgres copy of the demo
 * DB with the AXI-2680 reference workflow saved, its own backend running this story's branch and
 * its own Vite):
 *
 *   BASE_URL=http://127.0.0.1:5176 API_BASE_URL=http://localhost:3012 \
 *     npx playwright test tests/AXI-2679/AXI-2704-result-page-workflow.spec.ts --project=axi-2704-result-page-workflow
 *
 * Fixed data (demo DB reference case per the bug report), overridable by env: workspace
 * "Mag4" `8946e06a…`, project `7b4c3704…`, governed run `GR-42b79ac8` pinned to the saved
 * workflow `T10` ("IgG4 coating of ENT 059, CER 229 and CER 215+234", v1.0).
 *
 * Credentials come ONLY from `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD` (no literal default here or
 * anywhere in this file — NFR6).
 */

const WS = process.env.AXI2704_WORKSPACE_ID ?? '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT = process.env.AXI2704_PROJECT_ID ?? '7b4c3704-caaf-4ccf-ac88-8614fd2afdec';
const RUN_ID = process.env.AXI2704_RUN_ID ?? 'GR-42b79ac8';
const SAP_ID = process.env.AXI2704_SAP_ID ?? '4b1b47ea-f17a-4042-868a-cb3d0d2592c9';
const QUESTION_ID = process.env.AXI2704_QUESTION_ID ?? '0d678061-c9a2-41fe-a531-0bb6416d6419';
const WORKFLOW_TEMPLATE_ID = process.env.AXI2704_WORKFLOW_TEMPLATE_ID ?? 'T10';
const WORKFLOW_LABEL_FRAGMENT = process.env.AXI2704_WORKFLOW_LABEL_FRAGMENT ?? 'IgG4 coating';
const INVESTIGATOR_EMAIL = process.env.E2E_TEST_EMAIL;
const INVESTIGATOR_PASSWORD = process.env.E2E_TEST_PASSWORD;

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

interface Session {
  api: APIRequestContext;
  accessToken: string;
  refreshToken: string;
  userId: string;
}

async function login(email: string, password: string): Promise<Session> {
  const anon = await apiRequest.newContext();
  const res = await anon.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy();
  const { accessToken, refreshToken } = await res.json();
  await anon.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WS } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { api, accessToken, refreshToken, userId: me.id };
}

let investigator: Session;

test.beforeAll(async () => {
  test.skip(!INVESTIGATOR_EMAIL || !INVESTIGATOR_PASSWORD, 'E2E_TEST_EMAIL/E2E_TEST_PASSWORD not set for this environment');
  investigator = await login(INVESTIGATOR_EMAIL as string, INVESTIGATOR_PASSWORD as string);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
});

async function signInBrowser(page: Page): Promise<void> {
  await page.addInitScript(
    ([access, refresh, ws, project]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-active-workspace', ws);
      sessionStorage.setItem('axiome-investigator-last-workspace', ws);
      sessionStorage.setItem('axiome-investigator-last-project', project);
    },
    [investigator.accessToken, investigator.refreshToken, WS, PROJECT] as const,
  );
}

function resultPageUrl(): string {
  const query = new URLSearchParams({ sapId: SAP_ID, questionId: QUESTION_ID });
  return `${BASE_URL}/investigator/projects/${PROJECT}/runs/${RUN_ID}?${query.toString()}`;
}

test.describe('AXI-2704 Result page names and draws the saved workflow @SI-072 @SI-002', () => {
  test('AXI-2704 — the result page of a run launched from a saved workflow names it (T10 and its label) and draws its RECORDED-STEPS graph, never the base template', async ({ page }) => {
    // Backend contract: the run's own workflow identity, never the base recipe T2.
    const resultPage = await (await investigator.api.get(apiUrl(`/api/v1/projects/${PROJECT}/runs/${RUN_ID}/result-page`))).json();
    expect(resultPage.workflow, 'result-page serves a workflow identity').toBeTruthy();
    expect(resultPage.workflow.templateId).toBe(WORKFLOW_TEMPLATE_ID);
    expect(resultPage.workflow.name).toContain(WORKFLOW_LABEL_FRAGMENT);
    expect(resultPage.templateId).not.toBe(WORKFLOW_TEMPLATE_ID); // T2/T1, the base recipe, by design

    // Browser: the page names the workflow and draws its graph through the shared component.
    await signInBrowser(page);
    await page.goto(resultPageUrl());
    await expect(page.getByTestId('rp-page')).toBeVisible({ timeout: 30_000 });

    const name = page.getByTestId('rp-workflow-name');
    await expect(name).toBeVisible({ timeout: 30_000 });
    await expect(name).toContainText(WORKFLOW_TEMPLATE_ID);
    await expect(name).toContainText(WORKFLOW_LABEL_FRAGMENT);

    await expect(page.getByTestId('template-flow-graph')).toBeVisible({ timeout: 30_000 });
    const nodes = page.locator('[data-testid^="template-graph-node-"]');
    expect(await nodes.count(), 'the graph draws at least one recorded step').toBeGreaterThan(0);
  });

  test('AXI-2704 — a built-in opening template run (T1-T5) shows no workflow card', async ({ page }) => {
    const builtinRunId = process.env.AXI2704_BUILTIN_RUN_ID;
    test.skip(!builtinRunId, 'no T1-T5 comparison run id configured for this environment');

    await signInBrowser(page);
    await page.goto(`${BASE_URL}/investigator/projects/${PROJECT}/runs/${builtinRunId}`);
    await expect(page.getByTestId('rp-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('rp-workflow-graph')).toHaveCount(0);
  });
});
