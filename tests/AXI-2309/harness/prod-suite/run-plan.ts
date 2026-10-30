import { ApiClient, okBody } from './api-client';
import { ProdSuiteAbort } from './abort';

/**
 * AXI-2318 — the daily run's ORDER (FR30): Paul's methods first, then the full
 * ACTIVE system rule catalogue.
 *
 * "Active" = a SYSTEM rule the served listing returns as `published`
 * (`GET /rules?scope=system&status=published`, the same listing every picker
 * reads — rule-library.md §served rule). "Paul's methods" are identified by the
 * kernel OPERATION they carry (`operationId`), never by a rule UUID or code:
 * UUIDs differ per database and the demo DB already shows several system rows
 * per code, so the operation is the one identity that is stable on prod. Every
 * active rule carrying one of those operations runs in phase 1 — none is
 * picked or dropped — and every other active rule runs in phase 2, each exactly
 * once, in a deterministic order (code, then id).
 *
 * An EMPTY catalogue aborts the run: a "full catalogue" phase over zero rules
 * would read as a pass whether the platform works or not (a latently-green
 * report). The usual cause is a test identity missing `rule:view_shared`.
 */

/** The operations behind Paul's slides (AXI-2066 reproduction: slide 2 Dunn, slide 3 MWU + KW, heatmap Spearman, partial correlation). */
export const PAUL_OPERATIONS: readonly string[] = [
  'stats.dunn_posthoc',
  'stats.mann_whitney_u',
  'stats.kruskal_wallis',
  'stats.correlation',
  'stats.partial_correlation',
];

export interface CatalogueRule {
  id: string;
  code: string;
  operationId: string | null;
  runKind: string | null;
  runnable: boolean | null;
}

export type CasePhase = 'paul-methods' | 'catalogue';

export interface PlannedCase extends CatalogueRule {
  order: number;
  phase: CasePhase;
}

export interface RunPlan {
  paulOperations: string[];
  /** Paul operations no active rule carries — recorded, judged by AXI-2319's pass rule. */
  missingPaulOperations: string[];
  cases: PlannedCase[];
}

function toCatalogueRule(row: any): CatalogueRule {
  return {
    id: String(row.id),
    code: String(row.code ?? ''),
    operationId: typeof row.operationId === 'string' ? row.operationId : null,
    runKind: typeof row.runKind === 'string' ? row.runKind : null,
    runnable: typeof row.runnable === 'boolean' ? row.runnable : null,
  };
}

const isActiveSystem = (row: any) => row?.scope === 'system' && row?.status === 'published';

/** Every active system rule the identity can see, all pages. */
export async function fetchActiveCatalogue(client: ApiClient): Promise<CatalogueRule[]> {
  const rows: CatalogueRule[] = [];
  for (let page = 1; page <= 50; page++) {
    const body = okBody(await client.get(`/api/v1/rules?scope=system&status=published&limit=200&page=${page}`), 'list rules');
    const data: any[] = Array.isArray(body?.data) ? body.data : [];
    rows.push(...data.filter(isActiveSystem).map(toCatalogueRule));
    if (!body?.meta?.hasNextPage || data.length === 0) return rows;
  }
  throw new ProdSuiteAbort('plan', 'CATALOGUE_UNBOUNDED', 'rule listing did not terminate in 50 pages');
}

const byCodeThenId = (a: CatalogueRule, b: CatalogueRule) =>
  a.code.localeCompare(b.code) || a.id.localeCompare(b.id);

function dedupeById(rules: CatalogueRule[]): CatalogueRule[] {
  const seen = new Map<string, CatalogueRule>();
  for (const rule of rules) if (!seen.has(rule.id)) seen.set(rule.id, rule);
  return [...seen.values()];
}

/** Pure: order the catalogue into the two phases (FR30). */
export function buildRunPlan(catalogue: CatalogueRule[], paulOperations: readonly string[] = PAUL_OPERATIONS): RunPlan {
  const rules = dedupeById(catalogue);
  if (rules.length === 0) {
    throw new ProdSuiteAbort('plan', 'CATALOGUE_EMPTY',
      'the test identity sees no active system rule — grant it rule:read + rule:view_shared');
  }
  const rank = (r: CatalogueRule) => paulOperations.indexOf(r.operationId ?? '');
  const paul = rules.filter((r) => rank(r) >= 0).sort((a, b) => rank(a) - rank(b) || byCodeThenId(a, b));
  const rest = rules.filter((r) => rank(r) < 0).sort(byCodeThenId);
  const cases: PlannedCase[] = [
    ...paul.map((r) => ({ ...r, phase: 'paul-methods' as const })),
    ...rest.map((r) => ({ ...r, phase: 'catalogue' as const })),
  ].map((r, i) => ({ ...r, order: i + 1 }));
  const carried = new Set(paul.map((r) => r.operationId));
  return { paulOperations: [...paulOperations], missingPaulOperations: paulOperations.filter((op) => !carried.has(op)), cases };
}
