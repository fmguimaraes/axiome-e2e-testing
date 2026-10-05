import { APIRequestContext, test, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';
import { ReviewWorld, send } from './AXI-1765-rule-review-fixtures';
import { systemRuleCatalogue } from './seeded-rule-approval';

/**
 * AXI-1770 (epic AXI-1762 — FR1, FR2, FR3, FR5, FR7, FR9, NFR8; SI-017):
 * guidance content for the describe operations, the summary connectors and the
 * seeded QC rules.
 *
 * Scenario doc: manual-e2e/AXI-1762-Guided-Rule-Launch.md §13.
 *
 * Read from the REAL shared kernel registry and the REAL boot seeding — never a
 * hand-built fixture:
 *   1. `GET /rule-runs/operations` projects complete guidance and field help for
 *      the five describe operations (AC2).
 *   2. Each DESC-* carrier carries exactly the registry guidance, authored
 *      `claude`, and FR9 puts it at `checked` (AC1).
 *   3. Each SUM-* connector carries complete guidance, authored `claude`, help on
 *      EVERY connector slot (enum labels matching the enum exactly), passes every
 *      FR9 check and lands `checked` (AC1).
 *   4. Each seeded QC rule carries complete guidance authored `claude` and passes
 *      the two guidance checks; the only FR9 check it may fail is the
 *      PRE-EXISTING `protocol_compliance` gap (QC seeds declare no
 *      `qc_include`/`qc_fail_reasons` output fields), never a guidance one.
 *   5. Nothing in the family is served before a human approves it (FR7).
 *   6. End to end on one SUM connector: checked → submit → in_review → the
 *      submitter may NOT approve Claude-authored content → a DIFFERENT
 *      `rule:publish` holder approves → the served version carries the guidance
 *      and the connector help.
 *
 * Serial: scenario 6 moves one connector, and 2–5 read all of them. On a re-run
 * against the same stack, 2/3 accept a rule an earlier run took through review,
 * and 6 picks a connector still at `checked`.
 *
 * The family lists are restated on purpose: a spec that derived them from the
 * endpoint would pass on an empty catalogue.
 */

const DESCRIBE_OPERATION_IDS = [
  'describe.grouped_aggregate',
  'describe.count',
  'describe.top_n',
  'describe.subject_coverage',
  'describe.below_limit_count',
] as const;

const SUMMARY_CONNECTOR_CODES = [
  'SUM-RANK-01',
  'SUM-RANK-MEDIAN-01',
  'SUM-SPREAD-01',
  'SUM-CROSS-01',
  'SUM-COUNT-01',
  'SUM-CROSS-COUNT-01',
  'SUM-TOPN-01',
  'SUM-TOPN-FILTERED-01',
  'SUM-EXTREMES-01',
  'SUM-EXPR-RANK-01',
] as const;

const QC_RULE_CODES = [
  'IMM-QC-01',
  'IMM-QC-02',
  'IMM-QC-03',
  'IMM-QC-05',
  'IMM-QC-06',
  'IMM-QC-10',
  'IMM-QC-11',
  'IMM-QC-12',
  'IMM-SAFE-01',
  'IMM-SAFE-02',
  'IMM-CMP-01',
  'IMM-CMP-02',
  'IMM-CMP-03',
  'IMM-CMP-04',
  'IMM-CMP-05',
  'IMM-CMP-06',
  'IMM-CMP-07',
  'IMM-CMP-08',
  'IMM-CMP-09',
  'IMM-CMP-10',
  'IMM-CMP-11',
  'IMM-CMP-12',
  'IMM-CMP-13',
  'IMM-CMP-14',
] as const;

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
  guidance: Guidance | null;
  parameters: Array<{ key: string; allowedValues?: string[] | null; help: HelpBlock | null }>;
  columnRoles: Array<{ role: string; help: HelpBlock | null }>;
}

interface RuleCheck {
  id: string;
  passed: boolean;
  message: string;
}

interface ConnectorSlot {
  kind: string;
  enum?: string[];
  help?: HelpBlock;
}

interface RuleVersionRow {
  id: string;
  version: number;
  status: string;
  guidance: Guidance | null;
  authorKind: string | null;
  connector: { operationId: string; parameterScheme: Record<string, ConnectorSlot> } | null;
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

function helpGaps(prefix: string, h: HelpBlock | null | undefined, allowed?: string[] | null): string[] {
  if (!h) return [`${prefix}.help null`];
  const gaps: string[] = [];
  for (const field of ['label', 'what', 'why', 'example'] as const) {
    if (!nonEmpty(h[field])) gaps.push(`${prefix}.help.${field} empty`);
  }
  if (h.what.length > 160) gaps.push(`${prefix}.help.what > 160`);
  if (h.why.length > 160) gaps.push(`${prefix}.help.why > 160`);
  if (h.example.length > 120) gaps.push(`${prefix}.help.example > 120`);
  for (const value of allowed ?? []) {
    if (!nonEmpty(h.valueLabels?.[value])) gaps.push(`${prefix}.help.valueLabels.${value} missing`);
  }
  return gaps;
}

/** A connector's slots all carry help; enum labels name exactly the enum's values. */
function connectorGaps(connector: RuleVersionRow['connector']): string[] {
  if (!connector) return ['connector null'];
  const gaps: string[] = [];
  for (const [key, slot] of Object.entries(connector.parameterScheme)) {
    gaps.push(...helpGaps(`connector.${key}`, slot.help, slot.enum));
    const labelled = Object.keys(slot.help?.valueLabels ?? {}).sort();
    const declared = [...(slot.enum ?? [])].sort();
    if (JSON.stringify(labelled) !== JSON.stringify(declared)) {
      gaps.push(`connector.${key}.help.valueLabels ${JSON.stringify(labelled)} != enum ${JSON.stringify(declared)}`);
    }
  }
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

async function catalog(request: APIRequestContext, headers: Record<string, string>): Promise<CatalogRule[]> {
  // AXI-1809 (AXI-1822): the whole SYSTEM catalogue, every page — fixture rules pushed IMM-QC-01 off page one.
  return systemRuleCatalogue((path) => getJson(request, headers, path));
}

async function byCode(
  request: APIRequestContext,
  headers: Record<string, string>,
  codes: readonly string[],
): Promise<CatalogRule[]> {
  const rules = await catalog(request, headers);
  return codes.map((code) => {
    const rule = rules.find((r) => r.code === code);
    expect(rule, `${code} is seeded`).toBeDefined();
    return rule!;
  });
}

async function newestVersion(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
): Promise<RuleVersionRow> {
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

test.describe.configure({ mode: 'serial' });

test.describe('AXI-1770 — describe, summary connector and QC rule guidance content @SI-017', () => {
  test('AC2 — GET /rule-runs/operations projects complete guidance and help for all 5 describe operations @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const body = await getJson(request, headers, '/api/v1/rule-runs/operations');
    const byId = new Map<string, OperationDescriptor>(
      (body.operations as OperationDescriptor[]).map((op) => [op.operationId, op]),
    );

    const gaps: Record<string, string[]> = {};
    for (const operationId of DESCRIBE_OPERATION_IDS) {
      const op = byId.get(operationId);
      expect(op, `${operationId} is served by the operations endpoint`).toBeDefined();
      const opGaps = [
        ...guidanceGaps(op!.guidance),
        ...op!.parameters.flatMap((p) => helpGaps(`parameters.${p.key}`, p.help, p.allowedValues)),
        ...op!.columnRoles.flatMap((r) => helpGaps(`columnRoles.${r.role}`, r.help)),
      ];
      if (opGaps.length) gaps[operationId] = opGaps;
    }
    // One assertion over the whole family, so a failure names every gap at once.
    expect(gaps).toEqual({});
  });

  test('AC1 FR7 — every DESC-* carrier carries the registry guidance, authored claude, and FR9 puts it at checked @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const operations: OperationDescriptor[] = (await getJson(request, headers, '/api/v1/rule-runs/operations'))
      .operations;
    const rules = await catalog(request, headers);

    for (const operationId of DESCRIBE_OPERATION_IDS) {
      const carrier = rules.find((r) => (r.tags ?? []).includes(`op:${operationId}`));
      expect(carrier, `${operationId} has a carrier rule`).toBeDefined();
      const detail = await getJson(request, headers, `/api/v1/rules/${carrier!.id}`);
      const checks = checksOf(detail);
      expect(checks.guidance_complete?.passed, `${carrier!.code} guidance_complete`).toBe(true);
      expect(checks.field_help_complete?.passed, `${carrier!.code} field_help_complete`).toBe(true);

      const newest = await newestVersion(request, headers, carrier!.id);
      expect(newest.version, `${carrier!.code} live version`).toBe(detail.version);
      expect(newest.authorKind, `${carrier!.code} newest version author`).toBe('claude');
      const registryGuidance = operations.find((op) => op.operationId === operationId)!.guidance;
      expect(newest.guidance, `${carrier!.code} carries the registry guidance`).toEqual(registryGuidance);
      if (!enteredReview(detail)) {
        expect(detail.status, `${carrier!.code} live status`).toBe('checked');
      }
    }
  });

  test('AC1 FR3 — every SUM-* connector carries complete guidance and help on every slot, authored claude, passes every FR9 check and lands checked @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const gaps: Record<string, string[]> = {};
    for (const rule of await byCode(request, headers, SUMMARY_CONNECTOR_CODES)) {
      const detail = await getJson(request, headers, `/api/v1/rules/${rule.id}`);
      const failed = (detail.checks as RuleCheck[]).filter((c) => !c.passed).map((c) => `check ${c.id} failed`);

      const newest = await newestVersion(request, headers, rule.id);
      const ruleGaps = [...failed, ...guidanceGaps(newest.guidance), ...connectorGaps(newest.connector)];
      if (newest.version !== detail.version) ruleGaps.push(`newest version ${newest.version} != live ${detail.version}`);
      if (newest.authorKind !== 'claude') ruleGaps.push(`authorKind ${newest.authorKind}`);
      // The live rule's connector is the one the newest version carries: help reached the row too.
      if (JSON.stringify(detail.connector) !== JSON.stringify(newest.connector)) ruleGaps.push('row connector != version');
      if (!enteredReview(detail) && detail.status !== 'checked') ruleGaps.push(`status ${detail.status}`);
      if (ruleGaps.length) gaps[rule.code] = ruleGaps;
    }
    expect(gaps).toEqual({});
  });

  test('AC1 — every seeded QC rule carries complete guidance authored claude; no guidance check fails, only the pre-existing protocol_compliance gap may @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const gaps: Record<string, string[]> = {};
    for (const rule of await byCode(request, headers, QC_RULE_CODES)) {
      const detail = await getJson(request, headers, `/api/v1/rules/${rule.id}`);
      const checks = checksOf(detail);
      const ruleGaps: string[] = [];
      if (checks.guidance_complete?.passed !== true) ruleGaps.push('guidance_complete not passed');
      if (checks.field_help_complete?.passed !== true) ruleGaps.push('field_help_complete not passed');
      const otherFailures = Object.values(checks)
        .filter((c) => !c.passed && c.id !== 'protocol_compliance')
        .map((c) => `check ${c.id} failed`);
      ruleGaps.push(...otherFailures);

      const newest = await newestVersion(request, headers, rule.id);
      ruleGaps.push(...guidanceGaps(newest.guidance));
      if (newest.version !== detail.version) ruleGaps.push(`newest version ${newest.version} != live ${detail.version}`);
      if (newest.authorKind !== 'claude') ruleGaps.push(`authorKind ${newest.authorKind}`);
      if (newest.status === 'published') ruleGaps.push('newest version published by boot');
      if (ruleGaps.length) gaps[rule.code] = ruleGaps;
    }
    expect(gaps).toEqual({});
  });

  test('FR7 — no describe carrier, summary connector or QC rule is served until a human approves it @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const rules = await catalog(request, headers);
    const family = rules.filter(
      (r) =>
        (SUMMARY_CONNECTOR_CODES as readonly string[]).includes(r.code) ||
        (QC_RULE_CODES as readonly string[]).includes(r.code) ||
        DESCRIBE_OPERATION_IDS.some((id) => (r.tags ?? []).includes(`op:${id}`)),
    );
    expect(family).toHaveLength(SUMMARY_CONNECTOR_CODES.length + QC_RULE_CODES.length + DESCRIBE_OPERATION_IDS.length);
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

  test('AC1 FR11 — end to end: a SUM connector at checked → submit → a different rule:publish holder approves → the served version shows its guidance and connector help @SI-017', async ({
    request,
  }) => {
    const headers = await adminApi(request);
    const world = await ReviewWorld.create();
    let approverApi: APIRequestContext | undefined;
    let approverId: string | undefined;
    try {
      // A system rule is approved only by a platform admin holding rule:publish,
      // and not by whoever submitted Claude-authored content: a SECOND platform
      // admin, promoted for this test and demoted again in `finally`.
      const publisherRole = await world.role('sum-approver', ['rule:read', 'rule:publish']);
      const actor = await world.actor('sum-approver', publisherRole);
      approverId = actor.userId;
      await send(world.admin, 'patch', `/api/v1/users/${actor.userId}`, { role: 'ADMIN' });
      const login = await apiRequest.newContext();
      const tokens = await send(login, 'post', '/api/v1/auth/login', { email: actor.email, password: 'AXI1765-e2e-pw!' });
      await login.dispose();
      approverApi = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });

      let picked: CatalogRule | undefined;
      for (const rule of await byCode(request, headers, SUMMARY_CONNECTOR_CODES)) {
        if ((await getJson(request, headers, `/api/v1/rules/${rule.id}`)).status === 'checked') {
          picked = rule;
          break;
        }
      }
      expect(picked, 'at least one summary connector is still checked').toBeDefined();
      const rule = picked!;
      const before = await newestVersion(request, headers, rule.id);

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
        note: 'Read the guidance and connector help against the executor; accurate.',
        expectedContentHash: contentHash,
      });
      expect(approved.status).toBe('published');

      const after = await send(world.admin, 'get', `/api/v1/rules/${rule.id}`);
      expect(after.servedVersion?.version).toBe(after.version);
      expect(after.servedVersion?.contentHash).toBe(contentHash);
      const body = await getJson(request, headers, `/api/v1/rules/${rule.id}/versions`);
      const served = (Array.isArray(body) ? body : body.data).find((v: RuleVersionRow) => v.id === after.servedVersion.id);
      expect(served.guidance, `${rule.code} served version shows the guidance`).toEqual(before.guidance);
      expect(served.connector, `${rule.code} served version shows the connector help`).toEqual(before.connector);
      expect(connectorGaps(served.connector)).toEqual([]);
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
