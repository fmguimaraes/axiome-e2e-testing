import { test, expect, Page } from '@playwright/test';
import { adminApi, asList, type Api } from './harness/api';
import {
  ensureTenant, ingestFixture, assignProfileAndVerify, ensureAnalysis, pollTerminal,
  type Tenant, type Analysis,
} from './harness/seed';

/**
 * AXI-1435 — E2E: statistical trigger surface (picker → config → run →
 * result). Epic AXI-1432; covers AC21, AC22, NFR9 (SI-035).
 *
 * Unlike the AXI-1396..1399 epic's read-only "descriptor liveness" proxies,
 * this spec DRIVES THE REAL FRONTEND: the run-rule picker
 * (`DeltaRuleSelectionModal`, reused unchanged for every relationship-rule
 * family member per FR18), the seeded "Statistical" rule (code
 * `STATISTICAL-01`, tags `['relationship-rule','statistical']` —
 * `axiome-back/scripts/create-statistical-rule.ts`), and the descriptor-driven
 * `StatisticalRunConfigModal` AXI-1433 added. It seeds its own additive
 * project/dataset via the REST API (mirroring the suite's established
 * seeding convention — see `tests/AXI-1400/harness/seed.ts`), then drives a
 * real browser through: open the picker → select the statistical rule → the
 * descriptor-driven config opens → configure a compatible operation → run it
 * → poll to a terminal status → assert the result renders.
 *
 * FIXTURE DESIGN NOTE (load-bearing for AC22): `statistical-trigger.csv`
 * (patient_id, timepoint, score, score2, cohort) is DELIBERATELY all-numeric.
 * `DeltaRuleSelectionModal`'s referent-compatibility gate — reused unchanged
 * for every family member, including Statistical, since it gates on the
 * REFERENT alone, before any rule-specific logic runs — requires a numeric
 * field AND a mapped subject key/pairing axis (`patient_id`/`timepoint`) with
 * ≥2 levels (`compatibilityGate.ts`) before ANY config screen opens; and
 * `StatisticalRunConfigModal`'s own per-operation disable gate
 * (`evaluateStatisticalCompatibility` in `statisticalRunColumns.ts`) only
 * distinguishes 'numeric' vs. everything-else ('categorical'/'any' fold into
 * the same non-numeric bucket — see `candidateColumnsForShape`). Because the
 * referent gate above FORCES both a numeric column and (via patient_id/
 * timepoint) a non-numeric one to exist, no operation can ever appear
 * disabled on a referent that also clears the picker — UNLESS the referent
 * has NO non-numeric column at all. Hence: every column here is numeric
 * (including patient_id/timepoint, which the profiler classifies as
 * `numeric` purely from dtype — cardinality-independent,
 * `dataset_profiling.py::infer_logical_type`), so `stats.chi_square`
 * (rowColumn/columnColumn, both REQUIRED 'categorical') has zero candidates
 * and is genuinely, structurally disabled — while `stats.correlation`
 * (xColumn/yColumn, both 'numeric') and `stats.kruskal_wallis`
 * (groupColumn 'any' + valueColumns 'numeric') remain compatible. `cohort`
 * carries one singleton value (row 20) so Kruskal-Wallis's own count-based
 * BLOCK precondition (`sufficient_group_members`, min 2 per group) still
 * refuses the run at execute time even though the operation itself is
 * selectable (AC22's second, server-side clause).
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
async function openStatisticalConfig(page: Page): Promise<void> {
  await seedWorkspaceScope(page);
  await page.goto(`/projects/${tenant.projectId}/view-analyses/${analysis.analysisId}`);

  await page.getByRole('button', { name: 'Run rule' }).click();
  const statisticalRow = page.getByRole('radio').filter({ hasText: 'STATISTICAL-01' });
  await expect(statisticalRow).toBeVisible({ timeout: 15_000 });
  await statisticalRow.click();

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

    await openStatisticalConfig(page);

    // FR40/FR41 — the config surface offers a control per REGISTERED
    // operation, read from the live descriptor set, not a hardcoded list.
    for (const op of statisticalOps) {
      await expect(
        page.getByRole('radio', { name: new RegExp(escapeRegExp(op.label)) }),
        `operation "${op.label}" (${op.operationId}) is not offered in the config surface`,
      ).toBeVisible();
    }

    // A compatible operation: correlation needs two NUMERIC columns
    // (xColumn/yColumn) — both present on this all-numeric referent.
    const correlationRadio = page.getByRole('radio', { name: /^Correlation$/ });
    await expect(correlationRadio).toBeEnabled();
    await correlationRadio.click();

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
    await openStatisticalConfig(page);

    // Structural half (FE, `evaluateStatisticalCompatibility`): chi-square
    // needs two CATEGORICAL columns and this referent has none — disabled,
    // not hidden, with the exact reason for its first declared role.
    const chiSquareRadio = page.getByRole('radio', { name: /Chi-square/ });
    await expect(chiSquareRadio).toBeVisible();
    await expect(chiSquareRadio).toBeDisabled();
    await expect(page.getByText("No categorical column available for 'rowColumn'.")).toBeVisible();

    // Kruskal-Wallis's groupColumn is 'any'-shaped (structurally selectable
    // on ANY dataset — see the module note above), so it is NOT disabled
    // here: the insufficient-per-group precondition is a deliberately
    // client-unevaluated, server-side, execute-time refusal
    // (`statisticalRunColumns.ts`'s own doc comment on
    // `evaluateStatisticalCompatibility`).
    const kruskalRadio = page.getByRole('radio', { name: /^Kruskal-Wallis test$/ });
    await expect(kruskalRadio).toBeEnabled();
    await kruskalRadio.click();

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
