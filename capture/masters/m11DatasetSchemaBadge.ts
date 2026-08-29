import type { Page } from '@playwright/test';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { gotoStable, shutter } from './common';
import type { MasterResult } from './types';

/**
 * M11 — dataset header RNA-Seq DE schema badge + declare action.
 * `DatasetDetail` (research) has a REAL testid for this one, unlike every
 * other master here: `span[data-testid="de-schema-fingerprint-badge"]`.
 * Project mode (`/projects/:projectId/datasets/:datasetId`) is used so the
 * "Declare DE Evidence" action is eligible to render (it requires project
 * context, research: `isProjectMode || topMenuProjectId`).
 */
const ID = 'M11';
const TITLE = 'Dataset header — RNA-Seq DE schema badge + declare action';

export async function captureM11(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  await gotoStable(page, `${baseUrl}/projects/${ctx.projectId}/datasets/${ctx.deTableDatasetId}`);
  const badge = page.locator('[data-testid="de-schema-fingerprint-badge"]');
  await assertBadgeVisible(badge);
  await page.locator('button', { hasText: /declare de evidence|show de evidence/i }).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return shutter(ID, TITLE, page);
}

async function assertBadgeVisible(badge: ReturnType<Page['locator']>): Promise<void> {
  const appeared = await badge
    .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!appeared) throw new Error(`${ID}: precondition failed — de-schema-fingerprint-badge not visible on the dataset header`);
}
