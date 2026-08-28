import { SERVICE_HANDLE } from '../../steps/context';
import { projectHeaders } from '../../steps/projectProvisioning';
import { fetchPublishedVersions } from '../../steps/interpretationsEvidenceStaging';
import { pass, fail } from '../types';
import type { ProvisioningContext } from '../../steps/context';
import type { VerifyDeps } from '../deps';
import type { RuleResult } from '../types';

/**
 * Capture Spec §9/AC11 — "Interpretations: 3 ... Evidence: 6 ... Published:
 * 1 ... Provenance: at least one fork". Reuses `interpretationsEvidenceStaging.ts`'s
 * `fetchPublishedVersions` (AXI-1377, the same "exactly one published"
 * lookup that step's own idempotency guard depends on). The fork check
 * reads the derived, read-only `GET .../provenance-graph` route the
 * dev-epic-context's route table names but no prior story had called yet.
 */
const RULE = 'Capture Spec §9/AC11 — interpretations, evidence, published, fork';

interface RawEvidence {
  id: string;
  currentVersion?: { id: string } | null;
}

interface RawDecision {
  id: string;
  label: string;
}

interface ProvenanceGraph {
  nodes: { id: string }[];
  edges: { targetNodeId: string }[];
}

export async function checkGovernanceRecord(ctx: ProvisioningContext, deps: VerifyDeps): Promise<RuleResult> {
  const [evidenceCount, decisionCount, publishedCount, graph] = await Promise.all([
    fetchEvidenceCount(ctx, deps),
    fetchDecisionCount(ctx, deps),
    fetchPublishedVersions(ctx, deps.workspaceId, deps.analysisId).then((v) => v.length),
    fetchProvenanceGraph(ctx, deps),
  ]);
  return evaluateGovernanceRecord({ evidenceCount, decisionCount, publishedCount, hasFork: hasForkIn(graph) });
}

async function fetchEvidenceCount(ctx: ProvisioningContext, deps: VerifyDeps): Promise<number> {
  const res = await ctx.client.as<{ data: RawEvidence[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/view-analyses/${deps.analysisId}/evidences?page=1&limit=50`,
    undefined,
    projectHeaders(deps.workspaceId),
  );
  if (!res.ok) throw new Error(`listing evidence failed (status ${res.status})`);
  return (res.body?.data ?? []).filter((e) => e.currentVersion).length;
}

async function fetchDecisionCount(ctx: ProvisioningContext, deps: VerifyDeps): Promise<number> {
  const res = await ctx.client.as<{ data: RawDecision[] }>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/workspaces/${deps.workspaceId}/decisions?viewAnalysisId=${deps.analysisId}&limit=50`,
    undefined,
    projectHeaders(deps.workspaceId),
  );
  if (!res.ok) throw new Error(`listing decisions failed (status ${res.status})`);
  return (res.body?.data ?? []).length;
}

async function fetchProvenanceGraph(ctx: ProvisioningContext, deps: VerifyDeps): Promise<ProvenanceGraph> {
  const res = await ctx.client.as<ProvenanceGraph>(
    SERVICE_HANDLE,
    'GET',
    `/api/v1/view-analyses/${deps.analysisId}/provenance-graph`,
    undefined,
    projectHeaders(deps.workspaceId),
  );
  return res.body ?? { nodes: [], edges: [] };
}

/** Pure — exported for unit testing. A fork exists once some node has >= 2
 *  incoming edges (two interpretations citing the same evidence node). */
export function hasForkIn(graph: ProvenanceGraph): boolean {
  const inDegree = new Map<string, number>();
  for (const edge of graph.edges) inDegree.set(edge.targetNodeId, (inDegree.get(edge.targetNodeId) ?? 0) + 1);
  return [...inDegree.values()].some((n) => n >= 2);
}

interface GovernanceCounts {
  evidenceCount: number;
  decisionCount: number;
  publishedCount: number;
  hasFork: boolean;
}

/** Pure — exported for unit testing. */
export function evaluateGovernanceRecord(counts: GovernanceCounts): RuleResult {
  const problems = describeGovernanceProblems(counts);
  if (problems.length > 0) return fail(RULE, problems.join('; '));
  return pass(RULE, `interpretations=${counts.decisionCount} evidence=${counts.evidenceCount} published=${counts.publishedCount} fork=yes`);
}

function describeGovernanceProblems(counts: GovernanceCounts): string[] {
  const problems: string[] = [];
  if (counts.decisionCount !== 3) problems.push(`interpretations=${counts.decisionCount}, expected 3`);
  if (counts.evidenceCount !== 6) problems.push(`evidence=${counts.evidenceCount}, expected 6`);
  if (counts.publishedCount !== 1) problems.push(`published=${counts.publishedCount}, expected 1`);
  if (!counts.hasFork) problems.push('provenance graph has no fork (no node with >= 2 incoming edges)');
  return problems;
}
