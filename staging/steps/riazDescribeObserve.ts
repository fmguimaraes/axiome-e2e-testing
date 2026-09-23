/**
 * AXI-1565 (epic AXI-1555 — FR35) — reads, over REST, what a governed describe
 * run actually produced, in the shape `riazDescribeAssertions.ts` compares
 * against. Five reads, all of them the ones the product's own surfaces make:
 *
 *  1. the analysis' snapshots (`resultBinding.operationBinding` is decorated onto
 *     that list by AXI-1561 — the binding chip's source, never re-derived here);
 *  2. the rule run's result table (already in the trace, collected by the runner);
 *  3. the recommended `DataviewSpec` on the result dataset (`origin:'recommended'`,
 *     the same candidates listing `stage:riaz-publish` selects from — AXI-1553:
 *     never build a chart, only select the platform's own);
 *  4. the analysis' decision drafts, for the `descriptive_summary` draft whose
 *     `context.ruleRunId` names the run (AXI-1562);
 *  5. the plan node, for the connector code the planner CITED (the run row itself
 *     persists no connector code — AXI-1558 debt).
 */
import type { RestClient } from '../client/RestClient';
import { asList, must } from '../rules/ensureRule';
import { SERVICE_HANDLE } from './context';
import { projectHeaders } from './projectProvisioning';
import type { ObservedBinding, ObservedDecision, ObservedDescribeResult } from './riazDescribeAssertions';
import type { QuestionTrace } from './runRiazQuestions';

export const DESCRIBE_RUN_KIND = 'DESCRIBE';

interface Filter {
  column: string;
  operator: string;
  value: unknown;
}

interface OperationBindingDetail {
  operationId?: string | null;
  boundParameters?: Record<string, unknown> | null;
  nGroups?: number | null;
  unmappedColumns?: string[] | null;
  ambiguous?: boolean | null;
  matchedConnectors?: Array<{ ruleCode?: string }> | null;
  citation?: { status?: string | null } | null;
}

interface SnapshotRead {
  id: string;
  datasetId?: string | null;
  parentSnapshotId?: string | null;
  ruleRunId?: string | null;
  origin?: string | null;
  effectiveFilters?: Filter[] | null;
  filters?: Filter[] | null;
  resultBinding?: { state?: string | null; operationBinding?: OperationBindingDetail | null } | null;
}

interface DecisionRead {
  id: string;
  type?: string | null;
  status?: string | null;
  context?: { ruleRunId?: string | null; resultSentence?: { text?: string | null; pending?: boolean } | null } | null;
}

interface SpecRead {
  id: string;
  origin?: string | null;
}

export const filterText = (filters: readonly Filter[]): string =>
  filters.map((f) => `${f.column} ${f.operator} ${Array.isArray(f.value) ? f.value.join('/') : String(f.value)}`).join(' & ');

/** The connector code the plan node cited, wherever the planner put it. */
export function citedConnectorOf(node: QuestionTrace['planNodes'][number] | undefined): string | null {
  if (!node) return null;
  const operation = (node.operation ?? {}) as { ruleCode?: unknown };
  const params = (node.params ?? {}) as { ruleCode?: unknown };
  const code = operation.ruleCode ?? params.ruleCode;
  return typeof code === 'string' && code ? code : null;
}

/** `n_groups` as the binding reports it, else as the run's own metrics do. */
export function nGroupsOf(detail: OperationBindingDetail | null, summary: unknown): number | null {
  if (typeof detail?.nGroups === 'number') return detail.nGroups;
  const metrics = ((summary ?? {}) as { metrics?: Record<string, unknown> }).metrics ?? {};
  const n = (metrics as { n_groups?: unknown }).n_groups;
  return typeof n === 'number' ? n : null;
}

export function bindingOf(snapshot: SnapshotRead | undefined): ObservedBinding | null {
  const report = snapshot?.resultBinding;
  const detail = report?.operationBinding;
  if (!report || !detail) return null;
  return {
    state: report.state ?? null,
    ambiguous: detail.ambiguous ?? null,
    matchedConnectors: (detail.matchedConnectors ?? []).map((c) => c.ruleCode ?? '').filter(Boolean),
    unmappedColumns: detail.unmappedColumns ?? [],
    citationStatus: detail.citation?.status ?? null,
  };
}

/** The `descriptive_summary` draft this run's sentence lives on (AXI-1562). */
export function decisionOf(decisions: readonly DecisionRead[], ruleRunId: string): ObservedDecision | null {
  const draft = decisions.find((d) => d.context?.ruleRunId === ruleRunId);
  if (!draft) return null;
  return {
    id: draft.id,
    type: draft.type ?? null,
    ruleRunId: draft.context?.ruleRunId ?? null,
    sentenceText: draft.context?.resultSentence?.text ?? null,
    status: draft.status ?? null,
  };
}

async function listSnapshots(client: RestClient, H: Record<string, string>, analysisId: string): Promise<SnapshotRead[]> {
  return asList<SnapshotRead>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=100`, undefined, H), 'snapshots'));
}

async function listDecisions(client: RestClient, H: Record<string, string>, workspaceId: string, analysisId: string): Promise<DecisionRead[]> {
  return asList<DecisionRead>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/decisions?viewAnalysisId=${analysisId}&limit=100`, undefined, H), 'decisions'));
}

async function recommendedSpecId(client: RestClient, H: Record<string, string>, workspaceId: string, datasetId: string | null): Promise<string | null> {
  if (!datasetId) return null;
  const res = await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/workspaces/${workspaceId}/datasets/${datasetId}/candidates`, undefined, H);
  if (!res.ok) return null;
  return asList<SpecRead>(res.body).find((s) => s.origin === 'recommended')?.id ?? null;
}

/** Every DESCRIBE run of one question, observed. */
export async function observeDescribeResults(client: RestClient, workspaceId: string, q: QuestionTrace): Promise<ObservedDescribeResult[]> {
  if (!q.viewAnalysisId) return [];
  const H = projectHeaders(workspaceId);
  const snapshots = await listSnapshots(client, H, q.viewAnalysisId);
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  const decisions = await listDecisions(client, H, workspaceId, q.viewAnalysisId);
  const out: ObservedDescribeResult[] = [];
  for (const run of q.ruleRuns.filter((r) => r.kind === DESCRIBE_RUN_KIND)) {
    out.push(await observeOne(client, H, workspaceId, q, run, byId, decisions));
  }
  return out;
}

async function observeOne(
  client: RestClient,
  H: Record<string, string>,
  workspaceId: string,
  q: QuestionTrace,
  run: QuestionTrace['ruleRuns'][number],
  byId: Map<string, SnapshotRead>,
  decisions: readonly DecisionRead[],
): Promise<ObservedDescribeResult> {
  const produced = byId.get(run.producedSnapshotId);
  const referent = run.referentSnapshotId ? byId.get(run.referentSnapshotId) : undefined;
  const detail = produced?.resultBinding?.operationBinding ?? null;
  const decision = decisionOf(decisions, run.id);
  return {
    ruleRunId: run.id,
    snapshotId: run.producedSnapshotId,
    cohort: filterText(referent?.effectiveFilters ?? referent?.filters ?? []),
    operationId: run.operationId ?? detail?.operationId ?? null,
    citedConnector: citedConnectorOf(q.planNodes.find((n) => n.id === run.planNode)),
    boundParameters: detail?.boundParameters ?? {},
    columns: run.columns,
    rows: run.rows,
    nGroups: nGroupsOf(detail, run.summary),
    binding: bindingOf(produced),
    recommendedChartSpecId: await recommendedSpecId(client, H, workspaceId, produced?.datasetId ?? null),
    sentence: decision?.sentenceText ?? null,
    decision,
  };
}
