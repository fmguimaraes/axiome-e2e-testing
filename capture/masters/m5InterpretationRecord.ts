import type { Page } from '@playwright/test';
import { findApprovedInterpretation } from '../resolveCaptureContext';
import type { CaptureContext, Decision } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { gotoStable, shutter } from './common';
import type { MasterResult } from './types';

/**
 * M5 — Interpretation record (statement/cited evidence/author/timestamp).
 * `DecisionDraftDetail` (research): statement = `currentDraft.label`
 * rendered as the page `<h1>`; cited evidence = the "Evidence (N)" heading
 * inside the embedded `EvidenceListing`; author/timestamp = the
 * "Created by"/"Created" provenance panel. Targets the one APPROVED
 * interpretation (Capture Spec §9/EC4's published finding).
 */
const ID = 'M5';
const TITLE = 'Interpretation record — statement, cited evidence, author, timestamp';

export async function captureM5(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  const decision = findApprovedInterpretation(ctx.decisions);
  assertPrecondition(decision);
  const url = `${baseUrl}/projects/${ctx.projectId}/view-analyses/${ctx.analysisId}/decisions/${decision!.id}`;
  await gotoStable(page, url);
  await page.locator('h1').filter({ hasText: decision!.label }).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await page.locator('text=/Evidence \\(\\d+\\)/').waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await page.locator('text=Created by').waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return shutter(ID, TITLE, page);
}

/** Pure — exported for unit testing. */
export function assertPrecondition(decision: Decision | undefined): void {
  if (!decision) throw new Error(`${ID}: precondition failed — no interpretation with status "approved" is live`);
}
