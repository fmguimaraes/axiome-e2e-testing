import { SERVICE_HANDLE } from '../../steps/context';
import { fetchExistingSpecs } from '../../steps/chartStaging';
import { fetchSnapshots, findSnapshotByName } from '../../steps/snapshotStaging';
import { pass, fail } from '../types';
import type { ProvisioningContext } from '../../steps/context';
import type { SnapshotSummary } from '../../steps/snapshotStaging';
import type { VerifyDeps } from '../deps';
import type { RuleResult } from '../types';

/**
 * Capture Spec §8 (thresholds, author/value/rationale/provenance visible)
 * + §4/AC10/OQ6 (snapshot v1 pooled, v2 a GENUINELY different stratified
 * contrast — the OQ6 follow-up the dev-epic-context flags: "AXI-1380 verify
 * should assert v1 != v2 substance"). Reuses `chartStaging.ts`'s
 * `fetchExistingSpecs` (to resolve the threshold-carrying chart) and
 * `snapshotStaging.ts`'s `fetchSnapshots`/`findSnapshotByName` (AXI-1376,
 * the same name-keyed lookup that step's own idempotency depends on).
 */
const RULE = 'Capture Spec §4/§8/AC10 — thresholds with provenance, snapshots v1/v2';
const THRESHOLD_CHART_TITLE = 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1';

interface ExistingThreshold {
  id: string;
  label: string;
  status: string;
}

interface ExistingAnnotation {
  text: string;
  status: string;
  target: { type: string };
}

interface Verdict {
  ok: boolean;
  detail: string;
}

export async function checkThresholdsAndSnapshots(ctx: ProvisioningContext, deps: VerifyDeps): Promise<RuleResult> {
  const thresholdFinding = await checkThresholds(ctx, deps);
  if (!thresholdFinding.ok) return fail(RULE, thresholdFinding.detail);
  const snapshotFinding = await checkSnapshots(ctx, deps);
  if (!snapshotFinding.ok) return fail(RULE, snapshotFinding.detail);
  return pass(RULE, `${thresholdFinding.detail}; ${snapshotFinding.detail}`);
}

async function checkThresholds(ctx: ProvisioningContext, deps: VerifyDeps): Promise<Verdict> {
  const specs = await fetchExistingSpecs(ctx, deps.workspaceId, deps.deTableDatasetId, deps.analysisId);
  const spec = specs.find((s) => s.title === THRESHOLD_CHART_TITLE);
  if (!spec) return { ok: false, detail: `threshold-carrying chart "${THRESHOLD_CHART_TITLE}" not found live` };
  const [thresholds, annotations] = await Promise.all([fetchThresholds(ctx, spec.id), fetchAnnotations(ctx, spec.id)]);
  return evaluateThresholds(thresholds, annotations);
}

async function fetchThresholds(ctx: ProvisioningContext, specId: string): Promise<ExistingThreshold[]> {
  const res = await ctx.client.as<ExistingThreshold[]>(SERVICE_HANDLE, 'GET', `/api/v1/visualization-specs/${specId}/thresholds?status=active`);
  return res.body ?? [];
}

async function fetchAnnotations(ctx: ProvisioningContext, specId: string): Promise<ExistingAnnotation[]> {
  const res = await ctx.client.as<ExistingAnnotation[]>(SERVICE_HANDLE, 'GET', `/api/v1/visualization-specs/${specId}/annotations?status=active`);
  return res.body ?? [];
}

/** Pure — exported for unit testing. Capture Spec §8: >= 2 active
 *  thresholds, each carrying a non-empty provenance label, plus >= 1
 *  threshold-targeted annotation carrying a one-line rationale. */
export function evaluateThresholds(thresholds: ExistingThreshold[], annotations: ExistingAnnotation[]): Verdict {
  if (thresholds.length < 2) return { ok: false, detail: `only ${thresholds.length} active threshold(s), need >= 2` };
  if (thresholds.some((t) => t.label.trim().length === 0)) return { ok: false, detail: 'a threshold has no provenance label' };
  const rationales = annotations.filter((a) => a.target.type === 'threshold' && a.text.trim().length > 0);
  if (rationales.length === 0) return { ok: false, detail: 'no threshold rationale annotation found' };
  return { ok: true, detail: `${thresholds.length} thresholds with provenance labels, ${rationales.length} rationale annotation(s)` };
}

async function checkSnapshots(ctx: ProvisioningContext, deps: VerifyDeps): Promise<Verdict> {
  const snapshots = await fetchSnapshots(ctx, deps.workspaceId, deps.analysisId);
  const v1 = findSnapshotByName(snapshots, ctx.fixture.content.snapshots[0]?.name ?? '');
  const v2 = findSnapshotByName(snapshots, ctx.fixture.content.snapshots[1]?.name ?? '');
  return evaluateSnapshots(v1, v2);
}

/** Pure — exported for unit testing. AC10 + OQ6: both exist and are
 *  materialized (a live id), and v2 binds to a DIFFERENT dataset than v1 —
 *  the structural proof v2 is a real stratified contrast, not a same-data
 *  label (dev-epic-context OQ6 resolution). */
export function evaluateSnapshots(v1: SnapshotSummary | undefined, v2: SnapshotSummary | undefined): Verdict {
  if (!v1) return { ok: false, detail: 'snapshot v1 not found live' };
  if (!v2) return { ok: false, detail: 'snapshot v2 not found live' };
  if (v1.datasetId === v2.datasetId) {
    return { ok: false, detail: 'snapshot v2 binds to the same dataset as v1 — not a genuinely different stratified contrast (OQ6)' };
  }
  return { ok: true, detail: 'snapshot v1 and v2 both materialized, v2 bound to a distinct dataset (real stratified contrast)' };
}
