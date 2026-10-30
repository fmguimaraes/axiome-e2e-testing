import { test, expect, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { UiActor, signInAs, uiActor } from '../AXI-2265/AXI-2269-helpers';

/**
 * AXI-2350 (epic AXI-2308 Platform Opening: Human Guided) — Project Settings →
 * Statistical: a holder of `sap:write` writes the project's ONE SAP, versions
 * only (no delete, no edit in place); a non-holder sees it read-only and is
 * refused server-side; a project may have no SAP (runs are labelled
 * exploratory). FR16, AC12.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md
 * § "AXI-2350" (AXI-2350.2 .. AXI-2350.6).
 *
 * Requires a gateway + organization-service carrying AXI-2338 (one SAP per
 * project, `SapWriteGuard` on `sap:write`) and this branch's front. Self-provisioned:
 * a fresh workspace whose platform admin leaves it; every actor is a throwaway
 * self-registered user. Run with `--no-deps`.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 120_000 });

let world: PrivateProjectsWorld;
let editor: UiActor;
let viewer: UiActor;

const saps = (projectId: string, suffix = '') => apiUrl(`/api/v1/projects/${projectId}/saps${suffix}`);

function content(overrides: Record<string, unknown> = {}) {
  return {
    title: `E2E AXI-2350 SAP ${Date.now()}`,
    questionText: 'Does arm A differ from arm B?',
    planText: 'Primary: Mann–Whitney U on value, A vs B, α = 0.05.',
    linkedMethods: [],
    ...overrides,
  };
}

async function newProject(label: string): Promise<string> {
  const res = await editor.api.post(apiUrl('/api/v1/projects'), {
    data: { name: `E2E AXI-2350 ${label} ${Date.now()}`, workspaceId: world.workspaceId },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id;
}

async function listSaps(projectId: string): Promise<any[]> {
  const res = await editor.api.get(saps(projectId));
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).data;
}

/**
 * Session + scope. The shared helper seeds the workspace only; with no active
 * ORGANIZATION the shell auto-selects one at boot and that clears the workspace
 * (topMenuStore.setActiveOrganizationId), so the fixture's org is seeded too.
 */
async function signIn(page: Page, actor: UiActor): Promise<void> {
  await page.addInitScript((org) => localStorage.setItem('axiome-top-org', org), world.orgId);
  await signInAs(page, actor, world.workspaceId);
}

async function openStatistical(page: Page, actor: UiActor, projectId: string): Promise<void> {
  await signIn(page, actor);
  await page.goto(`/projects/${projectId}/settings?tab=statistical`);
  await expect(page.getByTestId('project-settings-statistical-tab')).toBeVisible();
}

async function fillPlan(page: Page, plan: { title: string; questionText: string; planText: string }) {
  await page.getByTestId('sap-field-title').fill(plan.title);
  await page.getByTestId('sap-field-questionText').fill(plan.questionText);
  await page.getByTestId('sap-field-planText').fill(plan.planText);
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  editor = await uiActor('editor', world.workspaceId);
  viewer = await uiActor('viewer', world.workspaceId);
  await world.addMember(editor, 'editor');
  await world.addMember(viewer, 'viewer');
  await world.leaveWorkspace();
});

test.afterAll(async () => {
  for (const a of [editor, viewer]) await a?.api.dispose();
  await world?.dispose();
});

test.describe('AXI-2350 Project Settings → Statistical', () => {
  let projectId: string;

  test('AC12 AXI-2350.2 a project with no SAP shows the exploratory empty state and a write affordance @SI-031 @SI-030', async ({ page }) => {
    projectId = await newProject('main');
    await openStatistical(page, editor, projectId);
    await expect(page.getByTestId('project-settings-tab-statistical')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('sap-empty-state')).toContainText('no statistical analysis plan');
    await expect(page.getByTestId('sap-empty-state')).toContainText('labelled exploratory');
    await expect(page.getByTestId('sap-write-first')).toBeVisible();

    await page.getByTestId('project-settings-tab-access').click();
    await expect(page).not.toHaveURL(/tab=statistical/);
    await page.getByTestId('project-settings-tab-statistical').click();
    await expect(page).toHaveURL(/tab=statistical/);
    await expect(page.getByTestId('sap-empty-state')).toBeVisible();
  });

  test('AC12 AXI-2350.3 a holder creates the SAP as version 1, stored verbatim @SI-031 @SI-030', async ({ page }) => {
    const plan = content({ planText: 'Primary: Mann–Whitney U.\n\nSecondary: none.' });
    await openStatistical(page, editor, projectId);
    await page.getByTestId('sap-write-first').click();
    await fillPlan(page, plan);
    await page.getByTestId('sap-save').click();

    await expect(page.getByTestId('sap-current-version')).toHaveText('Version 1 · current');
    await expect(page.getByTestId('sap-current-text-title')).toHaveText(plan.title);
    await expect(page.getByTestId('sap-current-text-plan')).toHaveText(plan.planText, { useInnerText: true });
    await expect(page.getByTestId('sap-history-table').locator('tbody tr')).toHaveCount(1);

    const listed = await listSaps(projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ version: 1, title: plan.title, questionText: plan.questionText, planText: plan.planText });
  });

  test('AC12 AXI-2350.4 saving again creates version 2; version 1 stays listed; no delete/edit-in-place @SI-031 @SI-030', async ({ page }) => {
    const [v1] = await listSaps(projectId);
    await openStatistical(page, editor, projectId);
    await page.getByTestId('sap-write-version').click();
    await expect(page.getByTestId('sap-field-title')).toHaveValue(v1.title);
    const newPlan = 'Primary: Mann–Whitney U, Holm-adjusted across two outcomes.';
    await page.getByTestId('sap-field-planText').fill(newPlan);
    await expect(page.getByTestId('sap-save')).toHaveText('Save as version 2');
    await page.getByTestId('sap-save').click();

    await expect(page.getByTestId('sap-current-version')).toHaveText('Version 2 · current');
    await expect(page.getByTestId('sap-current-text-plan')).toHaveText(newPlan);
    await expect(page.getByTestId('sap-history-row-2')).toContainText('Current');
    await expect(page.getByTestId('sap-history-row-1')).toContainText('Superseded');
    const tab = page.getByTestId('project-settings-statistical-tab');
    await expect(tab.getByRole('button', { name: /delete|remove/i })).toHaveCount(0);
    await expect(tab.getByRole('button', { name: /^edit/i })).toHaveCount(0);

    await page.getByTestId('sap-history-view-1').click();
    await expect(page.getByTestId('sap-selected-text-plan')).toHaveText(v1.planText);

    const versions = await (await editor.api.get(saps(projectId, `/${v1.id}/versions`))).json();
    expect(versions.map((v: any) => v.version)).toEqual([1, 2]);
    expect(versions[0].supersededBy).toBe(versions[1].sapVersionId);
  });

  test('AC12 AXI-2350.5 a caller without sap:write sees it read-only and the server refuses the write @SI-031 @SI-010', async ({ page }) => {
    const [latest] = await listSaps(projectId);
    await openStatistical(page, viewer, projectId);
    await expect(page.getByTestId('sap-current-version')).toHaveText(`Version ${latest.version} · current`);
    await expect(page.getByTestId('sap-read-only-note')).toContainText('sap:write');
    await expect(page.getByTestId('sap-write-version')).toHaveCount(0);

    const refused = await viewer.api.post(saps(projectId, `/${latest.id}/versions`), {
      data: { ...content(), basedOnVersion: latest.version },
    });
    expect(refused.status(), await refused.text()).toBe(403);
    expect((await listSaps(projectId))[0].version).toBe(latest.version);

    const empty = await newProject('viewer-empty');
    await page.goto(`/projects/${empty}/settings?tab=statistical`);
    await expect(page.getByTestId('sap-empty-state')).toBeVisible();
    await expect(page.getByTestId('sap-write-first')).toHaveCount(0);
  });

  test('AC12 AXI-2350.6 a stale create is refused 409 and the tab shows the existing SAP @SI-031 @SI-030', async ({ page }) => {
    const raced = await newProject('race');
    await openStatistical(page, editor, raced);
    await page.getByTestId('sap-write-first').click();
    await fillPlan(page, content({ title: 'Typed in the tab' }));

    const winner = content({ title: 'Written elsewhere first' });
    const created = await editor.api.post(saps(raced), { data: winner });
    expect(created.status(), await created.text()).toBe(201);

    await page.getByTestId('sap-save').click();
    await expect(page.getByTestId('sap-write-error')).toContainText('already has its analysis plan');
    await expect(page.getByTestId('sap-current-text-title')).toHaveText(winner.title);
    await expect(page.getByTestId('sap-save')).toHaveText('Save as version 2');
    const listed = await listSaps(raced);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ version: 1, title: winner.title });
  });
});
