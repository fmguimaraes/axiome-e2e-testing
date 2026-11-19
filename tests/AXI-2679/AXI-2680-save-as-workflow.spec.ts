import { expect, test, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { BASE_URL, apiUrl } from '../../config/env';

/**
 * AXI-2680 (epic AXI-2679 — Save Analysis As Workflow; SI-072, IEC 62304 class C).
 * Scenarios: `axiome-docs/manual-e2e/AXI-2679-Save-Analysis-As-Workflow.md` (AXI-2680 section).
 *
 * The "Save as workflow" action lives on the DECISION (interpretation) page. These tests drive a
 * real browser against the story's ISOLATED stack (its own Postgres copy of the demo DB, its own
 * backend and Vite — never the shared :5173/:3001 stacks), because a save WRITES a template:
 *
 *   BASE_URL=http://127.0.0.1:5175 API_BASE_URL=http://localhost:3011 \
 *     npx playwright test tests/AXI-2679/AXI-2680-save-as-workflow.spec.ts --project=axi-2680-save-as-workflow
 *
 * Fixed data (demo DB reference case, Feature §2), overridable by env:
 *  - reference decision `066d2bb5…` (project `b7b274bc…`) → T2, groups HD/IgG4-RD/SD, stratified by
 *    `reference`, dataset version `582bc2a6…` read from the RUNS;
 *  - a decision of the same workspace whose cited evidence's chart has no linked run → `WORKFLOW_NO_RUN`.
 */

const WS = process.env.AXI2680_WORKSPACE_ID ?? '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const REF_DECISION = process.env.AXI2680_REFERENCE_DECISION_ID ?? '066d2bb5-a1a8-4cda-ba15-3ca5aa2f5cac';
const REF_PROJECT = process.env.AXI2680_REFERENCE_PROJECT_ID ?? 'b7b274bc-48a3-494a-a66f-76390bb433a8';
const NOFIT_DECISION = process.env.AXI2680_NOFIT_DECISION_ID ?? '3d781149-00ce-4521-b40d-aa8b96fa7717';
const NOFIT_PROJECT = process.env.AXI2680_NOFIT_PROJECT_ID ?? 'f212fd26-4297-4d72-91b6-e06136a2eab4';
const REF_DATASET_VERSION = '582bc2a6-4900-4265-b15c-8c5cbb7fde59';
const ADMIN_EMAIL = process.env.E2E_TEST_EMAIL ?? 'admin@cro-one.com';
const ADMIN_PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'admin';
const VIEWER_PASSWORD = 'Axi2680-viewer-pw!';

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

async function registerViewer(): Promise<Session> {
  const email = `axi2680-viewer-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const anon = await apiRequest.newContext();
  const res = await anon.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: VIEWER_PASSWORD, firstName: 'AXI2680', lastName: 'Viewer' },
  });
  expect(res.ok(), `register ${email}: ${res.status()}`).toBeTruthy();
  await anon.dispose();
  return login(email, VIEWER_PASSWORD);
}

let admin: Session;
let viewer: Session | null = null;
let orgId: string;

async function signInBrowser(page: Page, session: Session): Promise<void> {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [session.accessToken, session.refreshToken, orgId, WS] as const,
  );
}

async function templateKeys(): Promise<string[]> {
  const res = await admin.api.get(apiUrl('/api/v1/analysis-templates'));
  expect(res.ok(), `catalog: ${res.status()}`).toBeTruthy();
  return ((await res.json()).data as { templateId: string }[]).map((t) => t.templateId).sort();
}

async function openDecision(page: Page, projectId: string, decisionId: string): Promise<void> {
  await page.goto(`${BASE_URL}/projects/${projectId}/decisions/${decisionId}`);
  await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
  admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const ws = await (await admin.api.get(apiUrl(`/api/v1/workspaces/${WS}`))).json();
  orgId = ws.ownerOrganizationId;
  expect(orgId, 'workspace owner organization').toBeTruthy();
});

test.afterAll(async () => {
  if (viewer) await admin.api.delete(apiUrl(`/api/v1/workspaces/${WS}/members/${viewer.userId}`)).catch(() => undefined);
  await viewer?.api.dispose();
  await admin?.api.dispose();
});

test.describe('AXI-2680 Save as workflow @SI-072 @SI-069 @SI-010', () => {
  test('AXI-2680 AC1 AC2 AC3 AC5 — the reference decision saves as the next T<n> (T2, groups, stratifyBy, source traced) and is listed as a saved workflow', async ({ page }) => {
    const before = await templateKeys();
    await signInBrowser(page, admin);
    await openDecision(page, REF_PROJECT, REF_DECISION);

    await page.getByTestId('save-as-workflow-button').click();
    const summary = page.getByTestId('save-workflow-summary');
    await expect(summary).toContainText('T2', { timeout: 30_000 });
    await expect(summary).toContainText('pct');
    await expect(summary).toContainText('HD, IgG4-RD, SD');
    await expect(summary).toContainText('ENT 059, CER 229, CER 215 et 234');

    await page.getByTestId('save-workflow-confirm').click();
    const key = (await page.getByTestId('save-workflow-key').textContent({ timeout: 30_000 }))?.trim() ?? '';
    const n = Number(/^T(\d+)$/.exec(key)?.[1] ?? NaN);
    expect(n, `saved key ${key}`).toBeGreaterThanOrEqual(6);
    expect(before, 'the key is a NEW template').not.toContain(key);

    const list = (await (await admin.api.get(apiUrl('/api/v1/analysis-templates'))).json()).data as { id: string; templateId: string }[];
    const saved = list.find((t) => t.templateId === key);
    expect(saved, `catalog lists ${key}`).toBeTruthy();
    const detail = await (await admin.api.get(apiUrl(`/api/v1/analysis-templates/${saved!.id}`))).json();
    expect(detail.scope).toBe('workspace');
    expect(detail.workspaceId).toBe(WS);
    const version = detail.versions[0];
    expect(version.kind).toBe('workflow');
    expect(version.status).toBe('published');
    expect(version.templateVersion).toBe('1.0');
    expect(version.recipeKey).toBe('T2');

    const body = version.workflow;
    expect(body.base.templateId).toBe('T2');
    const slots = Object.fromEntries((body.wizard.slots as { slot: string; value: unknown }[]).map((s) => [s.slot, s.value]));
    expect(slots.outcome).toBe('pct');
    expect(slots.groupingColumn).toBe('group');
    expect(slots.groups).toEqual(['HD', 'IgG4-RD', 'SD']);
    expect(body.wizard.stratifyBy).toEqual({ column: 'reference', strata: ['ENT 059', 'CER 229', 'CER 215 et 234'] });
    expect(body.source.kind).toBe('decision');
    expect(body.source.decisionId).toBe(REF_DECISION);
    expect(body.source.datasetVersionId).toBe(REF_DATASET_VERSION);
    expect(body.source.ruleRunIds.length).toBeGreaterThan(0);
    expect(body.source.savedBy).toBe(admin.userId);
    expect(body.interpretation).not.toBeNull();
    expect(body.charts.length).toBe(1);

    await page.goto(`${BASE_URL}/analysis-templates`);
    const row = page.getByRole('row').filter({ hasText: key });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('Saved workflow');
  });

  test('AXI-2680 AC4 — a decision whose branch does not fit is refused with its reason and nothing is written', async ({ page }) => {
    const before = await templateKeys();
    await signInBrowser(page, admin);
    await openDecision(page, NOFIT_PROJECT, NOFIT_DECISION);

    await page.getByTestId('save-as-workflow-button').click();
    await expect(page.getByTestId('save-workflow-refused')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="save-workflow-reason"][data-code="WORKFLOW_NO_RUN"]')).toBeVisible();
    await expect(page.getByTestId('save-workflow-confirm')).toHaveCount(0);

    const res = await admin.api.post(apiUrl('/api/v1/workflows'), { data: { source: { kind: 'decision', id: NOFIT_DECISION } } });
    const answer = await res.json();
    expect(answer.ok).toBe(false);
    expect((answer.reasons as { code: string }[]).map((r) => r.code)).toContain('WORKFLOW_NO_RUN');
    expect(await templateKeys()).toEqual(before);
  });

  test('AXI-2680 AC5 — a workspace member without workflow:save gets 403 and sees no Save action', async ({ page }) => {
    viewer = await registerViewer();
    const added = await admin.api.post(apiUrl(`/api/v1/workspaces/${WS}/members`), {
      data: { userId: viewer.userId, organizationId: orgId, role: 'viewer' },
    });
    expect(added.status(), `add viewer: ${await added.text()}`).toBeLessThan(300);
    const before = await templateKeys();

    const source = { kind: 'decision', id: REF_DECISION };
    const preview = await viewer.api.post(apiUrl('/api/v1/workflows/preview'), { data: { source } });
    expect(preview.status()).toBe(403);
    const save = await viewer.api.post(apiUrl('/api/v1/workflows'), { data: { source } });
    expect(save.status()).toBe(403);
    expect(JSON.stringify(await save.json())).toContain('workflow:save');
    expect(await templateKeys()).toEqual(before);

    await signInBrowser(page, viewer);
    await openDecision(page, REF_PROJECT, REF_DECISION);
    // The page really is the decision (not an error/landing page), so the absent button is a fact.
    await expect(page.getByText('ENT059 and CER229', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('save-as-workflow-button')).toHaveCount(0);
  });
});
