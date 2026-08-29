import type { Page } from '@playwright/test';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { clickResilient, gotoStable, shutter, assertOriginFilterIsUser } from './common';
import type { MasterResult } from './types';

/**
 * M1 — Question + Assumptions popover open + user-created charts (wide).
 * Page: `/projects/:projectId/view-analyses/:analysisId` (Workspace tab,
 * the default `activeTab`). "Wide" = the `Fields` view-mode toggle
 * (`ViewAnalysisObjectLine`/`ProjectViewAnalysisDetail.tsx` research:
 * `button[title="Compact field list (more room for charts)"]`), which
 * shrinks the left pane to 208px and gives the chart grid the rest.
 *
 * `?chartOrigin=user` RESTORED (AXI-1368 FIX 1, SI-033): the embedded
 * gallery's "User-created" filter previously returned 0 charts because it
 * queried candidates against `effectiveDatasetId` (the CURRENTLY ACTIVE
 * snapshot's own dataset), not the dataset(s) this analysis's real
 * user-created charts actually live on — confirmed live: the default
 * snapshot here is the v2 stratified snapshot, linked to a THIRD dataset
 * that has zero user-origin specs. `DatasetVisualizations.tsx` now unions
 * in each project-linked dataset's user-origin specs (never its
 * auto-origin ones — AC6/§19 stays intact) via a new
 * `originScanDatasetIds` prop `ProjectViewAnalysisDetail.tsx` populates
 * from `GET /projects/:id/datasets`, filtered to only the specs whose
 * bindings actually resolve against the page's currently-loaded columns
 * (a cross-dataset chart with unbindable columns would render a blank
 * plot under a real title, which is worse than the auto-candidate leak
 * this fix exists to remove). Live result on this tenant: filtering to
 * "User-created" now shows the 4 real, correctly-rendering user charts
 * bound to the analysis's own dataset (2 more live on a second, count-
 * matrix-shaped dataset whose columns don't resolve against this page's
 * loaded set — a disclosed, narrower remainder of the pre-existing
 * multi-dataset gallery gap, not a §19 leak).
 */
const ID = 'M1';
const TITLE = 'Question + Assumptions popover + user-created charts (wide)';

export async function captureM1(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  const userCharts = ctx.charts.filter((c) => c.origin === 'user');
  assertPrecondition(userCharts.length);
  await gotoStable(page, `${baseUrl}/projects/${ctx.projectId}/view-analyses/${ctx.analysisId}?chartOrigin=user`);
  await clickResilient(page, page.locator('button[title="Compact field list (more room for charts)"]'));
  await clickResilient(page, page.locator('button:has-text("Assumptions")').first());
  await page.getByRole('button', { name: /add assumption/i }).waitFor({ state: 'visible' }).catch(() => undefined);
  await assertOriginFilterIsUser(ID, page);
  await page.locator('.js-plotly-plot').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return shutter(ID, TITLE, page);
}

/** Pure — exported for unit testing (AC14: "preconditions asserted in code"). */
export function assertPrecondition(userChartCount: number): void {
  if (userChartCount < 1) throw new Error(`${ID}: precondition failed — no live user-origin chart found (need >= 1)`);
}
