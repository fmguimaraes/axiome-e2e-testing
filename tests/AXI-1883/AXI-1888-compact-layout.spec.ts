import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ROLES } from '../../config/roles';
import { ensureAuthTokens } from '../../config/auth';

/**
 * AXI-1888 — Compact layout for workspace-members and projects (epic AXI-1883).
 * Scenarios §1.1–§1.4 of
 * `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md`.
 *
 * ── Fixture note ──────────────────────────────────────────────────────────
 * Self-provisions a fresh organization + workspace + one project through the
 * public API (same convention as `tests/AXI-1518/harness/prompt-library-
 * fixtures.ts`), then seeds the browser session's `localStorage` directly
 * (`axiome-top-org`/`axiome-active-workspace`) rather than driving the
 * top-menu org/workspace comboboxes. The shared `organizations`/`workspaces`
 * list widgets those comboboxes read from page at a low default limit
 * (`GET /organizations`/`GET /workspaces` default to `limit=20`, sorted
 * newest-first) and a freshly-created record can age off page 1 by the time
 * a later navigation re-fetches it, at which point `TopMenu.tsx`'s own
 * clear-effect (`activeOrganizations.length > 0 && !find(...)` →
 * `setActiveOrganizationId(null)`) wipes the selection out from under the
 * test — a pre-existing gap tracked under the epic's FR4/FR5/NFR2, not this
 * story's FR11/NFR6. Seeding `localStorage` directly (the chromium
 * project's default `storageState` already authenticates as
 * `test@axiomebio.com` per AXI-1895 — `config/roles.ts`'s `admin` role) reads
 * the two pages under test, `Members.tsx`/`Projects.tsx`, which trust the
 * `topMenuStore` the same way the combobox does, without depending on that
 * separate widget's pagination.
 */

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

/**
 * ── Finding, out of this story's scope ───────────────────────────────────
 * The shared shell's top bar (`Layout.tsx`/`TopMenu.tsx`, SI-030) does not
 * itself go responsive at phone width: its org/workspace/project selector
 * row and its right-side icon cluster (notifications/help/theme/avatar)
 * neither wrap nor shrink, so the row's intrinsic width (~540-650px, timing-
 * dependent on which async bits — notification counts, the account menu —
 * have mounted) exceeds a 375px viewport and the WHOLE DOCUMENT grows a
 * horizontal scrollbar regardless of what any individual page renders below
 * it. This is pre-existing and platform-wide: `/datasets` itself — the very
 * page NFR6/AC6 point at as the compact-layout reference — overflows the
 * same way at the same width (confirmed by hand against this worktree's
 * front-end; not a regression introduced by Members.tsx/Projects.tsx). It is
 * owned by SI-030 (`Layout.tsx`/`TopMenu.tsx`), outside this story's
 * declared SI-031 ownership boundary, and is reported to the lead rather
 * than patched here.
 *
 * Given that, `document.documentElement.scrollWidth` cannot be a meaningful
 * pass/fail signal for THIS story's diff — it would fail identically on
 * `/datasets`, which this story does not touch. The two helpers below scope
 * NFR6's "no horizontal page scroll" / "16px gutter" checks to the page
 * CONTENT region this story owns (the `div.px-4 …` wrapper `Members.tsx`/
 * `Projects.tsx` render below the shared breadcrumb bar), which is exactly
 * what this story's diff changed and can be held accountable for.
 */
/**
 * Reads the content root's own `scrollWidth`/`clientWidth` rather than
 * scanning descendant `getBoundingClientRect()`s. A naive descendant scan
 * false-positives on the `DataTable` component's own
 * `overflow-hidden > overflow-x-auto > table` wrapper (`src/components/
 * DataTable.tsx`): the `<table>` element's natural multi-column width (e.g.
 * 972px for Members' 7 columns at a 375px viewport) reports a raw bounding
 * rect past the viewport edge even though it is clipped and only
 * internally/locally scrollable inside its own `overflow-x-auto` ancestor —
 * exactly the same internal-table-scroll pattern `/datasets` already uses
 * (NFR6 governs *page* scroll, not a deliberately-scrollable table). The
 * content root `div` itself does not set `overflow`, so its own
 * `scrollWidth` is NOT inflated by an `overflow-x-auto` descendant's
 * clipped content (confirmed: `root.scrollWidth === root.clientWidth ===
 * 375` on this page even though the table inside measures 972px) — this is
 * the correct, false-positive-free signal for "did THIS story's content
 * region itself grow page-level scroll."
 */
async function contentOverflowPx(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.querySelector('h1')?.closest('div[class*="px-4"]') as HTMLElement | null;
    if (!root) return 0;
    return Math.max(0, root.scrollWidth - root.clientWidth);
  });
}

async function contentGutterPx(page: import('@playwright/test').Page): Promise<number | null> {
  return page.evaluate(() => {
    const wrapper = document.querySelector('h1')?.closest('div[class*="px-4"]') as HTMLElement | null;
    if (!wrapper) return null;
    return parseFloat(getComputedStyle(wrapper).paddingLeft);
  });
}

interface Fixture {
  api: APIRequestContext;
  orgId: string;
  workspaceId: string;
  projectId: string;
}

async function adminApi(): Promise<APIRequestContext> {
  const bootstrap = await apiRequest.newContext();
  const role = ROLES.find((r) => r.name === 'admin');
  if (!role) throw new Error('admin role not configured');
  const tokens = await ensureAuthTokens(bootstrap, role);
  await bootstrap.dispose();
  return apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
}

async function provisionFixture(): Promise<Fixture> {
  const api = await adminApi();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const orgRes = await api.post(apiUrl('/api/v1/organizations'), {
    data: { name: `AXI-1888 Compact Layout Org ${stamp}`, type: 'biotech' },
  });
  if (!orgRes.ok()) throw new Error(`create organization failed (${orgRes.status()}): ${await orgRes.text()}`);
  const org = await orgRes.json();

  const wsRes = await api.post(apiUrl('/api/v1/workspaces'), {
    data: {
      name: `AXI-1888 Compact Layout WS ${stamp}`,
      type: 'internal',
      ownerOrganizationId: org.id,
      description: 'AXI-1888 compact-layout E2E fixture',
    },
  });
  if (!wsRes.ok()) throw new Error(`create workspace failed (${wsRes.status()}): ${await wsRes.text()}`);
  const ws = await wsRes.json();

  const projRes = await api.post(apiUrl('/api/v1/projects'), {
    data: { name: `AXI-1888 Compact Layout Project ${stamp}`, workspaceId: ws.id },
    headers: { 'X-Workspace-Id': ws.id },
  });
  if (!projRes.ok()) throw new Error(`create project failed (${projRes.status()}): ${await projRes.text()}`);
  const proj = await projRes.json();

  return { api, orgId: org.id, workspaceId: ws.id, projectId: proj.id };
}

test.describe.serial('AXI-1888 — Compact layout for workspace-members and projects (AXI-1883 §1.1-§1.4)', () => {
  let fx: Fixture;

  test.beforeAll(async () => {
    fx = await provisionFixture();
  });

  test.afterAll(async () => {
    await fx.api.dispose();
  });

  /** Seeds the active org/workspace scope the app reads from `topMenuStore`,
   *  leaving the chromium project's own `storageState` auth tokens intact. */
  async function seedScope(page: import('@playwright/test').Page): Promise<void> {
    await page.addInitScript(
      ([org, ws]) => {
        localStorage.setItem('axiome-top-org', org);
        localStorage.setItem('axiome-active-workspace', ws);
      },
      [fx.orgId, fx.workspaceId] as const,
    );
  }

  test('Scenario 1.1 — /workspace-members matches the /datasets compact layout at desktop width (AC6)', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await seedScope(page);
    await page.goto('/workspace-members');

    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    // Dense table: the same `DataTable` component family /datasets, /projects
    // and /workspace-members all share renders at `text-[13px]`.
    const table = page.locator('table');
    await expect(table).toHaveClass(/text-\[13px\]/);
    await expect(page.getByRole('columnheader', { name: 'Member' })).toBeVisible();
    await expect(page.getByText('test@axiomebio.com', { exact: false })).toBeVisible();
  });

  test('Scenario 1.2 — /projects matches the /datasets compact layout at desktop width (AC6)', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await seedScope(page);
    await page.goto('/projects');

    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    const table = page.locator('table');
    await expect(table).toHaveClass(/text-\[13px\]/);
    await expect(page.getByRole('columnheader', { name: 'Project' })).toBeVisible();
    await expect(page.getByRole('cell', { name: /AXI-1888 Compact Layout Project/ }).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Scenario 1.3 — /workspace-members keeps a 16px gutter and no content-level horizontal scroll at phone width (AC6, NFR6)', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await seedScope(page);
    await page.goto('/workspace-members');

    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    const overflow = await contentOverflowPx(page);
    expect(overflow).toBeLessThanOrEqual(0);

    const gutter = await contentGutterPx(page);
    expect(gutter).toBe(16);
  });

  test('Scenario 1.4 — /projects keeps a 16px gutter and no content-level horizontal scroll at phone width (AC6, NFR6)', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await seedScope(page);
    await page.goto('/projects');

    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    const overflow = await contentOverflowPx(page);
    expect(overflow).toBeLessThanOrEqual(0);

    const gutter = await contentGutterPx(page);
    expect(gutter).toBe(16);
  });
});
