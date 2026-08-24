import { test, expect, type Page } from '@playwright/test';

/**
 * AXI-1337 — Help: Context Binding (epic AXI-1332). Manual-E2E
 * §AXI-1332-Help-System (context scenarios).
 *
 * Exercises the context-anchor path over the real, bundled help corpus (the
 * AXI-1333 seed docs ship with the frontend — no backend, no seed provisioning,
 * FR9). A `<HelpAnchor>` on the Subject Schema editor binds that screen to the
 * context key `subjects.schema.editor`, which exactly one seed doc declares
 * (`subject-schema-versioning`, context: [subjects.schema.editor]). Per FR29/AC10
 * a single declaring document opens directly — no intermediate list.
 *
 * The multi-match list path (FR29/EC6) is not exercisable against the real corpus
 * (only one doc declares the key); it is covered headless by UT-FE-HELP-096/098.
 *
 * Tag @SI-037 (the help unit); the drawer store + anchor are help-owned. The
 * default project runs authenticated as admin, which holds subject:read.
 */

const HOST_ROUTE = '/subjects/schema';
const CONTEXT_KEY = 'subjects.schema.editor';
const DOC_TITLE = 'Subject schema versioning';

async function gotoSchemaEditor(page: Page): Promise<void> {
  await page.goto(HOST_ROUTE);
  // The context anchor renders in the page header once the screen mounts; wait on
  // it rather than networkidle.
  await expect(page.locator(`[data-help-anchor="${CONTEXT_KEY}"]`)).toBeVisible();
}

test.describe('AXI-1337 — help context binding (FR27-31/AC10/EC6)', () => {
  // ─── The context anchor is present on the bound screen (FR27/FR28) ────
  test('@SI-037 FR27/FR28 — the Subject Schema editor carries a context help anchor', async ({ page }) => {
    await gotoSchemaEditor(page);
    const anchor = page.locator(`[data-help-anchor="${CONTEXT_KEY}"]`);
    await expect(anchor).toBeVisible();
    await expect(anchor).toHaveAttribute('aria-label', /help/i);
  });

  // ─── Single declaring doc opens directly, no intermediate list (AC10) ─
  test('@SI-037 FR29/AC10 — a context anchor with one declaring doc opens it directly, no list', async ({ page }) => {
    await gotoSchemaEditor(page);
    const urlBefore = page.url();

    await page.locator(`[data-help-anchor="${CONTEXT_KEY}"]`).click();

    // The drawer opens over the page (FR11/EC8: URL unchanged, page not navigated).
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(page.url()).toBe(urlBefore);

    // AC10: the single declaring document renders directly — its H1 is shown and
    // no context-selection list is presented.
    await expect(dialog.getByRole('heading', { name: DOC_TITLE, level: 1 })).toBeVisible();
    await expect(page.getByTestId('help-context-list')).toHaveCount(0);
  });

  // ─── Closing the context drawer restores focus to the anchor (NFR8) ───
  test('@SI-037 NFR8 — Escape closes the context drawer and restores focus to the anchor', async ({ page }) => {
    await gotoSchemaEditor(page);
    const anchor = page.locator(`[data-help-anchor="${CONTEXT_KEY}"]`);
    await anchor.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(anchor).toBeFocused();
  });
});
