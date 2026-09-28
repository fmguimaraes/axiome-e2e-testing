/**
 * Find-or-create-or-approve for one library rule over the REST API.
 *
 * The rule lifecycle the gateway exposes (AXI-1768 approval gate) is
 *   POST  /api/v1/rules                        (create a draft — metadata + scope)
 *   PATCH /api/v1/rules/:id                    (author the body: evaluations, expression,
 *                                               outputFields, guard, heuristic …; the FR9
 *                                               checks then place it at `draft` or `checked`)
 *   POST  /api/v1/rules/:id/submit-for-review  (author: checked → in_review)
 *   POST  /api/v1/rules/:id/approve            (a rule:publish holder, against the reviewed
 *                                               content hash → immutable served version)
 *
 * AXI-1809: the old direct `POST /rules/:id/publish` is now an alias of approve
 * (it needs `in_review` and a justification), so this helper walks submit →
 * approve instead. It approves AS THE STAGING ADMIN: the backend allows that only
 * as a recorded self-approval of human-authored content when the admin is the
 * workspace's only approver. Otherwise it refuses (`SELF_APPROVAL_*`), and this
 * helper stops LOUDLY with the rule left `in_review`, for another approver to
 * decide in the Review queue; a re-run then reuses the served rule. It never
 * mints a throwaway approver on the owner's stack and never writes the database.
 *
 * `ensureRule` is idempotent: a served (published) version is reused as-is (a new
 * version is NOT minted — edit the library and bump the code, e.g. `-02`, when the
 * logic changes); an existing unserved row is re-authored (unless already
 * `in_review`) and walked through review; nothing else is touched.
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

interface RuleDetail extends RuleRow {
  servedVersion?: { id: string } | null;
  review?: { contentHash?: string | null } | null;
  checks?: Array<{ id: string; passed: boolean; message: string }>;
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

const UNSERVED = new Set(['draft', 'checked', 'in_review']);

export async function ensureRule(client: RestClient, draft: RuleDraft, scope: RuleScope, opts: EnsureRuleOptions = {}): Promise<{ row: RuleRow; action: EnsureRuleAction }> {
  const code = draft.create.code as string;
  const log = opts.log ?? (() => undefined);
  const listed = await findRuleVersions(client, code);
  const published = listed.find((r) => r.status === 'published');
  if (published) {
    log(`rule ${code} v${published.version} already published (${published.id})`);
    return { row: published, action: 'reused' };
  }
  let draftRow = listed.find((r) => UNSERVED.has(r.status));
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
  const id = draftRow.id;
  const read = async () => must(await client.as<RuleDetail>(ADMIN_HANDLE, 'GET', `/api/v1/rules/${id}`), `reading rule ${code}`);
  // An in_review row is frozen for its reviewer: re-authoring it would move it back and void the hash.
  if (draftRow.status !== 'in_review') {
    must(await client.as(ADMIN_HANDLE, 'PATCH', `/api/v1/rules/${id}`, draft.body), `authoring rule ${code}`);
  }
  let detail = await read();
  if (detail.status === 'draft') {
    const failing = (detail.checks ?? []).filter((c) => !c.passed).map((c) => `${c.id}: ${c.message}`);
    throw new Error(`rule ${code} (${id}) is draft after authoring, so it cannot be submitted for review — fix the library entry: ${failing.join(' | ') || 'no failing check reported'}`);
  }
  if (detail.status === 'checked') {
    must(await client.as(ADMIN_HANDLE, 'POST', `/api/v1/rules/${id}/submit-for-review`), `submitting rule ${code} for review`);
    detail = await read();
  }
  if (detail.status !== 'in_review' || !detail.review?.contentHash) {
    throw new Error(`rule ${code} (${id}) did not reach in_review (status ${detail.status})`);
  }
  const approved = await client.as<unknown>(ADMIN_HANDLE, 'POST', `/api/v1/rules/${id}/approve`, {
    note: opts.justification ?? `Approved by staging ensureRule for ${code}`,
    expectedContentHash: detail.review.contentHash,
  });
  if (!approved.ok) {
    throw new Error(
      `rule ${code} (${id}) is in_review but the staging admin may not approve it (status ${approved.status}): ` +
        `${JSON.stringify(approved.body).slice(0, 400)}. Another approver must approve it in the Review queue; re-run staging afterwards.`,
    );
  }
  detail = await read();
  if (!detail.servedVersion) throw new Error(`rule ${code} (${id}) is not served after approval (status ${detail.status})`);
  log(`approved rule ${code} v${detail.version ?? '?'} (${id})`);
  return { row: { ...draftRow, ...detail, id }, action };
}
