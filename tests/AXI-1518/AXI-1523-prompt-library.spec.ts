import { test, expect } from '@playwright/test';
import {
  provisionPromptLibraryFixture,
  disposeFixture,
  send,
  attempt,
  seedBrowserSession,
  updateWorkspaceRolePermissions,
  workspaceHeader as wsHeader,
  type PromptLibraryFixture,
} from './harness/prompt-library-fixtures';

/**
 * AXI-1523 — Guided Analysis Prompt Library (epic AXI-1518). Scenarios §4.1,
 * §4.2, §4.3, §5.1, §5.2, §5.3, §5.4, §5.5 of
 * `axiome-docs/manual-e2e/AXI-1518-Guided-Analysis-Prompt-Library.md`.
 * §5.6 stays `manual` — see the note at the bottom of this file.
 *
 * ── Fixture note ──────────────────────────────────────────────────────────
 * `config/roles.ts` only carries `admin` (platform admin) and `user` — there is
 * no seeded editor / viewer / second-workspace-admin login. `./harness/
 * prompt-library-fixtures.ts` self-provisions all four through the public API,
 * the same convention `tests/AXI-1425/collaboration-fixtures.ts` and
 * `tests/AXI-1244/subject-fixtures.ts` already use.
 *
 * ── Two disconnected RBAC axes (load-bearing finding — read before editing) ──
 * The gateway enforces `guided_analysis_prompt:*` from the caller's WORKSPACE
 * MEMBERSHIP role (`WorkspaceMember.role`/`roleId`, resolved by
 * `WorkspacePermissionGuard`) — that is the axis every negative in this file
 * asserts against, and it is correct.
 * The React page's OWN button/lock-reason rendering
 * (`GuidedAnalysisPrompts.tsx` → `useCurrentUserRole` → `GET /users/extended/
 * :id` → `roleId`) instead reads a role assigned to the user GLOBALLY (`POST
 * /users/:id/roles`), a completely different table. The product's own "assign a
 * workspace role" screen (`WorkspaceRoleAssignment.tsx`) only ever calls
 * `PATCH /workspaces/:id/members/:userId/role` — nothing in the shipped flow
 * keeps the two in sync. The fixture assigns BOTH so the UI-facing assertions
 * below exercise the real rendered page instead of a fixture-only illusion; this
 * is not evidence the two axes agree in production, and is reported as a gap
 * between the scenario's implicit model (one role, one workspace) and the
 * shipped code.
 *
 * ── Other prose-vs-code gaps found while writing this file ──────────────────
 *  - §4.2 step 1 says the new row's origin reads "User"; the shipped label
 *    (`promptOriginLabel`, NFR11) is **"Workspace"** for a user-origin prompt.
 *    Asserted against the actual word below.
 *  - §5.1's `prompt-readonly-note` testid is actually per-row,
 *    `prompt-readonly-note-<id>` (`GuidedAnalysisPrompts.tsx` `PromptRow`).
 *    Asserted against the actual testid below.
 *  - §4.3 step 1 says "confirm"; the shipped Archive button has no confirmation
 *    step (`onClick={onArchive}` fires immediately) — asserted without one.
 *  - §6's "this story deliberately emits none [audit records]" is *not* what the
 *    code does: `GuidedAnalysisPromptService.emitAudit` fires on every create/
 *    update/archive, citing FR35/AC24 in its own comment. Out of this story's
 *    scope either way (§6 names no scenario), reported here rather than
 *    silently asserted on or contradicted.
 */

test.describe.serial('AXI-1523 — Guided Analysis Prompt Library (AXI-1518 §4.1-4.3, §5.1-5.5)', () => {
  let fx: PromptLibraryFixture;
  let seededSystemIds: string[] = [];

  test.beforeAll(async () => {
    fx = await provisionPromptLibraryFixture();
    // Trigger the idempotent per-workspace system-prompt seed (FR2) once, up
    // front, so every test after this one sees a stable two-row baseline.
    const list = await send(fx.admin.api, 'get', '/api/v1/guided-analysis/prompts', undefined, {
      headers: wsHeader(fx.workspaceId),
    });
    seededSystemIds = list.filter((p: any) => p.origin === 'system').map((p: any) => p.id);
    expect(seededSystemIds.length, 'two system-origin strategies seed on first list').toBe(2);
  });

  test.afterAll(async () => {
    await disposeFixture(fx);
  });

  // ── §4.1 (AC1, AC6 · SI-010, SI-045, SI-046) ───────────────────────────

  test('AC1 AC6 SI-010 SI-045 SI-046 — the library lists the two seeded system strategies, origin as a word', async ({ page }) => {
    await seedBrowserSession(page, fx.admin.tokens, fx.workspaceId, fx.orgId);
    await page.goto('/guided-analysis/prompts');

    await expect(page.getByTestId('prompt-library')).toBeVisible();
    for (const id of seededSystemIds) {
      const origin = page.getByTestId(`prompt-origin-${id}`);
      await expect(origin).toBeVisible();
      // NFR11 — origin is a WORD, never colour alone.
      await expect(origin).toHaveText('System');
    }
  });

  test('AC1 SI-010 SI-045 SI-046 — every actionable control has an accessible name (NFR11)', async ({ page }) => {
    await seedBrowserSession(page, fx.admin.tokens, fx.workspaceId, fx.orgId);
    await page.goto('/guided-analysis/prompts');

    // The admin holds manage_system, so the seeded rows render live edit/archive
    // controls rather than a readonly note — exercise those, plus create.
    await expect(page.getByRole('button', { name: 'New strategy' })).toBeVisible();
    for (const id of seededSystemIds) {
      await expect(page.getByTestId(`prompt-edit-${id}`)).toHaveAccessibleName(/Edit strategy/);
      await expect(page.getByTestId(`prompt-archive-${id}`)).toHaveAccessibleName(/Archive strategy/);
    }
    // Keyboard reachability, sampled rather than exhaustively walked: the create
    // button is the first actionable control after the "Show archived" checkbox
    // and must be reachable by keyboard alone.
    await page.getByTestId('prompt-include-archived').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'New strategy' })).toBeFocused();
  });

  // ── §4.2 (AC1 · SI-002, SI-010, SI-045, SI-046) — create → read → update ──

  let editorPromptId: string;

  test('AC1 SI-002 SI-010 SI-045 SI-046 — create a strategy: origin "Workspace", version 1, exactly two fields', async ({ page }) => {
    await seedBrowserSession(page, fx.editor.tokens, fx.workspaceId, fx.orgId);
    await page.goto('/guided-analysis/prompts');

    await page.getByTestId('prompt-create-button').click();
    const dialog = page.getByTestId('prompt-editor-dialog');
    await expect(dialog).toBeVisible();
    // FR1 — exactly two fields; no category/tag/variable input exists.
    await expect(dialog.getByTestId('prompt-title-input')).toBeVisible();
    await expect(dialog.getByTestId('prompt-text-input')).toBeVisible();
    await expect(dialog.locator('input, textarea')).toHaveCount(2);

    await dialog.getByTestId('prompt-title-input').fill('Conservative — paired designs first');
    await dialog.getByTestId('prompt-text-input').fill(
      'Prefer the smallest plan that answers the question asked, favouring paired designs over independent ones.',
    );
    await dialog.getByTestId('prompt-save-button').click();
    await expect(dialog).toBeHidden();

    const row = page.locator('[data-testid^="prompt-row-"]', { hasText: 'Conservative — paired designs first' });
    await expect(row).toBeVisible();
    editorPromptId = (await row.getAttribute('data-testid'))!.replace('prompt-row-', '');
    // Prose says origin renders as "User" (§4.2 step 1); the shipped label is
    // "Workspace" (`promptOriginLabel`) — asserted against the real word.
    await expect(page.getByTestId(`prompt-origin-${editorPromptId}`)).toHaveText('Workspace');
    await expect(row).toContainText('v1');
  });

  test('AC1 SI-010 SI-045 SI-046 — the created strategy persists across reload', async ({ page }) => {
    await seedBrowserSession(page, fx.editor.tokens, fx.workspaceId, fx.orgId);
    await page.goto('/guided-analysis/prompts');
    await page.reload();

    const row = page.getByTestId(`prompt-row-${editorPromptId}`);
    await expect(row).toContainText('Conservative — paired designs first');
    await expect(row).toContainText(
      'Prefer the smallest plan that answers the question asked, favouring paired designs over independent ones.',
    );
  });

  test('AC1 FR5 SI-010 SI-045 SI-046 — updating bumps the version to 2', async ({ page }) => {
    await seedBrowserSession(page, fx.editor.tokens, fx.workspaceId, fx.orgId);
    await page.goto('/guided-analysis/prompts');

    await page.getByTestId(`prompt-edit-${editorPromptId}`).click();
    const dialog = page.getByTestId('prompt-editor-dialog');
    await dialog.getByTestId('prompt-text-input').fill(
      'Prefer the smallest plan that answers the question asked; escalate only once the paired design is exhausted.',
    );
    await dialog.getByTestId('prompt-save-button').click();
    await expect(dialog).toBeHidden();

    const row = page.getByTestId(`prompt-row-${editorPromptId}`);
    await expect(row).toContainText('v2');
    await expect(row).toContainText('escalate only once the paired design is exhausted');
  });

  // ── §4.3 (AC1, AC6 · SI-045, SI-046) — soft, reversible-by-reading archive ──

  test('AC1 AC6 SI-045 SI-046 — archive removes the row from the default list; no delete affordance exists', async ({ page }) => {
    await seedBrowserSession(page, fx.editor.tokens, fx.workspaceId, fx.orgId);
    await page.goto('/guided-analysis/prompts');

    // FR10 — no delete control anywhere on the page, archived or not.
    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);

    // Prose says "confirm"; the shipped Archive button has no confirmation step.
    await page.getByTestId(`prompt-archive-${editorPromptId}`).click();
    await expect(page.getByTestId(`prompt-row-${editorPromptId}`)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);
  });

  test('AC6 SI-045 SI-046 — "Show archived" reveals it, badged as archived', async ({ page }) => {
    await seedBrowserSession(page, fx.editor.tokens, fx.workspaceId, fx.orgId);
    await page.goto('/guided-analysis/prompts');

    await page.getByTestId('prompt-include-archived').check();
    const row = page.getByTestId(`prompt-row-${editorPromptId}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`prompt-archived-badge-${editorPromptId}`)).toHaveText('Archived');
  });

  test('AC6 SI-010 SI-045 — GET by id resolves the archived strategy (200, full record)', async () => {
    const res = await attempt(
      fx.admin.api,
      'get',
      `/api/v1/guided-analysis/prompts/${editorPromptId}`,
      undefined,
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(editorPromptId);
    expect(res.body.archivedAt).not.toBeNull();
  });

  test('AC6 SI-010 SI-045 — GET the list without includeArchived excludes it', async () => {
    const res = await attempt(
      fx.admin.api,
      'get',
      '/api/v1/guided-analysis/prompts',
      undefined,
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(200);
    expect(res.body.map((p: any) => p.id)).not.toContain(editorPromptId);
  });

  // ── §5.1 (AC2, AC3 · SI-001, SI-010, SI-045, SI-046) ────────────────────

  test('AC2 AC3 SI-001 SI-010 SI-045 SI-046 — editor: system rows locked with a stated reason, own rows stay editable', async ({ page }) => {
    // A fresh, un-archived editor-owned prompt (the §4.2 one is archived by now).
    const created = await send(fx.editor.api, 'post', '/api/v1/guided-analysis/prompts', {
      title: 'Editor own strategy (§5.1)',
      text: 'Exists only to prove the editor may still edit their own strategies.',
    }, { headers: wsHeader(fx.workspaceId) });

    await seedBrowserSession(page, fx.editor.tokens, fx.workspaceId, fx.orgId);
    await page.goto('/guided-analysis/prompts');

    for (const id of seededSystemIds) {
      const note = page.getByTestId(`prompt-readonly-note-${id}`);
      await expect(note).toBeVisible();
      await expect(note).toHaveText('System strategies can only be changed by a workspace admin.');
      await expect(page.getByTestId(`prompt-edit-${id}`)).toHaveCount(0);
    }
    await expect(page.getByTestId(`prompt-edit-${created.id}`)).toBeVisible();
    await expect(page.getByTestId(`prompt-archive-${created.id}`)).toBeVisible();
  });

  test('AC3 SI-001 SI-010 SI-045 — PATCH a system prompt as editor is refused 403, naming manage_system', async () => {
    const res = await attempt(
      fx.editor.api,
      'patch',
      `/api/v1/guided-analysis/prompts/${seededSystemIds[0]}`,
      { title: 'hijacked', text: 'hijacked' },
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('guided_analysis_prompt:manage_system');
  });

  // ── §5.2 (AC2 · SI-001, SI-010, SI-046) ─────────────────────────────────

  test('AC2 SI-001 SI-010 SI-046 — viewer: read-only in the UI, POST refused 403', async ({ page }) => {
    await seedBrowserSession(page, fx.viewer.tokens, fx.workspaceId, fx.orgId);
    await page.goto('/guided-analysis/prompts');

    await expect(page.getByTestId('prompt-library')).toBeVisible();
    await expect(page.getByTestId('prompt-create-button')).toHaveCount(0);
    for (const id of seededSystemIds) {
      await expect(page.getByTestId(`prompt-edit-${id}`)).toHaveCount(0);
      await expect(page.getByTestId(`prompt-archive-${id}`)).toHaveCount(0);
    }

    const res = await attempt(
      fx.viewer.api,
      'post',
      '/api/v1/guided-analysis/prompts',
      { title: 'should never exist', text: 'should never exist' },
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(403);
  });

  test('AC2 NFR3 SI-001 SI-010 SI-046 — revoking view mid-session eventually refuses the list (403), deny-by-default', async () => {
    // First call with this roleId POPULATES `WorkspacePermissionGuard`'s 60s
    // in-process permission cache (`fetchRolePermissions`). The guard's own
    // comment claims a role update invalidates it "via the version field", but
    // no such check exists in the code read for this story — only a bare
    // `Date.now() - cachedAt < 60_000` TTL. So the revoke below is NOT
    // observed immediately; `expect.poll` (a condition wait, not a fixed sleep
    // — NFR4) rides out the cache window instead of asserting a false
    // negative. This is the SAME mechanism §5.6 is deferred to manual for.
    const before = await attempt(fx.viewer.api, 'get', '/api/v1/guided-analysis/prompts', undefined, wsHeader(fx.workspaceId));
    expect(before.status).toBe(200);

    await updateWorkspaceRolePermissions(fx.admin.api, fx.viewer.roleId, []);

    await expect
      .poll(
        async () => (await attempt(fx.viewer.api, 'get', '/api/v1/guided-analysis/prompts', undefined, wsHeader(fx.workspaceId))).status,
        { timeout: 65_000, intervals: [2_000, 5_000] },
      )
      .toBe(403);
  });

  // ── §5.3 (AC4 · SI-010, SI-045) — cross-workspace, by id and by listing ──

  test('AC4 NFR9 SI-010 SI-045 — a foreign workspace id is 404, never 403 (existence oracle)', async () => {
    const foreignId = seededSystemIds[0];
    const secondAdminApi = fx.secondWorkspace.admin.api;
    const secondWsHeader = wsHeader(fx.secondWorkspace.workspaceId);

    const get = await attempt(secondAdminApi, 'get', `/api/v1/guided-analysis/prompts/${foreignId}`, undefined, secondWsHeader);
    expect(get.status).toBe(404);

    const patch = await attempt(
      secondAdminApi,
      'patch',
      `/api/v1/guided-analysis/prompts/${foreignId}`,
      { title: 'stolen', text: 'stolen' },
      secondWsHeader,
    );
    expect(patch.status).toBe(404);

    const archive = await attempt(secondAdminApi, 'post', `/api/v1/guided-analysis/prompts/${foreignId}/archive`, undefined, secondWsHeader);
    expect(archive.status).toBe(404);

    // The foreign row is unchanged when re-read from its own workspace.
    const stillThere = await attempt(fx.admin.api, 'get', `/api/v1/guided-analysis/prompts/${foreignId}`, undefined, wsHeader(fx.workspaceId));
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.title).not.toBe('stolen');
    expect(stillThere.body.archivedAt).toBeNull();
  });

  test('AC4 SI-010 SI-045 — the first workspace\'s prompts are absent from the second workspace\'s listing', async () => {
    const res = await attempt(
      fx.secondWorkspace.admin.api,
      'get',
      '/api/v1/guided-analysis/prompts',
      undefined,
      wsHeader(fx.secondWorkspace.workspaceId),
    );
    expect(res.status).toBe(200);
    const ids = new Set(res.body.map((p: any) => p.id));
    for (const id of seededSystemIds) expect(ids.has(id)).toBe(false);
  });

  // ── §5.4 (AC5 · SI-002, SI-010, SI-045) — origin: system is not mintable ──

  test('AC5 SI-002 SI-010 SI-045 — POST with origin: "system" is refused 400 (whitelisted DTO), nothing is created', async () => {
    const before = await send(fx.admin.api, 'get', '/api/v1/guided-analysis/prompts', undefined, { headers: wsHeader(fx.workspaceId) });

    const res = await attempt(
      fx.admin.api,
      'post',
      '/api/v1/guided-analysis/prompts',
      { title: 'forged system prompt', text: 'forged system prompt', origin: 'system' },
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(400);

    const after = await send(fx.admin.api, 'get', '/api/v1/guided-analysis/prompts', undefined, { headers: wsHeader(fx.workspaceId) });
    expect(after.length).toBe(before.length);
    expect(after.some((p: any) => p.title === 'forged system prompt')).toBe(false);
  });

  test('AC5 SI-010 SI-045 — PATCH with origin: "system" is refused 400; the prompt stays "user"', async () => {
    const created = await send(fx.admin.api, 'post', '/api/v1/guided-analysis/prompts', {
      title: 'origin conversion target',
      text: 'must stay user-origin',
    }, { headers: wsHeader(fx.workspaceId) });

    const res = await attempt(
      fx.admin.api,
      'patch',
      `/api/v1/guided-analysis/prompts/${created.id}`,
      { title: created.title, text: created.text, origin: 'system' },
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(400);

    const reread = await send(fx.admin.api, 'get', `/api/v1/guided-analysis/prompts/${created.id}`, undefined, { headers: wsHeader(fx.workspaceId) });
    expect(reread.origin).toBe('user');
  });

  // ── §5.5 (AC1 · SI-010, SI-045, SI-046) — bounds refused, never truncated ──

  test('AC1 FR11 EC13 SI-010 SI-045 SI-046 — a blank title is refused 400', async () => {
    const res = await attempt(
      fx.editor.api,
      'post',
      '/api/v1/guided-analysis/prompts',
      { title: '', text: 'valid text' },
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(400);
  });

  test('AC1 FR11 EC13 SI-010 SI-045 SI-046 — whitespace-only text is refused 400 (trimmed server-side, not stored blank)', async () => {
    const res = await attempt(
      fx.editor.api,
      'post',
      '/api/v1/guided-analysis/prompts',
      { title: 'valid title', text: '   ' },
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(400);
  });

  test('AC1 FR11 EC13 SI-010 SI-045 SI-046 — 4001 characters is refused 400, never silently truncated to 4000', async () => {
    const overBound = 'x'.repeat(4001);
    const res = await attempt(
      fx.editor.api,
      'post',
      '/api/v1/guided-analysis/prompts',
      { title: 'over bound', text: overBound },
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(400);

    const list = await send(fx.admin.api, 'get', '/api/v1/guided-analysis/prompts', undefined, { headers: wsHeader(fx.workspaceId) });
    expect(list.some((p: any) => p.title === 'over bound')).toBe(false);
  });

  test('AC1 FR11 SI-010 SI-045 SI-046 — exactly 4000 characters is accepted (the bound is inclusive)', async () => {
    const atBound = 'y'.repeat(4000);
    const res = await attempt(
      fx.editor.api,
      'post',
      '/api/v1/guided-analysis/prompts',
      { title: 'at bound', text: atBound },
      wsHeader(fx.workspaceId),
    );
    expect(res.status).toBe(201);
    expect(res.body.text.length).toBe(4000);
  });
});

/**
 * §5.6 — Permission lost mid-edit (EC6). Tagged `manual` in the scenario file;
 * NOT reproduced here (out of this story's scope, and the scenario markdown is
 * owned by a parallel agent).
 *
 * The stated reason ("the role cache refresh makes this flaky headless") still
 * holds: `WorkspacePermissionGuard.fetchRolePermissions` (`apps/gateway/src/
 * guards/workspace-permission.guard.ts`) is a bare 60-second in-process TTL
 * cache with no invalidation on a role update, despite the file's own comment
 * claiming one "via the version field on Role" — that check does not exist in
 * the code. `AC2 SI-001 SI-010 SI-046 — revoking view mid-session…` above hits
 * the identical mechanism and works around it with `expect.poll` up to a 65s
 * timeout; §5.6 additionally requires a SECOND live session concurrently
 * holding an open edit form while the revoke happens in a first, which is a
 * genuinely different (and harder) shape than a single polled re-check, so the
 * manual designation is not stale and should not be carried into automation
 * without a rework of the scenario itself.
 */
