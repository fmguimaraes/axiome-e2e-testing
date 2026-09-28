import { test, expect } from '@playwright/test';

/**
 * AXI-1777 (epic AXI-1776) — the collapsed sidebar rail shows a RENDERED
 * flyout instead of the browser's native `title` tooltip, and the icon-only
 * rail links keep an accessible name now that `title` is gone.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1776-Application-Shell-Navigation.md` §4.1–4.3.
 * Tag: @SI-030.
 *
 * FRONT-ONLY — no backend state, no seed, no fixture. It needs a signed-in
 * session (the config's admin storageState) purely so the shell renders.
 *
 * Placement MATHS are deliberately not asserted here: they are unit-tested
 * against the pure flyoutPosition() as UT-FE-SHELL-1777-01..05. Asserting
 * coordinates in a browser would pin the implementation, not the behaviour.
 *
 * §4.2 is the regression guard for the defect the AXI-1777 review gate
 * caught: the accessible name was on a generic <div> nested INSIDE the
 * <Link>. A name on a nested wrapper is not reliably announced, and onFocus
 * on that div never fires, because focus lands on the link and does not
 * propagate down to it. Both are why §4.2 and §4.3 assert on the LINK.
 */

const RAIL_WIDTH_PX = 56;

/** Collapse the sidebar and return the first collapsed nav link. */
async function collapsedRail(page: import('@playwright/test').Page) {
  await page.goto('/');
  // The desktop sidebar is the only <aside>; it carries no testid of its own.
  const sidebar = page.locator('aside').first();
  await expect(sidebar).toBeVisible();

  const box = await sidebar.boundingBox();
  if (!box || box.width > RAIL_WIDTH_PX + 8) {
    await page.getByRole('button', { name: 'Collapse' }).click();
  }
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThanOrEqual(RAIL_WIDTH_PX + 8);
  return sidebar.locator('a[aria-label]').first();
}

test.describe('AXI-1777 - the collapsed rail flyout', { tag: ['@SI-030'] }, () => {
  test('AC1 - hovering a collapsed nav item shows a rendered flyout carrying its name @SI-030', async ({ page }) => {
    const link = await collapsedRail(page);
    const name = await link.getAttribute('aria-label');
    expect(name, 'the collapsed rail link must carry a name to show').toBeTruthy();

    await expect(page.getByTestId('sidebar-flyout')).toHaveCount(0);
    await link.hover();

    const flyout = page.getByTestId('sidebar-flyout');
    await expect(flyout).toBeVisible();
    await expect(flyout).toHaveText(name!);
  });

  test('AC1 - the native title tooltip is gone from the rail, not merely covered @SI-030', async ({ page }) => {
    await collapsedRail(page);
    const sidebar = page.locator('aside').first();
    // A leftover `title` would still pop the small native tooltip on hover.
    await expect(sidebar.locator('[title]')).toHaveCount(0);
  });

  test('AC1 - the flyout closes when the pointer leaves @SI-030', async ({ page }) => {
    const link = await collapsedRail(page);
    await link.hover();
    await expect(page.getByTestId('sidebar-flyout')).toBeVisible();

    await page.mouse.move(600, 400);
    await expect(page.getByTestId('sidebar-flyout')).toHaveCount(0);
  });

  test('AC2 - the accessible name is on the LINK, not a nested wrapper @SI-030', async ({ page }) => {
    const link = await collapsedRail(page);
    const name = await link.getAttribute('aria-label');

    // The focusable element itself must resolve to that name.
    await expect(page.getByRole('link', { name: name! })).toBeVisible();
    // ...and the inner div must NOT be the one carrying it.
    await expect(link.locator('div[aria-label]')).toHaveCount(0);

    // Stronger: EVERY link on the collapsed rail must be named. Asserting only on
    // `a[aria-label]` would silently skip a link that lost its name, which is the
    // exact defect — a nav item whose name moved to a nested div drops out of that
    // selector instead of failing.
    const nav = page.locator('aside').first().locator('nav');
    await expect(nav.locator('a:not([aria-label])')).toHaveCount(0);
  });

  test('AC2 - keyboard focus opens the flyout, like hover @SI-030', async ({ page }) => {
    const link = await collapsedRail(page);
    await expect(page.getByTestId('sidebar-flyout')).toHaveCount(0);

    await link.focus();
    await expect(page.getByTestId('sidebar-flyout')).toBeVisible();

    await page.locator('body').click({ position: { x: 600, y: 400 } });
    await expect(page.getByTestId('sidebar-flyout')).toHaveCount(0);
  });
});
