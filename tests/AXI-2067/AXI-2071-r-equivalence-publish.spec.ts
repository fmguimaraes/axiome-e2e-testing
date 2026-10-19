import { test, expect, type Page } from '@playwright/test';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * AXI-2071 (epic AXI-2067 — FR11, AC5). Scenario doc:
 * `manual-e2e/AXI-2067-Method-R-Equivalence-Statement.md` §AXI-2071, scenarios 1-2.
 *
 * The published EXTERNAL R-equivalence statement is served by `axiome-front` as
 * a static page, keyed by bio-compute build SHA, reached from Help
 * (`src/docs/en/governance-and-provenance/r-equivalence-statement.md`). Nothing
 * here re-implements `publish_release`/`resolve_method_address`
 * (`axiome-bio-compute/scripts/validation/statement/publish.py`, unit-tested
 * there) — only the real app's static serving + the Help link are exercised.
 *
 * @SI-037 @SI-051
 */

const TOUR_IDS = [
  'orientation', 'workspace-data', 'comparability-gate', 'subjects-datasets', 'evidence-decisions',
  'graph-rules', 'help', 'admin', 'charts-views', 'collaboration',
];

/** Sign in as the seeded `user` role and skip every onboarding tour (memory:
 * a fresh user's tour `navigate()`s away from the page under test). */
async function signIn(page: Page): Promise<void> {
  const role = ROLES.find((r) => r.name === 'user')!;
  const api = await page.request;
  const tokens = await ensureAuthTokens(api, role);
  for (const tourId of TOUR_IDS) {
    await api.put(`/api/v1/onboarding-state`, {
      data: { tourId, tourVersion: 1, status: 'skipped', stepIndex: 0 },
    }).catch(() => undefined);
  }
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem('access_token', access as string);
      localStorage.setItem('refresh_token', refresh as string);
    },
    [tokens.accessToken, tokens.refreshToken] as const,
  );
}

interface VersionIndex {
  latest: string | null;
  versions: Record<string, { generated_at: string; methods: Record<string, string> }>;
}

async function fetchIndex(page: Page): Promise<VersionIndex> {
  const res = await page.request.get('/r-equivalence/index.json');
  expect(res.ok(), 'GET /r-equivalence/index.json').toBeTruthy();
  return res.json();
}

test.describe('AXI-2071 — published R-equivalence statement (AC5)', { tag: ['@SI-037', '@SI-051'] }, () => {
  // This spec signs in as the self-registering `user` role itself (via
  // localStorage tokens, like AXI-1901's `signIn`) rather than relying on
  // the `chromium` project's default `admin` storageState from the shared
  // `setup` project.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('AC5: Help links to the current statement, and it opens with a method section', async ({ page }) => {
    await page.goto('/help/governance-and-provenance/r-equivalence-statement');
    await expect(page.getByRole('heading', { name: 'The Method R-Equivalence Statement', level: 1 })).toBeVisible({
      timeout: 20_000,
    });

    const link = page.getByRole('link', { name: 'View the current R-equivalence statement' });
    await expect(link).toHaveAttribute('href', '/r-equivalence/latest/external.html');

    await link.click();
    await page.waitForURL('**/r-equivalence/latest/external.html');

    await expect(page.locator('body')).toContainText('bio-compute build');
    // At least one method section (each heading carries the stable
    // `method_id`-derived anchor id, exporters.method_anchor) — never an
    // exact count this story's published content does not control forever.
    await expect(page.locator('h2[id]').first()).toBeVisible({ timeout: 20_000 });
  });

  test('AC5: an earlier published version stays reachable, with its own release line', async ({ page }) => {
    await page.goto('/help/governance-and-provenance/r-equivalence-statement');
    const index = await fetchIndex(page);
    const latest = index.latest;
    const earlier = Object.keys(index.versions).find((v) => v !== latest);
    test.skip(!latest || !earlier, 'fewer than two published versions — AC5 needs at least two to compare');

    await page.goto(`/r-equivalence/${latest}/external.html`);
    await expect(page.locator('body')).toContainText(`bio-compute build ${latest}`);

    await page.goto(`/r-equivalence/${earlier}/external.html`);
    await expect(page.locator('body')).toContainText(`bio-compute build ${earlier}`);
    await expect(page.locator('body')).not.toContainText(`bio-compute build ${latest}`);
  });
});
