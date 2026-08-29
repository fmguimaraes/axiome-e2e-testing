import type { Page } from '@playwright/test';
import { SERVICE_HANDLE } from '../../staging/steps/context';
import { projectHeaders } from '../../staging/steps/projectProvisioning';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { clickResilient, gotoStable, shutter } from './common';
import { blocked } from './types';
import type { MasterResult } from './types';

/**
 * M10 — subject delta view (paired T1/T2). RESOLVED (AXI-1368 FIX 3).
 *
 * CORRECTED PREMISE, found by re-reading `SubjectCompleteView.tsx` (not by
 * trusting this module's own prior investigation note): the view does NOT
 * read the Subject-Management REST domain (`/subjects`, `/subject-
 * timepoints`, `/subject-rows`, `/subject-panels` — AXI-1244/1245) at all.
 * It queries `POST /workspaces/:id/datasets/:datasetId/query` — the SAME
 * route every other gallery/table view in this tenant uses — and pivots
 * the rows client-side (`lib/subjectView/mapToCards.ts`). A "wide format"
 * dataset (a `subjectId` column + >=2 remaining columns, which become the
 * timepoint columns) is all `SubjectCompleteView` needs to compute a real
 * Δ. `staging/steps/subjectStaging.ts` stages exactly that: a small,
 * ordinary CSV dataset (`riaz2017_subject_paired_timepoints.csv` — 6
 * synthetic subjects × 3 real checkpoint genes × invented T1/T2 values,
 * NFR8-clean) ingested through the tenant's normal upload path, bound to
 * its own dedicated view-analysis (kept OUTSIDE `content.datasets[]` so
 * AC5's "one corpus" rule never sees it — see that step's own doc).
 *
 * Verified live: Tiles view renders 6 subject cards with T1/T2 values;
 * "Complete view" opens `SubjectCompleteView`, which renders
 * "Δ interval T1 → T2" plus a real per-feature Δ (e.g. PDCD1 8.2→3.1,
 * Δ=-5.100) — genuine paired-timepoint delta math, not a placeholder.
 */
const ID = 'M10';
const TITLE = 'Subject delta view (paired T1/T2)';

export async function captureM10(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  if (!ctx.subjectAnalysisId) {
    return blocked(
      ID,
      TITLE,
      'no subject-paired-timepoints analysis live — staging/steps/subjectStaging.ts has not run against this tenant (run `npm run stage` to converge it).',
    );
  }
  const subjectCount = await fetchSubjectRowCount(ctx);
  assertPrecondition(subjectCount);

  await gotoStable(page, `${baseUrl}/projects/${ctx.projectId}/view-analyses/${ctx.subjectAnalysisId}`);
  await clickResilient(page, page.locator('button[title="Subject tile cards"]'));
  await page.locator('button:has-text("Complete view")').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await clickResilient(page, page.locator('button:has-text("Complete view")').first());
  await page.locator('text=Δ interval').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return shutter(ID, TITLE, page);
}

/** Pure — exported for unit testing (AC14). */
export function assertPrecondition(subjectRowCount: number): void {
  if (subjectRowCount < 1) throw new Error(`${ID}: precondition failed — no rows live in the subject-paired-timepoints dataset (need >= 1)`);
}

async function fetchSubjectRowCount(ctx: CaptureContext): Promise<number> {
  // Cheap live check (distinct from the DOM wait below) — a dataset that
  // ingested but came back empty should fail loud here, not read as "0
  // subjects rendered" after a 90s DOM timeout.
  const res = await ctx.client.as<{ rows: unknown[] }>(
    SERVICE_HANDLE,
    'POST',
    `/api/v1/workspaces/${ctx.workspaceId}/datasets/${await subjectDatasetId(ctx)}/query`,
    { filters: [], limit: 1, offset: 0 },
    projectHeaders(ctx.workspaceId),
  );
  if (!res.ok || !res.body) return 0;
  return res.body.rows?.length ?? 0;
}

async function subjectDatasetId(ctx: CaptureContext): Promise<string> {
  const res = await ctx.client.as<{ datasetId: string }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/view-analyses/${ctx.subjectAnalysisId}`,
    undefined,
    projectHeaders(ctx.workspaceId),
  );
  if (!res.ok || !res.body) throw new Error(`${ID}: could not resolve the subject-paired-timepoints dataset id (status ${res.status})`);
  return res.body.datasetId;
}
