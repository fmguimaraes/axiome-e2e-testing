import { SERVICE_HANDLE, recordTouched } from './context';
import { findExistingDataset, requireWorkspaceId, requireProjectId } from './datasetIngestion';
import { requireDatasetId } from './analysisFraming';
import { requireAnalysisId } from './chartStaging';
import { projectHeaders } from './projectProvisioning';
import type { ProvisioningContext } from './context';
import type { DatasetFixture, SnapshotFixture } from '../fixtures/types';
import type { Step } from './types';

const POLL_ATTEMPTS = 5;
const POLL_DELAY_MS = 200;

/**
 * FR11/AC10 (Capture Spec §4) — stages snapshot v1 (pooled) and v2 (real
 * stratified contrast). Depends on `ensure-comments`: Capture Spec §20's
 * declared order is comments before v2, because the external thread
 * (already staged, AXI-1375) resolves to v2.
 *
 * OQ6 FOLLOW-UP (real stratified v2, superseding the AXI-1376 "labeled v2"
 * finding): the original story found the analysis's bound dataset (the DE
 * table, `94b0bd10`) has no per-patient exposure column, so it staged v2 as
 * a same-data LABEL. That is fixed here by computing the real per-arm DE
 * result offline — `riaz_de/run_de_stratified.py` re-runs the pre-therapy
 * responder-vs-non-responder DESeq2 contrast SEPARATELY within the
 * ipilimumab-naive and -progressed arms (same offline-DE precedent as v1's
 * own `run_de.py`, and as `build_count_matrix_dataset.py` for AXI-1374's
 * charts 5-6) — and ingesting it as its own dataset
 * (`content.datasets[role='stratified_de_table']`).
 *
 * PLATFORM MECHANISM (why this is REST-feasible with no backend change):
 * `ViewAnalysisSnapshot.datasetId` is resolved PER SNAPSHOT
 * (`resolveSnapshotDatasetId`, `view-analyses.service.ts`), not fixed to the
 * analysis's root dataset. `CreateViewAnalysisSnapshotDto` already accepts
 * an explicit `datasetId` + `origin`, and `SnapshotOrigin.linked` exists
 * precisely for "a snapshot that points at an append-only-attached dataset
 * that is unrelated to the analysis root" (`assertOriginInvariant`'s own
 * comment) — exempt from the "must match root" invariant that `rule_derived`
 * enforces, and requiring no `RuleRun` (the platform's live "Stratification
 * Rule" feature, `IN-PROGRESS-Stratification-Rule.md`, is a separate,
 * unbuilt MVP — not needed here). The only server-side constraint is that
 * the linked dataset share the analysis's workspace
 * (`assertDatasetSharesWorkspace`), which the fixture's `checkDatasetsShareCorpus`
 * already guarantees. So: ingest the real per-arm result as an ordinary
 * dataset (same route as v1's dataset and AXI-1374's count-matrix dataset),
 * then `POST /view-analyses/snapshots` with `{ datasetId, origin: 'linked' }`
 * for v2. No product/backend change needed.
 *
 * SUPERSEDING A STALE PRIOR v2: the earlier story run already created a v2
 * row bound to the (wrong) root dataset. A snapshot's `datasetId` is
 * immutable once created (no PATCH field for it) and there is no DELETE
 * route for a snapshot, so a stale row can't be fixed or removed — it is
 * renamed out of the way (suffixed, see {@link SUPERSEDED_SUFFIX}) and a
 * fresh, correctly-linked snapshot is minted and given the canonical v2
 * name. This mirrors the "rename leaked artifacts rather than delete them"
 * precedent AXI-1371 already established for pre-existing tenant state.
 * Reconciliation is therefore NAME-keyed (a declared snapshot's `name` is
 * its idempotent identity, per `types.ts`), not version-ordinal-keyed —
 * version-ordinal pairing breaks the moment a superseded row exists between
 * two live backend versions.
 *
 * ROUTE FINDING (why plain `/snapshots`, not `/snapshots/materialize`): the
 * dev-epic-context route table pairs `POST /view-analyses/snapshots` with
 * `.../snapshots/materialize` as "await it (EC7)". Live source investigation
 * (`view-analyses.service.ts materializeSnapshot()`) shows `/materialize` is
 * a GET-OR-REUSE-by-filter-signature route ("snapshot-on-consumption"): it
 * returns an EXISTING snapshot when one already matches
 * (datasetId, filters, filterCombinator). Since v1 and v2 now resolve
 * against DIFFERENT datasets, `/materialize` would actually be safe for
 * them individually — but plain `POST /view-analyses/snapshots` (no dedup,
 * `createSnapshot()` always inserts a new row) is still the correct choice
 * for superseding a stale row, since minting the replacement must not
 * silently resolve back to whatever the dedup signature already matches.
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
 * Idempotent (NFR1): re-run finds each declared snapshot by name; a match
 * whose live `datasetId` already equals the declared target is a no-op; a
 * mismatch (stale) is superseded-then-recreated; a name with no live match
 * is created fresh.
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
    const rootDatasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
    const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, rootDatasetId);
    const datasetIdByRole = await resolveDatasetIdsByRole(ctx, workspaceId, content.datasets);

    for (const fixture of content.snapshots) {
      const targetDatasetId = resolveDatasetIdForSnapshot(fixture, datasetIdByRole, rootDatasetId);
      await ensureOneDeclaredSnapshot(ctx, workspaceId, analysisId, fixture, targetDatasetId, rootDatasetId);
    }
  },
};

export interface SnapshotSummary {
  id: string;
  version: number;
  name: string | null;
  datasetId: string;
}

/** Exported for unit testing — pure, no network. Resolves which live
 *  dataset id a declared snapshot must point at: its declared
 *  `datasetRole` if it has one, else the analysis's own root dataset. */
export function resolveDatasetIdForSnapshot(fixture: SnapshotFixture, datasetIdByRole: Record<string, string>, rootDatasetId: string): string {
  if (!fixture.datasetRole) return rootDatasetId;
  const id = datasetIdByRole[fixture.datasetRole];
  if (!id) throw new Error(`snapshot "${fixture.name}" declares datasetRole "${fixture.datasetRole}", but no dataset with that role is live yet`);
  return id;
}

/** Exported for unit testing — pure, no network. */
export function findSnapshotByName(current: SnapshotSummary[], name: string): SnapshotSummary | undefined {
  return current.find((s) => s.name === name);
}

/** Exported for unit testing — pure, no network. A live snapshot is stale
 *  relative to a declared target when it already exists under that name but
 *  resolves against a different dataset (immutable once created). */
export function snapshotIsStale(existing: SnapshotSummary, targetDatasetId: string): boolean {
  return existing.datasetId !== targetDatasetId;
}

async function resolveDatasetIdsByRole(ctx: ProvisioningContext, workspaceId: string, datasets: DatasetFixture[]): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const d of datasets) {
    const found = await findExistingDataset(ctx, workspaceId, d.originalFilename);
    if (found) map[d.role] = found.id;
  }
  return map;
}

async function ensureOneDeclaredSnapshot(
  ctx: ProvisioningContext,
  workspaceId: string,
  analysisId: string,
  fixture: SnapshotFixture,
  targetDatasetId: string,
  rootDatasetId: string,
): Promise<void> {
  const current = await fetchSnapshots(ctx, workspaceId, analysisId);
  const existing = findSnapshotByName(current, fixture.name);
  if (existing && !snapshotIsStale(existing, targetDatasetId)) return; // already correct (NFR1 no-op)
  if (existing) await supersedeSnapshot(ctx, workspaceId, analysisId, existing);
  const created = await createSnapshot(ctx, workspaceId, analysisId, targetDatasetId, rootDatasetId);
  await nameSnapshot(ctx, workspaceId, analysisId, created, fixture.name);
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

/** Mints a fresh snapshot bound to `targetDatasetId`. When that differs from
 *  the analysis's own root dataset, it is sent as an explicit
 *  `{ datasetId, origin: 'linked' }` — see the module doc for why `linked`
 *  is the correct origin for an unrelated, pre-computed real dataset. */
async function createSnapshot(ctx: ProvisioningContext, workspaceId: string, analysisId: string, targetDatasetId: string, rootDatasetId: string): Promise<SnapshotSummary> {
  const isLinked = targetDatasetId !== rootDatasetId;
  const body: Record<string, unknown> = { viewAnalysisId: analysisId, filters: [] };
  if (isLinked) {
    body.datasetId = targetDatasetId;
    body.origin = 'linked';
  }
  const res = await ctx.client.as<SnapshotSummary>(SERVICE_HANDLE, 'POST', '/api/v1/view-analyses/snapshots', body, projectHeaders(workspaceId));
  if (!res.ok || !res.body) throw new Error(`creating a snapshot for analysis ${analysisId} failed (status ${res.status})`);
  await awaitSnapshotVisible(ctx, workspaceId, analysisId, res.body.id); // EC7
  recordTouched(ctx, { kind: 'snapshot', name: `v${res.body.version}`, id: res.body.id, action: 'created' });
  return res.body;
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

const SUPERSEDED_SUFFIX = ' (superseded — bound to a stale dataset)';

/** Renames a stale prior snapshot out of the way so its name stops
 *  colliding with the declared identity marker — see module doc ("SUPERSEDING
 *  A STALE PRIOR v2") for why a rename, not a delete, is the only REST-
 *  available move. Idempotent: if the row was already renamed on a prior
 *  run, `nameSnapshot`'s no-op guard on the ordinary path stays correct;
 *  this function itself always fires once for a detected mismatch, which is
 *  fine because a superseded row is never looked up by name again. */
async function supersedeSnapshot(ctx: ProvisioningContext, workspaceId: string, analysisId: string, existing: SnapshotSummary): Promise<void> {
  const name = `${existing.name ?? `Snapshot v${existing.version}`}${SUPERSEDED_SUFFIX}`;
  await nameSnapshot(ctx, workspaceId, analysisId, existing, name);
  recordTouched(ctx, { kind: 'snapshot', name, id: existing.id, action: 'superseded' });
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
async function nameSnapshot(ctx: ProvisioningContext, workspaceId: string, analysisId: string, snapshot: SnapshotSummary, name: string): Promise<void> {
  if (snapshot.name === name) return;
  const body = { name, performedBy: 'server-derived-from-actor-id' };
  const res = await ctx.client.as(SERVICE_HANDLE, 'PATCH', `/api/v1/view-analyses/${analysisId}/snapshots/${snapshot.id}`, body, projectHeaders(workspaceId));
  if (!res.ok) throw new Error(`naming snapshot ${snapshot.id} "${name}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'snapshot', name, id: snapshot.id, action: 'renamed' });
}
