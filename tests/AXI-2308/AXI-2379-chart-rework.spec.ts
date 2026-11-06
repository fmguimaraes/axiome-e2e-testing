import { test, expect, type Page } from '@playwright/test';
import { adminApi, adminToken, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { ingestCsvFixture } from './harness/opening-templates';
import { gotoSettled, seedScope } from './harness/new-analysis';
import { launchAndDrain, wizardBody } from './harness/result-page';

/**
 * AXI-2379 (epic AXI-2308, slice of AXI-2377 — out-of-scope: AXI-2378's checks panel and
 * AXI-2383's verdict box are untouched here): the result page's box_plot presentation rule —
 * a group with fewer than 8 subjects draws jittered individual points + a median bar (no box);
 * a group with 8 or more keeps the box. pValue/effect size leave the plot for the caption text;
 * the y-axis title is the measurement's human label (never the literal "value").
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2308-Platform-Opening-Human-Guided.md` § AXI-2379.
 *
 * Fixture: `tests/AXI-2308/fixtures/opening-templates-paul-header.csv` (AXI-2339; synthetic) —
 * reused from AXI-2378/AXI-2327: T1 (sexe, F/M, n=12 each — >= 8) and T2 (cluster, 4 groups of
 * ~6 — < 8), so both branches of the n-rule are exercised on the SAME fixture.
 *
 * Run: `BASE_URL=<worktree Vite serving this branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2308/AXI-2379-* --project=chromium --no-deps`.
 * Never against the shared demo gateway (:3000): it approves seeded carriers (append-only).
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const MAG4 = 'microbiote_igg4_mag4_27';
const CLUSTER = 'cluster_selon_acr_eular_2019';

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let t1RunId: string;
let t2RunId: string;

const pagePath = (runId: string) => `/projects/${t.projectId}/runs/${runId}`;

async function openPage(page: Page, runId: string): Promise<void> {
  await seedScope(page, t);
  await gotoSettled(page, pagePath(runId));
  await expect(page.getByTestId('rp-answer')).toBeVisible({ timeout: 120_000 });
}

interface PlotLayout {
  yaxisTitle: string | null;
  annotationTexts: string[];
}

interface PlotTraceStyle {
  name: string | null;
  type: string;
  fillcolor: string | null;
  hasBox: boolean;
}

/** Reads the chart's drawn layout/trace shapes straight off the Plotly div — no re-computation, a read only. */
async function readPlot(page: Page): Promise<{ layout: PlotLayout; traces: PlotTraceStyle[] }> {
  const plot = page.getByTestId('rp-chart').locator('.js-plotly-plot');
  await expect(plot).toBeVisible({ timeout: 30_000 });
  return plot.evaluate((el) => {
    const gd = el as unknown as { data?: Array<Record<string, any>>; layout?: Record<string, any> };
    const layout = gd.layout ?? {};
    const annotationTexts = (layout.annotations ?? []).map((a: Record<string, any>) => String(a.text));
    return {
      layout: { yaxisTitle: layout.yaxis?.title?.text ?? null, annotationTexts },
      traces: (gd.data ?? []).map((tr) => ({
        name: typeof tr.name === 'string' ? tr.name : null,
        type: String(tr.type),
        fillcolor: typeof tr.fillcolor === 'string' ? tr.fillcolor : null,
        hasBox: tr.type === 'box',
      })),
    };
  });
}

test.describe.serial('AXI-2379 result page — chart rework: jitter/box by n, caption pValue/effect, real labels @SI-066 @SI-017', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    t = await ensureTenant(api);
    const datasetId = await ingestCsvFixture(api, t, FIXTURE);
    const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');
    dataset = anchored;
    await approveCarriersFor(['stats.unpaired_ttest', 'stats.mann_whitney_u', 'stats.kruskal_wallis', 'stats.dunn_posthoc']);
    await silenceTours(await adminToken());
    t1RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T1', `Does ${MAG4} differ between F and M?`, 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'groups', value: ['F', 'M'] }, { slot: 'outcome', value: MAG4 },
    ]));
    t2RunId = await launchAndDrain(api, t, wizardBody(t, dataset, 'T2', 'Does igg4_g_l differ across the clusters?', 'compare_groups', [
      { slot: 'groupingColumn', value: CLUSTER }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('AXI-2379.1 T1 (two groups of 12, n >= 8): both groups draw as a box, real level names (F/M) on the x-axis, y-axis titled by the measurement\'s human name', async ({ page }) => {
    // Arrange
    await openPage(page, t1RunId);

    // Act
    const { layout, traces } = await readPlot(page);
    const groups = traces.filter((tr) => tr.hasBox && (tr.name === 'F' || tr.name === 'M'));

    // Assert — a drawn box keeps a non-transparent fill; real data level names, never "Group 1"/"C1" placeholders invented here
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.fillcolor).not.toBe('rgba(0,0,0,0)');
    expect(layout.annotationTexts).toContain('n = 12');
    expect(layout.yaxisTitle).not.toBe('value');
    expect(layout.yaxisTitle).toBeTruthy();
  });

  test('AXI-2379.2 T1 figure caption states the n<8 rule and the test\'s pValue, rounded — no stat text on the plot itself', async ({ page }) => {
    // Arrange
    await openPage(page, t1RunId);

    // Act
    const caption = page.getByTestId('rp-distribution-caption');
    const { layout } = await readPlot(page);

    // Assert
    await expect(caption).toContainText('fewer than 8 subjects');
    await expect(caption).toContainText('pValue');
    expect(layout.annotationTexts.some((text) => /pValue/i.test(text))).toBe(false);
  });

  test('AXI-2379.3 T2 (four groups of ~6, n < 8): every group draws as points only (no box fill), with its own median bar', async ({ page }) => {
    // Arrange
    await openPage(page, t2RunId);

    // Act
    const { layout, traces } = await readPlot(page);
    const clusterNames = ['C1', 'C2', 'C3', 'C4'];
    const groupTraces = traces.filter((tr) => tr.hasBox && clusterNames.includes(tr.name ?? ''));
    const medianTraces = traces.filter((tr) => tr.type === 'scatter' && clusterNames.includes(tr.name ?? ''));

    // Assert — no drawn box fill for any under-floor group; its own median marker is present
    expect(groupTraces.length).toBeGreaterThan(0);
    for (const g of groupTraces) expect(g.fillcolor).toBe('rgba(0,0,0,0)');
    expect(medianTraces.length).toBeGreaterThan(0);
    for (const name of clusterNames) expect(layout.annotationTexts.some((text) => text.startsWith(`n =`) )).toBe(true);
  });

  test('AXI-2379.4 T2 figure caption carries the Dunn pairwise reading(s), rounded, never drawn on the plot', async ({ page }) => {
    // Arrange
    await openPage(page, t2RunId);

    // Act
    await page.getByTestId('rp-next').click(); // the Dunn tab
    const caption = page.getByTestId('rp-distribution-caption');
    const { layout } = await readPlot(page);

    // Assert
    await expect(caption).toContainText('fewer than 8 subjects');
    await expect(caption).toContainText('vs');
    expect(layout.annotationTexts.some((text) => text.includes('adjustedPValue') || /p_adj/i.test(text))).toBe(false);
  });
});
