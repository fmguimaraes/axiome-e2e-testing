import type { Page } from '@playwright/test';
import { assertProvenanceStampLegible } from '../../staging/steps/sponsorExportStaging';
import { SERVICE_HANDLE } from '../../staging/steps/context';
import { projectHeaders } from '../../staging/steps/projectProvisioning';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { gotoStable, shutter } from './common';
import type { MasterResult } from './types';

/**
 * M9 — co-branded PDF, generated with the provenance stamp. `ExportPreview`
 * (research) renders the real sponsor-report HTML inline as A4 pages, each
 * inside its own `<iframe>`, inside `.export-preview-canvas` — not a bare
 * download link, so navigating there with the resolved `publishedVersionId`
 * IS the "generated PDF" frame; the "Download PDF" button is deliberately
 * never clicked (that path opens a real file download, which a headless
 * capture cannot screenshot anyway).
 *
 * The precondition is asserted against the SAME raw preview HTML the
 * backend serves (`GET /exports/sponsor/:publishedVersionId/preview`), not
 * the rendered DOM — the per-page content lives inside `<iframe>` elements,
 * so the parent canvas's own `innerHTML`/`innerText` would not contain it.
 * Reuses `sponsorExportStaging.ts`'s `assertProvenanceStampLegible` (the
 * same check AXI-1379 already proved this HTML passes) rather than
 * redefining "legible" a second time (DRY).
 */
const ID = 'M9';
const TITLE = 'Co-branded sponsor export — provenance stamp';

export async function captureM9(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  assertPublishedVersionExists(ctx.publishedVersionId);
  const html = await fetchPreviewHtml(ctx, ctx.publishedVersionId!);
  assertProvenanceStampLegible(html);
  const url = `${baseUrl}/sponsor-review/views/${ctx.publishedVersionId}/export-preview`;
  await gotoStable(page, url);
  await page.locator('.export-preview-canvas').waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return shutter(ID, TITLE, page);
}

async function fetchPreviewHtml(ctx: CaptureContext, publishedVersionId: string): Promise<string> {
  const res = await ctx.client.as<string>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/exports/sponsor/${publishedVersionId}/preview?renderMode=sponsor`,
    undefined,
    projectHeaders(ctx.workspaceId),
  );
  if (!res.ok) throw new Error(`${ID}: fetching the sponsor export preview failed (status ${res.status})`);
  return res.raw;
}

/** Pure — exported for unit testing. */
export function assertPublishedVersionExists(publishedVersionId: string | undefined): void {
  if (!publishedVersionId) throw new Error(`${ID}: precondition failed — no published version live`);
}
