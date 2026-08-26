import { test, expect, type Page } from '@playwright/test';

/**
 * AXI-1357 — Help: Category model & grouped navigation (epic AXI-1353). Manual-E2E
 * §AXI-1353-Help-System-Content.
 *
 * Exercises the category taxonomy laid over the shipped Help System (AXI-1332):
 * addressable category landings, the canonical /help/:category/:slug URL, the
 * legacy /help/:docId redirect, and clickable category headers. Runs against the
 * bundled seed corpus (no backend, FR9), authenticated as admin.
 *
 * Seed corpus (AXI-1357 migration): category `getting-started` holds `welcome` and
 * `platform-structure`; `subjects-and-cohorts` holds `subject-schema-versioning`
 * and `managing-the-subject-schema`; `governance-and-provenance` holds
 * `supersede-not-mutate`.
 *
 * Tags: @SI-037 (help unit) and @SI-030 (app shell / router).
 */

const SCHEMA_ANCHOR = 'what-a-schema-version-is';

async function gotoAuthed(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('button', { name: 'Help' })).toBeVisible();
}

test.describe('AXI-1357 — category model & grouped navigation (FR11-17/AC5-9/AC13/EC7)', () => {
  // ─── Category landing lists the category's docs (FR13/AC5) ────────────
  test('@SI-030 @SI-037 AC5/FR13 — /help/:category renders a category landing listing its documents', async ({ page }) => {
    await page.goto('/help/getting-started');

    const landing = page.getByTestId('help-category-landing');
    await expect(landing).toBeVisible();
    // The getting-started category lists its in-range docs (welcome, platform-structure).
    await expect(landing.locator('[data-help-category-doc="welcome"]')).toBeVisible();
    await expect(landing.locator('[data-help-category-doc="platform-structure"]')).toBeVisible();
  });

  // ─── Legacy /help/:docId redirects to canonical, anchor preserved (FR12/AC6/AC13/EC7) ─
  test('@SI-030 @SI-037 AC13/EC7 — a legacy /help/:docId#anchor link redirects to the canonical category URL and scrolls', async ({ page }) => {
    await page.goto(`/help/subject-schema-versioning#${SCHEMA_ANCHOR}`);

    // The legacy id URL resolves by redirect to the canonical /help/:category/:slug (AC13).
    await expect(page).toHaveURL(
      new RegExp(`/help/subjects-and-cohorts/subject-schema-versioning#${SCHEMA_ANCHOR}$`),
    );
    // The anchor survives the redirect and deep-link scrolls the heading (EC7/AC5).
    await expect(page.getByRole('heading', { name: 'What a schema version is' })).toBeVisible();
    const target = page.locator(`#${SCHEMA_ANCHOR}`);
    await expect(target).toBeInViewport();
    await expect(page.getByTestId('help-anchor-missing')).toHaveCount(0);
  });

  // ─── Category header navigates to the landing (FR14/AC7) ──────────────
  test('@SI-030 @SI-037 AC7/FR14 — a category header in the browse tree navigates to the category landing', async ({ page }) => {
    await gotoAuthed(page, '/help');
    const tree = page.getByTestId('help-browse-tree');
    await expect(tree).toBeVisible();

    await tree.locator('[data-help-browse-category="subjects-and-cohorts"]').click();

    await expect(page).toHaveURL(/\/help\/subjects-and-cohorts$/);
    await expect(page.getByTestId('help-category-landing')).toBeVisible();
    await expect(
      page.locator('[data-help-category-doc="subject-schema-versioning"]'),
    ).toBeVisible();
  });

  // ─── Canonical URL renders the document (FR11) ────────────────────────
  test('@SI-030 @SI-037 FR11 — the canonical /help/:category/:slug URL renders the document', async ({ page }) => {
    await page.goto('/help/governance-and-provenance/supersede-not-mutate');
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('help-doc-not-found')).toHaveCount(0);
  });
});
