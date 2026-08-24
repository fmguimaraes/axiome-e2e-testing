import { test, expect, type Page } from '@playwright/test';
import { storageStateFor } from '../../config/roles';

/**
 * AXI-1339 — Help: Capability Gating & Permissions (epic AXI-1332). Manual-E2E
 * §AXI-1332-Help-System §15 (capability-gating scenarios).
 *
 * A document may declare `capabilities` in its frontmatter; it is visible only to
 * a user holding ALL of them (FR45), with an admin bypass. A user who may not see
 * a document finds no trace of it in navigation, search or context lists, and a
 * direct link resolves to a title-safe generic not-found (FR46/AC13/EC4). This
 * story adds one gated seed doc making the scenarios reachable over the real,
 * bundled corpus (no backend — FR9):
 *   • `en/subjects/managing-the-subject-schema.md` — `capabilities:
 *     [subject:schema_manage]`, also bound to the `subjects.schema.editor` context.
 *
 * Auth model (AXI-1264): the default `chromium` project runs as `admin`, who
 * BYPASSES the gate — so the admin leg proves the doc exists and the bypass works.
 * The deny leg re-uses the `user` role (a self-registered client with no workspace
 * role → holds no capability → deny-by-default), which is the "lacking user".
 *
 * Tag @SI-037 (the help unit); @SI-030 where the app shell / auth+role read is
 * exercised. Assertions are web-first (no sleeps).
 */

const GATED_ID = 'managing-the-subject-schema';
const GATED_TITLE = 'Managing the subject schema';
const OPEN_ID = 'subject-schema-versioning';

async function gotoAuthed(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('button', { name: 'Help' })).toBeVisible();
}

/** Open the search palette with the global shortcut (FR24) and return it. */
async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('help-search');
  await expect(palette).toBeVisible();
  return palette;
}

test.describe('AXI-1339 — capability gating @SI-037 @SI-030', () => {
  // ── Admin bypass: the gate never hides a doc from an admin (FR45). ──────────
  test.describe('as an admin (bypasses the gate)', () => {
    test('@SI-037 FR45 — the gated doc is reachable in browse and by direct link', async ({ page }) => {
      await gotoAuthed(page, '/help');
      await expect(page.getByTestId('help-browse-tree')).toBeVisible();
      // The admin sees the gated doc in the Subjects browse group.
      await expect(page.locator(`[data-help-browse-doc="${GATED_ID}"]`)).toBeVisible();

      // A direct link renders the document (its title is disclosed to the admin).
      await page.goto(`/help/${GATED_ID}`);
      await expect(page.getByRole('heading', { level: 1, name: GATED_TITLE })).toBeVisible();
      await expect(page.getByTestId('help-doc-not-found')).toHaveCount(0);
    });

    test('@SI-037 FR45 — the gated doc surfaces in search for an admin', async ({ page }) => {
      await gotoAuthed(page, '/subjects');
      const palette = await openPalette(page);
      await palette.getByTestId('help-search-input').fill('Managing subject schema');
      await expect(page.getByTestId('help-search-results')).toContainText(GATED_TITLE);
    });
  });

  // ── Deny-by-default: a lacking user sees no trace of the gated doc (AC13). ──
  test.describe('as a lacking user (no capability)', () => {
    test.use({ storageState: storageStateFor('user') });

    test('@SI-030 AC13/FR45 — the gated doc is absent from the browse tree', async ({ page }) => {
      await gotoAuthed(page, '/help');
      await expect(page.getByTestId('help-browse-tree')).toBeVisible();
      // The ungated sibling is visible; the gated doc leaves no nav entry.
      await expect(page.locator(`[data-help-browse-doc="${OPEN_ID}"]`)).toBeVisible();
      await expect(page.locator(`[data-help-browse-doc="${GATED_ID}"]`)).toHaveCount(0);
    });

    test('@SI-030 AC13/EC4 — a search matching the gated doc discloses nothing', async ({ page }) => {
      await gotoAuthed(page, '/subjects');
      const palette = await openPalette(page);
      await palette.getByTestId('help-search-input').fill('Managing subject schema');
      // No result row may carry the gated title — no count, title or excerpt leaks.
      await expect(page.getByTestId('help-search')).not.toContainText(GATED_TITLE);
    });

    test('@SI-030 AC13/FR46 — a direct link returns a title-safe not-found', async ({ page }) => {
      await page.goto(`/help/${GATED_ID}`);
      await expect(page.getByTestId('help-doc-not-found')).toBeVisible();
      // The generic state must not disclose the document title.
      await expect(page.locator('h1', { hasText: GATED_TITLE })).toHaveCount(0);
    });
  });
});
