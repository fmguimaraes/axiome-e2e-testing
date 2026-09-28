import { APIRequestContext, test, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';
import { ReviewWorld, send } from './AXI-1765-rule-review-fixtures';

/**
 * AXI-1769 (epic AXI-1762 — FR1, FR2, FR5, FR7, FR9, FR11, NFR8; SI-017):
 * guidance content for the 21 statistical tests.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §11.
 *
 * Read from the REAL shared kernel registry and the REAL boot seeding — never
 * a hand-built fixture:
 *   1. `GET /rule-runs/operations` projects complete guidance and field help
 *      for every statistical test (AC2 — every parameter, column role and enum
 *      value, within the NFR8 bounds).
 *   2. Since AXI-1768 boot seeds carriers into the lifecycle, never
 *      `published`: each statistical carrier carries exactly the registry
 *      guidance, is authored `claude`, and passes FR9, so it lands `checked`
 *      (AC1).
 *   3. Nothing is served before a human approves it (FR7).
 *   4. The whole path end to end: checked → submit-for-review → in_review →
 *      the submitter may NOT approve Claude-authored content → a DIFFERENT
 *      `rule:publish` holder approves → the served version carries the
 *      guidance.
 *
 * Serial: scenario 4 moves one carrier, and 2/3 read all of them. On a re-run
 * against the same stack, 2/3 accept a carrier an earlier run took through
 * review, and 4 picks a carrier still at `checked`.
 *
 * The family list is restated here on purpose: a spec that derived it from the
 * endpoint would pass on an empty catalogue.
 */

const STATISTICAL_TEST_OPERATION_IDS = [
  'stats.paired_ttest',
  'stats.wilcoxon_signed_rank',
  'stats.unpaired_ttest',
  'stats.mann_whitney_u',
  'stats.kruskal_wallis',
  'stats.one_way_anova',
  'stats.correlation',
  'stats.correlation_trimmed',
  'stats.chi_square',
  'stats.fisher_exact',
  'stats.kaplan_meier',
  'stats.log_rank',
  'stats.cox_proportional_hazards',
  'stats.deseq2_differential_expression',
  'stats.differential_abundance',
  'stats.alpha_diversity',
  'stats.permanova',
  'stats.anosim',
  'stats.permdisp',
  'stats.linear_mixed_model',
  'stats.site_batch_variance_test',
] as const;

interface HelpBlock {
  label: string;
  what: string;
  why: string;
  example: string;
  valueLabels: Record<string, string> | null;
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
  snapshot: { checks?: RuleCheck[] };
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Every way a projected descriptor falls short of FR1/FR2/NFR8 — empty when complete. */
function gapsOf(op: OperationDescriptor): string[] {
  const gaps: string[] = [];
  const g = op.guidance;
  if (!g) {
    gaps.push('guidance null');
  } else {
    for (const field of ['whatItDoes', 'whenToUse', 'whenNotToUse', 'example', 'youWillGet'] as const) {
      if (!nonEmpty(g[field])) gaps.push(`guidance.${field} empty`);
    }
    if (g.whatItDoes.length > 200) gaps.push('guidance.whatItDoes > 200');
    if (g.example.length > 120) gaps.push('guidance.example > 120');
  }
  const help = (prefix: string, h: HelpBlock | null, allowed?: string[] | null) => {
    if (!h) return gaps.push(`${prefix}.help null`);
    for (const field of ['label', 'what', 'why', 'example'] as const) {
      if (!nonEmpty(h[field])) gaps.push(`${prefix}.help.${field} empty`);
    }
    if (h.what.length > 160) gaps.push(`${prefix}.help.what > 160`);
    if (h.why.length > 160) gaps.push(`${prefix}.help.why > 160`);
    if (h.example.length > 120) gaps.push(`${prefix}.help.example > 120`);
    for (const value of allowed ?? []) {
      if (!nonEmpty(h.valueLabels?.[value])) gaps.push(`${prefix}.help.valueLabels.${value} missing`);
    }
    return gaps.length;
  };
  for (const p of op.parameters) help(`parameters.${p.key}`, p.help, p.allowedValues);
  for (const r of op.columnRoles) help(`columnRoles.${r.role}`, r.help);
  return gaps;
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

type CatalogRule = { id: string; code: string; tags: string[] | null };

async function statisticalCarriers(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<Array<{ operationId: string; carrier: CatalogRule }>> {
  const catalog: CatalogRule[] = (await getJson(request, headers, '/api/v1/rules?limit=200')).data;
  return STATISTICAL_TEST_OPERATION_IDS.map((operationId) => {
    const carrier = catalog.find((rule) => (rule.tags ?? []).includes(`op:${operationId}`));
    expect(carrier, `${operationId} has a carrier rule`).toBeDefined();
    return { operationId, carrier: carrier! };
  });
}

async function versionsOf(request: APIRequestContext, headers: Record<string, string>, id: string): Promise<RuleVersionRow[]> {
  const body = await getJson(request, headers, `/api/v1/rules/${id}/versions`);
  return Array.isArray(body) ? body : body.data;
}

/** A carrier an earlier run of scenario 4 took into review (a re-run on the same stack). */
function enteredReview(detail: any): boolean {
  return detail.status === 'in_review' || (detail.approvalHistory ?? []).some((r: any) => r.decision === 'approve');
}

test.describe.configure({ mode: 'serial' });

test.describe('AXI-1769 — statistical-test guidance content @SI-017', () => {
  test('AC2 — GET /rule-runs/operations projects complete guidance and help for all 21 statistical tests @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const body = await getJson(request, headers, '/api/v1/rule-runs/operations');
    const byId = new Map<string, OperationDescriptor>(
      (body.operations as OperationDescriptor[]).map((op) => [op.operationId, op]),
    );

    const gaps: Record<string, string[]> = {};
    for (const operationId of STATISTICAL_TEST_OPERATION_IDS) {
      const op = byId.get(operationId);
      expect(op, `${operationId} is served by the operations endpoint`).toBeDefined();
      const opGaps = gapsOf(op!);
      if (opGaps.length) gaps[operationId] = opGaps;
    }
    // One assertion over the whole family, so a failure names every gap at once.
    expect(gaps).toEqual({});
  });

  test('AC1 — every statistical carrier carries the registry guidance, authored claude, and FR9 puts it at checked @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const operations: OperationDescriptor[] = (await getJson(request, headers, '/api/v1/rule-runs/operations'))
      .operations;

    for (const { operationId, carrier } of await statisticalCarriers(request, headers)) {
      const detail = await getJson(request, headers, `/api/v1/rules/${carrier.id}`);
      const byCheck = Object.fromEntries((detail.checks as RuleCheck[]).map((c) => [c.id, c]));
      expect(byCheck.guidance_complete?.passed, `${carrier.code} guidance_complete`).toBe(true);
      expect(byCheck.field_help_complete?.passed, `${carrier.code} field_help_complete`).toBe(true);

      const versions = await versionsOf(request, headers, carrier.id);
      const newest = versions.reduce((a, b) => (b.version > a.version ? b : a));
      expect(newest.version, `${carrier.code} live version`).toBe(detail.version);
      expect(newest.authorKind, `${carrier.code} newest version author`).toBe('claude');
      const registryGuidance = operations.find((op) => op.operationId === operationId)!.guidance;
      expect(newest.guidance, `${carrier.code} carries the registry guidance`).toEqual(registryGuidance);
      if (!enteredReview(detail)) {
        // FR9 decides: complete content lands `checked` — submittable, never `published`.
        expect(detail.status, `${carrier.code} live status`).toBe('checked');
        expect(newest.status, `${carrier.code} newest version status`).toBe('checked');
      }
    }
  });

  test('FR7 — no statistical carrier is served until a human approves it @SI-017', async ({ request }) => {
    const headers = await adminApi(request);
    for (const { carrier } of await statisticalCarriers(request, headers)) {
      const detail = await getJson(request, headers, `/api/v1/rules/${carrier.id}`);
      const approvals = (detail.approvalHistory ?? []).filter((r: any) => r.decision === 'approve');
      if (approvals.length === 0) {
        expect(detail.servedVersion ?? null, `${carrier.code} is not served without an approval`).toBeNull();
      } else {
        // Served ⇒ approved: the served version is one an approval record names.
        expect(approvals.map((r: any) => r.ruleVersion)).toContain(detail.servedVersion.version);
      }
    }
  });

  test('AC1 FR11 — end to end: checked → submit → in_review → a different rule:publish holder approves → the served version shows the guidance @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const world = await ReviewWorld.create();
    let approverApi: APIRequestContext | undefined;
    let approverId: string | undefined;
    try {
      // A system rule is approved only by a platform admin holding rule:publish,
      // and not by whoever submitted Claude-authored content: so a SECOND platform
      // admin, promoted for this test and demoted again in `finally` (other specs
      // assume the bootstrap admin is the only platform approver).
      const publisherRole = await world.role('stats-approver', ['rule:read', 'rule:publish']);
      const actor = await world.actor('stats-approver', publisherRole);
      approverId = actor.userId;
      await send(world.admin, 'patch', `/api/v1/users/${actor.userId}`, { role: 'ADMIN' });
      const login = await apiRequest.newContext();
      const tokens = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: 'AXI1765-e2e-pw!' });
      await login.dispose();
      approverApi = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
      const approver = { userId: actor.userId, api: approverApi };

      let picked: { operationId: string; carrier: CatalogRule } | undefined;
      for (const entry of await statisticalCarriers(request, headers)) {
        if ((await getJson(request, headers, `/api/v1/rules/${entry.carrier.id}`)).status === 'checked') {
          picked = entry;
          break;
        }
      }
      expect(picked, 'at least one statistical carrier is still checked').toBeDefined();
      const { operationId, carrier } = picked!;

      // The platform admin submits it for review.
      const submitted = await send(world.admin, 'post', `/api/v1/rules/${carrier.id}/submit-for-review`);
      expect(submitted.status).toBe('in_review');

      const inReview = await send(world.admin, 'get', `/api/v1/rules/${carrier.id}`);
      const contentHash = inReview.review!.contentHash as string;

      // Claude-authored content is never approved by the person who submitted it.
      const refused = await world.admin.post(apiUrl(`/api/v1/rules/${carrier.id}/approve`), {
        data: { note: 'self-approving Claude text', expectedContentHash: contentHash },
      });
      expect(refused.status()).toBe(403);
      expect(await refused.text()).toContain('SELF_APPROVAL_CLAUDE_AUTHORED');

      // A different rule:publish holder approves the exact content they read.
      const approved = await send(approver.api, 'post', `/api/v1/rules/${carrier.id}/approve`, {
        note: 'Read the guidance against the executor; accurate.',
        expectedContentHash: contentHash,
      });
      expect(approved.status).toBe('published');

      const after = await send(world.admin, 'get', `/api/v1/rules/${carrier.id}`);
      expect(after.servedVersion?.version).toBe(after.version);
      expect(after.servedVersion?.contentHash).toBe(contentHash);
      const served = (await versionsOf(request, headers, carrier.id)).find((v) => v.id === after.servedVersion.id)!;
      const registryGuidance = (await getJson(request, headers, '/api/v1/rule-runs/operations')).operations.find(
        (op: OperationDescriptor) => op.operationId === operationId,
      ).guidance;
      expect(served.guidance, `${carrier.code} served version shows the guidance`).toEqual(registryGuidance);
      expect(served.authorKind).toBe('claude');
      expect(
        (after.approvalHistory ?? []).some((r: any) => r.decision === 'approve' && r.actorId === approver.userId),
      ).toBe(true);
    } finally {
      await approverApi?.dispose();
      if (approverId) await send(world.admin, 'patch', `/api/v1/users/${approverId}`, { role: 'USER' }).catch(() => undefined);
      await world.dispose();
    }
  });
});
