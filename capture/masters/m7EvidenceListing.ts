import type { Page } from '@playwright/test';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { clickResilient, gotoStable, shutter } from './common';
import type { MasterResult } from './types';

/**
 * M7 — Evidence listing, 6 entries. `activeTab === 'evidences'` on
 * `ProjectViewAnalysisDetail` renders `<EvidenceListing>` (research) — a
 * `role="tab"` button with accessible name "Evidence" selects it (no
 * dedicated testid on the tab list, but it IS a real ARIA tablist).
 */
const ID = 'M7';
const TITLE = 'Evidence listing, 6 entries';
const EXPECTED_COUNT = 6;

export async function captureM7(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  assertPrecondition(ctx.evidence.length);
  await gotoStable(page, `${baseUrl}/projects/${ctx.projectId}/view-analyses/${ctx.analysisId}`);
  await clickResilient(page, page.getByRole('tab', { name: /evidence/i }));
  await page.locator(`text=${ctx.evidence[0]!.title}`).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return shutter(ID, TITLE, page);
}

/** Pure — exported for unit testing. AC14 names "6 entries" as this
 *  master's own precondition, so a wrong count fails the master loudly
 *  (FR19) rather than shipping a frame with a stale/duplicated count —
 *  `verify` has no dedicated evidence-count rule today (a disclosed gap,
 *  see the story report), so this is the only place that count is checked. */
export function assertPrecondition(count: number): void {
  if (count !== EXPECTED_COUNT) throw new Error(`${ID}: precondition failed — live evidence count is ${count}, Capture Spec §9 requires exactly ${EXPECTED_COUNT}`);
}
