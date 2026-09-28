import { isDeepStrictEqual } from 'node:util';
import { APIRequestContext, test, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';
import { ReviewWorld, send } from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1771 (epic AXI-1762 — FR1, FR2, FR5, FR7, FR9, NFR2, NFR8; SI-017): guidance content for
 * delta, stratify, join, the cutoff proposals and tally, the screen and the split — and FR7's
 * closure: every submittable operation now carries complete guidance.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §17.
 *
 * Read from the REAL shared kernel registry and the REAL boot seeding — never a hand-built
 * fixture:
 *   1. `GET /rule-runs/operations` projects complete guidance and field help for the 13
 *      operations this story owns; every enum's `valueLabels` equal its allowed values exactly
 *      (Delta's `outputMode` among them); each family's censoring help says what its executor
 *      really does (delta applies it, the others record it).
 *   2. FR7: EVERY submittable operation the endpoint serves has complete guidance.
 *   3. Each single-operation carrier (JOIN-01, the seven STAT-* carriers) carries exactly the
 *      registry guidance, authored `claude`, and FR9 puts it at `checked`.
 *   4. The two FAMILY carriers (DELTA-01, STRATIFY-01) — which before this story could never
 *      receive guidance and stayed `draft` — carry their family guidance, authored `claude`, at
 *      `checked`.
 *   5. Nothing in the family is served before a human approves it.
 *   6. End to end on a family carrier: checked → submit → the submitter may NOT approve
 *      Claude-authored content → a DIFFERENT `rule:publish` holder approves with the content
 *      hash → the served version carries the guidance.
 *
 * Serial: scenario 6 moves one carrier; 3–5 read all of them. On a re-run against the same
 * stack, 3/4 accept a carrier an earlier run took through review, and 6 picks a family carrier
 * (else any carrier of this story) still at `checked`.
 *
 * The lists are restated on purpose: a spec that derived them from the endpoint would pass on an
 * empty catalogue.
 */

const DELTA_OPERATION_IDS = ['delta.difference', 'delta.ratio', 'delta.log2fc', 'delta.percent_change'] as const;
const STRATIFY_OPERATION_ID = 'stratify.explicit_groups';
const SINGLE_CARRIER_OPERATION_IDS = [
  'stats.cutoff_roc_youden',
  'stats.cutoff_maxstat',
  'stats.cutoff_distribution',
  'stats.cutoff_reference',
  'stats.cutoff_tally',
  'stats.screen_shortlist',
  'split.exploration_holdout',
  'join.attach',
] as const;
const STORY_OPERATION_IDS = [...DELTA_OPERATION_IDS, STRATIFY_OPERATION_ID, ...SINGLE_CARRIER_OPERATION_IDS];
const FAMILY_CARRIER_CODES = ['DELTA-01', 'STRATIFY-01'] as const;

/** `isSubmittableOperation` (back `rules/runnability/rule-runnability.ts`), restated: QC is not. */
const SUBMITTABLE_RUN_KINDS = ['DELTA', 'STRATIFY', 'STATISTICAL', 'JOIN', 'DESCRIBE'];

interface HelpBlock {
  label: string;
  what: string;
  why: string;
  example: string;
  valueLabels?: Record<string, string> | null;
}

interface Guidance {
  whatItDoes: string;
  whenToUse: string;
  whenNotToUse: string;
  example: string;
  youWillGet: string;
}

interface OperationDescriptor {
  operationId: string;
  runKind: string;
  guidance: Guidance | null;
  parameters: Array<{ key: string; allowedValues?: string[] | null; help: HelpBlock | null }>;
  columnRoles: Array<{ role: string; help: HelpBlock | null }>;
}

interface RuleCheck {
  id: string;
  passed: boolean;
  message: string;
}

interface RuleVersionRow {
  id: string;
  version: number;
  status: string;
  guidance: Guidance | null;
  authorKind: string | null;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function guidanceGaps(g: Guidance | null): string[] {
  if (!g) return ['guidance null'];
  const gaps: string[] = [];
  for (const field of ['whatItDoes', 'whenToUse', 'whenNotToUse', 'example', 'youWillGet'] as const) {
    if (!nonEmpty(g[field])) gaps.push(`guidance.${field} empty`);
  }
  if (g.whatItDoes.length > 200) gaps.push('guidance.whatItDoes > 200');
  if (g.example.length > 120) gaps.push('guidance.example > 120');
  return gaps;
}

/** Complete help within NFR8; an enum's labels name EXACTLY its allowed values (no stale extras). */
function helpGaps(prefix: string, h: HelpBlock | null | undefined, allowed?: string[] | null): string[] {
  if (!h) return [`${prefix}.help null`];
  const gaps: string[] = [];
  for (const field of ['label', 'what', 'why', 'example'] as const) {
    if (!nonEmpty(h[field])) gaps.push(`${prefix}.help.${field} empty`);
  }
  if (h.what.length > 160) gaps.push(`${prefix}.help.what > 160`);
  if (h.why.length > 160) gaps.push(`${prefix}.help.why > 160`);
  if (h.example.length > 120) gaps.push(`${prefix}.help.example > 120`);
  if (allowed && allowed.length > 0) {
    const labelled = Object.keys(h.valueLabels ?? {}).sort();
    if (JSON.stringify(labelled) !== JSON.stringify([...allowed].sort())) {
      gaps.push(`${prefix}.help.valueLabels ${JSON.stringify(labelled)} != allowed ${JSON.stringify([...allowed].sort())}`);
    }
    for (const value of allowed) {
      if (!nonEmpty(h.valueLabels?.[value])) gaps.push(`${prefix}.help.valueLabels.${value} empty`);
    }
  }
  return gaps;
}

function operationGaps(op: OperationDescriptor): string[] {
  return [
    ...guidanceGaps(op.guidance),
    ...op.parameters.flatMap((p) => helpGaps(`parameters.${p.key}`, p.help, p.allowedValues)),
    ...op.columnRoles.flatMap((r) => helpGaps(`columnRoles.${r.role}`, r.help)),
  ];
}

async function adminApi(request: APIRequestContext): Promise<Record<string, string>> {
  const admin = ROLES.find((role) => role.name === 'admin')!;
  const { accessToken } = await ensureAuthTokens(request, admin);
  return { Authorization: `Bearer ${accessToken}` };
}

async function getJson(request: APIRequestContext, headers: Record<string, string>, path: string): Promise<any> {
  const res = await request.get(apiUrl(path), { headers });
  if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}: ${await res.text()}`);
  return res.json();
}

async function operations(request: APIRequestContext, headers: Record<string, string>): Promise<Map<string, OperationDescriptor>> {
  const body = await getJson(request, headers, '/api/v1/rule-runs/operations');
  return new Map((body.operations as OperationDescriptor[]).map((op) => [op.operationId, op]));
}

type CatalogRule = { id: string; code: string; tags: string[] | null };

async function catalog(request: APIRequestContext, headers: Record<string, string>): Promise<CatalogRule[]> {
  return (await getJson(request, headers, '/api/v1/rules?limit=200')).data;
}

/** The single-operation carrier of `operationId` (its `op:` tag). */
function carrierOf(rules: CatalogRule[], operationId: string): CatalogRule {
  const carrier = rules.find((r) => (r.tags ?? []).includes(`op:${operationId}`));
  expect(carrier, `${operationId} has a carrier rule`).toBeDefined();
  return carrier!;
}

function familyCarrier(rules: CatalogRule[], code: string): CatalogRule {
  const carrier = rules.find((r) => r.code === code);
  expect(carrier, `${code} is seeded`).toBeDefined();
  return carrier!;
}

async function newestVersion(request: APIRequestContext, headers: Record<string, string>, id: string): Promise<RuleVersionRow> {
  const body = await getJson(request, headers, `/api/v1/rules/${id}/versions`);
  const versions: RuleVersionRow[] = Array.isArray(body) ? body : body.data;
  return versions.reduce((a, b) => (b.version > a.version ? b : a));
}

/** A rule an earlier run of the end-to-end scenario took into review (a re-run on the same stack). */
function enteredReview(detail: any): boolean {
  return detail.status === 'in_review' || (detail.approvalHistory ?? []).some((r: any) => r.decision === 'approve');
}

function checksOf(detail: any): Record<string, RuleCheck> {
  return Object.fromEntries((detail.checks as RuleCheck[]).map((c) => [c.id, c]));
}

function censoringWhy(op: OperationDescriptor): string {
  return op.parameters.find((p) => p.key === 'censoringSubstitution')?.help?.why ?? '';
}

test.describe.configure({ mode: 'serial' });

test.describe('AXI-1771 — delta, stratify, join, cutoff, screen and split guidance content @SI-017', () => {
  test('AC FR1 FR2 FR5 NFR8 — GET /rule-runs/operations projects complete guidance and help for all 13 operations; enum labels match exactly; censoring help is true per family @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const byId = await operations(request, headers);

    const gaps: Record<string, string[]> = {};
    for (const operationId of STORY_OPERATION_IDS) {
      const op = byId.get(operationId);
      expect(op, `${operationId} is served by the operations endpoint`).toBeDefined();
      const opGaps = operationGaps(op!);
      if (opGaps.length) gaps[operationId] = opGaps;
    }
    // One assertion over the whole family, so a failure names every gap at once.
    expect(gaps).toEqual({});

    // Delta's result-shape labels are served now (the front's OUTPUT_MODE_* maps were the only source).
    const outputMode = byId.get('delta.difference')!.parameters.find((p) => p.key === 'outputMode')!;
    expect(Object.keys(outputMode.help!.valueLabels ?? {}).sort()).toEqual(['annotate', 'delta_table']);

    // Delta APPLIES below-limit handling; stratify, cutoff, screen and split only record it.
    for (const id of DELTA_OPERATION_IDS) expect(censoringWhy(byId.get(id)!)).toContain('">200" with lod_over_2 becomes 100');
    for (const id of [STRATIFY_OPERATION_ID, ...SINGLE_CARRIER_OPERATION_IDS.filter((id) => id !== 'join.attach')]) {
      expect(censoringWhy(byId.get(id)!), `${id} censoring help`).toContain('does not rewrite values');
    }
    // The join declares no censoring parameter at all.
    expect(byId.get('join.attach')!.parameters.map((p) => p.key)).not.toContain('censoringSubstitution');
  });

  test('FR7 — every submittable operation the registry serves has complete guidance and field help @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const submittable = [...(await operations(request, headers)).values()].filter((op) =>
      SUBMITTABLE_RUN_KINDS.includes(op.runKind),
    );
    // Not an empty catalogue: at least this story's 13 plus the statistical and describe families.
    expect(submittable.length).toBeGreaterThanOrEqual(STORY_OPERATION_IDS.length + 21 + 5);
    const gaps: Record<string, string[]> = {};
    for (const op of submittable) {
      const opGaps = operationGaps(op);
      if (opGaps.length) gaps[op.operationId] = opGaps;
    }
    expect(gaps).toEqual({});
  });

  test('FR7 FR9 — every single-operation carrier (JOIN-01 and the seven STAT-* carriers) carries the registry guidance, authored claude, at checked @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const byId = await operations(request, headers);
    const rules = await catalog(request, headers);

    const gaps: Record<string, string[]> = {};
    for (const operationId of SINGLE_CARRIER_OPERATION_IDS) {
      const carrier = carrierOf(rules, operationId);
      const detail = await getJson(request, headers, `/api/v1/rules/${carrier.id}`);
      const failed = (detail.checks as RuleCheck[]).filter((c) => !c.passed).map((c) => `check ${c.id} failed`);
      const newest = await newestVersion(request, headers, carrier.id);
      const ruleGaps = [...failed];
      if (newest.version !== detail.version) ruleGaps.push(`newest version ${newest.version} != live ${detail.version}`);
      if (newest.authorKind !== 'claude') ruleGaps.push(`authorKind ${newest.authorKind}`);
      // Key-order-insensitive: a version's guidance round-trips through Postgres jsonb, which
      // reorders object keys, so a string comparison would report equal content as different.
      if (!isDeepStrictEqual(newest.guidance, byId.get(operationId)!.guidance)) {
        ruleGaps.push('guidance != registry guidance');
      }
      if (!enteredReview(detail) && detail.status !== 'checked') ruleGaps.push(`status ${detail.status}`);
      if (ruleGaps.length) gaps[carrier.code] = ruleGaps;
    }
    expect(gaps).toEqual({});
  });

  test('FR7 FR9 — the family carriers DELTA-01 and STRATIFY-01 now carry their family guidance, authored claude, at checked @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const byId = await operations(request, headers);
    const rules = await catalog(request, headers);

    for (const code of FAMILY_CARRIER_CODES) {
      const carrier = familyCarrier(rules, code);
      const detail = await getJson(request, headers, `/api/v1/rules/${carrier.id}`);
      const checks = checksOf(detail);
      expect(checks.guidance_complete?.passed, `${code} guidance_complete`).toBe(true);
      expect(checks.field_help_complete?.passed, `${code} field_help_complete`).toBe(true);
      expect((detail.checks as RuleCheck[]).filter((c) => !c.passed), `${code} failed checks`).toEqual([]);

      const newest = await newestVersion(request, headers, carrier.id);
      expect(newest.version, `${code} live version`).toBe(detail.version);
      expect(newest.authorKind, `${code} newest version author`).toBe('claude');
      expect(guidanceGaps(newest.guidance), `${code} guidance`).toEqual([]);
      if (!enteredReview(detail)) expect(detail.status, `${code} live status`).toBe('checked');
    }

    // STRATIFY has one operation: its carrier teaches exactly that operation's text.
    const stratify = await newestVersion(request, headers, familyCarrier(rules, 'STRATIFY-01').id);
    expect(stratify.guidance).toEqual(byId.get(STRATIFY_OPERATION_ID)!.guidance);
    // DELTA-01 runs any of the four formulas, so its family text names all four.
    const delta = await newestVersion(request, headers, familyCarrier(rules, 'DELTA-01').id);
    expect(delta.guidance!.whatItDoes).toMatch(/difference, ratio, log2 fold change or percent change/);
  });

  test('FR7 — no carrier of this story is served until a human approves it @SI-017', async ({ request }) => {
    const headers = await adminApi(request);
    const rules = await catalog(request, headers);
    const family = [
      ...SINGLE_CARRIER_OPERATION_IDS.map((id) => carrierOf(rules, id)),
      ...FAMILY_CARRIER_CODES.map((code) => familyCarrier(rules, code)),
    ];
    expect(family).toHaveLength(10);
    for (const rule of family) {
      const detail = await getJson(request, headers, `/api/v1/rules/${rule.id}`);
      const approvals = (detail.approvalHistory ?? []).filter((r: any) => r.decision === 'approve');
      if (approvals.length === 0) {
        expect(detail.servedVersion ?? null, `${rule.code} is not served without an approval`).toBeNull();
      } else {
        expect(approvals.map((r: any) => r.ruleVersion)).toContain(detail.servedVersion.version);
      }
    }
  });

  test('FR7 FR11 — end to end: a family carrier at checked → submit → the submitter is refused → a different rule:publish holder approves → the served version shows the guidance @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const world = await ReviewWorld.create();
    let approverApi: APIRequestContext | undefined;
    let approverId: string | undefined;
    try {
      // A system rule is approved only by a platform admin holding rule:publish, and not by
      // whoever submitted Claude-authored content: a SECOND platform admin, promoted for this
      // test and demoted again in `finally`.
      const publisherRole = await world.role('guidance-1771-approver', ['rule:read', 'rule:publish']);
      const actor = await world.actor('guidance-1771-approver', publisherRole);
      approverId = actor.userId;
      await send(world.admin, 'patch', `/api/v1/users/${actor.userId}`, { role: 'ADMIN' });
      const login = await apiRequest.newContext();
      const tokens = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: 'AXI1765-e2e-pw!' });
      await login.dispose();
      approverApi = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });

      // A family carrier first (the path this story opened), else any of this story's carriers.
      const rules = await catalog(request, headers);
      const candidates = [
        ...FAMILY_CARRIER_CODES.map((code) => familyCarrier(rules, code)),
        ...SINGLE_CARRIER_OPERATION_IDS.map((id) => carrierOf(rules, id)),
      ];
      let picked: CatalogRule | undefined;
      for (const rule of candidates) {
        if ((await getJson(request, headers, `/api/v1/rules/${rule.id}`)).status === 'checked') {
          picked = rule;
          break;
        }
      }
      expect(picked, 'at least one carrier of this story is still checked').toBeDefined();
      const rule = picked!;
      const before = await newestVersion(request, headers, rule.id);
      expect(before.authorKind).toBe('claude');

      const submitted = await send(world.admin, 'post', `/api/v1/rules/${rule.id}/submit-for-review`);
      expect(submitted.status).toBe('in_review');
      const inReview = await send(world.admin, 'get', `/api/v1/rules/${rule.id}`);
      const contentHash = inReview.review!.contentHash as string;

      // Claude-authored content is never approved by the person who submitted it.
      const refused = await world.admin.post(apiUrl(`/api/v1/rules/${rule.id}/approve`), {
        data: { note: 'self-approving Claude text', expectedContentHash: contentHash },
      });
      expect(refused.status()).toBe(403);
      expect(await refused.text()).toContain('SELF_APPROVAL_CLAUDE_AUTHORED');

      const approved = await send(approverApi, 'post', `/api/v1/rules/${rule.id}/approve`, {
        note: 'Read the guidance against the executor; accurate.',
        expectedContentHash: contentHash,
      });
      expect(approved.status).toBe('published');

      const after = await send(world.admin, 'get', `/api/v1/rules/${rule.id}`);
      expect(after.servedVersion?.version).toBe(after.version);
      expect(after.servedVersion?.contentHash).toBe(contentHash);
      const body = await getJson(request, headers, `/api/v1/rules/${rule.id}/versions`);
      const served = (Array.isArray(body) ? body : body.data).find((v: RuleVersionRow) => v.id === after.servedVersion.id);
      expect(served.guidance, `${rule.code} served version shows the guidance`).toEqual(before.guidance);
      expect(guidanceGaps(served.guidance)).toEqual([]);
      expect(served.authorKind).toBe('claude');
      expect(
        (after.approvalHistory ?? []).some((r: any) => r.decision === 'approve' && r.actorId === approverId),
      ).toBe(true);
    } finally {
      await approverApi?.dispose();
      if (approverId) await send(world.admin, 'patch', `/api/v1/users/${approverId}`, { role: 'USER' }).catch(() => undefined);
      await world.dispose();
    }
  });
});
