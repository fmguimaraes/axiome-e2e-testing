import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, primeWorkspace, type Seeded } from '../AXI-1717/harness/live-workbench';

/**
 * AXI-1892 (epic AXI-1883) - the Discovery Workbench's logo/nav drawer
 * animates in and out (FR21/AC12). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md` section "Workbench
 * drawer". Tags: @SI-046 (discoveryWorkbench UI — GlobalNavDrawer).
 *
 * The drawer is opened by the top bar's "Open navigation" button, next to
 * the logo (`WorkbenchTopBar.tsx`); FR21's "workbench logo drawer" names
 * this one drawer by what sits beside its trigger, not a second control on
 * the logo image itself (the logo image's own click still navigates home,
 * out of this story's scope — `WorkbenchTopBar.tsx` is touched, `TopMenu.tsx`
 * is not).
 *
 * No seeded step is driven — the preview workbench (no `analysisId`) is
 * enough to exercise the drawer, so this spec never runs a governed step.
 */
test.describe('AXI-1892 - workbench nav drawer animation (UI, real backend)', { tag: ['@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1892-${tag}`, `AXI-1892 drawer animation ${tag}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test.beforeEach(async ({ page }) => {
    await primeWorkspace(page, s);
    await page.goto(`/projects/${s.projectId}/discovery-workbench`);
    await expect(page.getByTestId('discovery-workbench')).toBeVisible({ timeout: 30_000 });
  });

  /** True once `document.activeElement` sits inside `#workbench-nav-drawer`. */
  const focusInsideDrawer = (page: import('@playwright/test').Page) =>
    page.evaluate(() => document.activeElement?.closest('#workbench-nav-drawer') != null);

  test('AC12 - opening the drawer reaches a visible, enter-transitioned state, and moves focus into it', async ({ page }) => {
    const panel = page.locator('#workbench-nav-drawer');
    await expect(panel).toHaveCount(0);

    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-drawer-phase', 'open');
    await expect(panel).toHaveClass(/translate-x-0/);
    await expect(panel).toHaveClass(/opacity-100/);
    // Regression (review bounce #1): an `inert`/`aria-hidden` panel during the
    // transient 'opening' commit would make `useFocusTrap`'s same-commit
    // `focusFirst()` a no-op, with no effect dependency that ever reruns it —
    // keyboard focus would simply never reach the drawer. Assert it did.
    await expect.poll(() => focusInsideDrawer(page)).toBe(true);
  });

  test('AC12 - closing animates out: the panel is hidden from a11y immediately, then removed after the exit transition, and focus returns to the trigger', async ({ page }) => {
    const panel = page.locator('#workbench-nav-drawer');
    const trigger = page.getByRole('button', { name: 'Open navigation' });
    await trigger.click();
    await expect(panel).toBeVisible();
    await expect.poll(() => focusInsideDrawer(page)).toBe(true);

    await page.keyboard.press('Escape');
    // Not caught by the accessible-role query the instant it starts closing.
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
    // ...but the node itself is still in the DOM, mid exit transition, not yanked out.
    await expect(panel).toHaveAttribute('data-drawer-phase', 'closing');
    await expect(panel).toHaveClass(/-translate-x-full/);
    // The focus trap restores focus to the element that opened it (NFR8) —
    // this happens on close, not on removal, so assert it before the panel
    // is gone rather than racing the ~200ms exit timer.
    await expect(trigger).toBeFocused();
    // Fully removed once the ~200ms exit transition completes.
    await expect(panel).toHaveCount(0, { timeout: 2_000 });
  });

  test('AC12 - closing via Escape and the backdrop both animate out the same way', async ({ page }) => {
    const panel = page.locator('#workbench-nav-drawer');

    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveAttribute('data-drawer-phase', 'closing');
    await expect(panel).toHaveCount(0, { timeout: 2_000 });

    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(panel).toBeVisible();
    await page.locator('[data-testid="workbench-nav-drawer-backdrop"]').click();
    await expect(panel).toHaveAttribute('data-drawer-phase', 'closing');
    await expect(panel).toHaveCount(0, { timeout: 2_000 });
  });
});
