import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2307 (epic AXI-2060): the Statistics control's new "Compare against"
 * picker — AC1 (lists the chart's groups, filters brackets to pairs naming
 * the chosen one, on every panel, persisting across a reload), AC2 (p-value
 * labels unchanged), AC4 (no setting ⇒ unchanged "all pairs" behaviour).
 *
 * AC3 (the PDF/audit export draws the same filtered brackets) needed no new
 * backend code — `pdf-render.service.ts`'s `visiblePairwisePairs` already
 * read `pairwise.reference_group` line-for-line with the front since
 * AXI-2243, pinned byte-identical by the shared golden fixture
 * (`__fixtures__/pairwise-brackets.golden.json`, case "strip_v1 AC3:
 * reference_group IgG4-RD…", UT-PDFR-071) — so it is covered at the unit
 * level in both repos and is not re-asserted here.
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2253 (sibling story; this control extends the same
 * Statistics section). Tags: @SI-033, @SI-017, @SI-015, @SI-018, @SI-010.
 *
 * Never mutates a real chart: every spec this file creates is a THROWAWAY
 * (title prefixed `[e2e AXI-2307 throwaway]`) deleted in `afterAll`. The Dunn
 * run is only READ (linked by id).
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const ENT059_ANALYSIS_ID = '97b8fce5-ae0a-48a3-846d-9468a23808a7';
const DUNN_ENT059_RUN_ID = '9eedf58d-4336-494e-bd55-1c69d9bf4381';
const GROUPS = ['HD', 'IgG4-RD', 'SD'];

const THROWAWAY_TITLE = '[e2e AXI-2307 throwaway]';

type Params = Record<string, unknown>;
interface Clone { id: string; datasetId: string }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
const clones: Clone[] = [];

function candidatesUrl(datasetId: string, suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
}

/** Same shared-RMQ sidecar noise AXI-2253's spec works around (see that
 * file's comment) — retry a handful of times before failing. */
async function retryOn500<T>(fn: () => Promise<T>, attempts = 6, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

/** The AXI-2243 single-reference strip shape, unlinked. */
function unfacetedBody(params: Params = {}) {
  return {
    templateId: 'strip_v1',
    templateVersion: '1.0.0',
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
    params: { x_title: 'Reference microbiota', y_title: '% microbiota opsonized', group_order: GROUPS, show_median: true, ...params },
    filters: [
      { column: 'group', operator: 'in', value: GROUPS },
      { column: 'reference', operator: 'eq', value: 'ENT 059' },
    ],
    viewAnalysisId: ENT059_ANALYSIS_ID,
  };
}

async function createClone(datasetId: string, body: Params, title: string): Promise<Clone> {
  const res = await retryOn500(async () => {
    const r = await api.post(candidatesUrl(datasetId), { data: { ...body, title: `${THROWAWAY_TITLE} ${title}` } });
    expect(r.ok(), `create clone: ${r.status()} ${await r.text()}`).toBeTruthy();
    return r;
  });
  const clone = { id: (await res.json()).id as string, datasetId };
  clones.push(clone);
  return clone;
}

async function linkRun(clone: Clone, computeRunId: string | null) {
  await retryOn500(async () => {
    const r = await api.patch(candidatesUrl(clone.datasetId, `/${clone.id}/compute-run-link`), { data: { computeRunId } });
    expect(r.ok(), `compute-run-link: ${r.status()} ${await r.text()}`).toBeTruthy();
    return r;
  });
}

async function signIn(page: Page) {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [accessToken, refreshToken, ORGANIZATION_ID, WORKSPACE_ID] as const,
  );
}

/** The live Plotly figure's bracket shapes, reduced to a bare count. */
async function bracketCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const gd = document.querySelector('.js-plotly-plot') as unknown as {
      layout?: { shapes?: { line?: { color?: string }; y0: number; y1: number }[] };
    } | null;
    const shapes = gd?.layout?.shapes ?? [];
    return shapes.filter((s) => s.line?.color === '#475569' && s.y0 === s.y1).length;
  });
}

/** The live Plotly figure's bracket LABEL texts (the p-value annotations). */
async function bracketLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const gd = document.querySelector('.js-plotly-plot') as unknown as {
      layout?: { annotations?: { text?: string; yshift?: number }[] };
    } | null;
    const annotations = gd?.layout?.annotations ?? [];
    return annotations.filter((a) => a.yshift === 10).map((a) => a.text ?? '');
  });
}

async function openChart(page: Page, clone: Clone): Promise<void> {
  await page.goto(`/datasets/${clone.datasetId}/chart/${clone.id}`);
  await expect
    .poll(
      async () => {
        const retryButton = page.getByRole('button', { name: 'Retry' });
        if (await retryButton.isVisible().catch(() => false)) {
          await retryButton.click();
        }
        return page.locator('.js-plotly-plot').count();
      },
      { timeout: 60000 },
    )
    .toBeGreaterThan(0);
}

/** The initial bracket render can race the just-written compute-run link
 * (same shared-RMQ sidecar read-after-write noise AXI-2253 retries around
 * for the switch label) — a reload re-rolls the pairwise fetch. */
async function waitForBrackets(page: Page): Promise<void> {
  await retryOn500(async () => {
    const count = await bracketCount(page);
    if (count > 0) return;
    await page.reload();
    await expect
      .poll(async () => page.locator('.js-plotly-plot').count(), { timeout: 30000 })
      .toBeGreaterThan(0);
    await expect.poll(() => bracketCount(page), { timeout: 15000 }).toBeGreaterThan(0);
  }, 4, 1000);
}

async function openStatisticsSection(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Visual' }).click();
  const header = page.getByRole('button', { name: 'Statistics' });
  await expect(header).toBeVisible();
  await header.click();
}

/** Waits past the Statistics panel's own fitting-run fetch (same shared-RMQ
 * noise AXI-2253 retries around) before the "Compare against" select is
 * trusted to be present. */
async function compareAgainstSelect(page: Page) {
  const select = page.locator('label:has-text("Compare against") + select');
  await retryOn500(async () => {
    if (await select.isVisible().catch(() => false)) return;
    await page.reload();
    await expect.poll(() => bracketCount(page), { timeout: 30000 }).toBeGreaterThan(0);
    await openStatisticsSection(page);
    await expect(select).toBeVisible({ timeout: 8000 });
  }, 4, 1000);
  return select;
}

test.describe('AXI-2307 - "Compare against" one reference group', { tag: ['@SI-033', '@SI-017', '@SI-015', '@SI-018', '@SI-010'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180000 });

  test.beforeAll(async () => {
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
  });

  test.afterAll(async () => {
    for (const clone of clones) {
      const res = await retryOn500(async () => {
        const r = await api.delete(candidatesUrl(clone.datasetId, `/${clone.id}`));
        expect([204, 404], `delete clone ${clone.id}: ${r.status()}`).toContain(r.status());
        return r;
      });
      void res;
    }
    await api.dispose();
  });

  test('AC1/AC4 - defaults to "All pairs" (today\'s behaviour), lists the chart\'s groups, and narrows to the chosen group', async ({ page }) => {
    const clone = await createClone(ENT059_DATASET_ID, unfacetedBody(), 'compare against');
    await linkRun(clone, DUNN_ENT059_RUN_ID);
    await signIn(page);
    await openChart(page, clone);
    // The brackets themselves come from a SEPARATE async fetch
    // (`usePairwiseComparison`) that resolves slightly after the base Plotly
    // figure mounts, and can race the just-written link — wait for them
    // before measuring, same as AXI-2253's spec.
    await waitForBrackets(page);
    const allPairsCount = await bracketCount(page);
    await openStatisticsSection(page);

    const select = await compareAgainstSelect(page);
    // AC4: with nothing chosen, "All pairs" is selected and every pair draws.
    await expect(select).toHaveValue('');
    const allPairsOptions = await select.locator('option').allTextContents();
    expect(allPairsOptions[0]).toBe('All pairs');
    // AC1: every one of the chart's own groups is offered.
    for (const group of GROUPS) expect(allPairsOptions).toContain(group);

    // AC1: choosing "IgG4-RD" keeps only brackets naming it.
    await select.selectOption({ label: 'IgG4-RD' });
    await expect.poll(() => bracketCount(page), { timeout: 10000 }).toBeLessThan(allPairsCount);
    const narrowedCount = await bracketCount(page);
    expect(narrowedCount).toBeGreaterThan(0);

    // AC1: persists across a reload.
    await page.reload();
    await waitForBrackets(page);
    await openStatisticsSection(page);
    const reloadedSelect = await compareAgainstSelect(page);
    await expect(reloadedSelect).toHaveValue('IgG4-RD');
    await expect.poll(() => bracketCount(page), { timeout: 10000 }).toBe(narrowedCount);

    // AC2: the surviving bracket's label is still the underlying run's
    // adjusted p-value string (or "ns") — display-only filtering never
    // changes what a kept bracket is labelled.
    const allPairsLabels = await retryOn500(async () => {
      await reloadedSelect.selectOption({ label: 'All pairs' });
      await expect.poll(() => bracketCount(page), { timeout: 10000 }).toBe(allPairsCount);
      return bracketLabels(page);
    });
    await reloadedSelect.selectOption({ label: 'IgG4-RD' });
    await expect.poll(() => bracketCount(page), { timeout: 10000 }).toBe(narrowedCount);
    const narrowedLabels = await bracketLabels(page);
    for (const label of narrowedLabels) expect(allPairsLabels).toContain(label);

    const savedRes = await retryOn500(async () => {
      const r = await api.get(candidatesUrl(clone.datasetId, `/${clone.id}`));
      expect(r.ok(), `get candidate: ${r.status()}`).toBeTruthy();
      return r;
    });
    const saved = await savedRes.json();
    expect(saved.params.pairwise).toMatchObject({ reference_group: 'IgG4-RD' });
  });

  test('AC1 - a faceted chart offers the SAME "Compare against" select, filtering every panel', async ({ page }) => {
    const facetedBody = {
      templateId: 'strip_v1',
      templateVersion: '1.0.0',
      bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' }, facet: { column_id: 'col_reference' } },
      params: { x_title: 'x', y_title: 'y', group_order: GROUPS, facet_order: ['ENT 059'] },
      filters: [
        { column: 'group', operator: 'in', value: GROUPS },
        { column: 'reference', operator: 'in', value: ['ENT 059'] },
      ],
      viewAnalysisId: ENT059_ANALYSIS_ID,
    };
    const clone = await createClone(ENT059_DATASET_ID, facetedBody, 'faceted compare against');
    await retryOn500(async () => {
      const r = await api.patch(candidatesUrl(clone.datasetId, `/${clone.id}/facet-compute-run-links`), {
        data: { facetComputeRunIds: { 'ENT 059': DUNN_ENT059_RUN_ID } },
      });
      expect(r.ok(), `facet-compute-run-links: ${r.status()} ${await r.text()}`).toBeTruthy();
      return r;
    });

    await signIn(page);
    await openChart(page, clone);
    await waitForBrackets(page);
    const allPairsCount = await bracketCount(page);
    await openStatisticsSection(page);
    const select = await compareAgainstSelect(page);
    // Exactly one select, not one per panel (same FR30 shape as the brackets switch).
    await expect(select).toHaveCount(1);
    await select.selectOption({ label: 'IgG4-RD' });
    await expect.poll(() => bracketCount(page), { timeout: 10000 }).toBeLessThan(allPairsCount);
  });
});
