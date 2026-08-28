import { recordTouched } from './context';
import { requireWorkspaceId, requireProjectId } from './datasetIngestion';
import { requireDatasetId } from './analysisFraming';
import { requireAnalysisId } from './chartStaging';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { Step } from './types';

/**
 * FR13/AC12/EC5/EC6 (AXI-1378, Capture Spec §11/§12/§21) — the "whole
 * feature" verification the dev-epic-context flags as unresolved: does the
 * external stakeholder invitation genuinely scope to published-only, or does
 * an external member land in the workspace with internal surfaces they just
 * happen not to have clicked into?
 *
 * METHOD: authenticated REST requests AS `external-stakeholder` (never
 * inferred from an admin screen, per FR13's own wording) against two classes
 * of route:
 *  - the client-exploration surfaces (published artifacts, external thread)
 *    the stakeholder SHOULD reach — expectation 'visible'.
 *  - the internal, workspace-scoped surfaces (the analysis-level Discussion
 *    thread, chart-anchored comments, interpretations/decision-drafts
 *    [including drafts], evidence, snapshots) the stakeholder must NOT reach
 *    — expectation 'hidden'.
 *
 * FINDING (confirmed by static analysis before this step's first live run,
 * see the source citations in `evaluateProbe`'s callers below): every
 * internal route above is `@UseGuards(AuthGuard, WorkspaceGuard, ...)` with
 * `@RequireWorkspace()` (`decision-drafts.controller.ts`,
 * `view-analyses.controller.ts`, `chart-comments.controller.ts`,
 * `snapshot-comments.controller.ts`), and `WorkspaceGuard` rejects any caller
 * who isn't a `WorkspaceMember` (`workspace.guard.ts`'s
 * `VALIDATE_MEMBERSHIP` RPC -> 403). `ClientExplorationService.inviteMember`
 * (`client-exploration.service.ts`) creates ONLY a
 * `ClientExplorationMembership` row — no `WorkspaceMember` row — so the
 * external stakeholder is never a workspace member. If that holds live, §21
 * is answered GENUINE SCOPING: the boundary is enforced by the same
 * membership check every other internal surface already relies on, not by a
 * UI affordance the stakeholder simply doesn't click.
 *
 * EC6 (hiding vs disabling): `classifyOutcome` treats ANY 2xx as 'visible'
 * regardless of a body-level flag — a 200 carrying real internal data next
 * to a `{disabled:true}` marker is still classified 'visible' and therefore
 * still a leak. Hiding means the internal routes never resolve for this
 * caller at all (403/400 from the guard, before the handler runs); disabling
 * would be a 200 with the same underlying data present but flagged off. The
 * two are structurally distinguishable by status code alone under this
 * platform's guard placement, so no body-shape check is needed to tell them
 * apart here.
 *
 * DEFERRED (environment note): the running backend is the STALE primary
 * (lacks the `authorType` fix from AXI-1375), so the external thread has
 * zero live messages — `ensureCommentsStep`'s external-message POST 500s.
 * The external thread's *reachability* (GET returns 200) is independent of
 * that bug and is hard-asserted here; the external thread's *content*
 * (actual DR-authored messages present) is soft-checked and logged as
 * DEFERRED, not hard-asserted, until the operational-phase stack reconcile
 * completes and `commentStaging.ts`'s external messages stage live.
 *
 * Records the §21 determination as a touched entity (kind
 * `external-scoping-verification`) so `stage.ts`'s per-run log always
 * surfaces it, and throws (this module's one hard gate) only when a HARD
 * probe's live outcome contradicts its expectation — a genuine leak or a
 * broken positive-scoping guarantee, either of which is a real platform
 * defect this story exists to catch, not a toolkit-authoring mistake to
 * silently tolerate on a rerun.
 */
export const verifyExternalScopingStep: Step<ProvisioningContext> = {
  id: 'verify-external-scoping',
  dependsOn: ['ensure-comments', 'ensure-interpretations-evidence-publish'],
  async run(ctx) {
    const deps = await resolveScopingDeps(ctx);
    const probes = buildScopingProbes(deps.workspaceId, deps.projectId, deps.analysisId);
    const results = await runProbes(ctx, probes);
    const finding = summarizeScoping(results);
    await reportExternalThreadContent(ctx, deps.projectId, deps.analysisId);
    recordScopingFinding(ctx, deps.analysisId, finding);
    reportScopingFinding(finding);
    assertScopingCorrect(finding);
  },
};

const EXTERNAL_HANDLE = 'external-stakeholder';
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

// ─── Dependency resolution ──────────────────────────────────────────────────

interface ScopingDeps {
  workspaceId: string;
  projectId: string;
  analysisId: string;
}

async function resolveScopingDeps(ctx: ProvisioningContext): Promise<ScopingDeps> {
  const primary = ctx.fixture.content.datasets.find((d) => d.role === 'de_table');
  if (!primary) throw new Error('no de_table dataset declared — cannot resolve the analysis to verify external scoping against');
  const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
  const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
  const datasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
  const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, datasetId);
  return { workspaceId, projectId, analysisId };
}

// ─── Probes (pure construction — exported for unit testing) ────────────────

export type ScopingExpectation = 'visible' | 'hidden';
export type ScopingOutcome = 'visible' | 'hidden' | 'error';

export interface ScopingProbe {
  label: string;
  path: string;
  expectation: ScopingExpectation;
  extraHeaders?: Record<string, string>;
  hard: boolean;
}

export interface ScopingProbeResult extends ScopingProbe {
  status: number;
  outcome: ScopingOutcome;
  matchesExpectation: boolean;
}

/** AC12/FR13: the client-exploration surfaces the external stakeholder MUST
 *  be able to reach. Both are testable live regardless of the deferred
 *  external-message bug (see module doc). */
function visibleProbes(projectId: string, analysisId: string): ScopingProbe[] {
  return [
    { label: 'published-artifacts list', path: `/api/v1/projects/${projectId}/client-exploration/published-artifacts`, expectation: 'visible', hard: true },
    { label: 'external thread (surface reachable)', path: `/api/v1/projects/${projectId}/client-exploration/artifacts/${analysisId}/comments`, expectation: 'visible', hard: true },
  ];
}

/** EC5: internal, workspace-scoped surfaces the external stakeholder MUST
 *  NOT reach — the internal discussion thread, chart-anchored comments,
 *  interpretations (including drafts), evidence, and unpublished snapshots.
 *  `dashboardVisualizationId` uses a placeholder id — `WorkspaceGuard` denies
 *  on membership before the handler ever resolves the specific resource, so
 *  the real id is not needed to prove the boundary holds (and using a
 *  placeholder keeps this probe independent of chart-staging internals). */
function hiddenProbes(workspaceId: string, analysisId: string): ScopingProbe[] {
  const headers = projectHeaders(workspaceId);
  return [
    hidden('internal analysis discussion thread', `/api/v1/snapshot-comments?anchorType=view_analysis&anchorId=${analysisId}`, headers),
    hidden('internal analysis discussion thread (no workspace header)', `/api/v1/snapshot-comments?anchorType=view_analysis&anchorId=${analysisId}`),
    hidden('chart-anchored internal comments', `/api/v1/comments?dashboardVisualizationId=${PLACEHOLDER_ID}`, headers),
    hidden('interpretations / decision drafts (incl. drafts)', `/api/v1/workspaces/${workspaceId}/decisions?viewAnalysisId=${analysisId}&limit=50`, headers),
    hidden('evidence records', `/api/v1/view-analyses/${analysisId}/evidences?page=1&limit=50`, headers),
    hidden('unpublished snapshots / working state', `/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=10`, headers),
  ];
}

function hidden(label: string, path: string, extraHeaders?: Record<string, string>): ScopingProbe {
  return { label, path, expectation: 'hidden', extraHeaders, hard: true };
}

export function buildScopingProbes(workspaceId: string, projectId: string, analysisId: string): ScopingProbe[] {
  return [...visibleProbes(projectId, analysisId), ...hiddenProbes(workspaceId, analysisId)];
}

// ─── Probe execution + classification (pure — exported for unit testing) ──

/** Any 2xx is 'visible' regardless of body content (EC6 — see module doc).
 *  400/401/403/404 is 'hidden' (the guard denied before data resolution).
 *  Anything else is 'error' — a transport/server failure, not a scoping
 *  answer, and is never treated as evidence either way. */
export function classifyOutcome(status: number): ScopingOutcome {
  if (status >= 200 && status < 300) return 'visible';
  if ([400, 401, 403, 404].includes(status)) return 'hidden';
  return 'error';
}

export function evaluateProbe(probe: ScopingProbe, status: number): ScopingProbeResult {
  const outcome = classifyOutcome(status);
  return { ...probe, status, outcome, matchesExpectation: outcome === probe.expectation };
}

async function runProbes(ctx: ProvisioningContext, probes: ScopingProbe[]): Promise<ScopingProbeResult[]> {
  const results: ScopingProbeResult[] = [];
  for (const probe of probes) results.push(await runOneProbe(ctx, probe));
  return results;
}

async function runOneProbe(ctx: ProvisioningContext, probe: ScopingProbe): Promise<ScopingProbeResult> {
  const res = await ctx.client.as(EXTERNAL_HANDLE, 'GET', probe.path, undefined, probe.extraHeaders);
  return evaluateProbe(probe, res.status);
}

// ─── §21 determination (pure — exported for unit testing) ─────────────────

export interface ScopingFinding {
  genuineScoping: boolean;
  leaks: ScopingProbeResult[];
  blockedFromPublished: ScopingProbeResult[];
  errors: ScopingProbeResult[];
  results: ScopingProbeResult[];
}

/** The §21 verdict: `leaks` = internal surfaces the external actor could
 *  reach (EC5); `blockedFromPublished` = surfaces it SHOULD reach but
 *  couldn't (FR13's positive half broken); `errors` = probes whose status
 *  wasn't classifiable either way (a tooling/transport problem, reported but
 *  not itself proof of a leak). Genuine scoping requires all three empty. */
export function summarizeScoping(results: ScopingProbeResult[]): ScopingFinding {
  const hard = results.filter((r) => r.hard);
  const leaks = hard.filter((r) => r.expectation === 'hidden' && r.outcome === 'visible');
  const blockedFromPublished = hard.filter((r) => r.expectation === 'visible' && r.outcome !== 'visible');
  const errors = hard.filter((r) => r.outcome === 'error');
  const genuineScoping = leaks.length === 0 && blockedFromPublished.length === 0 && errors.length === 0;
  return { genuineScoping, leaks, blockedFromPublished, errors, results };
}

function assertScopingCorrect(finding: ScopingFinding): void {
  if (finding.errors.length > 0) throw new Error(`external-scoping verification could not complete — ${describeAll(finding.errors)}`);
  if (finding.blockedFromPublished.length > 0) throw new Error(`FR13 violated — external stakeholder cannot reach a surface it should: ${describeAll(finding.blockedFromPublished)}`);
  if (finding.leaks.length > 0) throw new Error(`EC5 VIOLATION — external stakeholder can reach internal surface(s): ${describeAll(finding.leaks)}`);
}

function describeAll(results: ScopingProbeResult[]): string {
  return results.map((r) => `${r.label} (${r.path}) -> ${r.status}`).join('; ');
}

// ─── Reporting ──────────────────────────────────────────────────────────────

function recordScopingFinding(ctx: ProvisioningContext, analysisId: string, finding: ScopingFinding): void {
  const name = finding.genuineScoping ? 'genuine-scoping (published-only)' : 'LEAK-DETECTED';
  recordTouched(ctx, { kind: 'external-scoping-verification', name, id: analysisId, action: 'resolved' });
}

function reportScopingFinding(finding: ScopingFinding): void {
  const verdict = finding.genuineScoping ? 'GENUINE SCOPING — external member is published-only (§21 answered, good half)' : 'LEAK DETECTED — external member reaches internal surfaces (§21 answered, bad half; log for W5/Feature Backlog)';
  console.log(`[verify-external-scoping] §21 determination: ${verdict}`);
  finding.results.forEach(logOneResult);
}

function logOneResult(r: ScopingProbeResult): void {
  const tag = r.matchesExpectation ? 'OK' : 'MISMATCH';
  console.log(`[verify-external-scoping] ${r.hard ? 'HARD' : 'soft'} ${tag} — ${r.label}: expected=${r.expectation} actual=${r.outcome} (status ${r.status})`);
}

// ─── Deferred: external thread content (soft, not hard-asserted) ──────────

interface ExternalCommentSummary {
  authorId: string;
  authorType: string;
  content: string;
}

/**
 * §21/AC12's fuller claim ("returns ... the external thread") includes the
 * thread's CONTENT, not just its reachability. That is blocked on the
 * operational-phase stack reconcile (see module doc) — this logs the live
 * count so a future rerun's diff is visible, but never throws on it.
 */
async function reportExternalThreadContent(ctx: ProvisioningContext, projectId: string, analysisId: string): Promise<void> {
  const res = await ctx.client.as<{ comments: ExternalCommentSummary[] }>(
    EXTERNAL_HANDLE,
    'GET',
    `/api/v1/projects/${projectId}/client-exploration/artifacts/${analysisId}/comments`,
  );
  const count = res.body?.comments.length ?? 0;
  const status = count > 0 ? 'content present' : 'DEFERRED — 0 messages live (blocked on stack reconcile, see dev-epic-context AXI-1375)';
  console.log(`[verify-external-scoping] external thread content check: ${count} message(s) — ${status}`);
}
