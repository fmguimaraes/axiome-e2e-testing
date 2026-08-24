import { test, expect, type Page } from '@playwright/test';

/**
 * AXI-1335 — Help: Access & Navigation (epic AXI-1332). Manual-E2E
 * §AXI-1332-Help-System.
 *
 * Exercises the help entry points and navigation over the real, bundled help
 * corpus (the AXI-1333 seed docs ship with the frontend — no backend, no seed
 * provisioning, NFR3/FR9). The default project runs authenticated as admin;
 * help is available to any authenticated user, so no workspace is needed.
 *
 * Surfaces (tags: @SI-030 where the app shell/header/router is exercised,
 * @SI-037 for the help unit itself):
 *  - Header entry point → side drawer, page beneath untouched (FR10/FR11/AC4/EC8).
 *  - Keyboard: Escape closes the drawer, focus returns to the invoker (NFR8/AC18).
 *  - Full-page route `/help` browse root grouped by section (FR12/FR16).
 *  - Deep link `/help/{id}#{anchor}` renders the doc and scrolls to the heading
 *    (FR13/AC5), and the drawer + page render the same body (FR19).
 *  - In-doc `doc:` links resolve through the router without a full load (FR17).
 *  - Per-heading copy-link yields an absolute `/help/{id}#{anchor}` URL (FR18/AC6).
 *
 * Seed corpus asserted against (AXI-1333): section 'Getting Started' with the
 * doc `welcome` ("Welcome to Axiome"), whose H2 "How help works" has the
 * build-stable anchor `how-help-works`, and which links to
 * `doc:subject-schema-versioning#what-a-schema-version-is`.
 */

const WELCOME_TITLE = 'Welcome to Axiome';
const WELCOME_HEADING_ANCHOR = 'how-help-works';
// The in-doc `doc:` link welcome → subject-schema-versioning carries this anchor
// (welcome.md: `[schema versioning](doc:subject-schema-versioning#what-a-schema-version-is)`).
const SCHEMA_LINK_ANCHOR = 'what-a-schema-version-is';

/** A stable, always-available authenticated route to open help from. */
const HOST_ROUTE = '/subjects';

async function gotoAuthed(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // The app shell mounts the header (and the help drawer provider) on every
  // authenticated route; wait for the Help entry point rather than networkidle.
  await expect(page.getByRole('button', { name: 'Help' })).toBeVisible();
}

test.describe('AXI-1335 — help access & navigation (FR10-19/NFR8/AC4-6/AC18/EC3/EC8)', () => {
  // ─── Header entry point → drawer, page untouched (FR10/FR11/AC4/EC8) ──
  test('@SI-030 @SI-037 FR10/FR11/AC4 — the header Help button opens a modal drawer without navigating', async ({ page }) => {
    await gotoAuthed(page, HOST_ROUTE);
    const urlBefore = page.url();

    await page.getByRole('button', { name: 'Help' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The browse root renders inside the drawer (FR16), and the URL is unchanged
    // — the drawer overlays the page, it does not navigate (FR11/EC8).
    await expect(dialog.getByText('Getting Started')).toBeVisible();
    expect(page.url()).toBe(urlBefore);
  });

  // ─── Keyboard: Escape closes, focus restored (NFR8/AC18) ─────────────
  test('@SI-030 @SI-037 NFR8/AC18 — Escape closes the drawer and restores focus to the Help button', async ({ page }) => {
    await gotoAuthed(page, HOST_ROUTE);
    const helpButton = page.getByRole('button', { name: 'Help' });
    await helpButton.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(helpButton).toBeFocused();
  });

  // ─── Full-page browse root grouped by section (FR12/FR16) ────────────
  test('@SI-030 @SI-037 FR12/FR16 — /help renders the browse root grouped by section', async ({ page }) => {
    await page.goto('/help');
    const tree = page.getByTestId('help-browse-tree');
    await expect(tree).toBeVisible();
    await expect(tree.getByRole('heading', { name: 'Getting Started' })).toBeVisible();
    await expect(tree.getByRole('button', { name: new RegExp(WELCOME_TITLE) })).toBeVisible();
  });

  // ─── Deep link renders the doc + scrolls to the heading (FR13/AC5) ───
  test('@SI-030 @SI-037 FR13/AC5 — /help/{id}#{anchor} opens the document and scrolls to the heading', async ({ page }) => {
    await page.goto(`/help/welcome#${WELCOME_HEADING_ANCHOR}`);

    await expect(page.getByRole('heading', { name: WELCOME_TITLE, level: 1 })).toBeVisible();
    const heading = page.locator(`#${WELCOME_HEADING_ANCHOR}`);
    await expect(heading).toBeVisible();
    // FR13: the target heading is scrolled into the viewport on open.
    await expect(heading).toBeInViewport();
  });

  // ─── `doc:` link resolves through the router, no full load (FR17) ────
  test('@SI-030 @SI-037 FR17 — an in-doc `doc:` link navigates within the app (no full page load)', async ({ page }) => {
    await page.goto('/help/welcome');
    await expect(page.getByRole('heading', { name: WELCOME_TITLE, level: 1 })).toBeVisible();

    // Prove no full document load happened: tag the current document, click the
    // in-app doc link, and confirm the same document object handled the route.
    await page.evaluate(() => ((window as unknown as { __helpNoReload?: boolean }).__helpNoReload = true));
    const docLink = page.locator('a[data-doc-link="subject-schema-versioning"]').first();
    await expect(docLink).toHaveAttribute('href', new RegExp(`/help/subject-schema-versioning#${SCHEMA_LINK_ANCHOR}`));
    await docLink.click();

    await expect(page).toHaveURL(new RegExp(`/help/subject-schema-versioning#${SCHEMA_LINK_ANCHOR}`));
    const preserved = await page.evaluate(
      () => (window as unknown as { __helpNoReload?: boolean }).__helpNoReload === true,
    );
    expect(preserved, 'a `doc:` link must resolve through the router, not reload the page').toBe(true);

    // Regression (AXI-1335): the anchor the link carried must deep-link scroll the
    // target heading into view on the destination doc — not trip a false EC3
    // "section not found" notice (the bug fired that notice, then never scrolled).
    await expect(page.getByRole('heading', { name: 'What a schema version is' })).toBeVisible();
    const target = page.locator(`#${SCHEMA_LINK_ANCHOR}`);
    await expect(target).toBeVisible();
    await expect(target).toBeInViewport();
    await expect(page.getByTestId('help-anchor-missing')).toHaveCount(0);
  });

  // ─── Copy-link produces an absolute /help/{id}#{anchor} URL (FR18/AC6) ─
  test('@SI-030 @SI-037 FR18/AC6 — a heading copy-link resolves to an absolute /help/{id}#{anchor} URL', async ({ page }) => {
    await page.goto('/help/welcome');
    const copyLink = page.locator(`[data-help-copy-link="${WELCOME_HEADING_ANCHOR}"]`);
    await expect(copyLink).toHaveAttribute('href', `/help/welcome#${WELCOME_HEADING_ANCHOR}`);

    // Following the copy-link lands on the deep link it advertises (AC6 → AC5).
    await copyLink.click();
    await expect(page).toHaveURL(new RegExp(`/help/welcome#${WELCOME_HEADING_ANCHOR}$`));
  });
});
