import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';
import { ROLES } from '../../config/roles';

/**
 * AXI-1885 (epic AXI-1883 UI/UX Hardening) — Top-menu and page stability
 * crash fixes (FR4, FR10, NFR2, AC2, AC5).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md`, AXI-1885
 * section, scenarios 3.1-3.2. (Scenario 3.3 / FR5 is `manual` there — it needs
 * a dataset with a genuinely missing source file, not creatable via the REST
 * API; its root cause and fix are pinned by `UT-DS-QCOL-014`/`-015` in
 * `axiome-back/UT.md` and `UT-FE-GRAPH-1900..1902` in `axiome-front/UT.md`.)
 * Tags: @SI-030, @SI-031.
 *
 * Root cause: the top-menu's `organizations` list is one paginated page; the
 * "validate stored org" effect treated absence from that page as proof an
 * active org id was stale and cleared it, while `useSyncScopeFromUrl`
 * re-set the SAME id from the URL every render — an infinite
 * `setActiveOrganizationId` loop ("Maximum update depth exceeded"). The local
 * stack already holds 100+ organizations, so a freshly created one reliably
 * lands off the first page and reproduces the trigger with no special
 * fixture.
 */

const admin = ROLES.find((r) => r.name === 'admin')!;

async function createOffPageOrg(api: APIRequestContext, name: string): Promise<string> {
  const login = await api.post(`${API_BASE_URL}/api/v1/auth/login`, {
    data: { email: admin.email, password: admin.password },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const { accessToken } = await login.json();

  const created = await api.post(`${API_BASE_URL}/api/v1/organizations`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { name, type: 'biotech' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  return (await created.json()).id as string;
}

/** Collects console errors matching React's update-depth message. */
function trackUpdateDepthErrors(page: Page): string[] {
  const hits: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Maximum update depth exceeded/i.test(msg.text())) {
      hits.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    if (/Maximum update depth exceeded/i.test(err.message)) {
      hits.push(err.message);
    }
  });
  return hits;
}

test.describe('AXI-1885 - Top-menu and page stability crash fixes @SI-030 @SI-031', () => {
  test.describe.configure({ timeout: 60_000 });

  let api: APIRequestContext;
  let orgId: string;
  let orgName: string;

  test.beforeAll(async () => {
    api = await request.newContext();
    orgName = `AXI-1885 Off-Page Probe ${Date.now().toString(36)}`;
    orgId = await createOffPageOrg(api, orgName);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('FR4/NFR2/AC2 - /organizations/:id renders a page off the first (paginated) page with no update-depth crash', async ({ page }) => {
    const updateDepthHits = trackUpdateDepthErrors(page);

    await page.goto(`/organizations/${orgId}`);

    await expect(page.getByRole('heading', { name: orgName, level: 1 })).toBeVisible();
    await expect(page.getByText('Organization Not Found')).toHaveCount(0);
    expect(updateDepthHits).toEqual([]);
  });

  test('FR10/AC5 - "Add user" on an off-page organization renders and completes without an uncaught error', async ({ page }) => {
    const updateDepthHits = trackUpdateDepthErrors(page);

    await page.goto(`/organizations/${orgId}/add-user`);

    await expect(page.getByText('Organization Not Found')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Add User', level: 1 })).toBeVisible();
    await expect(page.getByRole('main').getByText(orgName, { exact: true })).toBeVisible();

    const addButton = page.getByRole('button', { name: 'Add User' });
    const firstUserCard = page
      .locator('div.space-y-2.max-h-\\[400px\\] button')
      .first();

    // The onboarding "Resume tour" dialog can float over the form; it is never
    // part of this story's own content. It must be DISMISSED ("Not now"), never
    // its "Resume" button (the first button in the dialog) — clicking Resume
    // STARTS the tour, which navigates the page away on its own. A normal
    // Playwright click can be retried indefinitely against its occlusion, so
    // this is a direct DOM click (bypassing the pointer-event interception
    // check) targeting the "Not now" button by its exact text.
    await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Resume tour"]');
      const buttons = Array.from(dialog?.querySelectorAll('button') ?? []);
      const dismissButton = buttons.find((b) => b.textContent?.trim() === 'Not now');
      (dismissButton as HTMLButtonElement | undefined)?.click();
    });

    // The seeded fixture pool may or may not have an available user to add;
    // either way, no uncaught error/crash must occur navigating this page.
    if (await firstUserCard.count()) {
      await page.evaluate(() => {
        const cards = document.querySelectorAll<HTMLButtonElement>(
          'div.space-y-2.max-h-\\[400px\\] button',
        );
        cards[0]?.click();
      });
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
        buttons.find((b) => b.textContent?.trim() === 'Add User')?.click();
      });
      await expect(page).toHaveURL(new RegExp(`/organizations/${orgId}$`));
    }

    expect(updateDepthHits).toEqual([]);
  });
});
