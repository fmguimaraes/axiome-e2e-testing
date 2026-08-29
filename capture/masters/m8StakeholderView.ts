import type { Page } from '@playwright/test';
import { SERVICE_HANDLE } from '../../staging/steps/context';
import { projectHeaders } from '../../staging/steps/projectProvisioning';
import type { CaptureContext } from '../resolveCaptureContext';
import { loginAsUi } from './login';
import { clickResilient, disableAnimations, dismissOnboardingIfPresent, shutter } from './common';
import { ACTION_TIMEOUT_MS } from '../config';
import type { MasterResult } from './types';

/**
 * M8 — stakeholder view, from Daniel Reiss's own seat (external session).
 * A SEPARATE UI login (external-stakeholder), not the default admin/service
 * session every other master reuses (Capture Spec §12 / dev-epic-context:
 * "no display-name override would satisfy this honestly").
 *
 * FINDING (disclosed, not fabricated around): `/client-exploration/workspace`
 * (`ClientExplorationWorkspace.tsx`, confirmed by source read) shows the
 * published-artifact list + a Provenance/Compare panel, but has NO
 * comments/discussion UI at all. The external THREAD only renders inside
 * the internal analysis-detail page's Discussion drawer
 * (`discussionTab==='external'`), which is workspace-membership-gated — a
 * page the external stakeholder structurally cannot open (AXI-1378: they
 * hold a `ClientExplorationMembership`, never a `WorkspaceMember` row). So
 * this master captures the external stakeholder's REAL, reachable seat —
 * the published-artifact workspace — not a fabricated "thread visible here"
 * frame. The REST-level fact (AC12: an authenticated request as external
 * returns the published record AND the external thread) is already proven
 * by `verify`'s `checkExternalScoping` rule; it is a UI gap, not a
 * staging/capture defect, that no single screen shows both today.
 */
const ID = 'M8';
const TITLE = "Stakeholder view — Daniel Reiss's external session (published artifacts)";

export async function captureM8(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  const artifactCount = await fetchPublishedArtifactCount(ctx);
  assertPrecondition(artifactCount);
  await loginAsUi(page, baseUrl, 'external-stakeholder');
  await page.goto(`${baseUrl}/client-exploration/workspace`, { waitUntil: 'domcontentloaded' });
  await disableAnimations(page);
  await dismissOnboardingIfPresent(page);
  await page.locator('text=Provider Published').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  await clickResilient(page, page.locator('button').filter({ has: page.locator('text=Provider Published') }).first());
  await page.locator('text=Provenance').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return shutter(ID, TITLE, page);
}

/** Real response shape: `{ artifacts: [...], total }` — confirmed against
 *  the frontend's own client (`axiome-front/src/lib/api/clientExploration.ts`
 *  `getPublishedArtifacts`), not the generic `{data: [...]}` envelope most
 *  other list routes in this toolkit use. */
async function fetchPublishedArtifactCount(ctx: CaptureContext): Promise<number> {
  const res = await ctx.client.as<{ artifacts: unknown[]; total: number }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/projects/${ctx.projectId}/client-exploration/published-artifacts`,
    undefined,
    projectHeaders(ctx.workspaceId),
  );
  if (!res.ok) throw new Error(`${ID}: fetching published artifacts failed (status ${res.status})`);
  return res.body?.artifacts?.length ?? 0;
}

/** Pure — exported for unit testing. */
export function assertPrecondition(publishedArtifactCount: number): void {
  if (publishedArtifactCount < 1) throw new Error(`${ID}: precondition failed — no published artifact visible to the external stakeholder`);
}
