import { test, expect, type Page } from '@playwright/test';

/**
 * AXI-1336 — Help: Client-side Search (epic AXI-1332). Manual-E2E
 * §AXI-1332-Help-System §12.
 *
 * Exercises the global search command palette (Cmd/Ctrl-K, FR24) over the real,
 * bundled help corpus (the AXI-1333 seed docs ship with the frontend — no
 * backend, no seed provisioning, FR9/FR23). The default project runs
 * authenticated as admin; help is available to any authenticated user.
 *
 * Tags: @SI-037 (the help/search unit) and @SI-030 (the global hotkey + app
 * shell mount reachable from any authenticated route).
 *
 * Seed corpus asserted against (AXI-1333):
 *  - `welcome` — "Welcome to Axiome"; body contains the word "drifting"
 *    ("keeps it from drifting") which appears in NO other field or document, so
 *    it is a pure body-only search term (AC7). Its body also mentions "schema".
 *  - `subject-schema-versioning` — "Subject schema versioning"; carries "schema"
 *    in its TITLE, so a search for "schema" must outrank the body-only match in
 *    `welcome` (AC8).
 *
 * NOTE: like AXI-1335, the integrated headless run is a Workflow 5 step — the
 * specs need a frontend built from the AXI-1336 branch (the standing local stack
 * serves `main`, which has the AXI-1335 help UI but not this story's palette
 * until it merges). This suite is authored against the real rendered DOM and
 * type-checks clean.
 */

const WELCOME_TITLE = 'Welcome to Axiome';
const SCHEMA_TITLE = 'Subject schema versioning';
/** A term present ONLY in the `welcome` document body (AC7). */
const BODY_ONLY_TERM = 'drifting';
/** A term in one doc's title and another's body — ranking probe (AC8). */
const SHARED_TERM = 'schema';

/** A stable, always-available authenticated route to open help from. */
const HOST_ROUTE = '/subjects';

async function gotoAuthed(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // The app shell mounts the header, the help drawer, and the search palette on
  // every authenticated route; wait for the Help entry point before proceeding.
  await expect(page.getByRole('button', { name: 'Help' })).toBeVisible();
}

/** Open the palette with the global keyboard shortcut (FR24). */
async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('help-search');
  await expect(palette).toBeVisible();
  await expect(palette).toHaveAttribute('aria-modal', 'true');
  return palette;
}

test.describe('AXI-1336 — help client-side search (FR20-26/NFR3/AC7-9/AC16/AC18)', () => {
  // ─── Cmd/Ctrl-K opens the palette from anywhere (FR24) ───────────────
  test('@SI-030 @SI-037 FR24 — Cmd/Ctrl-K opens the search palette from an app route', async ({ page }) => {
    await gotoAuthed(page, HOST_ROUTE);
    const urlBefore = page.url();

    const palette = await openPalette(page);

    // The input is focused and empty on open (FR25/AC9), and no navigation happened.
    const input = palette.getByTestId('help-search-input');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    expect(page.url()).toBe(urlBefore);
  });

  // ─── Title match outranks a body-only match (AC8) ────────────────────
  test('@SI-037 AC8 — a title match ranks above a body-only match', async ({ page }) => {
    await gotoAuthed(page, HOST_ROUTE);
    const palette = await openPalette(page);
    await palette.getByTestId('help-search-input').fill(SHARED_TERM);

    const results = palette.getByTestId('help-search-result');
    await expect(results.first()).toBeVisible();
    // subject-schema-versioning ("schema" in the title) must be first, above
    // welcome ("schema" only in the body).
    await expect(results.first()).toHaveAttribute('data-doc-id', 'subject-schema-versioning');
    const ids = await results.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-doc-id')),
    );
    expect(ids).toContain('welcome');
    expect(ids.indexOf('subject-schema-versioning')).toBeLessThan(ids.indexOf('welcome'));
  });

  // ─── A body-only term returns the doc with a highlighted excerpt (AC7) ─
  test('@SI-037 AC7 — a term only in a body returns the doc with the passage as the excerpt', async ({ page }) => {
    await gotoAuthed(page, HOST_ROUTE);
    const palette = await openPalette(page);
    await palette.getByTestId('help-search-input').fill(BODY_ONLY_TERM);

    const result = palette.getByTestId('help-search-result').filter({ hasText: WELCOME_TITLE });
    await expect(result).toBeVisible();
    // The excerpt shows the matched passage with the term highlighted (<mark>).
    await expect(result.locator('mark')).toContainText(new RegExp(BODY_ONLY_TERM, 'i'));
    await expect(result).toContainText(new RegExp(BODY_ONLY_TERM, 'i'));
  });

  // ─── Keyboard: arrow-nav + Enter opens the result in the drawer (FR24/AC18) ─
  test('@SI-030 @SI-037 FR24/AC18 — arrow keys + Enter open the selected result', async ({ page }) => {
    await gotoAuthed(page, HOST_ROUTE);
    const palette = await openPalette(page);
    const input = palette.getByTestId('help-search-input');
    await input.fill(SHARED_TERM);
    await expect(palette.getByTestId('help-search-result').first()).toBeVisible();

    await input.press('ArrowDown');
    await input.press('Enter');

    // The palette closes and the selected document opens in the help drawer.
    await expect(page.getByTestId('help-search')).toBeHidden();
    const drawer = page.getByTestId('help-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { name: SCHEMA_TITLE, level: 1 })).toBeVisible();
  });

  // ─── No results offers the browse tree (FR26) ────────────────────────
  test('@SI-037 FR26 — a no-results query offers the browse tree as a fallback', async ({ page }) => {
    await gotoAuthed(page, HOST_ROUTE);
    const palette = await openPalette(page);
    await palette.getByTestId('help-search-input').fill('zzzznomatchqxq');

    const noResults = palette.getByTestId('help-search-no-results');
    await expect(noResults).toBeVisible();
    await palette.getByTestId('help-search-browse').click();

    // The palette closes and the help drawer opens at the browse root.
    await expect(page.getByTestId('help-search')).toBeHidden();
    const drawer = page.getByTestId('help-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Getting Started')).toBeVisible();
  });

  // ─── No history: empty on reopen, nothing persisted (FR25/AC9) ───────
  test('@SI-037 AC9 — closing and reopening shows an empty input; nothing is persisted', async ({ page }) => {
    await gotoAuthed(page, HOST_ROUTE);
    const palette = await openPalette(page);
    await palette.getByTestId('help-search-input').fill(SHARED_TERM);
    await expect(palette.getByTestId('help-search-result').first()).toBeVisible();

    // Close (Escape) and reopen.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('help-search')).toBeHidden();
    const reopened = await openPalette(page);

    // The input is empty — no prior query (AC9).
    await expect(reopened.getByTestId('help-search-input')).toHaveValue('');
    // No query is written to the URL or browser storage (FR25/AC9).
    expect(page.url()).not.toContain(SHARED_TERM);
    const storage = await page.evaluate(() => ({
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
    }));
    const serialized = JSON.stringify(storage).toLowerCase();
    expect(serialized).not.toContain(SHARED_TERM);
  });

  // ─── Network inspection: only the app's own origin (AC16) ────────────
  test('@SI-037 AC16 — a full search session issues requests only to the app origin', async ({ page }) => {
    const foreign: string[] = [];
    const appOrigin = new URL(page.url() || 'http://localhost').origin;
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return;
      if (new URL(url).origin !== appOrigin) foreign.push(url);
    });

    await gotoAuthed(page, HOST_ROUTE);
    const origin = new URL(page.url()).origin;
    // Re-baseline origin now that we are on the authed route.
    foreign.length = 0;

    const palette = await openPalette(page);
    await palette.getByTestId('help-search-input').fill(SHARED_TERM);
    await expect(palette.getByTestId('help-search-result').first()).toBeVisible();

    // Open every seed document from search in turn (the corpus ships three docs;
    // AC16's "five documents" is corpus-bounded — the invariant is same-origin).
    for (const docId of ['subject-schema-versioning', 'welcome', 'supersede-not-mutate']) {
      await palette.getByTestId('help-search-input').fill(docId.split('-')[0]);
      const hit = palette.locator(`[data-testid="help-search-result"][data-doc-id="${docId}"]`);
      if (await hit.count()) {
        await hit.first().click();
        await expect(page.getByTestId('help-drawer')).toBeVisible();
        await page.keyboard.press('Escape');
        await openPalette(page);
      }
    }

    const offOrigin = foreign.filter((u) => new URL(u).origin !== origin);
    expect(offOrigin, `off-origin requests during help search: ${offOrigin.join(', ')}`).toEqual([]);
  });
});
