import { request as apiRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE_URL } from '../../config/env';
import { ReviewWorld, send, type RuleResponse } from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1809 (epic AXI-1762 — FR16, NFR12): the ONE way a spec or harness gets a
 * boot-seeded system rule SERVED.
 *
 * Since AXI-1768 nothing is served without an approval record and seeding never
 * publishes: a fresh stack boots every system rule at `checked` or `draft`, the
 * pickers are empty, `POST /rule-runs` answers "has no published version", and a
 * governed run names the carrier "awaiting approval". A spec that needs a served
 * seed walks it through review here, exactly as the owner does after the
 * migration (`demo/Rule-Approval-After-FR16-Migration.md`):
 *
 *   checked --(bulk submit-for-review, bootstrap admin)--> in_review
 *           --(bulk approve + expectedContentHashes, SECOND platform approver)--> published
 *
 * Why a SECOND approver, always: seeded guidance is Claude-authored
 * (`authorKind: 'claude'`, AXI-1769/1770), and Claude-authored content is never
 * self-approved; the submitter counts as an author. A throwaway user holding a
 * throwaway `rule:publish` role is promoted to platform ADMIN (system rules need
 * both) for the approval only, and demoted, with its role deleted, in `finally`.
 * Using it for human-authored seeds too keeps one path, independent of how many
 * other approvers the stack holds.
 *
 * What this helper NEVER does: edit seed content, call the retired direct
 * `POST /rules/:id/publish`, or write the database. A `draft` seed fails an FR9
 * check that only a content change can fix. That is a product gap, not a test
 * setup step, so it is refused LOUDLY ({@link SeedNotApprovableError}) before
 * anything is mutated, and the error names each failing check.
 *
 * Idempotent and safe under parallel workers: an already-served rule is skipped,
 * and success is judged by re-reading `servedVersion`, not by the bulk result. If
 * another worker's approval wins the race, this call still converges.
 *
 * Stack guard: approval records are append-only. On the shared demo gateway
 * (`:3000`) the owner decides what is approved, so this helper refuses to approve
 * there unless `E2E_ALLOW_SEED_APPROVAL=1` is set deliberately. A rule that is
 * already served passes on any stack, because nothing is written.
 */

export const SEED_APPROVAL_OPT_IN = 'E2E_ALLOW_SEED_APPROVAL';

/** Gateways that serve the owner's data (the shared demo / `make local-up` stack). */
const PROTECTED_GATEWAYS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);

const APPROVER_PASSWORD = 'AXI1765-e2e-pw!'; // ReviewWorld.actor's password
const SETTLE_ATTEMPTS = 5;
const SETTLE_DELAY_MS = 1_000;

export interface SeedBlock {
  code: string;
  ruleId: string;
  status: string;
  /** `<check id>: <message>` for every FR9 check that failed. */
  failingChecks: string[];
}

/** A requested seed is `draft` (or retired): only a content change can make it approvable. */
export class SeedNotApprovableError extends Error {
  constructor(readonly blocked: SeedBlock[]) {
    super(
      `seeded rule(s) cannot be approved — seeding never publishes and this helper never edits seed ` +
        `content, so a spec needing them is blocked on a product content change:\n` +
        blocked
          .map((b) => `  - ${b.code} is ${b.status}: ${b.failingChecks.join(' | ') || 'no failing check reported'}`)
          .join('\n'),
    );
    this.name = 'SeedNotApprovableError';
  }
}

export interface CatalogueRow {
  id: string;
  code: string;
  status: string;
  scope: string;
  tags: string[] | null;
}

interface RuleDetail extends RuleResponse {
  checks?: Array<{ id: string; passed: boolean; message: string }>;
  authorKind?: string;
}

/** True when approving seeds on the target gateway is allowed (see the stack guard above). */
export function seedApprovalAllowed(apiBase: string = API_BASE_URL): boolean {
  if (/^(1|true)$/i.test(process.env[SEED_APPROVAL_OPT_IN] ?? '')) return true;
  return !PROTECTED_GATEWAYS.has(apiBase.replace(/\/+$/, ''));
}

function assertSeedApprovalAllowed(codes: string[]): void {
  if (seedApprovalAllowed()) return;
  throw new Error(
    `refusing to approve seeded rule(s) ${codes.join(', ')} on ${API_BASE_URL}: that gateway serves the ` +
      `owner's data and approval records are append-only. Run against a scratch stack, or have the owner ` +
      `approve them (demo/Rule-Approval-After-FR16-Migration.md), or set ${SEED_APPROVAL_OPT_IN}=1 deliberately.`,
  );
}

/** Served = a published RuleVersion is live and the rule is not retired (AXI-1764 served-rule semantics). */
export function isServed(detail: Pick<RuleResponse, 'status' | 'servedVersion'>): boolean {
  return !!detail.servedVersion && detail.status !== 'deprecated' && detail.status !== 'archived';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CATALOGUE_PAGE_SIZE = 200;

/**
 * The WHOLE system-rule catalogue: every page, `scope === 'system'` only.
 *
 * Never "the first N rules" and never unscoped. Fixture rules left by other specs
 * (workspace/org scope, often carrying the same `op:` tag or a similar code) push
 * boot seeds off a single page. A lookup that takes the first tag match can then
 * bind a fixture instead of the carrier (the AXI-1822 finding). Exported so every
 * carrier lookup in the suite resolves through the same code path. `api` is an
 * authenticated context, or a `path → parsed body` getter for a harness with its own
 * token handling (it must throw on a non-2xx).
 */
export async function systemRuleCatalogue(
  api: APIRequestContext | ((path: string) => Promise<any>),
): Promise<CatalogueRow[]> {
  const get = typeof api === 'function' ? api : (path: string) => send(api, 'get', path);
  const rows: CatalogueRow[] = [];
  for (let page = 1; ; page++) {
    const body = await get(`/api/v1/rules?scope=system&limit=${CATALOGUE_PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(body?.data)) throw new Error('system rule catalogue response missing data[]');
    rows.push(...(body.data as CatalogueRow[]));
    if (!body.meta?.hasNextPage || body.data.length === 0) break;
  }
  return rows.filter((r) => r.scope === 'system');
}

const systemCatalogue = systemRuleCatalogue;

async function details(admin: APIRequestContext, ids: string[]): Promise<RuleDetail[]> {
  return Promise.all(ids.map((id) => send(admin, 'get', `/api/v1/rules/${id}`) as Promise<RuleDetail>));
}

function blockOf(detail: RuleDetail): SeedBlock {
  return {
    code: detail.code,
    ruleId: detail.id,
    status: detail.status,
    failingChecks: (detail.checks ?? []).filter((c) => !c.passed).map((c) => `${c.id}: ${c.message}`),
  };
}

/** A throwaway platform ADMIN holding `rule:publish`, logged in AFTER promotion so its JWT carries ADMIN. */
async function secondApprover(world: ReviewWorld): Promise<{ userId: string; api: APIRequestContext }> {
  const role = await world.role('axi1809-seed-approver', ['rule:read', 'rule:publish']);
  const actor = await world.actor('axi1809-seed-approver', role);
  await send(world.admin, 'patch', `/api/v1/users/${actor.userId}`, { role: 'ADMIN' });
  const login = await apiRequest.newContext();
  const tokens = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: APPROVER_PASSWORD });
  await login.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
  return { userId: actor.userId, api };
}

/**
 * Make every rule in `codes` (boot-seeded SYSTEM rule codes) served, and return
 * `code → ruleId`. See the file header for the walk, the guard and the refusals.
 */
export async function approveSeededRules(
  codes: string[],
  opts: { justification?: string } = {},
): Promise<Record<string, string>> {
  const wanted = [...new Set(codes)];
  if (wanted.length === 0) return {};
  const world = await ReviewWorld.create();
  try {
    const catalogue = await systemCatalogue(world.admin);
    const idByCode: Record<string, string> = {};
    const missing: string[] = [];
    for (const code of wanted) {
      const row = catalogue.find((r) => r.code === code);
      if (row) idByCode[code] = row.id;
      else missing.push(code);
    }
    if (missing.length) {
      throw new Error(`not a boot-seeded system rule on this stack: ${missing.join(', ')} (carriers and seeds are seeded at organization-service boot)`);
    }

    const pending = (await details(world.admin, Object.values(idByCode))).filter((d) => !isServed(d));
    if (pending.length === 0) return idByCode;

    const blocked = pending.filter((d) => d.status !== 'checked' && d.status !== 'in_review');
    if (blocked.length) throw new SeedNotApprovableError(blocked.map(blockOf));
    assertSeedApprovalAllowed(pending.map((d) => d.code));

    const toSubmit = pending.filter((d) => d.status === 'checked').map((d) => d.id);
    if (toSubmit.length) {
      // Per-rule skips (a concurrent worker submitted first) are fine: the re-read below decides.
      await send(world.admin, 'post', '/api/v1/rules/bulk/submit-for-review', { ruleIds: toSubmit });
    }

    const inReview = (await details(world.admin, pending.map((d) => d.id))).filter(
      (d) => !isServed(d) && d.status === 'in_review' && d.review?.contentHash,
    );
    let approval: { results?: Array<{ code: string | null; outcome: string; reasonCode: string | null; message: string | null }> } = {};
    if (inReview.length) {
      const approver = await secondApprover(world);
      try {
        approval = await send(approver.api, 'post', '/api/v1/rules/bulk/approve', {
          ruleIds: inReview.map((d) => d.id),
          justification:
            opts.justification ??
            `AXI-1809 e2e fixture: approving seeded rule(s) ${inReview.map((d) => d.code).join(', ')} so the spec runs against served rules.`,
          expectedContentHashes: Object.fromEntries(inReview.map((d) => [d.id, d.review!.contentHash])),
        });
      } finally {
        await approver.api.dispose();
        await send(world.admin, 'patch', `/api/v1/users/${approver.userId}`, { role: 'USER' }).catch(() => undefined);
      }
    }

    // Converge: judge by what the server now serves, allowing a concurrent winner a moment to land.
    let notServed: RuleDetail[] = [];
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
      notServed = (await details(world.admin, pending.map((d) => d.id))).filter((d) => !isServed(d));
      if (notServed.length === 0) return idByCode;
      await sleep(SETTLE_DELAY_MS);
    }
    const why = (code: string) => {
      const r = approval.results?.find((x) => x.code === code);
      return r ? `${r.outcome}${r.reasonCode ? ` ${r.reasonCode}` : ''}${r.message ? `: ${r.message}` : ''}` : 'no approval attempted';
    };
    throw new Error(
      `seeded rule(s) still not served after review:\n` +
        notServed.map((d) => `  - ${d.code} is ${d.status} (${why(d.code)})`).join('\n'),
    );
  } finally {
    await world.dispose();
  }
}

export interface BestEffortServing {
  /** Codes served after the call (already served, or approved now). */
  served: string[];
  /** Draft/retired seeds: only a content change makes them approvable. */
  blocked: SeedBlock[];
  /** Approvable but left alone because the target is a protected stack (see the stack guard). */
  withheld: string[];
}

/**
 * Harness-seeding variant: serve every APPROVABLE rule in `codes` and report the
 * rest instead of throwing. A shared seed (for example the live workbench) uses it
 * so that specs which never touch a blocked rule keep running. Every seam that
 * NEEDS one particular rule still calls {@link approveSeededRules} /
 * {@link approveCarriersFor}, which refuse loudly.
 */
export async function serveApprovableSeededRules(
  codes: string[],
  opts: { justification?: string } = {},
): Promise<BestEffortServing> {
  const wanted = [...new Set(codes)];
  const world = await ReviewWorld.create();
  let rows: RuleDetail[];
  try {
    const catalogue = await systemCatalogue(world.admin);
    const ids = wanted.map((code) => catalogue.find((r) => r.code === code)?.id).filter((id): id is string => !!id);
    rows = await details(world.admin, ids);
  } finally {
    await world.dispose();
  }
  const served = rows.filter(isServed).map((d) => d.code);
  const blocked = rows.filter((d) => !isServed(d) && d.status !== 'checked' && d.status !== 'in_review').map(blockOf);
  const approvable = rows.filter((d) => !isServed(d) && (d.status === 'checked' || d.status === 'in_review')).map((d) => d.code);
  if (approvable.length === 0) return { served, blocked, withheld: [] };
  if (!seedApprovalAllowed()) return { served, blocked, withheld: approvable };
  await approveSeededRules(approvable, opts);
  return { served: [...served, ...approvable], blocked, withheld: [] };
}

/**
 * The boot-seeded carrier codes for `operationIds`, by their `op:<operationId>`
 * tag (`CARRIER_SEEDS`, AXI-1766). A family carrier with no `op:` tag
 * (`STRATIFY-01`, `DELTA-01`) is named by code instead.
 */
export async function carrierCodesFor(operationIds: string[]): Promise<Record<string, string>> {
  const world = await ReviewWorld.create();
  try {
    const catalogue = await systemCatalogue(world.admin);
    const codes: Record<string, string> = {};
    const missing: string[] = [];
    for (const op of new Set(operationIds)) {
      const carrier = catalogue.find((r) => (r.tags ?? []).includes(`op:${op}`));
      if (carrier) codes[op] = carrier.code;
      else missing.push(op);
    }
    if (missing.length) throw new Error(`no boot-seeded carrier tagged op:<id> for ${missing.join(', ')}`);
    return codes;
  } finally {
    await world.dispose();
  }
}

/** Serve the carrier of each operation; returns `operationId → { code, ruleId }`. */
export async function approveCarriersFor(
  operationIds: string[],
  opts: { justification?: string } = {},
): Promise<Record<string, { code: string; ruleId: string }>> {
  const codes = await carrierCodesFor(operationIds);
  const ids = await approveSeededRules(Object.values(codes), opts);
  return Object.fromEntries(Object.entries(codes).map(([op, code]) => [op, { code, ruleId: ids[code] }]));
}
