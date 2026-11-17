import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld, access, type Actor } from '../AXI-2265/private-projects-fixtures';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';

/**
 * AXI-2596 (epic AXI-2598 — Investigator Handover): the Study page's "Completeness checks"
 * panel must list every check the server reports, including CC15 ("grouping fields declare
 * their levels"), and the footer's met/applicable count must never read fully met while a
 * server check still fails.
 *
 * Scenario: `axiome-docs/manual-e2e/AXI-2598-Investigator-Handover.md` § 5 (5.1).
 *
 * E2E CONTRACT — REAL setup throughout, no double. Sign-in, workspace, project and the
 * INVESTIGATOR role's permissions are real (demo gateway). The v2 declared plan, its data
 * specification and the CC15 completeness check are all evaluated by the real
 * organization-service completeness engine (`sap-decision/completeness/checks/
 * cc15-spec-grouping-levels.ts`) running on `main` — this is the exact check whose failure the
 * live bug repro (AXI-2596) reproduced, so no stub is needed or used.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const INVESTIGATOR_ROLE_ID = '00000000-0000-0000-0000-000000000105';
const PASSWORD = 'AXI2596-e2e-pw!';

interface Person extends Actor { email: string; accessToken: string }

let world: PrivateProjectsWorld;
let investigator: Person;
let projectOwner: Actor;
let projectId: string;

async function person(label: string, workspaceId: string): Promise<Person> {
  const email = `axi2596-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const bootstrap = await apiRequest.newContext();
  const registered = await bootstrap.post(apiUrl('/api/v1/auth/register'), { data: { email, password: PASSWORD, firstName: 'AXI2596', lastName: label } });
  expect(registered.ok(), `register ${label}: ${registered.status()}`).toBe(true);
  const login = await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password: PASSWORD } });
  expect(login.ok(), `login ${label}: ${login.status()}`).toBe(true);
  const { accessToken } = await login.json();
  await bootstrap.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': workspaceId } });
  const me = await (await api.get(apiUrl('/api/v1/auth/me'))).json();
  return { email, accessToken, userId: me.id, api };
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  investigator = await person('investigator', world.workspaceId);
  await world.addMember(investigator, { roleId: INVESTIGATOR_ROLE_ID });
  projectOwner = await world.actor('owner');
  await world.addMember(projectOwner, 'editor');
  await world.leaveWorkspace();
  await silenceTours(investigator.accessToken);

  const res = await projectOwner.api.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2596 ${Date.now()}`, workspaceId: world.workspaceId } });
  expect(res.status(), await res.text()).toBe(201);
  projectId = (await res.json()).id;
  const grant = await access.grant(projectOwner, projectId, investigator.userId);
  expect(grant.status(), await grant.text()).toBeLessThan(300);
});

test.afterAll(async () => {
  await investigator?.api.dispose();
  await projectOwner?.api.dispose();
  await world?.dispose();
});

async function signInInvestigator(page: Page): Promise<void> {
  await page.addInitScript(([org, ws, p]) => {
    localStorage.setItem('axiome-top-org', org);
    localStorage.setItem('axiome-active-workspace', ws);
    localStorage.setItem('axiome-active-project', p);
  }, [world.orgId, world.workspaceId, projectId] as const);
  await gotoSettled(page, '/login');
  await page.locator('input[type="email"]').fill(investigator.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/investigator$/, { timeout: 30_000 });
}

test.describe('AXI-2596 completeness count reflects every server check @SI-031', () => {
  test('AXI-2596.1 AC9 CC15 is listed and not-met, and flips to met once levels are declared', async ({ page }) => {
    await signInInvestigator(page);

    // Save the protocol — a plan cannot be created without one.
    await gotoSettled(page, `/investigator/projects/${projectId}/study/protocol`);
    await page.getByTestId('protocol-title').fill('AXI-2596 completeness repro');
    await page.getByTestId('protocol-objective').fill('Does sexe affect the outcome?');
    await page.getByTestId('protocol-study-population').fill('Adults, 18-75 years');
    await page.getByTestId('protocol-save').click();
    await expect(page.getByTestId('protocol-unsaved')).toHaveCount(0, { timeout: 15_000 });

    // Create a declared (v2) plan.
    await gotoSettled(page, `/investigator/projects/${projectId}/sap`);
    await expect(page.getByTestId('project-sap-page')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('sap-header-create-plan').click();
    await page.getByTestId('sap-create-timing-declared').check();
    await page.getByTestId('sap-create-plan-submit').click();
    await expect(page.getByTestId('sap-spec-editor')).toBeVisible({ timeout: 15_000 });

    // A grouping field with NO declared levels — the real CC15 trigger.
    await page.getByTestId('sap-spec-add-field').click();
    await page.getByTestId('sap-spec-field-0-name').fill('sexe');
    await page.getByTestId('sap-spec-field-0-label').fill('Sex');
    await page.getByTestId('sap-spec-field-0-role').selectOption('grouping_two_levels');
    await page.getByTestId('sap-spec-save').click();
    await expect.poll(async () => page.getByTestId('sap-plan-check-CC15').count(), { timeout: 15_000 }).toBeGreaterThan(0);

    const cc15 = page.getByTestId('sap-plan-check-CC15');
    await expect(cc15).toHaveAttribute('data-state', 'not_met');
    await expect(cc15).toContainText('Grouping fields declare their levels');
    const footerBefore = await page.getByTestId('sap-plan-checks-footer').textContent();
    const [metBefore, applicableBefore] = parseFooterCounts(footerBefore ?? '');
    expect(metBefore).toBeLessThan(applicableBefore);
    await expect(page.getByTestId('sap-finalise-open')).toBeDisabled();

    // Declare two levels — CC15 flips to met.
    await page.getByTestId('sap-spec-field-0-levels').fill('M, F');
    await page.getByTestId('sap-spec-save').click();
    await expect.poll(async () => page.getByTestId('sap-plan-check-CC15').getAttribute('data-state'), { timeout: 15_000 }).toBe('met');
  });
});

function parseFooterCounts(text: string): [number, number] {
  const match = text.match(/(\d+)\s+of\s+(\d+)\s+checks met/);
  if (!match) throw new Error(`AXI-2596: footer text did not match "N of N checks met": "${text}"`);
  return [Number(match[1]), Number(match[2])];
}
