import { test, expect, Page } from '@playwright/test';
import { adminApi, asList, type Api } from './harness/api';
import {
  ensureTenant, ingestFixture, assignProfileAndVerify, ensureAnalysis, pollTerminal, ruleCodeFor,
  type Tenant, type Analysis,
} from './harness/seed';

/**
 * AXI-1435 — E2E: statistical trigger surface (picker → config → run →
 * result). Epic AXI-1432; covers AC21, AC22, NFR9 (SI-035).
 *
 * Unlike the AXI-1396..1399 epic's read-only "descriptor liveness" proxies,
 * this spec DRIVES THE REAL FRONTEND: the run-rule picker
 * (`DeltaRuleSelectionModal`, reused for every relationship-rule family member),
 * the per-operation statistical rules (AXI-1456 — one governed rule per
 * registered operation, code `STAT-<METHOD>`, tags
 * `['relationship-rule','statistical','op:<operationId>']`, seeded by
 * `axiome-back/scripts/create-statistical-rule.ts`), and the descriptor-driven
 * `StatisticalRunConfigModal`. It seeds its own additive project/dataset via
 * the REST API (mirroring `tests/AXI-1400/harness/seed.ts`), then drives a real
 * browser through: open the picker → select an operation's rule → the config
 * opens PRE-BOUND to that operation → bind columns/params → run → poll to a
 * terminal status → assert the result renders.
 *
 * FIXTURE DESIGN NOTE (load-bearing for AC22): `statistical-trigger.csv`
 * (patient_id, timepoint, score, score2, cohort) is DELIBERATELY all-numeric.
 * Statistical rules BYPASS the Delta pairing-compatibility gate (AXI-1453/1455)
 * — they gate per-operation inside their own config
 * (`evaluateStatisticalCompatibility` in `statisticalRunColumns.ts`, which
 * distinguishes 'numeric' vs. everything-else). So `stats.chi_square`
 * (rowColumn/columnColumn, both REQUIRED 'categorical') has zero candidates on
 * an all-numeric referent → its PRE-BOUND config names the incompatible reason
 * and disables Run (AC22 structural half), while `stats.correlation`
 * (xColumn/yColumn, both 'numeric') and `stats.kruskal_wallis`
 * (groupColumn 'any' + valueColumns 'numeric') are fillable. `cohort` carries
 * one singleton value (row 20) so Kruskal-Wallis's count-based BLOCK
 * precondition (`sufficient_group_members`, min 2 per group) still refuses the
 * run at execute time (AC22's second, server-side clause).
 *
 * ACCESSIBILITY-GAP NOTE (load-bearing for the locators below): every
 * `Field` in `StatisticalRunConfigModal.tsx` renders `<label>{label}</label>`
 * as a SIBLING of its control, not wrapping it, and sets no `htmlFor`/`id` —
 * so the label is not programmatically associated with its `<select>`, and
 * `page.getByLabel(...)` cannot find these controls (a real a11y gap, not
 * just a test-authoring inconvenience — flagged in the story report). This
 * spec locates the xColumn/yColumn/groupColumn selects via an explicit
 * `<label>` text match + `xpath=following-sibling::select`, rather than
 * `getByLabel`. The OperationRow radios and the Measurements checklist's
 * checkboxes ARE correctly associated (the `<input>` sits nested inside its
 * own `<label>`), so those use ordinary `getByRole(...)`.
 */

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let api: Api;
let tenant: Tenant;
let analysis: Analysis;

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant(api);
  const datasetId = await ingestFixture(api, tenant, 'statistical-trigger.csv');
  await assignProfileAndVerify(api, tenant, ['patient_id', 'timepoint']);
  analysis = await ensureAnalysis(api, tenant, 'AXI-1435 statistical trigger surface', datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

/** The app reads the active workspace/org from localStorage (not the URL) —
 *  mirrors `tests/AXI-1244/subject-fixtures.ts`'s `seedBrowserSession`. The
 *  default `chromium` project already injects the admin's auth tokens via the
 *  `setup` project's storageState (`playwright.config.ts`); this only adds
 *  the workspace/org scope this spec's fixture project needs. */
async function seedWorkspaceScope(page: Page): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [tenant.workspaceId, tenant.orgId] as const,
  );
}

/** Navigate to the seeded analysis, open the run-rule picker, select the
 *  seeded Statistical rule, and wait for its descriptor-driven config to
 *  open (the picker auto-confirms once its referent-compatibility gate
 *  passes — `DeltaRuleSelectionModal`'s own `useEffect`, no separate click). */
/** Open the run-rule picker on the analysis (AXI-1456: each statistical operation
 *  is its own rule in the picker, so we select one by its `STAT-<METHOD>` code). */
async function openRunRulePicker(page: Page): Promise<void> {
  await seedWorkspaceScope(page);
  await page.goto(`/projects/${tenant.projectId}/view-analyses/${analysis.analysisId}`);
  await page.getByRole('button', { name: 'Run rule' }).click();
  await expect(page.getByRole('heading', { name: /Run relationship rule/i })).toBeVisible({ timeout: 15_000 });
}

/** Select a per-operation statistical rule by its code and wait for the config,
 *  which opens PRE-BOUND to that operation (no in-config method picker). */
async function selectMethodRule(page: Page, ruleCode: string): Promise<void> {
  const row = page.getByRole('radio').filter({ hasText: ruleCode });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByRole('heading', { name: /^Configure Statistical$/ })).toBeVisible({ timeout: 15_000 });
}

/** The `<select>` immediately following an EXACT-text `<label>` — see the
 *  ACCESSIBILITY-GAP note above for why `getByLabel` cannot be used here. */
function selectAfterLabel(page: Page, label: string) {
  return page
    .locator('label')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::select[1]');
}

test.describe('AXI-1435 — statistical trigger surface (picker → config → run → result)', { tag: ['@SI-035'] }, () => {
  test('AC21 — every registered statistical operation is selectable; a compatible one runs to SUCCEEDED and renders', async ({ page }) => {
    const descriptors = await api.get('/api/v1/rule-runs/operations');
    const rawList = Array.isArray(descriptors.body) ? descriptors.body : (descriptors.body?.operations ?? descriptors.body?.data ?? []);
    const statisticalOps = (rawList as any[]).filter((op) => op.runKind === 'STATISTICAL');
    expect(statisticalOps.length, 'no STATISTICAL operations registered on this environment').toBeGreaterThan(0);

    await openRunRulePicker(page);

    // FR40 — each REGISTERED operation is its own selectable rule in the picker,
    // one per live descriptor (not a hardcoded list, not a single rule).
    for (const op of statisticalOps) {
      await expect(
        page.getByRole('radio').filter({ hasText: ruleCodeFor(op.operationId) }),
        `operation "${op.label}" (${op.operationId}) has no rule in the picker`,
      ).toBeVisible();
    }

    // A compatible operation: correlation needs two NUMERIC columns
    // (xColumn/yColumn) — both present on this all-numeric referent. Selecting
    // its rule opens the config PRE-BOUND to stats.correlation (FR41).
    await selectMethodRule(page, ruleCodeFor('stats.correlation'));

    await selectAfterLabel(page, 'xColumn').selectOption('score');
    await selectAfterLabel(page, 'yColumn').selectOption('score2');

    const submit = page.getByRole('button', { name: 'Run rule' }).last();
    await expect(submit).toBeEnabled();

    const [runResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/rule-runs') && r.request().method() === 'POST'),
      submit.click(),
    ]);
    const runBody = await runResponse.json();
    const ruleRunId: string | undefined = runBody.ruleRunId ?? runBody.existingRuleRunId;
    expect(ruleRunId, `execute() returned no ruleRunId: ${JSON.stringify(runBody)}`).toBeTruthy();

    const run = await pollTerminal(api, tenant, ruleRunId!);
    expect(run.status, `stats.correlation run ${ruleRunId}: ${run.statusMessage ?? run.errorMessage ?? ''}`).toBe('SUCCEEDED');

    // FR13/FR32 — the materialised result carries the operation's declared
    // output columns (correlation: coefficient/pValue/ciLow/ciHigh/n/reason).
    const table = await api.get(`/api/v1/rule-runs/${run.id}/table`, tenant.headers);
    expect(table.status).toBe(200);
    expect(table.body.totalRows).toBeGreaterThanOrEqual(1);
    expect(table.body.columns).toEqual(expect.arrayContaining(['coefficient', 'pValue']));

    // FR33/AC12 — the run registers a rule-derived snapshot in THIS analysis;
    // opening it renders through the existing explorable-result surface
    // (AXI-1419), not a bespoke statistical viewer — the same declared
    // columns are visible as a table.
    const snapshots = await api.get(`/api/v1/view-analyses/${analysis.analysisId}/snapshots?page=1&limit=100`, tenant.headers);
    const produced = asList(snapshots.body).find((s: any) => s.ruleRunId === run.id);
    expect(produced, `no rule-derived snapshot registered for run ${run.id}`).toBeTruthy();

    await page.goto(`/projects/${tenant.projectId}/view-analyses/${analysis.analysisId}?snapshotId=${produced.id}`);
    await expect(page.getByRole('columnheader', { name: 'coefficient' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('columnheader', { name: 'pValue' })).toBeVisible();
  });

  test("AC22 — an operation whose required roles can't bind is shown disabled with a reason; a count-based BLOCK still refuses at execute time", async ({ page }) => {
    // Structural half (FE, `evaluateStatisticalCompatibility`): the Chi-square
    // rule needs two CATEGORICAL columns and this referent has none — its config
    // opens PRE-BOUND but names the incompatible reason for its first declared
    // role, with Run disabled (not hidden).
    await openRunRulePicker(page);
    await selectMethodRule(page, ruleCodeFor('stats.chi_square'));
    await expect(page.getByText("No categorical column available for 'rowColumn'.")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run rule' }).last()).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Kruskal-Wallis's groupColumn is 'any'-shaped (structurally bindable on ANY
    // dataset), so its config is fillable; the insufficient-per-group precondition
    // is a deliberately client-unevaluated, server-side, execute-time refusal.
    await openRunRulePicker(page);
    await selectMethodRule(page, ruleCodeFor('stats.kruskal_wallis'));

    await page.getByRole('checkbox', { name: 'score', exact: true }).check();
    await selectAfterLabel(page, 'groupColumn').selectOption('cohort');

    const submit = page.getByRole('button', { name: 'Run rule' }).last();
    await expect(submit).toBeEnabled();
    await submit.click();

    // FR7/AC5-equivalent for Statistical — the smallest bound group (`cohort`
    // value 2, a singleton) fails Kruskal-Wallis's `sufficient_group_members`
    // (min 2) BLOCK precondition; the run is refused, and the modal names
    // the failed condition inline rather than closing silently.
    await expect(page.getByText(/sufficient_group_members/)).toBeVisible({ timeout: 20_000 });
  });
});
