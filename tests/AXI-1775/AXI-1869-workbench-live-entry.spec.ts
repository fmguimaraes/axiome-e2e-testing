import { test, expect } from '@playwright/test';
import { seedLiveWorkbench, primeWorkspace, type Seeded } from '../AXI-1717/harness/live-workbench';
import { ensureDistinctWorkspace } from '../AXI-1507/harness/seed';

/**
 * AXI-1869 - the Discovery Workbench header button and per-row icon open a REAL
 * discovery analysis LIVE, not preview (epic AXI-1775). Scenario doc:
 * `axiome-docs/manual-e2e/AXI-1775-Discovery-Workbench-Phase-3.md` section 18.
 * Tags: @SI-035 (View Analysis list), @SI-046 (workbench entry helpers).
 *
 * AUTHORED, TYPECHECKED, NOT EXECUTED - no worktree stack was stood up for this
 * story. No `e2e-pass` is claimed. See section 18.6 of the scenario doc.
 *
 * `seedLiveWorkbench` already creates two analyses per project: `viewAnalysisId`
 * (a plain ViewAnalysis, NO discovery-plan instance) and `declaredAnalysisId` (a
 * discovery-plan instance was instantiated on it) — exactly the discovery /
 * non-discovery pair AC3/AC4 need, with no extra seeding.
 */
test.describe('AXI-1869 - workbench live entry (UI, real backend)', { tag: ['@SI-035', '@SI-046'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let s: Seeded;

  test.beforeAll(async () => {
    const tag = Date.now().toString(36);
    s = await seedLiveWorkbench(`axi-1869-${tag}`, `AXI-1869 workbench entry ${tag}`);
  });
  test.afterAll(async () => { await s?.api.ctx.dispose(); });

  test('AC1 - the header button opens the discovery-plan analysis LIVE, carrying its analysisId', async ({ page }) => {
    await primeWorkspace(page, s);
    await page.goto(`/projects/${s.projectId}/view-analyses`);
    await expect(page.getByTestId('open-discovery-workbench')).toBeVisible();

    await page.getByTestId('open-discovery-workbench').click();
    await page.waitForURL(new RegExp(`/projects/${s.projectId}/discovery-workbench\\?analysisId=${s.declaredAnalysisId}$`));
  });

  test('AC3/AC4 - only the discovery-plan row carries the workbench icon, and it opens THAT analysis live', async ({ page }) => {
    await primeWorkspace(page, s);
    await page.goto(`/projects/${s.projectId}/view-analyses`);

    const discoveryRow = page.getByTestId('analysis-row').filter({ hasText: `axi-1869-` }).filter({ hasText: '(declared R)' });
    const plainRow = page.getByTestId('analysis-row').filter({ hasText: `axi-1869-` }).filter({ hasText: '(open)' });
    await expect(discoveryRow).toBeVisible();
    await expect(plainRow).toBeVisible();

    // AC4 - a non-discovery row shows no icon at all.
    await expect(plainRow.getByTestId('open-discovery-workbench-row')).toHaveCount(0);

    // AC3 - the discovery row's own icon opens THAT analysis live.
    await discoveryRow.hover();
    await discoveryRow.getByTestId('open-discovery-workbench-row').click();
    await page.waitForURL(new RegExp(`/projects/${s.projectId}/discovery-workbench\\?analysisId=${s.declaredAnalysisId}$`));
  });

  test('AC5 - a genuinely distinct workspace the caller belongs to sees none of another workspace\'s project analyses', async () => {
    // `ensureDistinctWorkspace` mints a brand-new, per-run-unique workspace and the
    // same admin caller becomes its verified `admin` MEMBER (organization-service
    // `WorkspacesService.create` auto-adds the creator) — never a member of `s`'s
    // shared workspace by virtue of THIS membership. Scoping the request to that
    // workspace's id (`foreign.headers`) while asking for `s.projectId` (owned by
    // the OTHER workspace) is exactly the boundary AC5 exists to prove: a listing
    // scoped by `(workspaceId, projectId)` returns nothing when the two do not
    // belong to the same workspace, even though the caller is a real, authenticated
    // member somewhere. This clears `WorkspaceGuard` (a genuine membership) and
    // then must fail the org-service's own `(workspaceId, projectId)` AND-filter.
    const foreign = await ensureDistinctWorkspace(s.api, `axi-1869-${Date.now().toString(36)}`);
    const res = await s.api.get(`/api/v1/discovery/projects/${s.projectId}/discovery-analyses`, foreign.headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.analyses).toEqual([]);
  });
});
