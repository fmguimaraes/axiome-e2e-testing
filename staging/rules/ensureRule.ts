/**
 * Find-or-create-or-publish for one library rule over the REST API.
 *
 * The rule lifecycle the gateway exposes is
 *   POST  /api/v1/rules               (create a draft — metadata + scope)
 *   PATCH /api/v1/rules/:id           (author the body: evaluations, expression,
 *                                      outputFields, guard, heuristic …)
 *   POST  /api/v1/rules/:id/publish   (protocol validation → immutable version)
 *
 * `ensureRule` walks that ladder once per code and is idempotent: a published
 * version is reused as-is (a new version is NOT minted — edit the library and
 * bump the code, e.g. `-02`, when the logic changes), an existing draft is
 * re-authored and published, nothing else is touched.
 *
 * Scope: a governed `qc_check` resolves its cited rule by `{scope:'system'} OR
 * {organizationId}` (`rule-runs-analysis-runner.ts` `findCitedRule`), so a
 * workspace-scoped rule STAMPED with the tenant's organizationId is what makes
 * the citation land without minting a system rule. No org → system scope.
 */
import type { RestClient } from '../client/RestClient';
import { ADMIN_HANDLE } from '../steps/context';

export interface RuleDraft {
  /** Body of `POST /rules` minus scope (code, title, question, signals, logicSummary, risksNotes, category, protocolType, tags). */
  create: Record<string, unknown>;
  /** Body of `PATCH /rules/:id` (attributeEvaluations, expression, outputFields, confidenceHeuristic, guardOutput, ruoOnly, safetyFlags). */
  body: Record<string, unknown>;
}

export interface RuleRow {
  id: string;
  code: string;
  version: number;
  status: string;
  scope: string;
  protocolType?: string;
  title?: string;
}

export interface RuleScope {
  organizationId: string | null;
  workspaceId: string;
}

export interface EnsureRuleOptions {
  justification?: string;
  log?: (msg: string) => void;
  /** Resolve the tenant and report, but never write. */
  dryRun?: boolean;
}

export function must<T>(res: { ok: boolean; status: number; body?: T }, what: string): T {
  if (!res.ok || res.body === undefined) throw new Error(`${what} failed (status ${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body;
}

export function asList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const rec = (body ?? {}) as Record<string, unknown>;
  const data = rec.data ?? rec.ruleRuns ?? rec.items;
  return Array.isArray(data) ? (data as T[]) : [];
}

/** Every version of `code` the caller can see, newest first. */
export async function findRuleVersions(client: RestClient, code: string): Promise<RuleRow[]> {
  const res = must(await client.as<unknown>(ADMIN_HANDLE, 'GET', `/api/v1/rules?search=${encodeURIComponent(code)}&limit=50`), `listing rules ${code}`);
  return asList<RuleRow>(res)
    .filter((r) => r.code === code)
    .sort((a, b) => b.version - a.version);
}

export type EnsureRuleAction = 'reused' | 'created' | 'published' | 'would-create' | 'would-publish';

export async function ensureRule(client: RestClient, draft: RuleDraft, scope: RuleScope, opts: EnsureRuleOptions = {}): Promise<{ row: RuleRow; action: EnsureRuleAction }> {
  const code = draft.create.code as string;
  const log = opts.log ?? (() => undefined);
  const listed = await findRuleVersions(client, code);
  const published = listed.find((r) => r.status === 'published');
  if (published) {
    log(`rule ${code} v${published.version} already published (${published.id})`);
    return { row: published, action: 'reused' };
  }
  let draftRow = listed.find((r) => r.status === 'draft');
  const stamp = scope.organizationId ? { scope: 'workspace', organizationId: scope.organizationId, workspaceId: scope.workspaceId } : { scope: 'system' };
  if (opts.dryRun) {
    const action: EnsureRuleAction = draftRow ? 'would-publish' : 'would-create';
    log(`${action} rule ${code} (scope ${stamp.scope})`);
    return { row: draftRow ?? { id: '', code, version: 0, status: 'absent', scope: stamp.scope }, action };
  }
  let action: EnsureRuleAction = 'published';
  if (!draftRow) {
    draftRow = must(await client.as<RuleRow>(ADMIN_HANDLE, 'POST', '/api/v1/rules', { ...draft.create, ...stamp }), `creating rule ${code}`);
    log(`created rule ${code} (${draftRow.id}, scope ${stamp.scope})`);
    action = 'created';
  }
  must(await client.as(ADMIN_HANDLE, 'PATCH', `/api/v1/rules/${draftRow.id}`, draft.body), `authoring rule ${code}`);
  const pub = must(
    await client.as<RuleRow>(ADMIN_HANDLE, 'POST', `/api/v1/rules/${draftRow.id}/publish`, { justification: opts.justification ?? `Published by staging ensureRule for ${code}` }),
    `publishing rule ${code}`,
  );
  log(`published rule ${code} v${pub.version ?? '?'} (${draftRow.id})`);
  return { row: { ...draftRow, ...pub, id: draftRow.id }, action };
}
