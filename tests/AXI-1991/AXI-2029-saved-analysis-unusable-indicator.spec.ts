import { test, expect, request as apiRequest, type Page, type APIRequestContext } from '@playwright/test';
import { silenceTours } from '../AXI-1904/harness/tours';
import { adminApi, type Api, workspaceHeader } from '../AXI-1400/harness/api';
import { ingestFixture, pollRunTerminal, resolveMaterialisedRow, type Tenant } from '../AXI-1474/harness/seed';
import { RuleFamilyWorld, send } from './harness/world';

/**
 * AXI-2029 (epic AXI-1991 — AC14/AC18, SI-017; closes the `automation:
 * manual` deferral `AXI-2005-new-run-history-decision.spec.ts`'s own
 * scenario-doc entry §2.4 recorded — "the UI-rendered unusable-rule
 * indicator... reaching these through the browser needs the SAME completed-
 * run fixture as §2.4's API scenarios").
 *
 * `RuleUnusableIndicator` (`src/components/rules/RuleUnusableIndicator.tsx`)
 * is a pure, prop-driven component: it renders `data-testid=
 * "rule-unusable-indicator"` (no `ruleId` suffix — `ProjectViewAnalysisDetail
 * .tsx` mounts it with none) with the server's `reason` text verbatim,
 * exactly when `usability.usable === false`; otherwise it renders nothing.
 * Mounted at `!detailTarget && currentSnapshot` (`ProjectViewAnalysisDetail
 * .tsx`), which the `?snapshotId=` query-param navigation this suite already
 * proves (`tests/AXI-1435/statistical-trigger-surface.spec.ts`) satisfies —
 * `currentSnapshot` is set from that param on load, with no row-detail
 * panel open by default.
 *
 * The server half (`ViewAnalysesService.withCitedRuleUsability` →
 * `snapshot-usability.ts#resolveCitedRuleUsability` → `UsableRuleGateService
 * .partitionUsable`) decorates a rule-derived snapshot's `citedRuleUsability
 * .reason` with the SAME `FAMILY_NOT_AUTHORIZED_REASON` sentence every other
 * surface uses, read verbatim here — this spec is the ONE place that
 * confirms the WIRE-TO-PIXEL path end to end; the field's presence/shape is
 * already pinned at API level by `AXI-2005-new-run-history-decision
 * .spec.ts`'s own row 1.
 *
 * **Bounce #2 (B3 class — re-checked per the reviewer's instruction to audit
 * EVERY browser test in this story's eight spec files, not only
 * `AXI-2029-family-ui-corrections.spec.ts`).** `ProjectViewAnalysisDetail
 * .tsx` gates its ENTIRE body on `canView = (user?.userType === 'admin') ||
 * (!!roleId && hasPermission(roleId, 'view-analysis:view'))` — without it,
 * line ~1151 renders "Access denied" and the data-fetch effect (line ~1020,
 * `if (!viewAnalysisId || !canView) return;`) never runs, so
 * `rule-unusable-indicator` is never mounted at all. `viewer` below is now
 * granted a role carrying `view-analysis:view` for exactly this reason — an
 * earlier draft of this file created `viewer` with no role (and so no
 * `canView`) at all.
 *
 * AUTHORED, NOT RUN — no stack was started for this story. Selectors read
 * off `axiome-front` `origin/main` (`fe919b8`).
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(who.email);
  await page.locator('input[type="password"]').fill(who.password);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

interface UiActor {
  userId: string;
  email: string;
  password: string;
  accessToken: string;
  api: APIRequestContext;
}

async function uiActor(label: string, world: RuleFamilyWorld, roleId?: string, organizationId?: string): Promise<UiActor> {
  const email = `${unique(`axi2029-${label}`)}@axiome.local`;
  const password = 'AXI2029-ui-pw!';
  const bootstrap = await apiRequest.newContext();
  await send(bootstrap, 'post', '/api/v1/auth/register', { email, password, firstName: 'AXI2029', lastName: label });
  const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
  await bootstrap.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` } });
  const me = await send(api, 'get', '/api/v1/auth/me');
  if (roleId) {
    const assigned = await send(world.admin, 'post', `/api/v1/users/${me.json.id}/roles`, { roleId, organizationId });
    expect(assigned.status, `assigning role to ${label}: ${JSON.stringify(assigned.json)}`).toBeLessThan(300);
  }
  return { userId: me.json.id, email, password, accessToken: login.json.accessToken, api };
}

test.describe('AXI-2029 — the saved-analysis unusable-rule indicator renders the server\'s own sentence', () => {
  test.describe.configure({ timeout: 240_000 });

  test(
    "AC14/AC18: opening a snapshot whose cited rule is now family-withheld shows rule-unusable-indicator with the server's FAMILY_NOT_AUTHORIZED sentence @SI-017",
    async ({ page }) => {
      const ingestApi: Api = await adminApi();
      const world = await RuleFamilyWorld.create();
      try {
        const orgId = await world.organization('saved-indicator');
        const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'indicator', `AXI2029INDICATOR-${Date.now()}`);
        const tenant: Tenant = { orgId, workspaceId, headers: workspaceHeader(workspaceId) };
        const datasetId = await ingestFixture(ingestApi, tenant);
        const projectId = await world.project('saved-indicator', workspaceId);

        // B3 (bounce #2): `view-analysis:view` is the page's OWN gate
        // (`ProjectViewAnalysisDetail.tsx` — see this file's doc comment),
        // orthogonal to the family gate under test — never a rule_family:*
        // capability.
        const viewerRoleId = await world.role('saved-indicator-viewer', ['view-analysis:view']);
        const viewer = await uiActor('indicator-viewer', world, viewerRoleId, orgId);
        await world.addWorkspaceMember(workspaceId, { userId: viewer.userId, api: viewer.api });

        const submitted = await send(
          world.admin,
          'post',
          '/api/v1/rule-runs',
          { ruleId, runKind: 'QC', operationId: 'qc.rule_gate', projectId, workspaceId, datasetId },
        );
        expect(submitted.status, `baseline QC run submit: ${JSON.stringify(submitted.json)}`).toBeLessThan(300);
        const polled = await pollRunTerminal(ingestApi, tenant, submitted.json.ruleRunId);
        const row = await resolveMaterialisedRow(ingestApi, tenant, polled);
        const analysisId: string = submitted.json?.existingViewAnalysisId;
        expect(analysisId, `baseline run must resolve an analysis id: ${JSON.stringify(submitted.json)}`).toBeTruthy();
        const snaps = await ingestApi.get(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=200`, tenant.headers);
        const list = Array.isArray(snaps.body) ? snaps.body : snaps.body?.data ?? snaps.body?._list ?? [];
        const derived = list.find((s: any) => s.origin === 'rule_derived' && s.ruleRunId === row.id);
        expect(derived, `no rule-derived snapshot found for run ${row.id}: ${JSON.stringify(list)}`).toBeTruthy();

        await world.withNarrowedRule(orgId, ruleId, 'AXI-2029 Saved Indicator Narrowing', async () => {
          await silenceTours(viewer.accessToken);
          await signIn(page, viewer);
          await page.goto(`/projects/${projectId}/view-analyses/${analysisId}?snapshotId=${derived.id}`);

          const indicator = page.getByTestId('rule-unusable-indicator');
          await expect(indicator).toBeVisible();
          await expect(indicator).toContainText('No family of this rule is authorized for this project.');
          await expect(indicator).toHaveAttribute('title', 'No family of this rule is authorized for this project.');
        });

        // Recovery check: once restored (withNarrowedRule's own cleanup already
        // ran), the SAME snapshot's indicator must be gone on a fresh load —
        // the marker tracks LIVE project authorization, never a cached verdict.
        await page.goto(`/projects/${projectId}/view-analyses/${analysisId}?snapshotId=${derived.id}`);
        await expect(page.getByTestId('rule-unusable-indicator')).toHaveCount(0);
      } finally {
        await world.dispose();
        await ingestApi.ctx.dispose();
      }
    },
  );
});
