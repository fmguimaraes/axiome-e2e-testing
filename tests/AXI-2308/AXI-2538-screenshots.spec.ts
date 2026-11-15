import { Page, expect, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { gotoSettled } from './harness/new-analysis';

/**
 * AXI-2538 — side-by-side screenshots (dark/light, investigator vs team Datasets
 * page, empty/with-files states), per the owner's "Done" criteria. Not a
 * regression spec: a throwaway, self-provisioned workspace, screenshots only,
 * saved under `reports/AXI-2538/2026-11-15-investigator-datasets/`.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2538-shot-pw!';
const OUT_DIR = 'reports/AXI-2538/2026-11-15-investigator-datasets';

interface Person extends Actor {
  email: string;
}

let world: PrivateProjectsWorld;
let investigator: Person;
let teamAdmin: Person;
let projectId: string;

function unique(label: string): string {
  return `axi2538-shot-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `${unique(label)}@axiome.local`;
  const { request: apiRequest } = await import('@playwright/test');
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), {
    data: { email, password: PASSWORD, firstName: 'AXI2538', lastName: label },
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
  return { email, userId: me.id, api };
}

async function newProject(a: Actor, ws: string, name: string): Promise<string> {
  const res = await a.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2538 shot ${name} ${Date.now()}`, workspaceId: ws },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem('axiome.themePreference', t), theme);
}

async function signInInvestigator(page: Page): Promise<void> {
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

async function signInTeam(page: Page): Promise<void> {
  // The page may still hold an authenticated investigator session from an
  // earlier step in this same test — clear it first, otherwise `/login`
  // redirects straight past the form and the email input never renders.
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.addInitScript(
    ([org, ws]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [world.orgId, world.workspaceId] as const,
  );
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(teamAdmin.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(1500);
  await gotoSettled(page, '/datasets');
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  teamAdmin = await person('teamadmin', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  await world.addMember(teamAdmin, 'admin');
  await world.leaveWorkspace();
  projectId = await newProject(teamAdmin, world.workspaceId, 'study');
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await world?.dispose();
});

test('investigator Datasets — empty state, light + dark', async ({ page }) => {
  await setTheme(page, 'light');
  await signInInvestigator(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/investigator-datasets-empty-light.png`, fullPage: true });
});

test('investigator Datasets — empty state, dark', async ({ page }) => {
  await setTheme(page, 'dark');
  await signInInvestigator(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/investigator-datasets-empty-dark.png`, fullPage: true });
});

test('investigator + team Datasets — with files, light + dark', async ({ page }) => {
  // Upload one file through the real UI so both surfaces have a row to compare.
  await setTheme(page, 'light');
  await signInInvestigator(page);
  const name = `${unique('withfiles')}.csv`;
  const csv = 'subject_id,value,group\nS1,1,A\nS2,2,A\nS3,3,B\nS4,4,B\n';
  await page.locator('[data-testid^="upload-input"]').first().setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator(`[data-upload-name="${name}"]`)).toBeVisible({ timeout: 60_000 });
  const row = page.locator(`[data-upload-name="${name}"]`);
  const id = (await row.getAttribute('data-testid'))!.replace('upload-row-', '');
  await expect(page.getByTestId(`upload-status-${id}`)).toHaveText('Ready', { timeout: 180_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT_DIR}/investigator-datasets-withfiles-light.png`, fullPage: true });

  await setTheme(page, 'dark');
  await page.reload();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT_DIR}/investigator-datasets-withfiles-dark.png`, fullPage: true });

  // Team page, same workspace, same dataset
  await setTheme(page, 'light');
  await signInTeam(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT_DIR}/team-datasets-withfiles-light.png`, fullPage: true });

  await setTheme(page, 'dark');
  await page.reload();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT_DIR}/team-datasets-withfiles-dark.png`, fullPage: true });
});
