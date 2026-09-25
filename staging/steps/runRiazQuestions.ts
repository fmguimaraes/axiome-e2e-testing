import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RestClient } from '../client/RestClient';
import { ensureIdentities } from '../identities/ensureIdentities';
import { asList, must } from '../rules/ensureRule';
import { rulesForQuestion } from '../rules/riazRuleLibrary';
import { ADMIN_HANDLE, SERVICE_HANDLE } from './context';
import { projectHeaders } from './projectProvisioning';
import { allPassed, evaluateDescribeQuestion, type Assertion, type ObservedDescribeResult } from './riazDescribeAssertions';
import { DESCRIBE_EXPECTED, isDescribeQuestion } from './riazDescribeExpectations';
import { observeDescribeResults } from './riazDescribeObserve';
import { resolveTenant } from './stageRiazGuided';

/**
 * `npm run stage:riaz-questions` — asks the ten follow-up questions of
 * ../axiome-docs/demo/riaz-2017/Riaz-Guided-Questions.md through the REAL guided-analysis planner (the
 * same REST calls the guided page makes: profile → plan → governed submit →
 * drain → approve), as the presenter identity, and records every id, plan
 * node, rule run and result table to ../axiome-docs/demo/riaz-2017/riaz-questions-trace.json.
 *
 * Differences from the UI, both deliberate: the submit carries
 * `organizationId` (the UI omits it — org-scoped QC rules fail there), and
 * the interpretation node is approved as the service identity (the presenter
 * lacks `governed_execution:approve`). Nothing else is hand-built: the plan is
 * whatever the LLM returned.
 *
 *   npm run stage:riaz-questions                # Q2..Q11
 *   npm run stage:riaz-questions -- --only Q4,Q6
 *   npm run stage:riaz-questions -- --plan-only # planner only, no run
 *
 * Re-runs append: a question already in the trace is skipped unless --only
 * names it (a governed run is never idempotent — every submit is a new run).
 */
const PROTO_ROW_LIMIT = 1000;
const FRONT_URL = (process.env.STAGING_FRONT_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, '');
const TRACE_PATH = process.env.STAGING_RIAZ_QUESTIONS_TRACE?.trim() || '../axiome-docs/demo/riaz-2017/riaz-questions-trace.json';
const PRESENTER = 'cast-biologist';
const SETTLED = new Set(['SUCCEEDED', 'REUSED', 'FAILED', 'BLOCKED', 'CANCELLED', 'AWAITING_APPROVAL']);

type DatasetHandle = 'PAIRED' | 'DE' | 'DE_STRATA' | 'WIDE_V2';
const DATASET_FILES: Record<DatasetHandle, string> = {
  PAIRED: 'riaz2017_immune_paired_log2cpm_long.csv',
  DE: 'riaz2017_de_pre_R_vs_NR.csv',
  DE_STRATA: 'riaz2017_stratified_de_by_prior_ipi.csv',
  // AXI-1587 — the WIDE v2 panel-gene table (AXI-1586), has `prior_ipi` and `delta` (on-Pre).
  WIDE_V2: 'riaz2017_expression_by_response_timepoint_v2.csv',
};

const CYTO = 'CD8A, PRF1, GZMB, IFNG, PDCD1 and LAG3';
const PANEL = 'CD27, CD274, CD3E, CD8A, CTLA4, CXCL10, CXCL11, CXCL9, GZMA, GZMB, HAVCR2, HLA-DRA, IDO1, IFNG, IL2RA, IRF1, LAG3, LCK, NKG7, PDCD1, PRF1, STAT1, TIGIT, TOX';

type ProfileFilter = { column: string; operator: string; value: unknown };
/**
 * `profileSlices` (optional): the planner treats the profiled sample's observed
 * categories as the ONLY legal filter/group values ("verbatim-category
 * constraint"). The UI profiles the first 1000 rows, so on a table sorted by a
 * stratum column the second level never appears and the planner declines that
 * branch (Q9, three times). Listing slices here makes the runner profile
 * `1000 / n` rows from EACH slice instead — a documented deviation from the UI.
 */
export interface Question { id: string; dataset: DatasetHandle; text: string; profileSlices?: ProfileFilter[][] }

export const QUESTIONS: Question[] = [
  { id: 'Q2', dataset: 'PAIRED', text: 'Is PDCD1 (PD-1) transcript induced between the pre-treatment and on-treatment biopsy under nivolumab? Report the paired Pre→On change for PDCD1 across all patients, and separately in responders (response = R) and non-responders (response = NR).' },
  { id: 'Q3', dataset: 'PAIRED', text: 'In responders only (response = R), is the IFN-γ-related programme induced on treatment? Run one paired Pre→On test per gene (pivot on the gene column) for IFNG, CXCL9, CXCL10, CXCL11, IDO1, STAT1, IRF1 and HLA-DRA.' },
  { id: 'Q4', dataset: 'PAIRED', text: `Before treatment (timepoint = Pre), do responders already show higher expression of the cytotoxic genes ${CYTO} than non-responders? Compare response = R vs NR per gene (pivot on the gene column) with a Mann-Whitney U test.` },
  { id: 'Q5', dataset: 'PAIRED', text: `Does the on-treatment induction of the cytotoxic panel (${CYTO}) depend on prior ipilimumab exposure? Run the paired Pre→On test per gene (pivot on the gene column) separately in prior_ipi = ipi_naive and prior_ipi = ipi_progressed. Do not filter the gene column: keep the whole 24-gene panel in each stratum (the paired QC rule needs the full panel's rows) and on each stratum's compare_paired set featureColumn = gene (the feature dimension that separates the rows sharing a patient and timepoint) with valueColumn = log2_cpm, so the result has one row per gene.` },
  { id: 'Q6', dataset: 'PAIRED', text: 'At the on-treatment biopsy (timepoint = On), are the exhaustion / checkpoint markers LAG3, HAVCR2, TIGIT, CTLA4, TOX and PDCD1 higher in responders than in non-responders? Compare response = R vs NR per gene (pivot on the gene column) with a Mann-Whitney U test.' },
  { id: 'Q7', dataset: 'PAIRED', text: `Restricting to non-responders only (response = NR), is there any on-treatment induction of the cytotoxic panel ${CYTO}? Run the paired Pre→On test per gene (pivot on the gene column).` },
  { id: 'Q8', dataset: 'DE', text: `In this pooled pre-treatment responder-vs-non-responder differential-expression table, how many genes pass padj < 0.05, how many of those are up in responders (log2FoldChange > 0), and are any of the 24 immune panel genes (${PANEL}) among them?` },
  { id: 'Q9', dataset: 'DE_STRATA', text: 'Comparing the ipi_naive and ipi_progressed strata in this stratified pre-treatment differential-expression table, how many genes pass padj < 0.05 in each stratum, and is the responder-vs-non-responder signal concentrated in one stratum? Build two filter branches and describe each so the two significant-gene counts can be compared. Each branch must be ONE filter node carrying both conditions in a single conditions array (stratum = ipi_naive and padj < 0.05; stratum = ipi_progressed and padj < 0.05), depending directly on the QC check — do not chain a padj filter under a stratum filter. The table holds both strata (22333 rows each, 44666 in total).', profileSlices: [[{ column: 'stratum', operator: 'eq', value: 'ipi_naive' }], [{ column: 'stratum', operator: 'eq', value: 'ipi_progressed' }]] },
  { id: 'Q10', dataset: 'PAIRED', text: 'Are HLA-DRA and CD274 (PD-L1) induced between the pre-treatment and on-treatment biopsy, and is that induction confined to responders? Run the paired Pre→On test per gene for all patients, responders (response = R) and non-responders (response = NR): one compare_paired per cohort filter. Build each cohort as ONE filter node carrying both conditions (gene = X and response = R/NR in a single conditions array) that depends directly on the QC check — do not chain a response filter under a gene filter.' },
  { id: 'Q11', dataset: 'PAIRED', text: `Does the responder-restricted on-treatment induction of ${CYTO} hold when the paired t-test is replaced by the Wilcoxon signed-rank test? Run the Wilcoxon signed-rank test per gene Pre→On in responders (response = R) and in non-responders (response = NR): apply the paired QC check on the unfiltered responder and non-responder referents (the QC rule needs the whole 24-gene panel's rows), and set featureColumn = gene on each test (with valueColumn = log2_cpm) so the rows sharing a patient and timepoint are separated and the result has one row per gene; do not filter the gene column.` },

  // ── AXI-1565: the ten DESCRIPTIVE questions (Q12–Q21, epic AXI-1555 FR35) ──
  //
  // Each states its connector rule and bound parameters verbatim, the same
  // deliberate deviation from an unaided ask that `profileSlices` is: the
  // planner's freedom to choose a connector is proved by AXI-1563's unit tests,
  // while THIS runner exists to prove the executed path — table, recommended
  // chart, binding `match`, deterministic sentence, Decision — against numbers
  // derived from the source CSVs. A run that had to be re-asked until the
  // planner guessed the right shape would prove neither.
  { id: 'Q12', dataset: 'PAIRED', text: 'Across all patients at the pre-treatment biopsy, what is the mean log2 CPM of each of the 24 immune panel genes, ranked from highest to lowest? Plan exactly two nodes: one filter node with the single condition timepoint = Pre, then one describe node depending on it that cites the connector rule SUM-RANK-01 with groupColumns = [gene], valueColumn = log2_cpm, aggregation = mean and direction = desc.' },
  { id: 'Q13', dataset: 'PAIRED', text: 'Pooling all patients, what is the mean log2 CPM of each panel gene at the pre-treatment and the on-treatment biopsy? Plan exactly one describe node on the whole dataset (no filter) that cites the connector rule SUM-CROSS-01 with groupColumns = [gene, timepoint], valueColumn = log2_cpm and aggregation = mean.' },
  { id: 'Q14', dataset: 'PAIRED', text: 'How many patients are in each response × prior-ipilimumab group? Plan exactly two nodes: ONE filter node carrying both conditions in a single conditions array (gene = CD8A and timepoint = Pre — that single-gene, single-timepoint slice is what makes one row one patient), then one describe node depending on it that cites the connector rule SUM-COUNT-01 with groupColumns = [response, prior_ipi] and distinctKey = patient_id, so the counts are distinct patients and not rows.' },
  { id: 'Q15', dataset: 'DE', text: 'In this pre-treatment responder-vs-non-responder differential-expression table, which ten genes with padj < 0.05 have the largest positive log2 fold change? Plan exactly two nodes: one filter node with the single condition padj < 0.05, then one describe node depending on it that cites the connector rule SUM-TOPN-01 with sortColumn = log2FoldChange, direction = desc and n = 10.' },
  { id: 'Q16', dataset: 'DE', text: 'Among the genes passing padj < 0.05 at baseline, how many are up-regulated and how many are down-regulated in responders? Build two independent branches, each ONE filter node carrying both conditions in a single conditions array (padj < 0.05 and log2FoldChange > 0 for the up branch; padj < 0.05 and log2FoldChange < 0 for the down branch), each followed by one describe node that cites the connector rule SUM-COUNT-01 with groupColumns = [gene]; the number of groups each branch counts is the answer. Do not chain the two filters.' },
  { id: 'Q17', dataset: 'PAIRED', text: 'In responders only, what is the mean log2 CPM of each panel gene before and on treatment? Plan exactly two nodes: one filter node with the single condition response = R, then one describe node depending on it that cites the connector rule SUM-CROSS-01 with groupColumns = [gene, timepoint], valueColumn = log2_cpm and aggregation = mean.' },
  { id: 'Q18', dataset: 'PAIRED', text: 'What is the mean CXCL9 expression in responders and non-responders, before and on treatment? Plan exactly two nodes: one filter node with the single condition gene = CXCL9, then one describe node depending on it that cites the connector rule SUM-CROSS-01 with groupColumns = [response, timepoint], valueColumn = log2_cpm and aggregation = mean.' },
  { id: 'Q19', dataset: 'PAIRED', text: 'At the on-treatment biopsy, how does the mean expression of each panel gene compare between responders and non-responders? Plan exactly two nodes: one filter node with the single condition timepoint = On, then one describe node depending on it that cites the connector rule SUM-CROSS-01 with groupColumns = [gene, response], valueColumn = log2_cpm and aggregation = mean.' },
  { id: 'Q20', dataset: 'PAIRED', text: 'At the pre-treatment biopsy, which panel genes vary most between patients? Plan exactly two nodes: one filter node with the single condition timepoint = Pre, then one describe node depending on it that cites the connector rule SUM-RANK-01 with groupColumns = [gene], valueColumn = log2_cpm, aggregation = std and direction = desc.' },
  { id: 'Q21', dataset: 'DE', text: `For the 24 immune panel genes, what is the pre-treatment responder-vs-non-responder log2 fold change? Plan exactly two nodes: one filter node with the single condition gene in [${PANEL}], then one describe node depending on it that cites the connector rule SUM-RANK-01 with groupColumns = [gene], valueColumn = log2FoldChange, aggregation = mean and direction = desc.` },

  // ── AXI-1587: ten more DESCRIPTIVE questions (Q22–Q31, Chart-Enrichment-Brief §5) ──
  { id: 'Q22', dataset: 'PAIRED', text: `For each patient, what is the mean log2 CPM of the cytotoxic panel (${CYTO}) at the pre-treatment and the on-treatment biopsy, grouped by patient and timepoint? Plan exactly two nodes: one filter node with the single condition gene in [CD8A, PRF1, GZMB, IFNG, PDCD1, LAG3], then one describe node depending on it that cites the connector rule SUM-CROSS-01 with groupColumns = [patient_id, timepoint], valueColumn = log2_cpm and aggregation = mean.` },
  { id: 'Q23', dataset: 'WIDE_V2', text: 'Rank the patients by the change in CD8A expression between the pre-treatment and on-treatment biopsy, from the largest increase to the largest decrease. Plan exactly two nodes: one filter node with the single condition gene = CD8A, then one describe node depending on it that cites the connector rule SUM-TOPN-01 with sortColumn = delta, direction = desc and n = 27.' },
  { id: 'Q24', dataset: 'PAIRED', text: 'At the on-treatment biopsy, what is the mean log2 CPM of each panel gene in ipilimumab-naive and ipilimumab-progressed patients, grouped by gene and prior ipilimumab exposure? Plan exactly two nodes: one filter node with the single condition timepoint = On, then one describe node depending on it that cites the connector rule SUM-CROSS-01 with groupColumns = [gene, prior_ipi], valueColumn = log2_cpm and aggregation = mean.' },
  { id: 'Q25', dataset: 'DE', text: 'How many genes in the pre-treatment differential-expression table have an adjusted p-value below 0.01, between 0.01 and 0.05, and between 0.05 and 0.10? Build three independent branches, each depending directly on the dataset (not chained to one another): one filter node with the single condition padj < 0.01; one filter node carrying both conditions padj >= 0.01 and padj < 0.05 in a single conditions array; one filter node carrying both conditions padj >= 0.05 and padj < 0.10 in a single conditions array. Each filter node is followed by one describe node that cites the connector rule SUM-COUNT-01 with groupColumns = [gene]; the number of groups each branch counts is the answer.' },
  { id: 'Q26', dataset: 'PAIRED', text: 'At the pre-treatment biopsy, what is the median log2 CPM of each panel gene in responders and non-responders, grouped by gene and response? Plan exactly two nodes: one filter node with the single condition timepoint = Pre, then one describe node depending on it that cites the connector rule SUM-CROSS-01 with groupColumns = [gene, response], valueColumn = log2_cpm and aggregation = median.' },
  { id: 'Q27', dataset: 'DE', text: 'In this pre-treatment responder-vs-non-responder differential-expression table, which ten genes with padj < 0.05 have the largest negative log2 fold change? Plan exactly two nodes: one filter node with the single condition padj < 0.05, then one describe node depending on it that cites the connector rule SUM-TOPN-01 with sortColumn = log2FoldChange, direction = asc and n = 10.' },
  { id: 'Q28', dataset: 'PAIRED', text: 'For the chemokines CXCL9, CXCL10 and CXCL11, what is the mean log2 CPM at the pre-treatment and on-treatment biopsy in responders, grouped by gene and timepoint? Plan exactly two nodes: ONE filter node carrying both conditions in a single conditions array (gene in [CXCL9, CXCL10, CXCL11] and response = R) that depends directly on the dataset, then one describe node depending on it that cites the connector rule SUM-CROSS-01 with groupColumns = [gene, timepoint], valueColumn = log2_cpm and aggregation = mean.' },
  { id: 'Q29', dataset: 'PAIRED', text: 'At the pre-treatment biopsy, which patients have the highest HLA-DRA expression? Plan exactly two nodes: ONE filter node carrying both conditions in a single conditions array (gene = HLA-DRA and timepoint = Pre) that depends directly on the dataset, then one describe node depending on it that cites the connector rule SUM-TOPN-01 with sortColumn = log2_cpm, direction = desc and n = 10.' },
  { id: 'Q30', dataset: 'DE_STRATA', text: 'Among the genes with padj < 0.05 in each prior-ipilimumab stratum, what is the mean log2 fold change, grouped by stratum? Plan exactly two nodes: one filter node with the single condition padj < 0.05, then one describe node depending on it that cites the connector rule SUM-RANK-01 with groupColumns = [stratum], valueColumn = log2FoldChange, aggregation = mean and direction = desc.', profileSlices: [[{ column: 'stratum', operator: 'eq', value: 'ipi_naive' }], [{ column: 'stratum', operator: 'eq', value: 'ipi_progressed' }]] },
  { id: 'Q31', dataset: 'PAIRED', text: `At the on-treatment biopsy, what is the mean log2 CPM of the cytotoxic panel per patient, ranked from the hottest to the coldest tumour? Plan exactly two nodes: ONE filter node carrying both conditions in a single conditions array (timepoint = On and gene in [CD8A, PRF1, GZMB, IFNG, PDCD1, LAG3]) that depends directly on the dataset, then one describe node depending on it that cites the connector rule SUM-RANK-01 with groupColumns = [patient_id], valueColumn = log2_cpm, aggregation = mean and direction = desc.` },
  // ── AXI-1582: the filtered top-N and the first domain connector (epic AXI-1575) ──
  { id: 'Q36', dataset: 'PAIRED', text: 'At the pre-treatment biopsy, which five responders have the highest HLA-DRA expression? Plan exactly two nodes: ONE filter node carrying both conditions in a single conditions array (gene = HLA-DRA and timepoint = Pre) that depends directly on the dataset, then one describe node depending on it that cites the connector rule SUM-TOPN-FILTERED-01 with sortColumn = log2_cpm, direction = desc, n = 5 and filter = {column: response, op: eq, value: R}.' },
  { id: 'Q37', dataset: 'PAIRED', text: 'At the pre-treatment biopsy, what is the mean expression (log2 CPM) of each of the 24 immune panel genes, ranked from highest to lowest? Plan exactly two nodes: one filter node with the single condition timepoint = Pre, then one describe node depending on it that cites the connector rule SUM-EXPR-RANK-01 with groupColumns = [gene], valueColumn = log2_cpm, aggregation = mean and direction = desc.' },
];

export interface QuestionTrace {
  id: string;
  question: string;
  at: string;
  datasetId: string;
  datasetName: string;
  versionHash: string;
  rulesCited: string[];
  sessionId: string | null;
  planId: string | null;
  planner: string | null;
  plannerFallback: boolean | null;
  planStatus: string | null;
  plan: Record<string, unknown> | null;
  planNodes: Array<{ id: string; nodeType: string; params: unknown; operation: unknown; stepLabel: string }>;
  runId: string | null;
  viewAnalysisId: string | null;
  runStatus: string | null;
  nodes: Array<{ nodeId: string; status: string; error: string | null }>;
  ruleRuns: Array<{ id: string; kind: string; operationId: string | null; status: string; planNode: string | null; referentSnapshotId: string | null; producedSnapshotId: string; snapshotName: string | null; summary: unknown; columns: string[]; rows: Array<Record<string, unknown>> }>;
  snapshots: Array<{ id: string; name: string | null; version: number; origin: string | null; parentSnapshotId: string | null; rowCount: number | null }>;
  error: string | null;
  deepLinks: Record<string, string>;
  /** AXI-1565 — the describe results a descriptive question produced, as observed over REST. */
  describe?: { derivation: string; results: ObservedDescribeResult[] };
  /** AXI-1565 (FR35) — every expected-vs-actual check; one failure fails the question. */
  assertions?: Assertion[];
}

function log(msg: string): void {
  console.log(`[stage:riaz-questions] ${msg}`);
}

// ── envelope (what GuidedAnalysisPanel.send() assembles) ────────────────────

interface DatasetRow { id: string; displayName?: string; originalFilename?: string; fileHash?: string }
interface QueryResult { columns: Array<{ name: string; type?: string }>; rows: Array<Record<string, unknown>> }
interface DataState { datasetVersion?: string; variables?: Array<{ name: string; type: string; categories?: unknown }> }
interface RuleApi { id: string; code: string; title: string; protocolType: string; category: string; scope: string; status: string; tags?: string[]; question?: string; logicSummary?: string; signals?: string[]; attributeEvaluations?: Array<Record<string, unknown>>; outputFields?: Array<Record<string, unknown>>; guardOutput?: { blockDecision?: boolean } | null; isMandatory?: boolean }

function coerce(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return String(v);
}

async function buildEnvelope(client: RestClient, t: { workspaceId: string; projectId: string }, ds: DatasetRow, question: string, profileSlices?: ProfileFilter[][]) {
  const H = projectHeaders(t.workspaceId);
  const as = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => client.as<T>(PRESENTER, method, path, body, H);
  const project = must(await as<{ id: string; name: string; description?: string | null }>('GET', `/api/v1/projects/${t.projectId}`), 'reading project');
  const contract = (await as<Record<string, unknown>>('GET', `/api/v1/projects/${t.projectId}/semantic-contract`)).body ?? null;
  const operations = asList<Record<string, unknown>>((must(await as<unknown>('GET', '/api/v1/rule-runs/operations'), 'operations') as { operations?: unknown[] }).operations ?? []);
  const rules = asList<RuleApi>(must(await as<unknown>('GET', `/api/v1/rules?workspaceId=${t.workspaceId}&status=published&limit=500`), 'rules'));
  const slices = profileSlices?.length ? profileSlices : [undefined];
  const perSlice = Math.floor(PROTO_ROW_LIMIT / slices.length);
  const parts: QueryResult[] = [];
  for (const filters of slices) parts.push(must(await as<QueryResult>('POST', `/api/v1/workspaces/${t.workspaceId}/datasets/${ds.id}/query`, filters ? { limit: perSlice, filters } : { limit: PROTO_ROW_LIMIT }), 'querying dataset'));
  const slice: QueryResult = { columns: parts[0].columns, rows: parts.flatMap((p) => p.rows) };
  const columnNames = slice.columns.map((c) => c.name);
  const dataset = { datasetVersion: ds.fileHash ?? '', columns: columnNames, rows: slice.rows.map((r) => Object.fromEntries(columnNames.map((c) => [c, coerce(r[c])]))) };
  const dataState = must(await as<DataState>('POST', '/api/v1/guided-analysis/profile', { projectId: t.projectId, dataset }), 'profiling dataset');
  const c = (contract ?? {}) as { profile?: { id?: string; version?: string; displayName?: string }; fallbackMode?: boolean; vocabulary?: unknown; filters?: unknown; chartPresets?: unknown; fieldMappings?: Array<{ sourceField: string; canonicalField: string | null; status: string }> };
  const name = ds.displayName || ds.originalFilename || ds.id;
  return {
    projectId: t.projectId,
    question,
    sendData: false,
    context: {
      project: { id: project.id, name: project.name, description: project.description ?? null },
      scientificContext: contract
        ? { profileId: c.profile?.id ?? null, profileVersion: c.profile?.version ?? null, displayName: c.profile?.displayName ?? null, fallbackMode: c.fallbackMode ?? false, vocabulary: c.vocabulary ?? {}, filters: c.filters ?? [], preferredVisualizations: c.chartPresets ?? [], fieldMappings: (c.fieldMappings ?? []).map((m) => ({ sourceField: m.sourceField, canonicalField: m.canonicalField, status: m.status })) }
        : null,
      dataStructure: dataState,
      datasets: null,
      availableRules: {
        ruleCount: rules.length,
        operationCount: operations.length,
        rules: rules.map((r) => ({
          id: r.id, code: r.code, title: r.title, protocolType: r.protocolType, category: r.category, scope: r.scope, status: r.status, tags: r.tags ?? [],
          question: r.question ?? '', logicSummary: r.logicSummary ?? '', signals: r.signals ?? [],
          inputs: (r.attributeEvaluations ?? []).map((a) => ({ attributeKey: a.attributeKey, valueType: a.valueType, operator: a.operator, value: a.value, ...(a.context ? { context: a.context } : {}), ...(a.label ? { label: a.label } : {}) })),
          outputFields: (r.outputFields ?? []).map((f) => ({ key: f.key, type: f.type, ...(f.description ? { description: f.description } : {}) })),
          blocksDecision: r.guardOutput?.blockDecision === true, isMandatory: r.isMandatory === true,
        })),
        operations: operations.map((o) => ({ operationId: o.operationId, label: o.label, runKind: o.runKind, submitToken: o.submitToken ?? null })),
      },
    },
    datasets: [{ datasetId: ds.id, name, versionHash: dataState.datasetVersion ?? ds.fileHash ?? '', columns: (dataState.variables ?? []).map((v) => ({ name: v.name, type: v.type, ...(v.categories ? { categories: v.categories } : {}) })) }],
  };
}

// ── plan → run → results ────────────────────────────────────────────────────

interface PlanResponse { plan: Record<string, unknown> & { planId: string; nodes: Array<Record<string, unknown>> }; status: string; planner: string; plannerFallback: boolean; sessionId: string }
interface RunStatus { runId: string; status: string; runStatus?: string; nodes: Array<{ nodeId: string; status: string; error?: string | null }> }
interface SnapshotRow { id: string; version: number; name: string | null; origin?: string; ruleRunId?: string | null; parentSnapshotId?: string | null; rowCount?: number | null }

async function drain(client: RestClient, H: Record<string, string>, projectId: string, runId: string): Promise<RunStatus> {
  let status: RunStatus | undefined;
  for (let i = 0; i < 150; i++) {
    status = must(await client.as<RunStatus>(ADMIN_HANDLE, 'GET', `/api/v1/governed-execution/status?projectId=${projectId}&runId=${runId}`, undefined, H), 'run status');
    const nodes = status.nodes ?? [];
    if (nodes.length > 0 && nodes.every((n) => SETTLED.has(n.status))) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!status) throw new Error('no run status');
  return status;
}

async function collect(client: RestClient, workspaceId: string, viewAnalysisId: string, plan: PlanResponse['plan'], runId: string): Promise<Pick<QuestionTrace, 'ruleRuns' | 'snapshots'>> {
  const H = projectHeaders(workspaceId);
  const snapshots = asList<SnapshotRow>(must(await client.as<unknown>(SERVICE_HANDLE, 'GET', `/api/v1/view-analyses/${viewAnalysisId}/snapshots?page=1&limit=100`, undefined, H), 'snapshots'));
  const ruleRuns: QuestionTrace['ruleRuns'] = [];
  for (const s of snapshots.filter((s) => s.origin === 'rule_derived' && s.ruleRunId)) {
    const run = must(await client.as<{ id: string; runKind?: string; operationId?: string | null; status: string; summaryJson?: unknown; materializedNodeId?: string | null }>(ADMIN_HANDLE, 'GET', `/api/v1/rule-runs/${s.ruleRunId}`, undefined, H), `rule run ${s.ruleRunId}`);
    let columns: string[] = [];
    let rows: Array<Record<string, unknown>> = [];
    const table = await client.as<{ columns?: Array<string | { name: string }>; rows?: Array<Record<string, unknown>> }>(ADMIN_HANDLE, 'GET', `/api/v1/rule-runs/${run.id}/table?page=1&limit=200`, undefined, H);
    if (table.ok && table.body) {
      rows = table.body.rows ?? [];
      columns = (table.body.columns ?? Object.keys(rows[0] ?? {})).map((c) => (typeof c === 'string' ? c : c.name));
    }
    const nodeId = run.materializedNodeId ? run.materializedNodeId.replace(`${runId}__`, '') : null;
    ruleRuns.push({ id: run.id, kind: run.runKind ?? '', operationId: run.operationId ?? null, status: run.status, planNode: nodeId, referentSnapshotId: s.parentSnapshotId ?? null, producedSnapshotId: s.id, snapshotName: s.name, summary: run.summaryJson ?? null, columns, rows });
  }
  void plan;
  return { ruleRuns, snapshots: snapshots.map((s) => ({ id: s.id, name: s.name, version: s.version, origin: s.origin ?? null, parentSnapshotId: s.parentSnapshotId ?? null, rowCount: s.rowCount ?? null })) };
}

async function askOne(client: RestClient, t: { workspaceId: string; projectId: string; organizationId: string | null }, datasets: DatasetRow[], q: Question, planOnly: boolean): Promise<QuestionTrace> {
  const H = projectHeaders(t.workspaceId);
  const ds = datasets.find((d) => (d.originalFilename ?? d.displayName) === DATASET_FILES[q.dataset] || d.displayName === DATASET_FILES[q.dataset]);
  if (!ds) throw new Error(`dataset ${DATASET_FILES[q.dataset]} not found in workspace ${t.workspaceId}`);
  const base = `${FRONT_URL}/projects/${t.projectId}`;
  const trace: QuestionTrace = {
    id: q.id, question: q.text, at: new Date().toISOString(), datasetId: ds.id, datasetName: ds.originalFilename ?? ds.displayName ?? ds.id, versionHash: ds.fileHash ?? '',
    rulesCited: rulesForQuestion(q.id).map((e) => e.code),
    sessionId: null, planId: null, planner: null, plannerFallback: null, planStatus: null, plan: null, planNodes: [],
    runId: null, viewAnalysisId: null, runStatus: null, nodes: [], ruleRuns: [], snapshots: [], error: null,
    deepLinks: {
      guidedPage: `${FRONT_URL}/guided-analysis?projectId=${t.projectId}&workspaceId=${t.workspaceId}&datasetId=${ds.id}&name=${encodeURIComponent(ds.originalFilename ?? '')}`,
      guidedHistory: `${base}/guided-analyses`,
    },
  };
  try {
    log(`${q.id}: building envelope on ${trace.datasetName}`);
    const envelope = await buildEnvelope(client, t, ds, q.text, q.profileSlices);
    log(`${q.id}: planning (${(envelope.context.availableRules.rules as unknown[]).length} rules offered)`);
    const planRes = must(await client.as<PlanResponse>(PRESENTER, 'POST', '/api/v1/guided-analysis/plan', { projectId: t.projectId, envelope, sessionId: null }, H), 'planning');
    trace.sessionId = planRes.sessionId ?? null;
    trace.planId = planRes.plan.planId;
    trace.planner = planRes.planner;
    trace.plannerFallback = planRes.plannerFallback;
    trace.planStatus = planRes.status;
    trace.plan = planRes.plan;
    trace.planNodes = planRes.plan.nodes.map((n) => ({ id: String(n.id), nodeType: String(n.nodeType), params: n.params, operation: n.operation ?? null, stepLabel: String(n.stepLabel ?? '') }));
    log(`${q.id}: plan ${trace.planId} (${trace.planner}${trace.plannerFallback ? ', FALLBACK' : ''}) — ${trace.planNodes.map((n) => `${n.id}:${n.nodeType}`).join(' ')}`);
    if (planOnly) return trace;

    const body = { projectId: t.projectId, planId: trace.planId, plan: planRes.plan, datasetId: ds.id, workspaceId: t.workspaceId, ...(t.organizationId ? { organizationId: t.organizationId } : {}) };
    const sub = must(await client.as<{ runId: string; viewAnalysisId: string }>(PRESENTER, 'POST', '/api/v1/governed-execution/submit', body, H), 'submitting');
    trace.runId = sub.runId;
    trace.viewAnalysisId = sub.viewAnalysisId;
    log(`${q.id}: run ${sub.runId} → analysis ${sub.viewAnalysisId}`);
    let status = await drain(client, H, t.projectId, sub.runId);
    const awaiting = status.nodes.filter((n) => n.status === 'AWAITING_APPROVAL');
    for (const n of awaiting) {
      const res = await client.as(SERVICE_HANDLE, 'POST', '/api/v1/governed-execution/resolve', { projectId: t.projectId, runId: sub.runId, nodeId: n.nodeId, approved: true }, H);
      log(`${q.id}: approved ${n.nodeId} (${res.status})`);
    }
    if (awaiting.length) status = await drain(client, H, t.projectId, sub.runId);
    trace.runStatus = status.runStatus ?? status.status;
    trace.nodes = status.nodes.map((n) => ({ nodeId: n.nodeId.replace(`${sub.runId}__`, ''), status: n.status, error: n.error ?? null }));
    trace.nodes.forEach((n) => log(`${q.id}: node ${n.nodeId}: ${n.status}${n.error ? ` — ${n.error}` : ''}`));
    Object.assign(trace, await collect(client, t.workspaceId, sub.viewAnalysisId, planRes.plan, sub.runId));
    trace.ruleRuns.forEach((r) => log(`${q.id}: rule run ${r.id} ${r.kind} ${r.operationId ?? ''} ${r.status} node=${r.planNode} rows=${r.rows.length} cols=${r.columns.join(',')}`));
    trace.deepLinks.analysis = `${base}/view-analyses/${sub.viewAnalysisId}`;
    trace.deepLinks.provenance = `${base}/view-analyses/${sub.viewAnalysisId}/provenance`;
    await assertDescribe(client, t, base, trace);
  } catch (err) {
    trace.error = err instanceof Error ? err.message : String(err);
    log(`${q.id}: ERROR ${trace.error}`);
  }
  return trace;
}

/**
 * AXI-1565 (FR35) — for a descriptive question, read what the platform produced
 * and decide every assertion. Nothing is recomputed from the run's own output:
 * the expectations come from the source CSVs (`riazDescribeExpectations.ts`).
 */
async function assertDescribe(client: RestClient, t: { workspaceId: string }, base: string, trace: QuestionTrace): Promise<void> {
  const expectation = DESCRIBE_EXPECTED[trace.id];
  if (!expectation) return;
  const results = await observeDescribeResults(client, t.workspaceId, trace);
  // The two surfaces the epic's objective is judged on — the result view with
  // its sentence/chip/chart, and the Decision the sentence was minted onto.
  if (results[0]) trace.deepLinks.describeResult = `${base}/view-analyses/${trace.viewAnalysisId}?snapshotId=${results[0].snapshotId}`;
  if (results[0]?.decision) trace.deepLinks.describeDecision = `${base}/view-analyses/${trace.viewAnalysisId}/decisions/${results[0].decision.id}`;
  trace.describe = { derivation: expectation.derivation, results };
  trace.assertions = evaluateDescribeQuestion(expectation, results);
  trace.assertions.forEach((a) => log(`${trace.id}: ${a.ok ? 'ok  ' : 'FAIL'} ${a.name}: expected ${a.expected}, got ${a.actual}`));
  const failed = trace.assertions.filter((a) => !a.ok).length;
  log(`${trace.id}: ${trace.assertions.length - failed}/${trace.assertions.length} assertions green`);
}

function parseArgs(argv: string[]): { only: string[] | null; planOnly: boolean } {
  let only: string[] | null = null;
  let planOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') only = argv[++i].split(',').map((s) => s.trim().toUpperCase());
    else if (argv[i].startsWith('--only=')) only = argv[i].slice(7).split(',').map((s) => s.trim().toUpperCase());
    else if (argv[i] === '--plan-only') planOnly = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { only, planOnly };
}

async function main(): Promise<void> {
  const { only, planOnly } = parseArgs(process.argv.slice(2));
  const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const client = new RestClient({ baseUrl });
  await ensureIdentities(client, process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local', process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin');
  const tenant = await resolveTenant(client);
  log(`workspace ${tenant.workspaceId} / project ${tenant.projectId} / org ${tenant.organizationId ?? '(none)'}`);
  const datasets = asList<DatasetRow>(must(await client.as<unknown>(ADMIN_HANDLE, 'GET', `/api/v1/workspaces/${tenant.workspaceId}/datasets?limit=10000`, undefined, projectHeaders(tenant.workspaceId)), 'datasets'));
  const existing: QuestionTrace[] = existsSync(TRACE_PATH) ? (JSON.parse(readFileSync(TRACE_PATH, 'utf8')) as { questions: QuestionTrace[] }).questions : [];
  const traces = new Map(existing.map((t) => [t.id, t]));
  const todo = QUESTIONS.filter((q) => (only ? only.includes(q.id) : !traces.has(q.id)));
  log(`asking ${todo.map((q) => q.id).join(', ') || 'nothing (all in trace; use --only)'}`);
  for (const q of todo) {
    // JWTs outlive neither a long batch nor a slow planner: re-login before
    // every question (idempotent; Q10/Q11 once 401'd after ~15 min).
    await ensureIdentities(client, process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local', process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin');
    const trace = await askOne(client, tenant, datasets, q, planOnly);
    traces.set(q.id, trace);
    writeFileSync(TRACE_PATH, JSON.stringify({ projectId: tenant.projectId, workspaceId: tenant.workspaceId, organizationId: tenant.organizationId, questions: [...traces.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))) }, null, 2));
    log(`${q.id}: trace written (${trace.error ? 'ERROR' : trace.runStatus ?? 'planned'})`);
  }
  const all = [...traces.values()];
  report(only ? all.filter((t) => only.includes(t.id)) : all);
}

/**
 * AXI-1565 (AC4) — the batch PASSES only when no question errored AND every
 * assertion of every asserted question is green. A run row alone is not a pass.
 */
function report(traces: QuestionTrace[]): void {
  const errored = traces.filter((t) => t.error);
  const asserted = traces.filter((t) => t.assertions?.length);
  // A descriptive question that produced no assertions at all (it errored, or no
  // describe run was ever created) is a FAILURE, never a silent pass.
  const unasserted = traces.filter((t) => isDescribeQuestion(t.id) && !t.assertions?.length);
  unasserted.forEach((t) => console.log(`  ${t.id.padEnd(4)} FAIL  no describe assertions were evaluated${t.error ? ` — ${t.error}` : ''}`));
  const red = [...asserted.filter((t) => !allPassed(t.assertions ?? [])), ...unasserted];
  for (const t of asserted) {
    const a = t.assertions ?? [];
    console.log(`  ${t.id.padEnd(4)} ${allPassed(a) ? 'PASS' : 'FAIL'}  ${a.filter((x) => x.ok).length}/${a.length} assertions${isDescribeQuestion(t.id) ? ` · ${t.describe?.results.length ?? 0} describe result(s)` : ''}`);
  }
  for (const t of red) (t.assertions ?? []).filter((a) => !a.ok).forEach((a) => console.log(`  ${t.id}: FAIL ${a.name} — expected ${a.expected}, got ${a.actual}`));
  const verdict = red.length ? 'FAILED' : errored.length ? 'PARTIAL' : 'PASSED';
  console.log(`\n${verdict} — stage:riaz-questions: ${traces.length} question(s); ${errored.length} error(s); ${red.length} question(s) with a failed assertion.`);
  if (verdict === 'FAILED') process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith('runRiazQuestions.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
