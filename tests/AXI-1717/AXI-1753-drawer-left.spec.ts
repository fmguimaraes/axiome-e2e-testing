import { test, expect } from '@playwright/test';
import { adminApi, workspaceHeader, type Api } from '../AXI-1435/harness/api';
import { ensureTenant, ensureProject } from '../AXI-1507/harness/seed';

/**
 * AXI-1753 (epic AXI-1717, ruling R19) — every workbench drawer opens on the
 * LEFT, beside the phase rail, and the canvas re-fits so no node is covered.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1717-Discovery-Workbench.md` §19.
 * Tag: @SI-046.
 *
 * PREVIEW PATH ONLY — this ruling is a placement/layout change with no
 * backend dependency (front-only story), so it needs no discovery-plan
 * instance and no `?analysisId=`; a bare project is enough to render the
 * canvas and its ONE always-present drawer trigger, the guiding-question
 * crumb (`WorkbenchQuestionModal`, shared by every drawer via the single
 * `WorkbenchModal` shell — AC2's "one shared placement, not per-panel").
 */

test.describe('AXI-1753 - workbench drawer placement (preview, real backend)', { tag: ['@SI-046'] }, () => {
  let api: Api;
  let t: Awaited<ReturnType<typeof ensureTenant>>;
  let projectId: string;

  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureTenant(api);
    projectId = await ensureProject(api, t, 'AXI-1753 Drawer Left');
  });
  test.afterAll(async () => { await api?.ctx.dispose(); });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    }, [t.workspaceId, t.orgId] as const);
  });

  test('AC1 - a drawer opens on the left, flush beside the phase rail, not centred over the canvas', async ({ page }) => {
    await page.goto(`/projects/${projectId}/discovery-workbench`);
    await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });
    const rail = page.getByTestId('phase-rail');
    await expect(rail).toBeVisible();
    const railBox = await rail.boundingBox();
    expect(railBox).toBeTruthy();

    await page.getByTestId('workbench-question').getByLabel('Show full question').click();
    const drawer = page.getByTestId('workbench-question-modal');
    await expect(drawer).toBeVisible();
    const dialog = drawer.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).toBeTruthy();

    // Left, not centred: the dialog's left edge sits just past the rail's right
    // edge, nowhere near where a centred modal would land on a normal viewport.
    expect(dialogBox!.x).toBeGreaterThanOrEqual(railBox!.x + railBox!.width - 1);
    expect(dialogBox!.x).toBeLessThan(railBox!.x + railBox!.width + 80);

    await page.getByRole('dialog', { name: 'Guiding question' }).getByLabel('Close').click();
    await expect(drawer).toBeHidden();
  });

  test('AC1 - one shared placement: the Steps panel collapsed moves the SAME drawer left too, not a per-panel offset', async ({ page }) => {
    await page.goto(`/projects/${projectId}/discovery-workbench`);
    await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });

    // Collapse the Steps panel/phase rail first (`[` toggles it — PhaseRail.tsx).
    await page.keyboard.press('[');
    const collapsedRail = page.getByTestId('phase-rail-collapsed');
    await expect(collapsedRail).toBeVisible();
    const collapsedBox = await collapsedRail.boundingBox();

    await page.getByTestId('workbench-question').getByLabel('Show full question').click();
    const dialog = page.getByTestId('workbench-question-modal').getByRole('dialog');
    await expect(dialog).toBeVisible();
    const dialogBox = await dialog.boundingBox();

    // Beside the NARROW collapsed rail now — still left, still flush, no separate
    // "collapsed drawer" component or offset was written for this case.
    expect(dialogBox!.x).toBeGreaterThanOrEqual(collapsedBox!.x + collapsedBox!.width - 1);
    expect(dialogBox!.x).toBeLessThan(collapsedBox!.x + collapsedBox!.width + 80);
  });

  test('AC1 - the canvas re-fits so the node behind the drawer is no longer covered', async ({ page }) => {
    await page.goto(`/projects/${projectId}/discovery-workbench`);
    await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });
    const questionNode = page.getByTestId('workbench-question');
    await expect(questionNode).toBeVisible({ timeout: 30_000 });

    await questionNode.getByLabel('Show full question').click();
    const dialog = page.getByTestId('workbench-question-modal').getByRole('dialog');
    await expect(dialog).toBeVisible();
    // `DrawerFitEffect`'s re-fit runs a 300ms transition; give it a little more
    // to settle before reading node positions back off the DOM.
    await page.waitForTimeout(500);
    const dialogBox = await dialog.boundingBox();
    const afterBox = await questionNode.boundingBox();
    expect(dialogBox).toBeTruthy();
    expect(afterBox).toBeTruthy();

    // The question node (the one the drawer was opened from) sits clear of the
    // drawer's own footprint after the re-fit — it moved right, not hidden
    // behind the dialog panel.
    expect(afterBox!.x).toBeGreaterThanOrEqual(dialogBox!.x + dialogBox!.width);
  });
});
