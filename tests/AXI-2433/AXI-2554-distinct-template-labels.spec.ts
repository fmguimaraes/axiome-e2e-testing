import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { OPENING_TEMPLATES_PATH } from '../AXI-2308/harness/opening-templates';

/**
 * AXI-2554 (epic AXI-2433 — W5 owner finding, 2026-11-15). Plan mode's Analysis step and the
 * New Analysis wizard both read their cards from `GET /guided-analysis/opening-templates`
 * (the opening-template catalog, SI-045). T1 (Mann-Whitney U) and T2 (Kruskal-Wallis then
 * Dunn/Holm) used to share the one label "Compare groups", which read on screen as one card
 * offered twice. The fix renamed the catalog's own label — never a second place — to
 * "Compare two groups" (T1) and "Compare several groups" (T2); `methodSubtitle` is unchanged,
 * and the `compare_groups` INTENT (a separate vocabulary) is untouched.
 *
 * API-level (no browser): the wizard/plan-mode screens that render these cards are AXI-2328's
 * and AXI-2447's own specs; this one pins the one upstream fact they both depend on.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md`
 * (added alongside this spec — see § AXI-2554.1).
 *
 * STATUS: authored, NOT run — no isolated stack was available for this story (team-mode
 * story-developer agent, no sidecar this week, epic precedent AXI-2409..2412). Do not read a
 * green/red result into this file; none was taken.
 *
 * Run: `API_BASE_URL=<gateway serving this branch> npx playwright test tests/AXI-2433/AXI-2554-*`.
 */

let api: Api;
let t: Tenant;

test.describe('AXI-2554 opening-template catalog — T1/T2 never share a label @SI-045 @SI-002', () => {
  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureTenant(api);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2554.1 — the catalog names T1 "Compare two groups" and T2 "Compare several groups", with every label distinct', async () => {
    const res = await api.get(OPENING_TEMPLATES_PATH, t.headers);
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ templateId: string; label: string; methodSubtitle: string }>;
    const byId = Object.fromEntries(rows.map((r) => [r.templateId, r]));

    expect(byId.T1?.label).toBe('Compare two groups');
    expect(byId.T1?.methodSubtitle).toBe('Mann-Whitney U test');
    expect(byId.T2?.label).toBe('Compare several groups');
    expect(byId.T2?.methodSubtitle).toBe("Kruskal-Wallis test, then Dunn's pairwise test (Holm)");

    // The AC itself: no two templates on the catalog ever read as the same card.
    const labels = rows.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
