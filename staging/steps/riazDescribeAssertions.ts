/**
 * AXI-1565 (epic AXI-1555 — FR35) — the pure assertion engine for the ten
 * descriptive Riaz questions: given what `Riaz-Guided-Questions.md` says a
 * question must produce (`riazDescribeExpectations.ts`) and what the platform
 * actually produced (`riazDescribeObserve.ts` reads it over REST), decide each
 * assertion. No network, no I/O — every function here is a pure comparison, so
 * the unit tests (`riazDescribeAssertions.spec.ts`, UT-E2E-DESC-001..) exercise
 * exactly the code the live runner uses.
 *
 * A question FAILS when any of its assertions fails; there is no partial credit
 * and no "warning" severity — the epic's objective is "a question ends with a
 * chart and an answer", and half of that is not an answer.
 */
import {
  VALUE_TOLERANCE,
  type DescribeExpectation,
  type ExpectedCell,
  type ExpectedDescribeResult,
  type ExpectedParameters,
} from './riazDescribeExpectations';

export interface ObservedBinding {
  state: string | null;
  ambiguous: boolean | null;
  matchedConnectors: string[];
  unmappedColumns: string[];
  citationStatus: string | null;
}

/** The registry-declared chart of the run's operation, resolved against its result columns. */
export interface ObservedRecommendedChart {
  chartType: string | null;
  roles: Record<string, string>;
  missingColumns: string[];
  surfaces: string[];
}

export interface ObservedDecision {
  id: string;
  type: string | null;
  ruleRunId: string | null;
  sentenceText: string | null;
  status: string | null;
}

/**
 * One column bound to a connector parameter, as the binding report carries it
 * (`operationBinding.canonicalFields`). A COLUMN-ROLE parameter never appears in
 * `boundParameters` — see `COLUMN_ROLE_PARAMETERS`.
 */
export interface ObservedColumnBinding {
  parameter: string;
  column: string;
  canonicalField: string | null;
}

export interface ObservedDescribeResult {
  ruleRunId: string;
  /** the snapshot the run produced — what `?snapshotId=` opens in the UI */
  snapshotId: string;
  /** the referent snapshot's effective filters, rendered `col op value & …` */
  cohort: string;
  operationId: string | null;
  /** the connector code cited on the plan node that produced this run */
  citedConnector: string | null;
  /** SCALAR parameters only (`aggregation`, `direction`, `n`) — review-gate blocker 1 */
  boundParameters: Record<string, unknown>;
  /** the column roles (`groupColumns`, `valueColumn`, `sortColumn`, `distinctKey`), in bound order */
  canonicalFields: ObservedColumnBinding[];
  columns: string[];
  rows: Array<Record<string, unknown>>;
  nGroups: number | null;
  binding: ObservedBinding | null;
  /** any `origin: 'recommended'` DataviewSpec on the result dataset (context only — see `recommendedChart`) */
  recommendedChartSpecId: string | null;
  /** the operation's DECLARED chart, resolved against this run's result columns — what the UI renders */
  recommendedChart: ObservedRecommendedChart | null;
  /** the sentence as the RESULT surface carries it (the run's Evidence text) */
  sentence: string | null;
  decision: ObservedDecision | null;
}

export interface Assertion {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}

const assertion = (name: string, expected: unknown, actual: unknown, ok: boolean): Assertion => ({
  name,
  expected: String(expected),
  actual: String(actual),
  ok,
});

const eq = (name: string, expected: unknown, actual: unknown): Assertion =>
  assertion(name, expected, actual, String(expected) === String(actual));

/** ±0.01 (FR35). A missing actual value never passes. */
export function nearly(expected: number, actual: unknown, tolerance = VALUE_TOLERANCE): boolean {
  const n = typeof actual === 'number' ? actual : typeof actual === 'string' ? Number(actual) : NaN;
  return Number.isFinite(n) && Math.abs(n - expected) <= tolerance;
}

/** The result table's aggregate column: `<aggregation>_<valueColumn>`, or `n` for a count. */
export function aggregateColumnName(params: ExpectedParameters): string {
  if (!params.valueColumn) return 'n';
  return `${params.aggregation ?? 'mean'}_${params.valueColumn}`;
}

/** Case-insensitive column read — the kernel echoes the source column's case, the expectation need not. */
export function readColumn(row: Record<string, unknown>, column: string): unknown {
  if (column in row) return row[column];
  const key = Object.keys(row).find((k) => k.toLowerCase() === column.toLowerCase());
  return key === undefined ? undefined : row[key];
}

/** A row's group label: its `groupColumns` values in bound order, joined by `|`. */
export function rowLabel(row: Record<string, unknown>, groupColumns: readonly string[]): string {
  return groupColumns.map((c) => String(readColumn(row, c) ?? '')).join('|');
}

const groupColumnsOf = (params: ExpectedParameters): string[] => params.groupColumns ?? [];

/** For `describe.top_n` the label lives in the first non-`rank`, non-sort column of the row. */
export function topNLabel(row: Record<string, unknown>, sortColumn: string | undefined): string {
  const key = Object.keys(row).find((k) => k !== 'rank' && k !== sortColumn);
  return key === undefined ? '' : String(row[key] ?? '');
}

const labelOf = (row: Record<string, unknown>, exp: ExpectedDescribeResult): string => {
  if (exp.operationId !== 'describe.top_n') return rowLabel(row, groupColumnsOf(exp.parameters));
  // A NAMED label column is preferred; the positional fallback stays for a
  // top_n expectation that does not declare one (review-gate advisory A4).
  return exp.labelColumn ? String(readColumn(row, exp.labelColumn) ?? '') : topNLabel(row, exp.parameters.sortColumn);
};

const valueColumnOf = (exp: ExpectedDescribeResult): string =>
  exp.operationId === 'describe.top_n' ? exp.parameters.sortColumn ?? '' : aggregateColumnName(exp.parameters);

// ── individual assertion groups ─────────────────────────────────────────────

function cellAssertions(prefix: string, exp: ExpectedDescribeResult, cell: ExpectedCell, row: Record<string, unknown> | undefined): Assertion[] {
  if (!row) return [assertion(`${prefix} row "${cell.label}"`, 'present', 'missing', false)];
  const out: Assertion[] = [];
  if (cell.value !== undefined) {
    const actual = readColumn(row, valueColumnOf(exp));
    out.push(assertion(`${prefix} "${cell.label}" ${valueColumnOf(exp)}`, `${cell.value} ±${VALUE_TOLERANCE}`, actual, nearly(cell.value, actual)));
  }
  if (cell.n !== undefined) out.push(eq(`${prefix} "${cell.label}" n`, cell.n, readColumn(row, 'n')));
  return out;
}

function positionAssertions(exp: ExpectedDescribeResult, obs: ObservedDescribeResult): Assertion[] {
  const out: Assertion[] = [];
  if (exp.top) out.push(...boundaryAssertions('top', exp, exp.top, obs.rows[0]));
  if (exp.bottom) out.push(...boundaryAssertions('bottom', exp, exp.bottom, obs.rows[obs.rows.length - 1]));
  return out;
}

function boundaryAssertions(which: string, exp: ExpectedDescribeResult, cell: ExpectedCell, row: Record<string, unknown> | undefined): Assertion[] {
  if (!row) return [assertion(`${which} row`, cell.label, 'no rows', false)];
  return [eq(`${which} row label`, cell.label, labelOf(row, exp)), ...cellAssertions(which, exp, cell, row)];
}

function rankAssertions(exp: ExpectedDescribeResult, obs: ObservedDescribeResult): Assertion[] {
  return (exp.ranks ?? []).flatMap((r) => {
    const row = obs.rows[r.rank - 1];
    if (!row) return [assertion(`rank ${r.rank}`, r.label, 'no such row', false)];
    const label = eq(`rank ${r.rank} label`, r.label, labelOf(row, exp));
    if (r.value === undefined) return [label];
    const actual = readColumn(row, valueColumnOf(exp));
    return [label, assertion(`rank ${r.rank} value`, `${r.value} ±${VALUE_TOLERANCE}`, actual, nearly(r.value, actual))];
  });
}

function labelledCellAssertions(exp: ExpectedDescribeResult, obs: ObservedDescribeResult): Assertion[] {
  return (exp.cells ?? []).flatMap((cell) => {
    const row = obs.rows.find((r) => labelOf(r, exp) === cell.label);
    return cellAssertions('cell', exp, cell, row);
  });
}

/**
 * A connector parameter whose value is a COLUMN (kind `column`) or an ordered
 * list of columns (kind `columns`).
 *
 * These are NOT in `boundParameters`. The backend builds that bag from
 * `effectiveParameters(operationId, run.operationParams)`, and `operationParams`
 * is assembled by `copyConnectorScalars`, which keeps only the `enum`/`number`
 * kinds (axiome-back `guided-analysis/plan/operation-binding.ts`). The column
 * roles travel separately, as `operationBinding.canonicalFields`
 * (`rule-binding/signature/describe-facts.ts#bindingsOf`: one entry per bound
 * column, in `operandRoles` insertion order, so `groupColumns` order is
 * preserved). Reading a column role off `boundParameters` therefore reports
 * `unbound` on a run that bound it perfectly — the review-gate blocker this set
 * exists to prevent.
 */
export const COLUMN_ROLE_PARAMETERS: ReadonlySet<string> = new Set(['groupColumns', 'valueColumn', 'sortColumn', 'distinctKey']);

/** The columns bound to one parameter, in bound order. */
export function boundColumns(canonicalFields: readonly ObservedColumnBinding[], parameter: string): string[] {
  return canonicalFields.filter((f) => f.parameter === parameter).map((f) => f.column);
}

function parameterAssertions(exp: ExpectedDescribeResult, obs: ObservedDescribeResult): Assertion[] {
  return Object.entries(exp.parameters).map(([key, want]) =>
    COLUMN_ROLE_PARAMETERS.has(key) ? columnRoleAssertion(key, want, obs) : scalarAssertion(key, want, obs),
  );
}

function columnRoleAssertion(key: string, want: unknown, obs: ObservedDescribeResult): Assertion {
  const expected = (Array.isArray(want) ? want : [want]).map(String).join(',');
  const got = boundColumns(obs.canonicalFields, key);
  return assertion(`bound ${key}`, expected, got.join(',') || 'unbound', got.join(',') === expected);
}

function scalarAssertion(key: string, want: unknown, obs: ObservedDescribeResult): Assertion {
  const got = obs.boundParameters[key];
  const expected = String(want);
  const actual = got === undefined ? 'unbound' : String(got);
  return assertion(`bound ${key}`, expected, actual, expected === actual);
}

function bindingAssertions(exp: ExpectedDescribeResult, obs: ObservedDescribeResult): Assertion[] {
  const b = obs.binding;
  if (!b) return [assertion('binding report', 'present', 'absent', false)];
  return [
    eq('binding state', 'covered', b.state),
    assertion('binding ambiguous', false, b.ambiguous, b.ambiguous === false),
    assertion('binding matched connector', exp.connector, b.matchedConnectors.join(',') || 'none', b.matchedConnectors.includes(exp.connector)),
    assertion('binding unmapped columns', 'none', b.unmappedColumns.join(',') || 'none', b.unmappedColumns.length === 0),
  ];
}

/**
 * The recommended chart the product actually renders: the OPERATION's declared
 * `defaultChart` (registry, AXI-1414), bound to this run's own result columns.
 * Not an `origin: 'recommended'` DataviewSpec — a describe result carries none,
 * and asserting on one reported "absent" against a product that renders the
 * chart. The user's rule still holds end-to-end: the chart is the platform's
 * own recommendation, selected, never hand-built.
 */
function recommendedChartAssertions(obs: ObservedDescribeResult): Assertion[] {
  const chart = obs.recommendedChart;
  if (!chart) return [assertion('recommended chart', 'declared by the operation', 'no defaultChart on the descriptor', false)];
  return [
    assertion('recommended chart', 'declared for the result surface', `${chart.chartType ?? 'none'} [${chart.surfaces.join(',') || 'no surface'}]`, Boolean(chart.chartType) && chart.surfaces.includes('result')),
    assertion('recommended chart columns', 'every role resolves to a result column', chart.missingColumns.length ? `missing ${chart.missingColumns.join(',')} (roles ${JSON.stringify(chart.roles)})` : JSON.stringify(chart.roles), chart.missingColumns.length === 0),
  ];
}

/** The sentence as the RESULT surface carries it — the run's Evidence text. */
function sentenceAssertions(exp: ExpectedDescribeResult, obs: ObservedDescribeResult): Assertion[] {
  const text = obs.sentence;
  if (exp.sentence !== undefined) return [assertion('evidence sentence (exact)', exp.sentence, text ?? 'absent', text === exp.sentence)];
  const out: Assertion[] = [assertion('evidence sentence', 'non-empty', text ?? 'absent', Boolean(text && text.trim()))];
  for (const s of exp.sentenceIncludes ?? []) out.push(assertion(`sentence contains "${s}"`, 'yes', text ?? 'absent', Boolean(text?.includes(s))));
  for (const s of exp.sentenceExcludes ?? []) out.push(assertion(`sentence omits "${s}"`, 'yes', text ?? 'absent', Boolean(text) && !text!.includes(s)));
  return out;
}

/**
 * The Decision surface. The draft is LOOKED UP by `context.ruleRunId`
 * (`decisionOf`), so its presence IS the "linked to this run" assertion — a
 * draft that names another run is simply absent here, and re-asserting the id
 * it was found by would assert nothing (review-gate advisory A1). What is
 * genuinely cross-surface is the sentence: the draft's text against the
 * EVIDENCE's text, two records the platform writes independently.
 */
function decisionAssertions(exp: ExpectedDescribeResult, obs: ObservedDescribeResult): Assertion[] {
  const d = obs.decision;
  if (!d) return [assertion(`descriptive_summary decision for run ${obs.ruleRunId}`, 'present', 'absent', false)];
  return [
    eq('decision type', 'descriptive_summary', d.type),
    assertion('decision sentence === evidence sentence', obs.sentence ?? 'absent', d.sentenceText ?? 'absent', Boolean(obs.sentence) && d.sentenceText === obs.sentence),
    ...(exp.sentence === undefined ? [] : [assertion('decision sentence (exact)', exp.sentence, d.sentenceText ?? 'absent', d.sentenceText === exp.sentence)]),
  ];
}

// ── one result, one question ────────────────────────────────────────────────

/** Every assertion FR35 requires of one describe result. */
export function evaluateDescribeResult(exp: ExpectedDescribeResult, obs: ObservedDescribeResult): Assertion[] {
  return [
    eq('operationId', exp.operationId, obs.operationId),
    eq('cited connector', exp.connector, obs.citedConnector ?? 'none'),
    eq('n_groups', exp.nGroups, obs.nGroups ?? 'absent'),
    ...(exp.rowCount === undefined ? [] : [eq('result rows', exp.rowCount, obs.rows.length)]),
    ...parameterAssertions(exp, obs),
    ...bindingAssertions(exp, obs),
    ...positionAssertions(exp, obs),
    ...rankAssertions(exp, obs),
    ...labelledCellAssertions(exp, obs),
    ...recommendedChartAssertions(obs),
    ...sentenceAssertions(exp, obs),
    ...decisionAssertions(exp, obs),
  ];
}

/**
 * Pair each expected result with the observed one whose cohort (the referent's
 * effective filters) carries the expectation's discriminating fragment. A
 * question with one expected result and one observed result pairs regardless of
 * cohort text, so a planner that expresses the same slice differently does not
 * fail the question on wording.
 */
export function pairResults(
  expected: readonly ExpectedDescribeResult[],
  observed: readonly ObservedDescribeResult[],
): Array<{ expected: ExpectedDescribeResult; observed: ObservedDescribeResult | null }> {
  const pool = [...observed];
  return expected.map((exp) => {
    const index = expected.length === 1 && pool.length === 1 ? 0 : pool.findIndex((o) => o.cohort.includes(exp.cohort));
    if (index < 0) return { expected: exp, observed: null };
    return { expected: exp, observed: pool.splice(index, 1)[0] };
  });
}

/** Every assertion of a whole question, prefixed by the result it belongs to. */
export function evaluateDescribeQuestion(expectation: DescribeExpectation, observed: readonly ObservedDescribeResult[]): Assertion[] {
  return pairResults(expectation.results, observed).flatMap(({ expected, observed: obs }, i) => {
    const prefix = expectation.results.length > 1 ? `[${expected.cohort || `result ${i + 1}`}] ` : '';
    if (!obs) return [assertion(`${prefix}describe result`, `a run on "${expected.cohort}"`, 'no matching describe run', false)];
    return evaluateDescribeResult(expected, obs).map((a) => ({ ...a, name: `${prefix}${a.name}` }));
  });
}

export const allPassed = (assertions: readonly Assertion[]): boolean => assertions.every((a) => a.ok);
