import type { Page } from '@playwright/test';
import { SERVICE_HANDLE } from '../../staging/steps/context';
import { projectHeaders } from '../../staging/steps/projectProvisioning';
import type { CaptureContext } from '../resolveCaptureContext';
import { ACTION_TIMEOUT_MS } from '../config';
import { gotoStable, shutter } from './common';
import type { MasterResult } from './types';

/**
 * M6 — Provenance graph, dataset -> validated interpretation, with a fork.
 * `ProjectViewAnalysisProvenance` (research) mounts a real `@xyflow/react`
 * graph, ready-selector `.react-flow`. The fork check re-derives the same
 * fact `interpretationsEvidenceStaging.ts`'s module doc already proves live
 * (two interpretations citing the same Evidence node by id = 2 incoming
 * INFORMED edges) — a node with indegree >= 2 is a fork.
 */
const ID = 'M6';
const TITLE = 'Provenance graph — dataset to interpretation, with a fork';

interface ProvenanceEdge {
  targetNodeId: string;
}

export async function captureM6(page: Page, baseUrl: string, ctx: CaptureContext): Promise<MasterResult> {
  const edges = await fetchProvenanceEdges(ctx);
  assertPrecondition(edges);
  const url = `${baseUrl}/projects/${ctx.projectId}/view-analyses/${ctx.analysisId}/provenance`;
  await gotoStable(page, url);
  await page.locator('.react-flow').waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
  return shutter(ID, TITLE, page);
}

async function fetchProvenanceEdges(ctx: CaptureContext): Promise<ProvenanceEdge[]> {
  const res = await ctx.client.as<{ edges: ProvenanceEdge[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/view-analyses/${ctx.analysisId}/provenance-graph`,
    undefined,
    projectHeaders(ctx.workspaceId),
  );
  if (!res.ok) throw new Error(`${ID}: fetching the provenance graph failed (status ${res.status})`);
  return res.body?.edges ?? [];
}

/** Pure — exported for unit testing (AC11: "at least one fork"). */
export function hasFork(edges: ProvenanceEdge[]): boolean {
  const targetCounts = new Map<string, number>();
  for (const e of edges) targetCounts.set(e.targetNodeId, (targetCounts.get(e.targetNodeId) ?? 0) + 1);
  return [...targetCounts.values()].some((count) => count >= 2);
}

export function assertPrecondition(edges: ProvenanceEdge[]): void {
  if (!hasFork(edges)) throw new Error(`${ID}: precondition failed — no provenance node has >= 2 incoming edges (no fork)`);
}
