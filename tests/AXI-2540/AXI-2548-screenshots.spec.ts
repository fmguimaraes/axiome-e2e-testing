import { Page, Route, expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';

/**
 * AXI-2548 — evidence screenshots for the handback report: a processing row
 * (elapsed time + known stage), a failed row (plain-language reason + Retry),
 * and a ready row. Not a regression spec: throwaway, self-provisioned
 * workspace, saved under `reports/AXI-2548/2026-11-15-upload-status/`.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2548-shot-pw!';
const OUT_DIR = 'reports/AXI-2548/2026-11-15-upload-status';

interface Person extends Actor {
  email: string;
  accessToken: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let projectId: string;

function unique(label: string): string {
  return `axi2548-shot-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const { request: apiRequest } = await import('@playwright/test');
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2548', lastName: label },
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

async function newProject(a: Actor, ws: string, name: string): Promise<string> {
  const res = await a.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2548 shot ${name} ${Date.now()}`, workspaceId: ws },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function signIn(page: Page): Promise<void> {
  await page.addInitScript(
    ([org, ws, project]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', project);
    },
    [world.orgId, world.workspaceId, projectId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
  await gotoSettled(page, '/investigator/uploads');
  await expect(page.getByTestId('investigator-uploads')).toBeVisible({ timeout: 30_000 });
}

async function uploadAndSettle(page: Page, label: string): Promise<string> {
  const name = `${unique(label)}.csv`;
  const csv = 'subject_id,value\nS1,1\nS2,2\nS3,3\n';
  await page.locator('[data-testid^="upload-input"]').first().setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const row = page.locator(`[data-upload-name="${name}"]`);
  await expect(row).toBeVisible({ timeout: 120_000 });
  const id = (await row.getAttribute('data-testid'))!.replace('upload-row-', '');
  await expect(page.getByTestId(`upload-status-${id}`)).toHaveText('Ready', { timeout: 180_000 });
  return id;
}

async function stubLatestIngestion(page: Page, datasetId: string, latestIngestion: Record<string, unknown>): Promise<void> {
  await page.route(/\/api\/v1\/workspaces\/[^/]+\/datasets(\?|$)/, async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json();
    const list = Array.isArray(body.data) ? body.data : body;
    const target = list.find((d: { id: string }) => d.id === datasetId);
    if (target) target.latestIngestion = { ...target.latestIngestion, ...latestIngestion };
    await route.fulfill({ response, json: body.data ? { ...body, data: list } : list });
  });
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  const teamAdmin = await world.actor('team-admin');
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(teamAdmin, 'admin');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);
  projectId = await newProject(teamAdmin, world.workspaceId, 'study');
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test('processing row — elapsed time + known stage', async ({ page }) => {
  await signIn(page);
  const id = await uploadAndSettle(page, 'processing');
  const startedAt = new Date(Date.now() - 90_000).toISOString();
  await stubLatestIngestion(page, id, { status: 'running', startedAt, createdAt: startedAt, errorCode: null, retriedAt: null });
  await page.reload();
  await expect(page.getByTestId(`upload-status-${id}`)).toContainText(/\d+(m|s)/, { timeout: 180_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/processing.png`, fullPage: true });
});

test('failed row — plain-language reason + Retry', async ({ page }) => {
  await signIn(page);
  const id = await uploadAndSettle(page, 'failed');
  await stubLatestIngestion(page, id, { status: 'failed', errorCode: 'INGESTION_TIMEOUT', retriedAt: null });
  await page.reload();
  await expect(page.getByTestId(`upload-retry-${id}`)).toBeVisible({ timeout: 180_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/failed-with-retry.png`, fullPage: true });
});

test('ready row', async ({ page }) => {
  await signIn(page);
  await uploadAndSettle(page, 'ready');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/ready.png`, fullPage: true });
});
