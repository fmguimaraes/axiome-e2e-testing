import { SERVICE_HANDLE, recordTouched } from './context';
import { requireWorkspaceId, requireProjectId } from './datasetIngestion';
import { findExistingAnalysis, requireDatasetId } from './analysisFraming';
import { fetchExistingSpecs, requireAnalysisId } from './chartStaging';
import { ensureMemberRole } from './workspaceMembership';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type {
  ChartAnchoredCommentFixture,
  CommentReplyFixture,
  CommentsFixture,
  ExternalThreadMessageFixture,
  InternalCommentFixture,
} from '../fixtures/types';
import type { ExistingSpec } from './chartStaging';
import type { Step } from './types';

/**
 * FR10/AC9 (AXI-1375, Capture Spec §7) — stages the three comment surfaces
 * on the AXI-1373 analysis (`cf17e1ea`): the internal analysis-level thread,
 * the four chart-anchored comments, and the external stakeholder thread.
 *
 * THREAD-TYPE FINDING (this story's investigation, corrects the AXI-1369
 * audit catalog's labeling — see `staging/audit/actionCatalog.ts`): the
 * Discussion tab's internal thread — the one with type badges
 * (Assumption/QC concern/Question/Interpretation note) — is backed by
 * `/api/v1/snapshot-comments` with `anchorType: 'view_analysis'`, confirmed
 * against `axiome-front/src/components/SnapshotDiscussionPanel.tsx` (which
 * renders `SNAPSHOT_COMMENT_TYPE_LABELS[comment.commentType]`) and its data
 * source `snapshotComments.ts`. `/api/v1/comments` (chart-comments) is what
 * actually backs CHART-anchored comments (`axiome-front/src/components/
 * ChartComments.tsx`), keyed on `dashboardVisualizationId` — it has no
 * `commentType` field at all, so it structurally cannot be the type-badged
 * surface. The catalog's "create-analysis-comment" -> `/api/v1/comments`
 * label predates this investigation and is corrected here.
 *
 * RESOLVE: `/api/v1/snapshot-comments` already has resolve/reopen (AXI-1369
 * confirmed this live) — so the one comment Capture Spec §7.1 requires
 * RESOLVED (the LF "Volcano y-axis" QC concern) resolves live against the
 * RUNNING backend today, no deploy required. `/api/v1/comments`
 * (chart-comments) did NOT have resolve — that gap is closed in this same
 * story on the backend (SI-019, `chart-comments.controller.ts`
 * `/comments/:id/resolve` + `/reopen`), but none of the four §7.2
 * chart-anchored comments need resolving, so nothing here depends on that
 * fix being deployed to the RUNNING stack to converge live.
 *
 * CHART ANCHORING: a chart-anchored comment needs a `DashboardVisualization`
 * row, which is a SEPARATE entity from the `DataviewSpec`/candidate
 * `chartStaging.ts` creates (confirmed by reading `dashboards.service.ts` —
 * no auto-creation trigger exists between the two). This step ensures one
 * `ProjectDashboard` exists for the analysis project, links each of the four
 * target charts' candidate onto it (`POST /dashboards/:id/visualizations`),
 * and only then can comment on the resulting `dashboardVisualizationId`.
 *
 * EXTERNAL THREAD: `POST /projects/:projectId/client-exploration/artifacts/
 * :artifactId/comments` requires `artifactId` to be a PUBLISHED client-
 * exploration artifact (`ClientExplorationPublishedArtifact`, matched by
 * `(configId, artifactId)` only — `artifactType` is free text, never
 * validated against the id it's attached to). No snapshot or published
 * interpretation exists yet in this tenant (those are later stories), so
 * this step publishes the view-analysis itself as the artifact
 * (`artifactType: 'view_analysis'`) — a legitimate, defensible anchor for
 * THIS story's thread, distinct from and not a substitute for AXI-1377's
 * eventual "publish one interpretation" governance action (FR12). Both the
 * external stakeholder (`authorType: 'client'`) and an internal cast member
 * (`authorType: 'internal'`) post through the SAME route — the route itself
 * only checks `AuthGuard` (any authenticated caller), confirmed against
 * `client-exploration-comments.controller.ts`; there is no separate
 * internal-reply mechanism. AC9's "authored solely by the external
 * stakeholder" is read as scoping the EXTERNAL side of the boundary (no
 * other client-side author), which CN's internal-side reply does not
 * violate.
 */
export const ensureCommentsStep: Step<ProvisioningContext> = {
  id: 'ensure-comments',
  dependsOn: ['ensure-charts'],
  async run(ctx) {
    const content = ctx.fixture.content;
    const primary = content.datasets.find((d) => d.role === 'de_table');
    if (!primary) return;
    const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
    const datasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
    const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, datasetId);

    await grantCommentAuthorAccess(ctx, workspaceId, content.comments);
    await ensureInternalThread(ctx, workspaceId, analysisId, content.comments.internalThread);
    await ensureChartAnchoredComments(ctx, workspaceId, projectId, datasetId, analysisId, content.comments.chartAnchored);
    await ensureExternalThread(ctx, workspaceId, projectId, analysisId, content.comments.externalThread);
  },
};

const COMMENT_WORKSPACE_ROLE = 'editor';

/** Exported for unit testing — pure, no network. Every internal-side author
 *  across the internal thread (including reply authors) and the
 *  chart-anchored comments needs workspace membership to comment at all
 *  (`WorkspaceGuard`) — the external stakeholder is deliberately excluded,
 *  the whole point of the client-exploration surface being a non-member
 *  boundary. */
export function resolveCommentAuthorHandles(comments: CommentsFixture): string[] {
  const handles = new Set<string>();
  for (const c of comments.internalThread) {
    handles.add(c.authorHandle);
    for (const r of c.replies ?? []) handles.add(r.authorHandle);
  }
  for (const c of comments.chartAnchored) handles.add(c.authorHandle);
  for (const m of comments.externalThread) if (m.authorType === 'internal') handles.add(m.authorHandle);
  return [...handles];
}

async function grantCommentAuthorAccess(ctx: ProvisioningContext, workspaceId: string, comments: CommentsFixture): Promise<void> {
  for (const handle of resolveCommentAuthorHandles(comments)) await ensureMemberRole(ctx, workspaceId, handle, COMMENT_WORKSPACE_ROLE);
}

// ─── §7.1 Internal thread (snapshot-comments) ──────────────────────────────

interface ExistingSnapshotComment {
  id: string;
  commentType: string;
  content: string;
  status: string;
  replies: ExistingSnapshotComment[];
}

/** Exported for unit testing — pure, no network (NFR1 idempotency, mirrors
 *  `analysisFraming.ts`'s `alreadyStaged`). Matches on (type, text) among
 *  non-deleted top-level comments — replies are checked separately by the
 *  caller once the parent is known. */
export function alreadyStagedInternalComment(existing: ExistingSnapshotComment[], comment: InternalCommentFixture): ExistingSnapshotComment | undefined {
  return existing.find((e) => e.commentType === comment.type && e.content === comment.text);
}

/** Exported for unit testing — pure, no network. */
export function alreadyStagedReply(existingReplies: ExistingSnapshotComment[], reply: CommentReplyFixture): boolean {
  return existingReplies.some((r) => r.content === reply.text);
}

async function ensureInternalThread(ctx: ProvisioningContext, workspaceId: string, analysisId: string, comments: InternalCommentFixture[]): Promise<void> {
  const existing = await fetchInternalThread(ctx, workspaceId, analysisId);
  for (const comment of comments) await ensureOneInternalComment(ctx, workspaceId, analysisId, comment, existing);
}

async function fetchInternalThread(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<ExistingSnapshotComment[]> {
  const res = await ctx.client.as<{ comments: ExistingSnapshotComment[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/snapshot-comments?anchorType=view_analysis&anchorId=${analysisId}`,
    undefined,
    projectHeaders(workspaceId),
  );
  return res.body?.comments ?? [];
}

async function ensureOneInternalComment(
  ctx: ProvisioningContext,
  workspaceId: string,
  analysisId: string,
  comment: InternalCommentFixture,
  existing: ExistingSnapshotComment[],
): Promise<void> {
  const found = alreadyStagedInternalComment(existing, comment);
  const record = found ?? (await createInternalComment(ctx, workspaceId, analysisId, comment));
  await ensureReplies(ctx, workspaceId, analysisId, record.id, comment, found?.replies ?? []);
  if (comment.resolved) await ensureResolved(ctx, workspaceId, record.id, found?.status);
}

async function ensureReplies(
  ctx: ProvisioningContext,
  workspaceId: string,
  analysisId: string,
  parentCommentId: string,
  comment: InternalCommentFixture,
  existingReplies: ExistingSnapshotComment[],
): Promise<void> {
  for (const reply of comment.replies ?? []) {
    if (alreadyStagedReply(existingReplies, reply)) continue;
    await createInternalComment(ctx, workspaceId, analysisId, { type: comment.type, authorHandle: reply.authorHandle, text: reply.text }, parentCommentId);
  }
}

async function createInternalComment(
  ctx: ProvisioningContext,
  workspaceId: string,
  analysisId: string,
  comment: InternalCommentFixture,
  parentCommentId?: string,
): Promise<ExistingSnapshotComment> {
  const body = { anchorType: 'view_analysis', anchorId: analysisId, commentType: comment.type, content: comment.text, parentCommentId };
  const res = await ctx.client.as<ExistingSnapshotComment>(comment.authorHandle, 'POST', '/api/v1/snapshot-comments', body, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`staging internal comment "${comment.type}" as "${comment.authorHandle}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'comment', name: `internal:${comment.type}`, id: res.body.id, action: parentCommentId ? 'linked' : 'created' });
  return res.body;
}

async function ensureResolved(ctx: ProvisioningContext, workspaceId: string, commentId: string, existingStatus: string | undefined): Promise<void> {
  if (existingStatus === 'resolved') return;
  const res = await ctx.client.as(SERVICE_HANDLE, 'PATCH', `/api/v1/snapshot-comments/${commentId}/resolve`, undefined, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`resolving internal comment ${commentId} failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'comment', name: 'internal:resolved', id: commentId, action: 'resolved' });
}

// ─── §7.2 Chart-anchored comments (dashboard + chart-comments) ─────────────

interface DashboardSummary {
  id: string;
  name: string;
}

interface DashboardVisualizationSummary {
  id: string;
  dataviewSpecId: string;
  datasetVersionId: string;
  dashboardId: string;
}

interface ExistingChartComment {
  id: string;
  content: string;
}

// No Jira key in a staged entity name (AC4). Surfaced by the clean stage-from-empty
// rebuild (AXI-1368 validation): the AC4 forbidden-name gate correctly rejected the
// prior "Discussion charts (AXI-1375)" name.
const COMMENT_DASHBOARD_NAME = 'Chart discussion anchors';

/** Exported for unit testing — pure, no network. */
export function alreadyStagedChartComment(existing: ExistingChartComment[], text: string): boolean {
  return existing.some((c) => c.content === text);
}

async function ensureChartAnchoredComments(
  ctx: ProvisioningContext,
  workspaceId: string,
  projectId: string,
  datasetId: string,
  analysisId: string,
  chartAnchored: ChartAnchoredCommentFixture[],
): Promise<void> {
  if (chartAnchored.length === 0) return;
  const dashboardId = await ensureDashboard(ctx, workspaceId, projectId);
  const specs = await fetchExistingSpecs(ctx, workspaceId, datasetId, analysisId);
  const links = await fetchDashboardVisualizations(ctx, workspaceId, dashboardId);
  for (const comment of chartAnchored) await ensureOneChartComment(ctx, workspaceId, projectId, datasetId, dashboardId, specs, links, comment);
}

async function ensureDashboard(ctx: ProvisioningContext, workspaceId: string, projectId: string): Promise<string> {
  const existing = await fetchDashboards(ctx, workspaceId, projectId);
  const found = existing.find((d) => d.name === COMMENT_DASHBOARD_NAME);
  if (found) return found.id;
  return createDashboard(ctx, workspaceId, projectId);
}

async function fetchDashboards(ctx: ProvisioningContext, workspaceId: string, projectId: string): Promise<DashboardSummary[]> {
  const res = await ctx.client.as<{ data: DashboardSummary[] } | DashboardSummary[]>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/dashboards?projectId=${projectId}`,
    undefined,
    projectHeaders(workspaceId),
  );
  const body = res.body;
  return Array.isArray(body) ? body : (body?.data ?? []);
}

async function createDashboard(ctx: ProvisioningContext, workspaceId: string, projectId: string): Promise<string> {
  const body = { name: COMMENT_DASHBOARD_NAME, purpose: 'Discussion anchor for chart-level comments (Capture Spec §7.2)', projectId, workspaceId };
  const res = await ctx.client.as<{ id: string }>(SERVICE_HANDLE, 'POST', '/api/v1/dashboards', body, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`creating comment dashboard failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'dashboard', name: COMMENT_DASHBOARD_NAME, id: res.body.id, action: 'created' });
  return res.body.id;
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

/**
 * A `DataviewSpec`'s `datasetVersionId` equals the dataset id it was
 * created on (confirmed against `candidates.service.ts`'s `persistUserSpec`
 * — `datasetVersionId: dto.datasetVersionId`, itself set from the create
 * route's `:datasetId` URL param). All four §7.2 target charts live on the
 * primary de_table dataset, so `datasetId` (the caller's own) is correct
 * without a second lookup.
 */
async function ensureVisualizationLink(
  ctx: ProvisioningContext,
  workspaceId: string,
  dashboardId: string,
  datasetId: string,
  links: DashboardVisualizationSummary[],
  spec: ExistingSpec,
): Promise<DashboardVisualizationSummary> {
  const found = links.find((l) => l.dataviewSpecId === spec.id);
  if (found) return found;
  const body = { dataviewSpecId: spec.id, datasetVersionId: datasetId, title: spec.title ?? undefined };
  return createVisualizationLink(ctx, workspaceId, dashboardId, spec, body);
}

async function createVisualizationLink(
  ctx: ProvisioningContext,
  workspaceId: string,
  dashboardId: string,
  spec: ExistingSpec,
  body: { dataviewSpecId: string; datasetVersionId: string; title: string | undefined },
): Promise<DashboardVisualizationSummary> {
  const res = await ctx.client.as<DashboardVisualizationSummary>(
    SERVICE_HANDLE,
    'POST',
    `/api/v1/dashboards/${dashboardId}/visualizations`,
    body,
    projectHeaders(workspaceId),
  );
  if (!res.ok || !res.body) throw new Error(`linking chart "${spec.title}" to the comment dashboard failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'dashboard', name: `link:${spec.title}`, id: res.body.id, action: 'linked' });
  return res.body;
}

async function ensureOneChartComment(
  ctx: ProvisioningContext,
  workspaceId: string,
  projectId: string,
  datasetId: string,
  dashboardId: string,
  specs: ExistingSpec[],
  links: DashboardVisualizationSummary[],
  comment: ChartAnchoredCommentFixture,
): Promise<void> {
  const spec = specs.find((s) => s.title === comment.chartTitle);
  if (!spec) throw new Error(`chart-anchored comment targets "${comment.chartTitle}", which does not exist among staged charts — ensure-charts must run first`);
  const link = await ensureVisualizationLink(ctx, workspaceId, dashboardId, datasetId, links, spec);
  const existing = await fetchChartComments(ctx, workspaceId, link.id);
  if (alreadyStagedChartComment(existing, comment.text)) return;
  await createChartComment(ctx, workspaceId, projectId, datasetId, dashboardId, link, comment);
}

async function fetchChartComments(ctx: ProvisioningContext, workspaceId: string, dashboardVisualizationId: string): Promise<ExistingChartComment[]> {
  const res = await ctx.client.as<{ data: ExistingChartComment[] } | ExistingChartComment[]>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/comments?dashboardVisualizationId=${dashboardVisualizationId}`,
    undefined,
    projectHeaders(workspaceId),
  );
  const body = res.body;
  return Array.isArray(body) ? body : (body?.data ?? []);
}

async function createChartComment(
  ctx: ProvisioningContext,
  workspaceId: string,
  projectId: string,
  datasetId: string,
  dashboardId: string,
  link: DashboardVisualizationSummary,
  comment: ChartAnchoredCommentFixture,
): Promise<void> {
  const body = {
    dashboardVisualizationId: link.id,
    dashboardId,
    projectId,
    dataviewSpecId: link.dataviewSpecId,
    datasetVersionId: link.datasetVersionId ?? datasetId,
    content: comment.text,
  };
  const res = await ctx.client.as<{ id: string }>(comment.authorHandle, 'POST', '/api/v1/comments', body, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`staging chart comment on "${comment.chartTitle}" as "${comment.authorHandle}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'comment', name: `chart:${comment.chartTitle}`, id: res.body.id, action: 'created' });
}

// ─── §7.3 External thread (client-exploration) ─────────────────────────────

interface ExistingExternalComment {
  content: string;
  authorType: string;
}

const EXTERNAL_ARTIFACT_TYPE = 'view_analysis';

/** Exported for unit testing — pure, no network. */
export function alreadyStagedExternalMessage(existing: ExistingExternalComment[], message: ExternalThreadMessageFixture): boolean {
  return existing.some((c) => c.content === message.text && c.authorType === message.authorType);
}

async function ensureExternalThread(
  ctx: ProvisioningContext,
  workspaceId: string,
  projectId: string,
  analysisId: string,
  externalThread: ExternalThreadMessageFixture[],
): Promise<void> {
  if (externalThread.length === 0) return;
  await ensureClientExplorationEnabled(ctx, projectId);
  await ensureExternalMember(ctx, projectId);
  await ensurePublishedArtifact(ctx, projectId, analysisId);
  const existing = await fetchExternalComments(ctx, projectId, analysisId);
  for (const message of externalThread) await ensureOneExternalMessage(ctx, projectId, analysisId, message, existing);
}

async function ensureClientExplorationEnabled(ctx: ProvisioningContext, projectId: string): Promise<void> {
  const res = await ctx.client.as(SERVICE_HANDLE, 'POST', `/api/v1/projects/${projectId}/client-exploration/enable`);
  if (!res.ok) throw new Error(`enabling client exploration on project ${projectId} failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'client-exploration', name: 'enabled', id: projectId, action: 'granted' });
}

async function ensureExternalMember(ctx: ProvisioningContext, projectId: string): Promise<void> {
  const externalUserId = await resolveUserId(ctx, 'external-stakeholder');
  const already = await ctx.client.as(SERVICE_HANDLE, 'GET', `/api/v1/projects/${projectId}/client-exploration/members/${externalUserId}`);
  if (already.ok) return;
  const body = { clientUserId: externalUserId, permissions: { canView: true, canComment: true } };
  const res = await ctx.client.as(SERVICE_HANDLE, 'POST', `/api/v1/projects/${projectId}/client-exploration/members`, body);
  if (!res.ok) throw new Error(`inviting the external stakeholder to project ${projectId} failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'client-exploration', name: 'external-stakeholder', id: externalUserId, action: 'granted' });
}

async function resolveUserId(ctx: ProvisioningContext, handle: string): Promise<string> {
  const res = await ctx.client.as<{ id: string }>(handle, 'GET', '/api/v1/auth/me');
  if (!res.ok || !res.body) throw new Error(`could not resolve identity "${handle}"'s user id (status ${res.status})`);
  return res.body.id;
}

/** `publishArtifacts` upserts server-side (confirmed against
 *  `client-exploration.service.ts`), so this call is safely idempotent on
 *  every re-run without a pre-check. */
async function ensurePublishedArtifact(ctx: ProvisioningContext, projectId: string, analysisId: string): Promise<void> {
  const body = { artifacts: [{ artifactId: analysisId, artifactType: EXTERNAL_ARTIFACT_TYPE }] };
  const res = await ctx.client.as(SERVICE_HANDLE, 'POST', `/api/v1/projects/${projectId}/client-exploration/published-artifacts`, body);
  if (!res.ok) throw new Error(`publishing analysis ${analysisId} to client exploration failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'client-exploration', name: 'published-artifact', id: analysisId, action: 'granted' });
}

async function fetchExternalComments(ctx: ProvisioningContext, projectId: string, analysisId: string): Promise<ExistingExternalComment[]> {
  const res = await ctx.client.as<{ comments: ExistingExternalComment[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/projects/${projectId}/client-exploration/artifacts/${analysisId}/comments`,
  );
  return res.body?.comments ?? [];
}

async function ensureOneExternalMessage(
  ctx: ProvisioningContext,
  projectId: string,
  analysisId: string,
  message: ExternalThreadMessageFixture,
  existing: ExistingExternalComment[],
): Promise<void> {
  if (alreadyStagedExternalMessage(existing, message)) return;
  const body = { authorType: message.authorType, content: message.text };
  const res = await ctx.client.as(message.authorHandle, 'POST', `/api/v1/projects/${projectId}/client-exploration/artifacts/${analysisId}/comments`, body);
  if (!res.ok) throw new Error(`staging external thread message as "${message.authorHandle}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'comment', name: 'external-thread', id: analysisId, action: 'created' });
}
