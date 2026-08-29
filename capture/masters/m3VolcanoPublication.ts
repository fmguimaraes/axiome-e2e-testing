import type { Page } from '@playwright/test';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { gotoStable, shutter } from './common';
import type { ExistingSpec } from '../../staging/steps/chartStaging';
import type { MasterResult } from './types';

/**
 * M3 — Volcano detail, publication mode, a significant point hovered.
 * `/datasets/:datasetId/chart/:specId?displayMode=publication` is the ONE
 * confirmed genuine deep-link query param for this page (research:
 * `DatasetChart.tsx` reads `displayMode` from `searchParams`; `chartOrigin`
 * is read by the gallery, not this page). Hover targets the first rendered
 * Plotly data point — real hover, not a synthetic tooltip.
 */
const ID = 'M3';
const TITLE = 'Volcano detail, publication mode, hovered significant point';
const VOLCANO_TITLE = 'Volcano — pre-therapy responders vs non-responders (baseMean ≥ 10)';

export async function captureM3(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  const spec = findVolcanoSpec(ctx.charts);
  assertPrecondition(spec);
  const url = `${baseUrl}/datasets/${ctx.deTableDatasetId}/chart/${spec!.id}?displayMode=publication`;
  await gotoStable(page, url);
  await page.locator('.js-plotly-plot').waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await hoverASignificantPoint(page);
  return shutter(ID, TITLE, page);
}

/** Pure — exported for unit testing. */
export function findVolcanoSpec(charts: ExistingSpec[]): ExistingSpec | undefined {
  return charts.find((c) => c.title === VOLCANO_TITLE && c.origin === 'user');
}

/** Pure — exported for unit testing. */
export function assertPrecondition(spec: ExistingSpec | undefined): void {
  if (!spec) throw new Error(`${ID}: precondition failed — user-origin volcano spec "${VOLCANO_TITLE}" not live`);
}

/**
 * Hovers the plot's drag-rect (`.nsewdrag`, the pointer-capture layer every
 * Plotly chart renders regardless of trace type), NOT an individual point
 * DOM element. This dataset is 22,333 rows — Plotly's own `traceType =
 * rows.length > 1000 ? 'scattergl' : 'scatter'` (confirmed by source read,
 * `specialized.builders.ts`) means the volcano renders via WebGL canvas,
 * where individual points have no DOM node to hover at all. Plotly computes
 * the nearest point to the cursor and shows its native tooltip regardless
 * of render mode, so hovering the upper-right quadrant (where significant
 * up-regulated points cluster on this −log10(p)-by-log2FC chart) reliably
 * lands the hover on a real significant point without needing its DOM node.
 */
async function hoverASignificantPoint(page: Page): Promise<void> {
  const dragRect = page.locator('.js-plotly-plot .nsewdrag').first();
  await dragRect.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  const box = await dragRect.boundingBox();
  if (!box) throw new Error(`${ID}: precondition failed — plot drag layer has no bounding box to hover`);
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.15);
  await page.locator('.hoverlayer, .plotly-notifier').first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
}
