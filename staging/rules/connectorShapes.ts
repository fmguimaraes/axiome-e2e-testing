/**
 * AXI-1581 (epic AXI-1575 — FR13–FR16) — a MIRROR of the ten seeded `SUM-*`
 * connector parameter schemes
 * (`axiome-back/apps/organization-service/src/rules/seed-rules.ts`), narrow
 * enough to answer ONE question offline: could the connector a staged Riaz
 * question CITES actually bind the parameters that question declares?
 *
 * Why a mirror and not a read of the stack: the staged questions are authored in
 * this repo and reviewed here, and the defect this exists to catch — Q20 kept
 * citing `SUM-RANK-01` with `aggregation: std` after AXI-1581 narrowed that enum
 * to {mean, sum} — is a CONTRADICTION INSIDE THIS REPO'S OWN FIXTURES. It costs a
 * full staged run (an LLM plan per question, a governed submit and a drain) to
 * discover it live, and the run fails at the last question rather than at review.
 * The same mirror-with-a-named-origin pattern the front end uses for chart
 * binding roles (`bindingRoles.ts`).
 *
 * It is deliberately NOT a second matcher: it models only the facts the
 * connector-matcher's `valueCriterion` and `cardinality` checks decide on —
 * required parameters, enum membership and group-column arity. A connector's
 * real authority is always the seed.
 */

export interface ConnectorShape {
  operationId: string;
  /** admissible `groupColumns` lengths; `null` when the operation groups nothing */
  groupColumnArity: number[] | null;
  /** parameters that must be bound for the connector to match */
  required: string[];
  /** admissible values per enum parameter — a value outside it cannot bind */
  enums: Record<string, string[]>;
  /** parameters the seed pins ABSENT (`fixed: null`) — declaring one cannot bind */
  forbidden?: string[];
  /**
   * A DOMAIN connector (AXI-1582) also requires its value column to resolve to a
   * semantic role, which is a fact of the PROJECT's semantic contract and not of
   * this repo. The mirror therefore checks its shape only, and says so.
   */
  domain?: boolean;
}

/**
 * Mirrors `seed-rules.ts` (AXI-1559 + AXI-1581 + AXI-1582) AFTER AXI-1581's two
 * narrowings: `SUM-RANK-01`'s
 * aggregation is {mean, sum} (median/spread/extremes moved to their own
 * connectors) and `SUM-COUNT-01` groups by exactly ONE column (the two-column
 * cross-tab moved to `SUM-CROSS-COUNT-01`).
 */
export const CONNECTOR_SHAPES: Readonly<Record<string, ConnectorShape>> = Object.freeze({
  'SUM-RANK-01': {
    operationId: 'describe.grouped_aggregate',
    groupColumnArity: [1],
    required: ['groupColumns', 'valueColumn', 'aggregation', 'direction'],
    enums: { aggregation: ['mean', 'sum'], direction: ['asc', 'desc'] },
  },
  'SUM-RANK-MEDIAN-01': {
    operationId: 'describe.grouped_aggregate',
    groupColumnArity: [1],
    required: ['groupColumns', 'valueColumn', 'aggregation', 'direction'],
    enums: { aggregation: ['median'], direction: ['asc', 'desc'] },
  },
  'SUM-SPREAD-01': {
    operationId: 'describe.grouped_aggregate',
    groupColumnArity: [1],
    required: ['groupColumns', 'valueColumn', 'aggregation', 'direction'],
    enums: { aggregation: ['std'], direction: ['desc'] },
  },
  'SUM-EXTREMES-01': {
    operationId: 'describe.grouped_aggregate',
    groupColumnArity: [1],
    required: ['groupColumns', 'valueColumn', 'aggregation', 'direction'],
    enums: { aggregation: ['min', 'max'], direction: ['asc', 'desc'] },
  },
  'SUM-CROSS-01': {
    operationId: 'describe.grouped_aggregate',
    groupColumnArity: [2],
    required: ['groupColumns', 'valueColumn', 'aggregation'],
    enums: { aggregation: ['mean', 'median', 'std', 'min', 'max', 'sum'], direction: ['asc'] },
  },
  'SUM-COUNT-01': {
    operationId: 'describe.count',
    groupColumnArity: [1],
    required: ['groupColumns'],
    enums: {},
  },
  'SUM-CROSS-COUNT-01': {
    operationId: 'describe.count',
    groupColumnArity: [2],
    required: ['groupColumns'],
    enums: {},
  },
  'SUM-TOPN-01': {
    operationId: 'describe.top_n',
    groupColumnArity: null,
    required: ['sortColumn', 'n', 'direction'],
    enums: { direction: ['asc', 'desc'] },
    // AXI-1582 pinned `filter: { fixed: null }` — an unfiltered top-N only.
    forbidden: ['filter'],
  },
  'SUM-TOPN-FILTERED-01': {
    operationId: 'describe.top_n',
    groupColumnArity: null,
    required: ['sortColumn', 'n', 'direction', 'filter'],
    enums: { direction: ['asc', 'desc'] },
  },
  'SUM-EXPR-RANK-01': {
    operationId: 'describe.grouped_aggregate',
    groupColumnArity: [1],
    required: ['groupColumns', 'valueColumn', 'aggregation', 'direction'],
    enums: { aggregation: ['mean', 'median', 'std', 'min', 'max', 'sum'], direction: ['asc', 'desc'] },
    domain: true,
  },
});

/**
 * The parameters a staged question declares its describe node will bind. Read
 * structurally (not as an index signature) so `ExpectedParameters` — the shape
 * the expectations are authored in — satisfies it without a cast.
 */
export interface DeclaredParameters {
  groupColumns?: string[];
  valueColumn?: string;
  aggregation?: string;
  direction?: string;
  distinctKey?: string;
  sortColumn?: string;
  n?: number;
  filter?: unknown;
}

function arityProblems(shape: ConnectorShape, code: string, params: DeclaredParameters): string[] {
  const groups = params.groupColumns;
  if (shape.groupColumnArity === null) return Array.isArray(groups) ? [`${code} binds ${shape.operationId}, which groups nothing — groupColumns must not be declared`] : [];
  if (!Array.isArray(groups)) return [];
  return shape.groupColumnArity.includes(groups.length)
    ? []
    : [`${code} accepts ${shape.groupColumnArity.join(' or ')} group column(s), the question declares ${groups.length} (${groups.join(', ')})`];
}

function enumProblems(shape: ConnectorShape, code: string, params: DeclaredParameters): string[] {
  const declared = params as Record<string, unknown>;
  return Object.entries(shape.enums).flatMap(([name, allowed]) => {
    const value = declared[name];
    if (value === undefined) return [];
    return allowed.includes(String(value)) ? [] : [`${code} accepts ${name} in {${allowed.join(', ')}}, the question declares '${String(value)}'`];
  });
}

/**
 * Every reason the CITED connector could not bind the DECLARED parameters, as
 * sentences a reader can act on. An empty array means the citation is
 * self-consistent under the current seeds.
 */
export function connectorBindingProblems(
  code: string,
  operationId: string | undefined,
  params: DeclaredParameters,
  /**
   * `declaresEveryParameter: false` for the EXPECTATIONS sweep: an
   * `ExpectedParameters` is the set of parameters a question ASSERTS on the run,
   * not the full set the node binds (AXI-1582's Q36 asserts sortColumn /
   * direction / n but not its `filter`), so a missing required parameter there is
   * an assertion gap, not a binding failure. `true` — the default — is the
   * complete-declaration case a prompt makes.
   */
  { declaresEveryParameter = true }: { declaresEveryParameter?: boolean } = {},
): string[] {
  const shape = CONNECTOR_SHAPES[code];
  if (!shape) return [`${code} is not one of the ten seeded SUM-* connectors — nothing in this repo may cite it`];
  const problems: string[] = [];
  if (operationId && operationId !== shape.operationId) problems.push(`${code} binds ${shape.operationId}, the question declares ${operationId}`);
  const declared = params as Record<string, unknown>;
  if (declaresEveryParameter) problems.push(...shape.required.filter((p) => declared[p] === undefined).map((p) => `${code} requires ${p}, the question declares none`));
  problems.push(...(shape.forbidden ?? []).filter((p) => declared[p] !== undefined).map((p) => `${code} is pinned to an absent ${p}, the question declares one`));
  problems.push(...arityProblems(shape, code, params));
  problems.push(...enumProblems(shape, code, params));
  return problems;
}

const CITATION = /cites the connector rule ([A-Z0-9-]+)/g;

/** Every connector code a question's prompt text instructs the planner to cite. */
export function citedConnectorsInPrompt(text: string): string[] {
  return [...text.matchAll(CITATION)].map((m) => m[1]);
}
