import type { Page } from '@playwright/test';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { clickResilient, gotoStable, shutter, assertOriginFilterIsUser } from './common';
import type { MasterResult } from './types';

/**
 * M4 — Discussion panel, 3 authors, 1 resolved, mention dropdown open.
 * Drawer trigger: `button[aria-label^="Discussion"]` (object-line icon
 * row, research). AC9 (3 distinct authors / >=1 resolved) is already a
 * hard `verify` gate rule (`checkMultiAuthorThreads`) that ran before
 * capture started — this master's own precondition re-asserts the SAME
 * fact against what actually rendered in the DOM.
 *
 * LIVE FINDING (why this no longer checks the fixture's cast display
 * names): a comment's `authorName` is denormalized at CREATE time
 * (`comments.ts`/`snapshotComments.ts`), and `applyCastNamesStep` (which
 * PATCHes "Léa Fontaine" etc. onto the identities' profiles) runs LAST in
 * the `stage` step graph — after every comment already exists. So the
 * internal thread's stored `authorName`s are the IDENTITY_REGISTRY
 * placeholders ("Cast Bioinformatician", ...), not the cast character
 * names, regardless of what the profile says today. This master now
 * asserts against `ctx.internalThreadAuthorNames` (the live, actual
 * values `resolveCaptureContext.ts` reads back), not an assumption.
 *
 * `?chartOrigin=user` RESTORED (AXI-1368 FIX 1 — see M1's own doc for the
 * root cause and fix): the embedded gallery behind this drawer now shows
 * the analysis's real user-created charts instead of "0 charts", so the
 * §19-clean filter is worth applying here too.
 */
const ID = 'M4';
const TITLE = 'Discussion panel — 3 authors, 1 resolved, mention dropdown open';

export async function captureM4(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  assertPrecondition(ctx.internalThreadAuthorNames);
  await gotoStable(page, `${baseUrl}/projects/${ctx.projectId}/view-analyses/${ctx.analysisId}?chartOrigin=user`);
  await assertOriginFilterIsUser(ID, page);
  await clickResilient(page, page.locator('button[aria-label^="Discussion"]'));
  await assertAuthorsVisible(page, ctx.internalThreadAuthorNames);
  await openMentionDropdown(page);
  return shutter(ID, TITLE, page);
}

/** Pure — exported for unit testing (AC14). */
export function assertPrecondition(authorNames: string[]): void {
  if (authorNames.length < 3) throw new Error(`${ID}: precondition failed — only ${authorNames.length} distinct live author name(s) on the internal thread (need >= 3)`);
}

async function assertAuthorsVisible(page: Page, names: string[]): Promise<void> {
  // The comment list loads asynchronously after the drawer opens — wait for
  // the FIRST author to actually render before checking the rest, so a slow
  // fetch never reads as "0 authors" (isVisible() itself never retries).
  await page.locator(`text=${names[0]}`).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  const visible = await Promise.all(names.map((n) => page.locator(`text=${n}`).first().isVisible().catch(() => false)));
  const distinctVisible = visible.filter(Boolean).length;
  if (distinctVisible < 3) throw new Error(`${ID}: precondition failed — only ${distinctVisible}/${names.length} live author name(s) actually visible in the discussion panel`);
}

async function openMentionDropdown(page: Page): Promise<void> {
  const composer = page.locator('[contenteditable="true"], textarea').last();
  await composer.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await composer.click();
  await page.keyboard.type('@');
  await page.locator('[role="listbox"], [role="menu"]').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
}
