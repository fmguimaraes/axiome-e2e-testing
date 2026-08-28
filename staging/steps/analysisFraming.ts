import { SERVICE_HANDLE, recordTouched } from './context';
import { findExistingDataset, requireProjectId, requireWorkspaceId } from './datasetIngestion';
import { projectHeaders } from './projectProvisioning';
import { ensureMemberRole } from './workspaceMembership';
import type { ProvisioningContext } from './context';
import type { AssumptionCategory, AssumptionFixture } from '../fixtures/types';
import type { Step } from './types';

/**
 * FR9/AC8 (AXI-1373, Capture Spec §4/§5) — creates (or locates) the
 * view-analysis on the analysis project, frames it with the scientific
 * question, and stages the true assumptions authored as the cast biostat
 * identity (Marc Ottavi/MO — Capture Spec §3 owns assumptions/thresholds/
 * contrast choices). Depends on `ensure-dataset` for the workspace/project/
 * dataset ids it needs.
 *
 * FR9 TRUTH JUDGMENT — the crux of this story: the 4th assumption
 * ("threshold provenance") is staged ONLY when {@link THRESHOLD_DECLARED_BEFORE_CONTRAST}
 * is true. See that constant's doc for the evidence. Staging it
 * unconditionally would make the demo commit the exact error the product
 * exists to prevent (Capture Spec §5, R7) — so the guard defaults closed
 * and every withheld run logs why.
 */
export const ensureAnalysisFramingStep: Step<ProvisioningContext> = {
  id: 'ensure-analysis-framing',
  dependsOn: ['ensure-dataset'],
  async run(ctx) {
    const content = ctx.fixture.content;
    // The view-analysis itself is bound to ONE dataset (the platform's own
    // `POST /view-analyses` shape) — that is always the DE table (AXI-1373's
    // "scientific spine"), never the count-matrix dataset AXI-1374 adds. See
    // `chartStaging.ts`'s module doc for how the count-matrix's charts still
    // get scoped to this same analysis despite that.
    const dataset = content.datasets.find((d) => d.role === 'de_table');
    if (!dataset || !content.scientificQuestion || content.assumptions.length === 0) return;
    const workspaceId = requireWorkspaceId(ctx, dataset.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, dataset.projectName);
    const datasetId = await requireDatasetId(ctx, workspaceId, dataset.originalFilename);
    await grantAuthorAccess(ctx, workspaceId, content.assumptions);
    // AC (story): "the title is the scientific question verbatim" — the
    // view-analysis's `name` and its framed Review Question are the same
    // string, sourced from the one fixture field (see `types.ts`).
    const analysisId = await ensureViewAnalysis(ctx, workspaceId, projectId, datasetId, content.scientificQuestion);
    await ensureReviewQuestion(ctx, workspaceId, analysisId, content.scientificQuestion);
    await ensureAssumptions(ctx, workspaceId, analysisId, content.assumptions);
  },
};

const ANALYSIS_WORKSPACE_ROLE = 'editor';

type BackendAssumptionType = 'cohort_definition' | 'data_filter' | 'methodological_choice' | 'domain_assumption' | 'other';

/** Exported for reuse by `chartStaging.ts` (AXI-1374) — the chart step needs
 *  this same view-analysis id to scope every chart's `viewAnalysisId`. */
export interface AnalysisSummary {
  id: string;
  name: string;
  status: string;
  datasetId: string;
  createdAt: string;
}

interface AssumptionResponse {
  type: string;
  text: string;
  status: string;
}

interface FramingPayload {
  reviewQuestion: { text: string } | null;
  assumptions: AssumptionResponse[];
}

/**
 * FR9 TRUTH JUDGMENT (Capture Spec §5, R7) — whether the |log2FC| >= 1
 * threshold was genuinely declared BEFORE the DE contrast was run, in THIS
 * staging run. Evidence checked on disk 2026-08-28: `riaz_de/run_de.py` —
 * the actual pydeseq2 script that produced the staged DE table — declares
 * no threshold anywhere (no log2FC cutoff, no config, no pre-registration
 * comment; its only cutoff reference is an internal padj<0.05 sanity print,
 * not a log2FC provenance record), and the DE output files on disk predate
 * this toolkit's first commit. The contrast already happened before this
 * staging run could declare anything in front of it — so "declared before
 * the contrast was run" is false of how this demo was actually built.
 * Default false. Flip to true ONLY on concrete, citable evidence to the
 * contrary (e.g. a dated pre-registration artifact checked into `riaz_de/`)
 * — cite it in a comment here when you do.
 */
export const THRESHOLD_DECLARED_BEFORE_CONTRAST = false;

export const THRESHOLD_WITHHELD_REASON =
  'claim not true of this run — the Riaz DE contrast (riaz_de/run_de.py, pydeseq2 0.5.2) was pre-computed; ' +
  'no threshold was declared before it ran (FR9)';

/** Exported for reuse by `chartStaging.ts` (AXI-1374) — same lookup, same
 *  "must already exist, ensure-dataset ran first" guard. */
export async function requireDatasetId(ctx: ProvisioningContext, workspaceId: string, filename: string): Promise<string> {
  const found = await findExistingDataset(ctx, workspaceId, filename);
  if (!found) throw new Error(`dataset "${filename}" not found in workspace ${workspaceId} — ensure-dataset must run first`);
  return found.id;
}

/** True iff `assumption` is one FR9 permits staging — everything except a
 *  4th (threshold-provenance) entry while the truth guard stays closed. */
export function isStageable(assumption: AssumptionFixture): boolean {
  return assumption.category !== 'threshold_provenance' || THRESHOLD_DECLARED_BEFORE_CONTRAST;
}

/** Every distinct author handle among the assumptions FR9 actually allows to
 *  stage needs `framing:add_assumption` on this workspace — granted once,
 *  up front, so the per-assumption POST loop never has to think about
 *  authorization (NFR1: no-op once already granted). */
async function grantAuthorAccess(ctx: ProvisioningContext, workspaceId: string, assumptions: AssumptionFixture[]): Promise<void> {
  const handles = new Set(assumptions.filter(isStageable).map((a) => a.authorHandle));
  for (const handle of handles) await ensureMemberRole(ctx, workspaceId, handle, ANALYSIS_WORKSPACE_ROLE);
}

/**
 * Idempotent find-or-rename-or-create (NFR1), mirroring `reuseProject`'s
 * pattern in `projectProvisioning.ts`. Lookup is by (`projectId`,
 * `datasetId`, `origin: user_created`) rather than by name — the name IS
 * the scientific question and is expected to be re-worded over time (FR6);
 * a name-keyed lookup would silently mint a second, orphaned analysis every
 * time the question's wording changes instead of renaming the one that's
 * already bound to this dataset.
 */
async function ensureViewAnalysis(
  ctx: ProvisioningContext,
  workspaceId: string,
  projectId: string,
  datasetId: string,
  name: string,
): Promise<string> {
  const existing = await findExistingAnalysis(ctx, workspaceId, projectId, datasetId);
  if (existing) return reuseAnalysis(ctx, workspaceId, existing, name);
  return createViewAnalysis(ctx, workspaceId, projectId, datasetId, name);
}

async function reuseAnalysis(ctx: ProvisioningContext, workspaceId: string, existing: AnalysisSummary, name: string): Promise<string> {
  if (existing.name !== name) await renameAnalysis(ctx, workspaceId, existing.id, name);
  const action = existing.name === name ? 'reused' : 'renamed';
  recordTouched(ctx, { kind: 'analysis', name, id: existing.id, action });
  return existing.id;
}

async function renameAnalysis(ctx: ProvisioningContext, workspaceId: string, analysisId: string, name: string): Promise<void> {
  const res = await ctx.client.as(SERVICE_HANDLE, 'PATCH', `/api/v1/view-analyses/${analysisId}`, { name }, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`renaming view-analysis ${analysisId} failed (status ${res.status})`);
}

/** Earliest-created match, deterministically, in case more than one
 *  user_created analysis is already bound to this dataset (AXI-1372 flagged
 *  stale dataset links on this project — see dev-epic-context). Exported
 *  for reuse by `chartStaging.ts` (AXI-1374). */
export async function findExistingAnalysis(ctx: ProvisioningContext, workspaceId: string, projectId: string, datasetId: string): Promise<AnalysisSummary | undefined> {
  const res = await ctx.client.as<{ data: AnalysisSummary[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/view-analyses?projectId=${projectId}&origin=user_created`,
    undefined,
    projectHeaders(workspaceId),
  );
  const matches = (res.body?.data ?? []).filter((a) => a.datasetId === datasetId && a.status !== 'archived');
  return matches.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

async function createViewAnalysis(
  ctx: ProvisioningContext,
  workspaceId: string,
  projectId: string,
  datasetId: string,
  name: string,
): Promise<string> {
  const res = await ctx.client.as<{ id: string }>(
    SERVICE_HANDLE,
    'POST',
    '/api/v1/view-analyses',
    { projectId, datasetId, name },
    projectHeaders(workspaceId),
  );
  if (!res.ok || !res.body) throw new Error(`creating view-analysis "${name}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'analysis', name, id: res.body.id, action: 'created' });
  return res.body.id;
}

async function fetchFraming(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<FramingPayload> {
  const res = await ctx.client.as<FramingPayload>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/view-analyses/${analysisId}/framing`,
    undefined,
    projectHeaders(workspaceId),
  );
  return res.body ?? { reviewQuestion: null, assumptions: [] };
}

async function ensureReviewQuestion(ctx: ProvisioningContext, workspaceId: string, analysisId: string, text: string): Promise<void> {
  const framing = await fetchFraming(ctx, workspaceId, analysisId);
  if (framing.reviewQuestion?.text === text) return;
  const res = await ctx.client.as(
    SERVICE_HANDLE,
    'PATCH',
    `/api/v1/view-analyses/${analysisId}/review-question`,
    { text },
    projectHeaders(workspaceId),
  );
  if (!res.ok) throw new Error(`setting review question on analysis ${analysisId} failed (status ${res.status})`);
}

async function ensureAssumptions(ctx: ProvisioningContext, workspaceId: string, analysisId: string, assumptions: AssumptionFixture[]): Promise<void> {
  const framing = await fetchFraming(ctx, workspaceId, analysisId);
  for (const assumption of assumptions) await ensureOneAssumption(ctx, workspaceId, analysisId, assumption, framing.assumptions);
}

async function ensureOneAssumption(
  ctx: ProvisioningContext,
  workspaceId: string,
  analysisId: string,
  assumption: AssumptionFixture,
  existing: AssumptionResponse[],
): Promise<void> {
  if (!isStageable(assumption)) return logWithheld(ctx, assumption);
  if (alreadyStaged(existing, assumption)) return;
  await stageAssumption(ctx, workspaceId, analysisId, assumption);
}

/** Exported for unit testing (NFR1 idempotency) — pure, no network. */
export function alreadyStaged(existing: AssumptionResponse[], assumption: AssumptionFixture): boolean {
  const type = toBackendType(assumption.category);
  return existing.some((a) => a.status === 'active' && a.type === type && a.text === assumption.text);
}

/** NFR7 — a withheld assumption logs its reason from the log alone; also
 *  recorded on `touched` (id 'n/a': nothing was created) so the story
 *  report can cite the withholding without re-reading console output. */
function logWithheld(ctx: ProvisioningContext, assumption: AssumptionFixture): void {
  console.log(`[staging] withheld assumption category=${assumption.category} — ${THRESHOLD_WITHHELD_REASON}`);
  recordTouched(ctx, { kind: 'assumption', name: assumption.category, id: 'n/a', action: 'withheld' });
}

async function stageAssumption(ctx: ProvisioningContext, workspaceId: string, analysisId: string, assumption: AssumptionFixture): Promise<void> {
  const type = toBackendType(assumption.category);
  const res = await ctx.client.as(
    assumption.authorHandle,
    'POST',
    `/api/v1/view-analyses/${analysisId}/assumptions`,
    { type, text: assumption.text },
    projectHeaders(workspaceId),
  );
  if (!res.ok) throw new Error(`staging assumption "${assumption.category}" as "${assumption.authorHandle}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'assumption', name: assumption.category, id: analysisId, action: 'created' });
}

/**
 * Fixture categories mirror the backend `AssumptionType` enum verbatim for
 * the three FR9 actually stages (`cohort_definition`/`data_filter`/
 * `methodological_choice`). `threshold_provenance` has no backend
 * counterpart — the closest is `domain_assumption` (a declared domain fact,
 * which is what a published-cutoff provenance claim is). This mapping is
 * exercised only if {@link THRESHOLD_DECLARED_BEFORE_CONTRAST} is ever
 * flipped true.
 */
export function toBackendType(category: AssumptionCategory): BackendAssumptionType {
  return category === 'threshold_provenance' ? 'domain_assumption' : category;
}
