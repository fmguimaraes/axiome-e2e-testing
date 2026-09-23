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
import type { ObservedBinding, ObservedColumnBinding, ObservedDecision, ObservedDescribeResult } from './riazDescribeAssertions';
import type { QuestionTrace } from './runRiazQuestions';

export const DESCRIBE_RUN_KIND = 'DESCRIBE';

interface Filter {
  column: string;
  operator: string;
  value: unknown;
}

interface OperationBindingDetail {
  operationId?: string | null;
  /** SCALARS ONLY — the column roles live in `canonicalFields` (see `COLUMN_ROLE_PARAMETERS`). */
  boundParameters?: Record<string, unknown> | null;
  canonicalFields?: Array<{ parameter?: string; column?: string; canonicalField?: string | null }> | null;
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

interface EvidenceRead {
  id: string;
  currentVersion?: { text?: string | null; citationContext?: { snapshot_id?: string } | null } | null;
}

/** The column roles the binding report carries, normalised and order-preserving. */
export function canonicalFieldsOf(detail: OperationBindingDetail | null): ObservedColumnBinding[] {
  return (detail?.canonicalFields ?? [])
    .filter((f) => typeof f?.parameter === 'string' && typeof f?.column === 'string')
    .map((f) => ({ parameter: f.parameter as string, column: f.column as string, canonicalField: f.canonicalField ?? null }));
}

/**
 * The sentence as the RESULT surface carries it — the Evidence AXI-1562 mints,
 * found by its citation context, never by title.
 *
 * Deliberately a DIFFERENT surface from the decision draft: comparing the draft's
 * sentence with a sentence read off that same draft asserts nothing (review-gate
 * advisory A1). Evidence text vs draft text is a real cross-surface check.
 */
export function sentenceEvidenceText(evidences: readonly EvidenceRead[], snapshotId: string): string | null {
  const found = evidences.find((e) => e.currentVersion?.citationContext?.snapshot_id === snapshotId);
  return found?.currentVersion?.text ?? null;
}

export const filterText = (filters: readonly Filter[]): string =>
  filters.map((f) => `${f.column} ${f.operator} ${Array.isArray(f.value) ? f.value.join('/') : String(f.value)}`).join(' & ');

/**
 * The DESCRIBE plan node that produced the i-th describe run.
 *
 * `RuleRun.materializedNodeId` is a workflow node UUID, NOT the plan node's id
 * (`n2_describe_rank_mean`), so the id join silently never matches and every
 * question reported `cited connector: none` on the first live run. The runs of
 * one analysis come back in snapshot order and the plan's describe nodes are
 * executed in plan order, so the i-th describe node produced the i-th describe
 * run; the id match is still tried first, in case a future run row carries the
 * plan id. (The run itself persists NO connector code — `rule_runs` has no
 * `rule_code` column — which is AXI-1558's recorded debt and the reason the
 * citation has to be read from the plan at all.)
 */
export function describeNodeFor(
  planNodes: QuestionTrace['planNodes'],
  run: QuestionTrace['ruleRuns'][number],
  describeRunIndex: number,
): QuestionTrace['planNodes'][number] | undefined {
  const byId = planNodes.find((n) => n.id === run.planNode);
  if (byId) return byId;
  const describeNodes = planNodes.filter((n) => n.nodeType === 'describe' || String((n.params as { operation?: unknown })?.operation ?? '').startsWith('describe.'));
  const sameOperation = describeNodes.filter((n) => operationIdOf(n) === run.operationId);
  const pool = sameOperation.length ? sameOperation : describeNodes;
  return pool[describeRunIndex] ?? pool[0];
}

const operationIdOf = (node: QuestionTrace['planNodes'][number]): string | null => {
  const operation = (node.operation ?? {}) as { operationId?: unknown };
  const params = (node.params ?? {}) as { operation?: unknown };
  const id = operation.operationId ?? params.operation;
  return typeof id === 'string' ? id : null;
};

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

/**
 * The RECOMMENDED CHART of a describe result is NOT a `DataviewSpec` with
 * `origin: 'recommended'` — that was this step's first-run misconception, and
 * it reported "recommended chart absent" while the product renders one.
 *
 * What the UI actually renders (`GuidedRecommendedChart`, AXI-1462/AXI-1564) is
 * the chart the OPERATION DECLARES in the registry (`defaultChart`, AXI-1414),
 * whose role templates (`{groupColumns}`, `{aggregation}_{valueColumn}`,
 * `{sortColumn}`, `rank`, `n`) are resolved against the RUN's own result
 * columns. So "the recommended chart is present" means exactly: the descriptor
 * declares a `result`-surface default chart AND every column its roles resolve
 * to exists in the result table. The exploratory `origin: 'auto'` candidates on
 * the result dataset are a different surface and prove nothing about it.
 */
export interface ObservedRecommendedChart {
  chartType: string | null;
  /** role → the column it resolved to (after template substitution) */
  roles: Record<string, string>;
  /** roles whose template resolved to a column the result table does not carry */
  missingColumns: string[];
  surfaces: string[];
}

export interface OperationDescriptor {
  operationId?: string;
  defaultChart?: { type?: string; roles?: Record<string, string>; annotation?: string[]; surfaces?: string[] } | null;
}

/** `{groupColumns}` / `{aggregation}_{valueColumn}` / `{sortColumn}` → real column names. */
export function resolveChartRole(
  template: string,
  boundParameters: Record<string, unknown>,
  canonicalFields: readonly ObservedColumnBinding[],
): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_m, key: string) => {
    const columns = canonicalFields.filter((f) => f.parameter === key).map((f) => f.column);
    if (columns.length) return columns.join(',');
    const scalar = boundParameters[key];
    return scalar === undefined || scalar === null ? '' : String(scalar);
  });
}

export function recommendedChartOf(
  descriptors: readonly OperationDescriptor[],
  operationId: string | null,
  boundParameters: Record<string, unknown>,
  canonicalFields: readonly ObservedColumnBinding[],
  columns: readonly string[],
): ObservedRecommendedChart | null {
  const chart = descriptors.find((d) => d.operationId === operationId)?.defaultChart;
  if (!chart) return null;
  const roles: Record<string, string> = {};
  const missingColumns: string[] = [];
  const known = new Set(columns.map((c) => c.toLowerCase()));
  for (const [role, template] of Object.entries(chart.roles ?? {})) {
    const resolved = resolveChartRole(template, boundParameters, canonicalFields);
    roles[role] = resolved;
    for (const column of resolved.split(',').filter(Boolean)) {
      if (!known.has(column.toLowerCase())) missingColumns.push(column);
    }
  }
  return { chartType: chart.type ?? null, roles, missingColumns, surfaces: chart.surfaces ?? [] };
}

async function listOperationDescriptors(client: RestClient, H: Record<string, string>): Promise<OperationDescriptor[]> {
  const res = await client.as<{ operations?: OperationDescriptor[] }>(SERVICE_HANDLE, 'GET', '/api/v1/rule-runs/operations', undefined, H);
  return res.ok && res.body?.operations ? res.body.operations : [];
}

async function listEvidence(client: RestClient, H: Record<string, string>, analysisId: string): Promise<EvidenceRead[]> {
  const res = await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${analysisId}/evidences?page=1&limit=100`, undefined, H);
  return res.ok ? asList<EvidenceRead>(res.body) : [];
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
  const evidences = await listEvidence(client, H, q.viewAnalysisId);
  const descriptors = await listOperationDescriptors(client, H);
  const out: ObservedDescribeResult[] = [];
  const describeRuns = q.ruleRuns.filter((r) => r.kind === DESCRIBE_RUN_KIND);
  for (const [i, run] of describeRuns.entries()) {
    out.push(await observeOne(client, H, workspaceId, q, run, byId, decisions, evidences, descriptors, i));
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
  evidences: readonly EvidenceRead[],
  descriptors: readonly OperationDescriptor[],
  describeRunIndex: number,
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
    citedConnector: citedConnectorOf(describeNodeFor(q.planNodes, run, describeRunIndex)),
    boundParameters: detail?.boundParameters ?? {},
    canonicalFields: canonicalFieldsOf(detail),
    columns: run.columns,
    rows: run.rows,
    nGroups: nGroupsOf(detail, run.summary),
    binding: bindingOf(produced),
    recommendedChartSpecId: await recommendedSpecId(client, H, workspaceId, produced?.datasetId ?? null),
    recommendedChart: recommendedChartOf(descriptors, run.operationId, detail?.boundParameters ?? {}, canonicalFieldsOf(detail), run.columns),
    sentence: sentenceEvidenceText(evidences, run.producedSnapshotId),
    decision,
  };
}
