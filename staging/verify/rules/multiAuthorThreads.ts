import { SERVICE_HANDLE } from '../../steps/context';
import { projectHeaders } from '../../steps/projectProvisioning';
import { pass, fail } from '../types';
import type { ProvisioningContext } from '../../steps/context';
import type { VerifyDeps } from '../deps';
import type { RuleResult } from '../types';

/**
 * Capture Spec §7/AC9 — "≥ 3 distinct authors, ≥ 1 reply, ≥ 1 resolved" on
 * the internal thread; the four chart-anchored comments (a "tab count"
 * FR18 names); the external thread non-zero and authored, on the client
 * side, solely by the external stakeholder. Three independent live reads,
 * folded into one RuleResult because they are all facets of the same
 * Capture Spec §7 "comments" surface.
 */
const RULE = 'Capture Spec §7/AC9 — multi-author threads, chart-anchored count';
const COMMENT_DASHBOARD_NAME = 'Chart discussion anchors';

interface InternalComment {
  authorId: string;
  status: string;
  replies: { authorId: string }[];
}

interface ExternalComment {
  authorId: string;
  authorType: string;
}

interface DashboardSummary {
  id: string;
  name: string;
}

interface DashboardVisualizationSummary {
  id: string;
}

interface Verdict {
  ok: boolean;
  detail: string;
}

export async function checkMultiAuthorThreads(ctx: ProvisioningContext, deps: VerifyDeps): Promise<RuleResult> {
  const internal = evaluateInternalThread(await fetchInternalThread(ctx, deps));
  if (!internal.ok) return fail(RULE, internal.detail);
  const external = evaluateExternalThread(await fetchExternalThread(ctx, deps));
  if (!external.ok) return fail(RULE, external.detail);
  const chartAnchored = evaluateChartAnchoredCount(await fetchChartAnchoredCount(ctx, deps), ctx.fixture.content.comments.chartAnchored.length);
  if (!chartAnchored.ok) return fail(RULE, chartAnchored.detail);
  return pass(RULE, `${internal.detail}; ${external.detail}; ${chartAnchored.detail}`);
}

async function fetchInternalThread(ctx: ProvisioningContext, deps: VerifyDeps): Promise<InternalComment[]> {
  const res = await ctx.client.as<{ comments: InternalComment[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/snapshot-comments?anchorType=view_analysis&anchorId=${deps.analysisId}`,
    undefined,
    projectHeaders(deps.workspaceId),
  );
  return res.body?.comments ?? [];
}

/** Pure — exported for unit testing. */
export function evaluateInternalThread(comments: InternalComment[]): Verdict {
  const authors = new Set(comments.flatMap((c) => [c.authorId, ...c.replies.map((r) => r.authorId)]));
  const hasReply = comments.some((c) => c.replies.length > 0);
  const hasResolved = comments.some((c) => c.status === 'resolved');
  if (authors.size < 3) return { ok: false, detail: `internal thread has only ${authors.size} distinct author(s), need >= 3` };
  if (!hasReply) return { ok: false, detail: 'internal thread has no reply' };
  if (!hasResolved) return { ok: false, detail: 'internal thread has no resolved comment' };
  return { ok: true, detail: `internal thread: ${authors.size} authors, reply present, resolved present` };
}

async function fetchExternalThread(ctx: ProvisioningContext, deps: VerifyDeps): Promise<ExternalComment[]> {
  const res = await ctx.client.as<{ comments: ExternalComment[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/projects/${deps.projectId}/client-exploration/artifacts/${deps.analysisId}/comments`,
  );
  return res.body?.comments ?? [];
}

/** Pure — exported for unit testing. An internal-side reply on the external
 *  thread does not violate AC9 — only the CLIENT (external) side must be a
 *  single author (`commentStaging.ts`'s module doc). */
export function evaluateExternalThread(comments: ExternalComment[]): Verdict {
  if (comments.length === 0) return { ok: false, detail: 'external thread is empty' };
  const clientAuthors = new Set(comments.filter((c) => c.authorType === 'client').map((c) => c.authorId));
  if (clientAuthors.size === 0) return { ok: false, detail: 'external thread has no client-side (external stakeholder) message' };
  if (clientAuthors.size > 1) return { ok: false, detail: `external thread client side has ${clientAuthors.size} distinct authors, expected exactly 1` };
  return { ok: true, detail: `external thread: ${comments.length} message(s), 1 external author` };
}

/** Pure — exported for unit testing. */
export function evaluateChartAnchoredCount(live: number, declared: number): Verdict {
  if (live !== declared) return { ok: false, detail: `${live} chart-anchored comment(s) live, expected ${declared}` };
  return { ok: true, detail: `${live} chart-anchored comment(s)` };
}

async function fetchChartAnchoredCount(ctx: ProvisioningContext, deps: VerifyDeps): Promise<number> {
  const dashboard = await findCommentDashboard(ctx, deps);
  if (!dashboard) return 0;
  const links = await fetchDashboardVisualizations(ctx, deps.workspaceId, dashboard.id);
  const counts = await Promise.all(links.map((l) => fetchChartCommentCount(ctx, deps.workspaceId, l.id)));
  return counts.reduce((a, b) => a + b, 0);
}

async function findCommentDashboard(ctx: ProvisioningContext, deps: VerifyDeps): Promise<DashboardSummary | undefined> {
  const res = await ctx.client.as<{ data: DashboardSummary[] } | DashboardSummary[]>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/dashboards?projectId=${deps.projectId}`,
    undefined,
    projectHeaders(deps.workspaceId),
  );
  const body = res.body;
  const all = Array.isArray(body) ? body : (body?.data ?? []);
  return all.find((d) => d.name === COMMENT_DASHBOARD_NAME);
}

async function fetchDashboardVisualizations(ctx: ProvisioningContext, workspaceId: string, dashboardId: string): Promise<DashboardVisualizationSummary[]> {
  const res = await ctx.client.as<{ data: DashboardVisualizationSummary[] } | DashboardVisualizationSummary[]>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/dashboards/${dashboardId}/visualizations`,
    undefined,
    projectHeaders(workspaceId),
  );
  const body = res.body;
  return Array.isArray(body) ? body : (body?.data ?? []);
}

async function fetchChartCommentCount(ctx: ProvisioningContext, workspaceId: string, dashboardVisualizationId: string): Promise<number> {
  const res = await ctx.client.as<{ data: unknown[] } | unknown[]>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/comments?dashboardVisualizationId=${dashboardVisualizationId}`,
    undefined,
    projectHeaders(workspaceId),
  );
  const body = res.body;
  return Array.isArray(body) ? body.length : (body?.data.length ?? 0);
}
