import { test, expect, Page } from '@playwright/test';
import {
  provisionPromptLibraryFixture,
  disposeFixture,
  send,
  attempt,
  type PromptLibraryFixture,
  type Tokens,
} from './harness/prompt-library-fixtures';

/**
 * AXI-2058 — Organization-level strategies (WS1a, epic AXI-1518). Scenarios
 * §5C.1-5C.4 of `axiome-docs/manual-e2e/AXI-1518-Guided-Analysis-Prompt-Library.md`.
 *
 * ── AUTHORED, NOT RUN ─────────────────────────────────────────────────────
 * Written against `AXI-2058-org-skills-backend`'s read contract
 * (`GuidedAnalysisPromptContract.organizationId`, the
 * `guided-analysis/organizations/:orgId/prompts` route shape) and this
 * story's own shipped frontend testids/copy. Neither the frontend nor the
 * backend half of AXI-2058 is merged to `main` at authoring time, so no
 * running stack exposes the organization routes yet — this file has never
 * been executed. Do not report `e2e-pass` for this story on the strength of
 * this file alone; it is a spec, not a run.
 *
 * ── Fixture reuse ────────────────────────────────────────────────────────
 * Reuses `./harness/prompt-library-fixtures.ts` (AXI-1523) rather than a
 * second provisioning module: `fx.admin` is the PLATFORM ADMIN, which the
 * organization controller's `grantsOf()` bypasses to full grants
 * (`isPlatformAdminRole`), so it exercises the org-scope CRUD without this
 * file needing its own org-capability-grant plumbing. `fx.editor` already
 * holds a WORKSPACE-level `guided_analysis_prompt:manage` grant and
 * deliberately NO organization-level one — exactly the AC28/5C.3 negative.
 *
 * `seedBrowserSession` (AXI-1523) always seeds BOTH the workspace and the
 * org id, which would make the page resolve to WORKSPACE scope (this
 * story's own `resolvePromptScope` — workspace wins when both are set). The
 * organization-scope scenarios below need the workspace id ABSENT, so this
 * file seeds the browser session locally instead of importing that helper
 * for the org-only cases.
 */

function orgHeader(organizationId: string): Record<string, string> {
  return { 'X-Organization-Id': organizationId };
}

/** Seed a page with only the organization active — no workspace id at all. */
async function seedOrgOnlySession(page: Page, tokens: Tokens, orgId: string): Promise<void> {
  await page.addInitScript(
    ([access, refresh, org]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.removeItem('axiome-active-workspace');
      localStorage.setItem('axiome-top-org', org);
    },
    [tokens.accessToken, tokens.refreshToken, orgId] as const,
  );
}

/** Seed a page with only the workspace active — no organization id. */
async function seedWorkspaceOnlySession(page: Page, tokens: Tokens, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ([access, refresh, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.removeItem('axiome-top-org');
    },
    [tokens.accessToken, tokens.refreshToken, workspaceId] as const,
  );
}

const ORG_PROMPTS_PATH = (orgId: string) => `/api/v1/guided-analysis/organizations/${orgId}/prompts`;

test.describe.serial('AXI-2058 — Organization-level strategies (AXI-1518 §5C.1-5C.4)', () => {
  let fx: PromptLibraryFixture;
  let orgPromptId: string;

  test.beforeAll(async () => {
    fx = await provisionPromptLibraryFixture();
  });

  test.afterAll(async () => {
    await disposeFixture(fx);
  });

  // ── §5C.1 (AC27 · SI-010, SI-045, SI-046) ──────────────────────────────

  test('AC27 SI-010 SI-045 SI-046 — an organization strategy is created and listed with Origin "Organization"', async ({ page }) => {
    await seedOrgOnlySession(page, fx.admin.tokens, fx.orgId);
    await page.goto('/guided-analysis/prompts');

    await expect(page.getByTestId('prompt-library')).toBeVisible();
    await expect(page.getByTestId('prompt-create-button')).toBeVisible();

    await page.getByTestId('prompt-create-button').click();
    await page.getByTestId('prompt-title-input').fill('Org-wide conservative');
    await page.getByTestId('prompt-text-input').fill('Prefer the smallest plan across the organization.');
    await page.getByTestId('prompt-save-button').click();

    const row = page.locator('tr', { hasText: 'Org-wide conservative' });
    await expect(row).toBeVisible();

    const created = await send(fx.admin.api, 'get', ORG_PROMPTS_PATH(fx.orgId), undefined, {
      headers: orgHeader(fx.orgId),
    });
    const match = created.find((p: any) => p.title === 'Org-wide conservative');
    expect(match, 'the created row is returned by the organization list route').toBeTruthy();
    expect(match.organizationId).toBe(fx.orgId);
    expect(match.workspaceId).toBeNull();
    orgPromptId = match.id;

    await expect(page.getByTestId(`prompt-origin-${orgPromptId}`)).toHaveText('Organization');
  });

  // ── §5C.2 (AC27, AC28 · SI-010, SI-045, SI-046) ────────────────────────

  test('AC27 AC28 SI-010 SI-045 SI-046 — the organization strategy is visible, union-listed and locked from the workspace screen', async ({ page }) => {
    await seedWorkspaceOnlySession(page, fx.admin.tokens, fx.workspaceId);
    await page.goto('/guided-analysis/prompts');

    const orgRow = page.getByTestId(`prompt-row-${orgPromptId}`);
    await expect(orgRow).toBeVisible();
    await expect(page.getByTestId(`prompt-origin-${orgPromptId}`)).toHaveText('Organization');

    // AC28 — no edit/archive affordance, even for an admin holding every
    // workspace-level grant; the lock names the organization, not the
    // system-origin reason.
    await expect(page.getByTestId(`prompt-edit-${orgPromptId}`)).toHaveCount(0);
    await expect(page.getByTestId(`prompt-archive-${orgPromptId}`)).toHaveCount(0);
    const note = page.getByTestId(`prompt-readonly-note-${orgPromptId}`);
    await expect(note).toBeVisible();
    await expect(note).toContainText('organization level');
  });

  // ── §5C.3 (AC29 · SI-010) ───────────────────────────────────────────────

  test('AC29 SI-010 — organization CRUD is refused without a satisfying organization capability', async () => {
    // No X-Organization-Id header at all.
    const noHeader = await attempt(fx.editor.api, 'post', ORG_PROMPTS_PATH(fx.orgId), {
      title: 'Should not be created',
      text: 'x',
    });
    expect([400, 401, 403]).toContain(noHeader.status);

    // A WORKSPACE-level `manage` grant (fx.editor's) does not satisfy the
    // organization's own capability check (AC28's server-side half).
    const workspaceGrantOnly = await attempt(
      fx.editor.api,
      'post',
      ORG_PROMPTS_PATH(fx.orgId),
      { title: 'Should not be created', text: 'x' },
      orgHeader(fx.orgId),
    );
    expect(workspaceGrantOnly.status).toBe(403);
  });

  // ── §5C.4 (AC29 · SI-046) ────────────────────────────────────────────────

  test('AC29 SI-046 — no scope active shows neither create nor a workspace-only message', async ({ page }) => {
    await page.addInitScript(
      ([access, refresh]) => {
        localStorage.setItem('access_token', access);
        localStorage.setItem('refresh_token', refresh);
        localStorage.removeItem('axiome-active-workspace');
        localStorage.removeItem('axiome-top-org');
      },
      [fx.admin.tokens.accessToken, fx.admin.tokens.refreshToken] as const,
    );
    await page.goto('/guided-analysis/prompts');

    const empty = page.getByTestId('prompt-library-no-workspace');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('organization');
    await expect(page.getByTestId('prompt-create-button')).toHaveCount(0);
  });
});
