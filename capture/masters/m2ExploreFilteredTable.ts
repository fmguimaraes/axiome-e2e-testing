import type { Page } from '@playwright/test';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { clickResilient, gotoStable, shutter, assertOriginFilterIsUser } from './common';
import type { MasterResult } from './types';

/**
 * M2 — Explore: filtered table + group comparison chart. Same pane as M1
 * ("Explore" is the `all-charts` sub-tab's label per research), switched to
 * the `Table` view mode (`button[title="Full data table"]`).
 *
 * `?chartOrigin=user` RESTORED (AXI-1368 FIX 1 — see M1's own doc for the
 * root cause and fix). Two live findings from before the fix no longer
 * hold: (1) the embedded gallery no longer returns "0 charts" under the
 * filter — it now unions in every project-linked dataset's real,
 * binding-resolvable user-origin specs; (2) a user-origin card's visible
 * heading IS the stored spec `title` (confirmed live: both titles below
 * render verbatim as `<h4>` text) — unlike an auto-origin card's
 * auto-derived label, which the ORIGINAL version of this comment was
 * written against. Both declared chart titles are therefore asserted
 * ON SCREEN now, not just over REST.
 *
 * SECOND_CHART_TITLE deliberately picks a chart that renders under the
 * fix's binding-resolvability guard, not the original "group comparison"
 * chart (`Expression by response group...`) — that one lives on a second,
 * count-matrix-shaped dataset whose columns (`pre_expression`, `response`)
 * don't exist on the dataset this page's table/gallery actually queries,
 * so the fix correctly excludes it rather than shipping a blank plot under
 * a real title (see M1's doc). Recommend a dedicated per-card cross-
 * dataset query as a follow-up if "the six, fully merged" is ever required.
 */
const ID = 'M2';
const TITLE = 'Explore — filtered table + chart gallery (Table view)';
const FILTERED_CHART_TITLE = 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1';
const SECOND_CHART_TITLE = 'P-value distribution — tested universe';

export async function captureM2(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  assertPrecondition(ctx.charts.map((c) => c.title));
  await gotoStable(page, `${baseUrl}/projects/${ctx.projectId}/view-analyses/${ctx.analysisId}?chartOrigin=user`);
  await clickResilient(page, page.locator('button[title="Full data table"]'));
  await assertOriginFilterIsUser(ID, page);
  await page.locator('.js-plotly-plot').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await assertTitlesVisible(page);
  return shutter(ID, TITLE, page);
}

/** Pure — exported for unit testing. The REST-level half of AC (both charts
 *  genuinely exist, user-origin) — `assertTitlesVisible` covers the on-
 *  screen half, now achievable post-fix. */
export function assertPrecondition(chartTitles: (string | null)[]): void {
  const has = (t: string) => chartTitles.includes(t);
  if (!has(FILTERED_CHART_TITLE)) throw new Error(`${ID}: precondition failed — filtered-table chart "${FILTERED_CHART_TITLE}" not live`);
  if (!has(SECOND_CHART_TITLE)) throw new Error(`${ID}: precondition failed — second chart "${SECOND_CHART_TITLE}" not live`);
}

async function assertTitlesVisible(page: Page): Promise<void> {
  for (const title of [FILTERED_CHART_TITLE, SECOND_CHART_TITLE]) {
    const visible = await page.locator(`text=${title}`).first().isVisible().catch(() => false);
    if (!visible) throw new Error(`${ID}: precondition failed — "${title}" not visible in the rendered gallery`);
  }
}
