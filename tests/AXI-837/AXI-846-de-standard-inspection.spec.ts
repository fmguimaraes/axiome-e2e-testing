import { test, expect } from '@playwright/test';
import {
  adminApi, type Api,
  ensureFreshTenant, registerDeEvidence, ensureViewAnalysis, createDecisionDraft, primeWorkspace,
  type Tenant, type Analysis,
} from './harness/seed';

/**
 * AXI-846 (epic AXI-837) — DE Standard Inspection auto-offer/clone (FR34/FR35)
 * and the decision-level DE row-citation toolbar action (FR36/FR37).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-837-RNA-Seq-Differential-Expression.md`
 * §4.2 step 9 (offer), §4.5 step 9 (apply/clone), §4.7 (decision citation).
 * Tags: @SI-034 (front: `ProjectViewAnalysisDetail`, `DEStandardInspectionOfferBanner`,
 * `DataTableExplorer`'s "Cite into decision" action), @SI-015 (back:
 * `DeStandardInspectionService`, `DECitationService`).
 *
 * REAL BACKEND, LLM-FREE. Fixture: `tests/AXI-1640/fixtures/de_small.csv`
 * (DESeq2-shaped: gene_id/baseMean/log2FoldChange/lfcSE/stat/pvalue/padj).
 * Every tenant is freshly minted per test (see harness) so the offer's
 * "no existing saved view" branch is never polluted by a sibling run.
 */

test.describe('AXI-846 - DE Standard Inspection offer + clone (UI, real backend)', { tag: ['@SI-034', '@SI-015'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let api: Api;
  let t: Tenant;
  let analysis: Analysis;

  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureFreshTenant(api);
    await registerDeEvidence(api, t);
    analysis = await ensureViewAnalysis(api, t);
  });
  test.afterAll(async () => { await api?.ctx.dispose(); });

  test.beforeEach(async ({ page }) => { await primeWorkspace(page, t); });

  test('FR34 - a DE-fingerprinted dataset with no existing saved view shows the DE Standard Inspection offer banner', async ({ page }) => {
    await page.goto(`/projects/${t.projectId}/view-analyses/${analysis.analysisId}`);
    const banner = page.getByTestId('de-standard-inspection-offer-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('DE Standard Inspection');
    await expect(banner.getByRole('button', { name: 'Use this template' })).toBeVisible();
  });

  test('FR35 - clicking "Use this template" clones it into a workspace-scoped saved view and navigates there', async ({ page }) => {
    await page.goto(`/projects/${t.projectId}/view-analyses/${analysis.analysisId}`);
    const banner = page.getByTestId('de-standard-inspection-offer-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });

    await banner.getByRole('button', { name: 'Use this template' }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/views\/[0-9a-f-]{36}/, { timeout: 30_000 });

    // The offer must never be re-shown over a dataset that now carries a saved view (EC — offer's `existing_saved_view` branch).
    const secondAnalysis = await ensureViewAnalysis(api, t);
    await page.goto(`/projects/${t.projectId}/view-analyses/${secondAnalysis.analysisId}`);
    await expect(page.getByTestId('de-standard-inspection-offer-banner')).toHaveCount(0, { timeout: 15_000 });
  });
});

test.describe('AXI-846 - cite selected rows into a decision draft (UI, real backend)', { tag: ['@SI-034', '@SI-015'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  let api: Api;
  let t: Tenant;
  let analysis: Analysis;
  let decisionLabel: string;

  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureFreshTenant(api);
    analysis = await ensureViewAnalysis(api, t);
    const draft = await createDecisionDraft(api, t, analysis);
    decisionLabel = draft.label;
  });
  test.afterAll(async () => { await api?.ctx.dispose(); });

  test.beforeEach(async ({ page }) => { await primeWorkspace(page, t); });

  test('FR36 FR37 - selecting table rows and citing them into a decision draft succeeds and the citation is retrievable', async ({ page }) => {
    await page.goto(`/projects/${t.projectId}/view-analyses/${analysis.analysisId}`);

    const targetSelect = page.getByLabel('Cite selected rows into decision');
    await expect(targetSelect).toBeVisible({ timeout: 30_000 });
    await targetSelect.selectOption({ label: decisionLabel });

    // Select the first two rows of the table (checkbox column, AXI-846's shared
    // selection payload with the evidence-citation toolbar action).
    const rowCheckboxes = page.getByRole('checkbox', { name: /^Select row \d+$/ });
    await expect(rowCheckboxes.first()).toBeVisible({ timeout: 30_000 });
    await rowCheckboxes.nth(0).check();
    await rowCheckboxes.nth(1).check();

    const citeButton = page.getByRole('button', { name: new RegExp(`Cite into .*${decisionLabel.slice(0, 12)}`) });
    await expect(citeButton).toBeVisible();
    await citeButton.click();

    await expect(page.getByText(/Cited \d+ row\(s\) into the decision/)).toBeVisible({ timeout: 15_000 });

    // Retrievable: the capture is readable back off the decision's own citations endpoint.
    const decisionId = await api
      .get(`/api/v1/workspaces/${t.workspaceId}/decisions?projectId=${t.projectId}&limit=100`, t.headers)
      .then((res) => res.body.data.find((d: any) => d.label === decisionLabel)?.id);
    expect(decisionId, 'seeded decision draft not found via the list endpoint').toBeTruthy();

    const captured = await api.get(`/api/v1/workspaces/${t.workspaceId}/decisions/${decisionId}/de-citations`, t.headers);
    expect(captured.status, JSON.stringify(captured.body)).toBe(200);
    expect(captured.body.captures.length).toBeGreaterThan(0);
    const citedRowCount = captured.body.captures.reduce((n: number, c: any) => n + c.cited_rows.length, 0);
    expect(citedRowCount).toBeGreaterThanOrEqual(2);
  });
});
