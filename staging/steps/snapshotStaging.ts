import { SERVICE_HANDLE, recordTouched } from './context';
import { requireWorkspaceId, requireProjectId } from './datasetIngestion';
import { requireDatasetId } from './analysisFraming';
import { requireAnalysisId } from './chartStaging';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { SnapshotFixture } from '../fixtures/types';
import type { Step } from './types';

const POLL_ATTEMPTS = 5;
const POLL_DELAY_MS = 200;

/**
 * FR11/AC10 (Capture Spec §4) — stages snapshot v1 (pooled) and v2
 * (stratified label) on the analysis. Depends on `ensure-comments`: Capture
 * Spec §20's declared order is comments before v2, because the external
 * thread (already staged, AXI-1375) resolves to v2.
 *
 * STRATIFICATION FINDING: "stratified by prior ipilimumab exposure" cannot
 * be a real data-level contrast here. The analysis's bound dataset (the DE
 * table, `94b0bd10`) has exactly six columns — gene/baseMean/log2FoldChange/
 * lfcSE/pvalue/padj (verified against the live CSV header) — no per-patient
 * or per-arm column exists to filter on. The Riaz sample metadata DOES carry
 * a naive/progressed label (`SampleTableCorrected.9.19.16.csv`'s
 * `NIV3-NAIVE`/`NIV3-PROG` column), but turning that into a real stratified
 * DE result requires re-running the differential-expression contrast per arm
 * offline (the same class of work `riaz_de/build_count_matrix_dataset.py`
 * did for AXI-1374's charts 5-6) — a bioinformatics pipeline task, not a
 * REST staging call, and out of SI-044's "no backend change expected" scope.
 * Per the story's own instruction, v2 is honestly staged as a LABELED
 * version — the same underlying (unfiltered) slice as v1, distinguished only
 * by its `name` — rather than fabricating a stratified result that does not
 * exist. This is disclosed, not hidden: EC3's "progressed arm is
 * underpowered" finding already lives as staged CONTENT in the AXI-1375
 * internal/external comment threads, which is where a reader actually sees
 * it; it is not something this step needs to compute or gate on.
 *
 * ROUTE FINDING (why plain `/snapshots`, not `/snapshots/materialize`): the
 * dev-epic-context route table pairs `POST /view-analyses/snapshots` with
 * `.../snapshots/materialize` as "await it (EC7)". Live source investigation
 * (`view-analyses.service.ts materializeSnapshot()`) shows `/materialize` is
 * a GET-OR-REUSE-by-filter-signature route ("snapshot-on-consumption"): it
 * returns an EXISTING snapshot when one already matches
 * (datasetId, filters, filterCombinator). Since v1 and v2 both resolve
 * against the same dataset with the same (empty) filters — no real
 * stratification filter exists, see above — calling `/materialize` twice
 * would collapse v2 into v1's row (`created: false`), violating AC10's "two
 * distinct" requirement. Plain `POST /view-analyses/snapshots` has no such
 * dedup — `createSnapshot()` always inserts a new row at `version = count +
 * 1` — so it is the correct route for minting two DISTINCT versions here.
 *
 * EC7 FINDING: `createSnapshot()` → `persistSnapshot()` →
 * `materializeSnapshotNode()` is a synchronous chain of Prisma calls (no
 * queue, no `ClientProxy.emit`, no separate status field on
 * `ViewAnalysisSnapshot` — confirmed against the Prisma schema and service
 * source). There is no pending/materializing state to poll for. `EC7`'s
 * "await terminal status (poll, bounded)" is still honored defensively by
 * {@link awaitSnapshotVisible} — a bounded read-after-write check — which
 * converges on its first attempt every time given this backend's actual
 * (synchronous) behavior; it exists to satisfy the written requirement and
 * guard against a future async rework, not because the current code needs it.
 *
 * Idempotent (NFR1): re-run counts existing snapshots and creates only the
 * shortfall, then (re)asserts each declared name onto the version it belongs
 * to — a no-op PATCH once names already match.
 */
export const ensureSnapshotsStep: Step<ProvisioningContext> = {
  id: 'ensure-snapshots',
  dependsOn: ['ensure-comments'],
  async run(ctx) {
    const content = ctx.fixture.content;
    const primary = content.datasets.find((d) => d.role === 'de_table');
    if (!primary || content.snapshots.length === 0) return;
    const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
    const datasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
    const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, datasetId);

    const existingCount = (await fetchSnapshots(ctx, workspaceId, analysisId)).length;
    await ensureSnapshotCount(ctx, workspaceId, analysisId, existingCount, content.snapshots.length);
    const current = await fetchSnapshots(ctx, workspaceId, analysisId);
    await ensureSnapshotNames(ctx, workspaceId, analysisId, current, content.snapshots);
  },
};

export interface SnapshotSummary {
  id: string;
  version: number;
  name: string | null;
}

/** Exported for unit testing — pure, no network (NFR1: how many creates a
 *  given existing count still needs). */
export function snapshotsToCreate(existingCount: number, targetCount: number): number {
  return Math.max(0, targetCount - existingCount);
}

/** Exported for unit testing — pure, no network. `declared[i]` binds to the
 *  version-ascending snapshot at index `i` (array order = version order). */
export function pairSnapshotsToNames(byVersionAsc: SnapshotSummary[], declared: SnapshotFixture[]): { snapshot: SnapshotSummary; fixture: SnapshotFixture }[] {
  return declared.map((fixture, i) => ({ snapshot: byVersionAsc[i], fixture })).filter((pair) => pair.snapshot !== undefined);
}

/**
 * REAL BACKEND BUG FOUND (live, 2026-08-28, no backend change made here —
 * out of SI-044's REST-only scope): `GET /view-analyses/:id/snapshots` 500s
 * whenever `page` is omitted from the query string, regardless of `limit`
 * (`?limit=50` alone still 500s; `?page=1&limit=50` succeeds). Root cause
 * (from the live backend logs): `ViewAnalysesMessageController.findSnapshots`
 * forwards `data.page` straight through to `ViewAnalysesService.findSnapshots
 * (viewAnalysisId, page = 1, limit = 20)` — but the RPC round-trip does not
 * leave a genuinely-omitted `page` as `undefined` on arrival, so the `page =
 * 1` default parameter never fires, and `skip: (page - 1) * limit` computes a
 * negative skip Prisma rejects. Every OTHER list route this toolkit calls
 * either takes no page param at all or is unaffected; this is the first call
 * to THIS route in the epic. Worked around here by always passing `page=1`
 * explicitly — logged for a future fix story, not fixed in this one.
 */
async function fetchSnapshots(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<SnapshotSummary[]> {
  const res = await ctx.client.as<{ data: SnapshotSummary[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=50`,
    undefined,
    projectHeaders(workspaceId),
  );
  return (res.body?.data ?? []).slice().sort((a, b) => a.version - b.version);
}

async function ensureSnapshotCount(ctx: ProvisioningContext, workspaceId: string, analysisId: string, existingCount: number, targetCount: number): Promise<void> {
  const shortfall = snapshotsToCreate(existingCount, targetCount);
  for (let i = 0; i < shortfall; i++) await createSnapshot(ctx, workspaceId, analysisId);
}

async function createSnapshot(ctx: ProvisioningContext, workspaceId: string, analysisId: string): Promise<void> {
  const body = { viewAnalysisId: analysisId, filters: [] };
  const res = await ctx.client.as<SnapshotSummary>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/snapshots', body, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`creating a snapshot for analysis ${analysisId} failed (status ${res.status})`);
  await awaitSnapshotVisible(ctx, workspaceId, analysisId, res.body.id); // EC7
  recordTouched(ctx, { kind: 'snapshot', name: `v${res.body.version}`, id: res.body.id, action: 'created' });
}

/** EC7 — bounded read-after-write poll. See module doc for why this
 *  converges immediately against the current (synchronous) backend. */
async function awaitSnapshotVisible(ctx: ProvisioningContext, workspaceId: string, analysisId: string, snapshotId: string): Promise<void> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const snapshots = await fetchSnapshots(ctx, workspaceId, analysisId);
    if (snapshots.some((s) => s.id === snapshotId)) return;
    await sleep(POLL_DELAY_MS);
  }
  throw new Error(`snapshot ${snapshotId} did not become read-visible within the bounded poll window (EC7)`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureSnapshotNames(ctx: ProvisioningContext, workspaceId: string, analysisId: string, current: SnapshotSummary[], declared: SnapshotFixture[]): Promise<void> {
  for (const pair of pairSnapshotsToNames(current, declared)) await ensureOneSnapshotName(ctx, workspaceId, analysisId, pair.snapshot, pair.fixture);
}

/**
 * REAL BACKEND BUG FOUND (live, 2026-08-28, no backend change made here):
 * `UpdateSnapshotDto.performedBy` is declared required (`@IsString()`, no
 * `@IsOptional()`) even though `updateSnapshot()` on the gateway controller
 * always OVERWRITES it from `@ActorId()` before forwarding
 * (`{ id: snapshotId, ...body, performedBy }`) — so a body carrying only
 * `{ name }`, the only field a caller can legitimately set, 400s with
 * "performedBy must be a string" before the controller's own override ever
 * runs. Every other proxy route in this file that re-derives an actor field
 * (`createThreshold`, `createSnapshot`, etc.) types its `@Body()` as
 * `Omit<Dto, 'thatField'>` precisely to avoid this; `updateSnapshot` is the
 * one route that doesn't. Worked around by sending a placeholder
 * `performedBy` the server discards and replaces — logged for a future fix
 * story, not fixed in this one (SI-044 is REST-only / no backend change).
 */
async function ensureOneSnapshotName(ctx: ProvisioningContext, workspaceId: string, analysisId: string, snapshot: SnapshotSummary, fixture: SnapshotFixture): Promise<void> {
  if (snapshot.name === fixture.name) return;
  const body = { name: fixture.name, performedBy: 'server-derived-from-actor-id' };
  const res = await ctx.client.as(SERVICE_HANDLE, 'PATCH', `/api/v1/view-analyses/${analysisId}/snapshots/${snapshot.id}`, body, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`naming snapshot ${snapshot.id} "${fixture.name}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'snapshot', name: fixture.name, id: snapshot.id, action: 'renamed' });
}
