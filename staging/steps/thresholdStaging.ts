import { SERVICE_HANDLE, recordTouched } from './context';
import { requireWorkspaceId, requireProjectId } from './datasetIngestion';
import { requireDatasetId } from './analysisFraming';
import { fetchExistingSpecs, requireAnalysisId } from './chartStaging';
import type { ProvisioningContext } from './context';
import type { CastMemberFixture, ThresholdFixture } from '../fixtures/types';
import type { Step } from './types';

/**
 * (Capture Spec §8) — stages the two governance thresholds on the chart
 * that names them ("Significant differential expression — FDR < 0.05,
 * |log2FC| ≥ 1"), authored as Marc Ottavi/MO (Capture Spec §3).
 *
 * NO DEDICATED FR/AC (finding): the feature doc's FR list has FR10=comments,
 * FR11=snapshots — no numbered FR or AC is pinned to thresholds specifically,
 * even though Capture Spec §8 and the flow diagram's step 8 both cover them,
 * and FR6 names "threshold values and rationales" as fixture content. Staged
 * here anyway per the story brief; traceability cites FR6 (content) — a real
 * gap worth flagging at W5, not something this story can retroactively number.
 *
 * `ThresholdsProxyController` (`apps/gateway/src/proxy/thresholds.controller.ts`)
 * carries only `@UseGuards(AuthGuard)` — no `WorkspaceGuard`/`WorkspaceRoleGuard`
 * — so no workspace-role grant is needed before authoring as MO (confirmed
 * against source; unlike the framing/comment routes, which do gate on a
 * workspace role).
 *
 * PROVENANCE FINDING: the backend `Threshold` entity has no structured
 * provenance or rationale field — only `field`/`operator`/`value`/`label`/
 * `consumers`/`status`/`createdBy` (`libs/contracts/src/threshold/
 * threshold.patterns.ts`, `apps/organization-service/.../prisma/schema.prisma`
 * `model Threshold`). Capture Spec §8's "provenance visible" and "one-line
 * rationale" are honestly represented as: (1) a short marker folded into
 * `label` (e.g. "— published cutoff (external)"), and (2) a threshold-
 * targeted `Annotation` (`POST /api/v1/annotations`, `target: {type:
 * 'threshold', thresholdId}`) carrying the one-line rationale text, authored
 * with MO's real display name — exactly the mechanism the frontend's own
 * `NoteComposer` placeholder invites ("Why this cutoff… (e.g. PD-L1 ≥ 50%
 * per KEYNOTE-024)", `ThresholdsPanel.tsx`). No field is fabricated.
 *
 * MAGNITUDE FINDING: `ThresholdOperator` has no absolute-value operator, so
 * "|log2FC| ≥ 1" (a two-sided exclusion zone) cannot be expressed as one
 * `Threshold` row. The positive boundary (`log2FoldChange >= 1`) is staged
 * as the canonical governance record; the label and rationale both state the
 * rule is symmetric (mirrored at -1) so nothing here misdescribes the cutoff
 * as one-sided.
 *
 * Idempotent (NFR1): re-run matches on (field, operator, value) among active
 * thresholds and (target, text) among active annotations — no duplicate
 * POST, no `assertNoActiveDuplicate` 400 on a second run.
 */
export const ensureThresholdsStep: Step<ProvisioningContext> = {
  id: 'ensure-thresholds',
  dependsOn: ['ensure-charts'],
  async run(ctx) {
    const content = ctx.fixture.content;
    const primary = content.datasets.find((d) => d.role === 'de_table');
    if (!primary || content.thresholds.length === 0) return;
    const workspaceId = requireWorkspaceId(ctx, primary.workspaceName);
    const projectId = await requireProjectId(ctx, workspaceId, primary.projectName);
    const datasetId = await requireDatasetId(ctx, workspaceId, primary.originalFilename);
    const analysisId = await requireAnalysisId(ctx, workspaceId, projectId, datasetId);

    const specs = await fetchExistingSpecs(ctx, workspaceId, datasetId, analysisId);
    for (const threshold of content.thresholds) await ensureOneThreshold(ctx, specs, threshold, ctx.fixture.cast);
  },
};

interface ExistingSpecRef {
  id: string;
  title: string | null;
}

interface ExistingThreshold {
  id: string;
  field: string;
  operator: string;
  value: number | [number, number];
  status: string;
}

interface ExistingAnnotation {
  id: string;
  text: string;
  status: string;
  target: { type: 'chart' } | { type: 'threshold'; thresholdId: string };
}

/** Exported for unit testing — pure, no network (NFR1 idempotency). */
export function alreadyStagedThreshold(existing: ExistingThreshold[], fixture: ThresholdFixture): ExistingThreshold | undefined {
  return existing.find((e) => e.status === 'active' && e.field === fixture.field && e.operator === fixture.operator && e.value === fixture.value);
}

/** Exported for unit testing — pure, no network. */
export function alreadyStagedRationale(existing: ExistingAnnotation[], thresholdId: string, text: string): boolean {
  return existing.some((a) => a.status === 'active' && a.target.type === 'threshold' && a.target.thresholdId === thresholdId && a.text === text);
}

/** Exported for unit testing — pure, no network. `author` on an Annotation
 *  is a display label, not an identity claim (`thresholds.controller.ts`
 *  comment) — the real actor is still `authorHandle`'s own JWT. */
export function resolveCastDisplayName(cast: CastMemberFixture[], handle: string): string {
  const member = cast.find((c) => c.handle === handle);
  if (!member) throw new Error(`no cast member declared for handle "${handle}"`);
  return `${member.displayFirstName} ${member.displayLastName}`;
}

async function ensureOneThreshold(ctx: ProvisioningContext, specs: ExistingSpecRef[], fixture: ThresholdFixture, cast: CastMemberFixture[]): Promise<void> {
  const spec = specs.find((s) => s.title === fixture.chartTitle);
  if (!spec) throw new Error(`threshold "${fixture.label}" targets chart "${fixture.chartTitle}", which does not exist among staged charts — ensure-charts must run first`);
  const existing = await fetchThresholds(ctx, spec.id);
  const record = alreadyStagedThreshold(existing, fixture) ?? (await createThreshold(ctx, spec.id, fixture));
  await ensureRationale(ctx, spec.id, record.id, fixture, cast);
}

async function fetchThresholds(ctx: ProvisioningContext, specId: string): Promise<ExistingThreshold[]> {
  const res = await ctx.client.as<ExistingThreshold[]>(SERVICE_HANDLE, 'GET', `/api/v1/visualization-specs/${specId}/thresholds?status=active`);
  return res.body ?? [];
}

async function createThreshold(ctx: ProvisioningContext, specId: string, fixture: ThresholdFixture): Promise<ExistingThreshold> {
  const body = { visualizationSpecId: specId, field: fixture.field, operator: fixture.operator, value: fixture.value, label: fixture.label };
  const res = await ctx.client.as<ExistingThreshold>(fixture.authorHandle, 'POST', '/api/v1/thresholds', body);
  if (!res.ok || !res.body) throw new Error(`staging threshold "${fixture.label}" as "${fixture.authorHandle}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'threshold', name: fixture.label, id: res.body.id, action: 'created' });
  return res.body;
}

async function fetchAnnotations(ctx: ProvisioningContext, specId: string): Promise<ExistingAnnotation[]> {
  const res = await ctx.client.as<ExistingAnnotation[]>(SERVICE_HANDLE, 'GET', `/api/v1/visualization-specs/${specId}/annotations?status=active`);
  return res.body ?? [];
}

async function ensureRationale(ctx: ProvisioningContext, specId: string, thresholdId: string, fixture: ThresholdFixture, cast: CastMemberFixture[]): Promise<void> {
  const existing = await fetchAnnotations(ctx, specId);
  if (alreadyStagedRationale(existing, thresholdId, fixture.rationale)) return;
  const author = resolveCastDisplayName(cast, fixture.authorHandle);
  const body = { visualizationSpecId: specId, text: fixture.rationale, author, target: { type: 'threshold' as const, thresholdId } };
  const res = await ctx.client.as(fixture.authorHandle, 'POST', '/api/v1/annotations', body);
  if (!res.ok) throw new Error(`staging rationale for threshold "${fixture.label}" as "${fixture.authorHandle}" failed (status ${res.status})`);
  recordTouched(ctx, { kind: 'annotation', name: `rationale:${fixture.label}`, id: thresholdId, action: 'created' });
}
