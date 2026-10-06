import { test, expect, Page, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, workspaceHeader, type Api } from '../AXI-1400/harness/api';

/**
 * AXI-1889 — Guided-analysis polish (epic AXI-1883 UI/UX Hardening).
 * Covers FR12–FR15 / AC7–AC9.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1883-UI-UX-Hardening.md` §4.1–4.4.
 * Tags: @SI-046 (prompt CRUD page, page header), @SI-030 (nav: useNavItems).
 *
 * Nothing here calls `POST /guided-analysis/plan` — the prompt library's own
 * CRUD routes are plain CRUD (no LLM involved), and the nav/header checks are
 * front-only. No live-LLM gate needed in this file.
 */

const RUN_TAG = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
const NAMES = {
  org: `AXI-1889 E2E Org ${RUN_TAG}`,
  workspace: `AXI-1889 E2E Workspace ${RUN_TAG}`,
  project: `AXI-1889 E2E Project ${RUN_TAG}`,
};

interface Tenant {
  orgId: string;
  workspaceId: string;
  projectId: string;
  headers: Record<string, string>;
}

/**
 * Always-fresh tenant, never reuse-by-name. `TopMenu`'s org dropdown fetches
 * organizations with no `limit` override (the gateway default page size) and
 * the local stack has accumulated 100+ orgs from prior E2E runs; an org
 * reused from an old run can sit outside that page, which trips `TopMenu`'s
 * "stale org — not in the fetched list — clear it" effect (`TopMenu.tsx`
 * lines 83-87) and silently wipes the workspace/project this spec just
 * seeded. A uniquely-named, just-created org is always the newest row, so it
 * is always on page one. `TopMenu.tsx`/`topMenuStore.ts` are out of this
 * story's ownership boundary — worked around here, not fixed there.
 */
async function createTenant(api: Api): Promise<Tenant> {
  const org = await api.post('/api/v1/organizations', { name: NAMES.org, type: 'biotech' });
  const orgId = org.body.id;

  const ws = await api.post('/api/v1/workspaces', {
    name: NAMES.workspace, type: 'internal', ownerOrganizationId: orgId,
  });
  const workspaceId = ws.body.id;
  const headers = workspaceHeader(workspaceId);

  const proj = await api.post('/api/v1/projects', { name: NAMES.project, workspaceId }, headers);
  const projectId = proj.body.id;

  return { orgId, workspaceId, projectId, headers };
}

/** The active org/workspace/project is client state `topMenuStore` reads from
 *  localStorage; without it project-scoped nav/pages render "No Workspace" /
 *  "Access denied" regardless of the account's real backend permissions
 *  (same seam `AXI-1524`/`AXI-1718` seed before every UI assertion). */
async function seedScope(page: Page, tenant: Tenant, scope: 'workspace' | 'project'): Promise<void> {
  await page.addInitScript(
    ([org, ws, proj, withProject]) => {
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      if (withProject) localStorage.setItem('axiome-active-project', proj);
    },
    [tenant.orgId, tenant.workspaceId, tenant.projectId, scope === 'project'] as const,
  );
}

/**
 * `TopMenu` reads the active org/workspace synchronously off localStorage at
 * store init, but something downstream of that first render (outside this
 * story's owned files — `TopMenu.tsx`/`topMenuStore.ts` are explicitly off
 * limits) can still clear it back to null a beat later, which a bare
 * post-`goto` check misses. Poll on the workspace chip showing the REAL name
 * (not just the absence of the "Select workspace first" placeholder) right
 * before the action that needs the header, so a late reset fails loudly
 * instead of racing `X-Workspace-Id` into a 400.
 */
async function waitForScopeReady(page: Page, workspaceName: string): Promise<void> {
  // `TopMenu` truncates long names with CSS (`max-w-[140px] truncate`), not a
  // text shorten — the accessible name is the full string, shared by both the
  // org button (same name here, since org/workspace/project all share the
  // run's tag) and the workspace button. The workspace switcher carries a
  // stable `data-tour` hook; key off that instead of the (ambiguous) name.
  await expect(page.locator('[data-tour="app-shell.workspace-switcher"]', { hasText: workspaceName }))
    .toBeVisible({ timeout: 20_000 });
}

interface AuthTokens { accessToken: string; refreshToken: string }

/**
 * The project-scope nav (`projectNav` in `useNavItems.ts`) — "Skills" among
 * it — is only ever rendered for a NON-platform-admin caller: a platform
 * admin (`user.userType === 'admin'`, true for both this suite's default
 * `admin` storageState and the `test@axiomebio.com` identity) always sees
 * `adminSection` instead (Layout.tsx: `auth.isAdmin() ? adminSection :
 * navigation`), by design, unrelated to this story. Provisioning a plain
 * organization member with `guided_analysis_prompt:view` — mirroring
 * `tests/AXI-1149/harness/rbac.ts`'s `mkUser`/`mkRole`/`assign` recipe — is
 * what actually exercises FR13's nav entry.
 */
async function provisionSkillsViewer(admin: Api, tenant: Tenant): Promise<AuthTokens> {
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const password = `Rb!${tag}Zz9!`;
  const email = `axi1889-skills-${tag}@rbac.test`;

  const role = await admin.post('/api/v1/roles', {
    name: `axi1889-skills-${tag}`,
    scope: 'ORGANIZATION',
    permissions: ['guided_analysis_prompt:view'],
  });
  const user = await admin.post('/api/v1/users', {
    email, password, firstName: 'axi1889', lastName: 'skills',
  });
  await admin.post(`/api/v1/users/${user.body.id}/roles`, { roleId: role.body.id });
  await admin.post(`/api/v1/workspaces/${tenant.workspaceId}/members`, {
    userId: user.body.id, organizationId: tenant.orgId, role: 'editor',
  });

  const anon = await apiRequest.newContext();
  const res = await anon.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  if (!res.ok()) throw new Error(`login failed for ${email}: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  await anon.dispose();
  return { accessToken: body.accessToken, refreshToken: body.refreshToken };
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let api: Api;
let tenant: Tenant;
let skillsViewerTokens: AuthTokens;

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await createTenant(api);
  skillsViewerTokens = await provisionSkillsViewer(api, tenant);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

// ── §4.1 — AC7: prompt library CRUD ─────────────────────────────────────────

test('AC7 — create, edit, archive and show-archived all work on /guided-analysis/prompts @SI-046', async ({ page }) => {
  await seedScope(page, tenant, 'workspace');
  await page.goto('/guided-analysis/prompts');
  await waitForScopeReady(page, NAMES.workspace);

  const title = `AXI-1889 e2e strategy ${Date.now()}`;
  const editedTitle = `${title} (edited)`;

  // CREATE — re-check scope right before the mutating action; a late reset of
  // the active workspace (see `waitForScopeReady`'s doc comment) would
  // otherwise only surface as "X-Workspace-Id header is required" here.
  await waitForScopeReady(page, NAMES.workspace);
  await page.getByTestId('prompt-create-button').click();
  await page.getByTestId('prompt-title-input').fill(title);
  await page.getByTestId('prompt-text-input').fill('Created by the AXI-1889 e2e spec.');
  await page.getByTestId('prompt-save-button').click();
  await expect(page.getByTestId('prompt-editor-dialog')).toHaveCount(0);

  const row = page.locator('tr', { hasText: title });
  await expect(row).toBeVisible();
  await expect(row).toContainText('v1');

  // UPDATE
  await row.getByRole('button', { name: `Edit strategy ${title}` }).click();
  await page.getByTestId('prompt-title-input').fill(editedTitle);
  await page.getByTestId('prompt-save-button').click();
  await expect(page.getByTestId('prompt-editor-dialog')).toHaveCount(0);

  const editedRow = page.locator('tr', { hasText: editedTitle });
  await expect(editedRow).toBeVisible();
  await expect(editedRow).toContainText('v2');

  // ARCHIVE (the library's delete — FR12/OQ-4: soft archive, never a hard
  // delete route; see `promptsApi.ts`'s own doc comment)
  await editedRow.getByRole('button', { name: `Archive strategy ${editedTitle}` }).click();
  await expect(page.locator('tr', { hasText: editedTitle })).toHaveCount(0);

  // Archived prompts are opt-in (FR10)
  await page.getByTestId('prompt-include-archived').check();
  const archivedRow = page.locator('tr', { hasText: editedTitle });
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow.getByText('Archived', { exact: true })).toBeVisible();
});

// ── §4.2 — AC8: "Skills" nav item at project scope leads to the library ─────

test.describe('AC8 — Skills nav entry', () => {
  // A plain org member, not the suite's platform-admin default — see
  // `provisionSkillsViewer`'s doc comment for why.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('"Skills" appears in the project-scope nav and routes to the prompt library @SI-030', async ({ page }) => {
    await page.addInitScript(
      ([access, refresh]) => {
        localStorage.setItem('access_token', access);
        localStorage.setItem('refresh_token', refresh);
      },
      [skillsViewerTokens.accessToken, skillsViewerTokens.refreshToken] as const,
    );
    await seedScope(page, tenant, 'project');
    await page.goto('/overview');
    await waitForScopeReady(page, NAMES.workspace);

    const skillsLink = page.getByRole('link', { name: 'Skills' });
    await expect(skillsLink).toBeVisible();
    await skillsLink.click();

    await expect(page).toHaveURL(/\/guided-analysis\/prompts$/);
    await expect(page.getByTestId('prompt-library')).toBeVisible();
  });
});

// ── §4.3 — AC8: the old "Analysis strategies" link is retired ──────────────

test('AC8 — /guided-analysis no longer renders the "Analysis strategies" link @SI-046', async ({ page }) => {
  await seedScope(page, tenant, 'project');
  await page.goto(`/guided-analysis?scope=project&projectId=${tenant.projectId}&workspaceId=${tenant.workspaceId}`);
  await waitForScopeReady(page, NAMES.workspace);

  await expect(page.getByRole('heading', { name: 'Guided Analysis' })).toBeVisible();
  await expect(page.getByTestId('prompt-library-link')).toHaveCount(0);
  await expect(page.getByText('Analysis strategies')).toHaveCount(0);
});

// ── §4.4 — AC9: /guided-analysis uses the shared PageHeader ─────────────────

test('AC9 — /guided-analysis renders its title through the shared PageHeader @SI-046', async ({ page }) => {
  await seedScope(page, tenant, 'project');
  await page.goto(`/guided-analysis?scope=project&projectId=${tenant.projectId}&workspaceId=${tenant.workspaceId}`);
  await waitForScopeReady(page, NAMES.workspace);

  const heading = page.getByRole('heading', { name: 'Guided Analysis' });
  await expect(heading).toBeVisible();

  // PageHeader's signature affordance: an InfoHint "(i)" button next to the
  // title, carrying the subtitle text as its accessible name — the hand-rolled
  // header this page used before AXI-1889 had no such element, only an inline
  // <p> subtitle with no accessible name of its own.
  const infoHint = page.getByRole('button', {
    name: /governed, option-driven path/i,
  });
  await expect(infoHint).toBeVisible();
});
