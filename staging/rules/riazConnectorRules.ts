/**
 * AXI-1565 (epic AXI-1555 — FR34) — the four SUMMARY **connector rules** the ten
 * descriptive Riaz questions cite, made visible to the Riaz tenant by
 * `stage:rules`.
 *
 * They are NOT authored here. Unlike every other rule in `riazRuleLibrary.ts`, a
 * connector carries an `operationId` + `parameterScheme` (AXI-1559) that the
 * public `POST /rules` DTO does not accept, and they ship as PUBLISHED SYSTEM
 * seeds (`apps/organization-service/src/rules/seed-rules.ts`) so every
 * environment has the identical four. Re-authoring them from the staging repo
 * would create a second, drifting definition of a governed rule — the exact
 * thing `ensureRule`'s "bump the code, never re-version" rule exists to prevent.
 *
 * What `stage:rules` therefore does is the only thing that is the tenant's
 * business: prove each connector exists, is published, binds the operation it
 * should, and is ENTITLED to the Riaz organization — granting it when the org
 * runs `CUSTOM` rule access, and reporting honestly when it runs `NONE`.
 * Idempotent: a second run reports `visible` and writes nothing.
 */
import type { RestClient } from '../client/RestClient';
import { ADMIN_HANDLE } from '../steps/context';
import { asList, must, type RuleRow } from './ensureRule';

/** The four codes, with the describe operation each one binds (AXI-1559 seeds). */
export const RIAZ_CONNECTORS: ReadonlyArray<{ code: string; operationId: string }> = Object.freeze([
  { code: 'SUM-RANK-01', operationId: 'describe.grouped_aggregate' },
  { code: 'SUM-CROSS-01', operationId: 'describe.grouped_aggregate' },
  { code: 'SUM-COUNT-01', operationId: 'describe.count' },
  { code: 'SUM-TOPN-01', operationId: 'describe.top_n' },
]);

export type ConnectorAction = 'visible' | 'granted' | 'would-grant' | 'missing' | 'unentitled';

export interface ConnectorReport {
  code: string;
  ruleId: string | null;
  version: number | null;
  scope: string | null;
  operationId: string | null;
  action: ConnectorAction;
  problems: string[];
}

export interface RuleDetail extends RuleRow {
  connector?: { operationId?: string; parameterScheme?: Record<string, unknown> } | null;
  tags?: string[];
}

interface AccessConfig {
  mode?: string;
  grants?: Array<{ ruleId: string }>;
}

/** `ALL` needs no grant; `CUSTOM` needs one per rule; `NONE` cannot be fixed by a grant. */
export function needsGrant(mode: string | undefined, granted: boolean): boolean {
  return (mode ?? 'ALL').toUpperCase() === 'CUSTOM' && !granted;
}

export function isEntitled(mode: string | undefined, granted: boolean): boolean {
  const m = (mode ?? 'ALL').toUpperCase();
  if (m === 'ALL') return true;
  if (m === 'NONE') return false;
  return granted;
}

/** The problems a connector read reveals, as sentences a reader can act on. */
export function connectorProblems(code: string, expectedOperationId: string, rule: RuleDetail | undefined, mode: string | undefined): string[] {
  if (!rule) return [`${code} is not published on this stack — the AXI-1559 system seed has not run (restart the organization-service, or re-seed)`];
  const problems: string[] = [];
  if (rule.status !== 'published') problems.push(`${code} is ${rule.status}, not published`);
  const bound = rule.connector?.operationId ?? null;
  if (bound !== expectedOperationId) problems.push(`${code} binds operation ${bound ?? 'none'}, expected ${expectedOperationId}`);
  if ((mode ?? 'ALL').toUpperCase() === 'NONE') problems.push(`the organization's rule access mode is NONE — no grant can make ${code} visible`);
  return problems;
}

async function readAccess(client: RestClient, organizationId: string): Promise<AccessConfig> {
  const res = await client.as<AccessConfig>(ADMIN_HANDLE, 'GET', `/api/v1/organizations/${organizationId}/rule-access`);
  return res.ok && res.body ? res.body : {};
}

async function readConnector(client: RestClient, code: string): Promise<RuleDetail | undefined> {
  const listed = asList<RuleRow>(must(await client.as<unknown>(ADMIN_HANDLE, 'GET', `/api/v1/rules?search=${encodeURIComponent(code)}&limit=50`), `listing ${code}`))
    .filter((r) => r.code === code && r.status === 'published')
    .sort((a, b) => b.version - a.version);
  if (!listed[0]) return undefined;
  const res = await client.as<RuleDetail>(ADMIN_HANDLE, 'GET', `/api/v1/rules/${listed[0].id}`);
  return res.ok && res.body ? res.body : (listed[0] as RuleDetail);
}

async function grant(client: RestClient, ruleId: string, organizationId: string, performedBy: string): Promise<void> {
  must(
    await client.as<unknown>(ADMIN_HANDLE, 'POST', '/api/v1/rule-access/bulk', { ruleIds: [ruleId], organizationIds: [organizationId], action: 'GRANT', performedBy }),
    `granting rule ${ruleId} to organization ${organizationId}`,
  );
}

export interface EnsureConnectorsOptions {
  log?: (msg: string) => void;
  dryRun?: boolean;
}

/** FR34 — the four connectors, proved present and entitled for the Riaz tenant. */
export async function ensureConnectorsVisible(
  client: RestClient,
  tenant: { organizationId: string | null },
  opts: EnsureConnectorsOptions = {},
): Promise<ConnectorReport[]> {
  const log = opts.log ?? (() => undefined);
  const access = tenant.organizationId ? await readAccess(client, tenant.organizationId) : {};
  const grantedIds = new Set((access.grants ?? []).map((g) => g.ruleId));
  const performedBy = must(await client.as<{ id: string }>(ADMIN_HANDLE, 'GET', '/api/v1/auth/me'), 'resolving the admin user').id;
  const reports: ConnectorReport[] = [];
  for (const { code, operationId } of RIAZ_CONNECTORS) {
    reports.push(await ensureOne(client, { code, operationId, organizationId: tenant.organizationId, mode: access.mode, performedBy }, grantedIds, log, opts.dryRun === true));
  }
  return reports;
}

interface EnsureOneInput {
  code: string;
  operationId: string;
  organizationId: string | null;
  mode: string | undefined;
  performedBy: string;
}

async function ensureOne(
  client: RestClient,
  input: EnsureOneInput,
  grantedIds: Set<string>,
  log: (msg: string) => void,
  dryRun: boolean,
): Promise<ConnectorReport> {
  const { code, operationId, organizationId, mode } = input;
  const rule = await readConnector(client, code);
  const problems = connectorProblems(code, operationId, rule, mode);
  const base: ConnectorReport = { code, ruleId: rule?.id ?? null, version: rule?.version ?? null, scope: rule?.scope ?? null, operationId: rule?.connector?.operationId ?? null, action: 'missing', problems };
  if (!rule || problems.length) return { ...base, action: rule ? 'unentitled' : 'missing' };
  const granted = grantedIds.has(rule.id);
  if (!needsGrant(mode, granted)) {
    log(`connector ${code} v${rule.version} visible to the tenant (${(mode ?? 'ALL').toUpperCase()} rule access)`);
    return { ...base, action: isEntitled(mode, granted) ? 'visible' : 'unentitled' };
  }
  if (dryRun) return { ...base, action: 'would-grant' };
  await grant(client, rule.id, organizationId as string, input.performedBy);
  log(`granted connector ${code} v${rule.version} to organization ${organizationId}`);
  return { ...base, action: 'granted' };
}

/**
 * AXI-1565 — the three DESCRIBE **carrier** rules (AXI-1556's
 * `axiome-back/scripts/create-describe-rules.ts`). A connector rule says WHICH
 * describe operation to run and with what parameters; the carrier is the
 * SYSTEM rule the run itself cites — `RuleRunsAnalysisRunner.resolveRuleId`
 * resolves it by the `op:<operationId>` tag, not by code, and a describe node
 * whose operation has no carrier fails at submit with "no seeded system rule
 * for <operationId>". Entitlement never enters into it (system scope), so the
 * only thing `stage:rules` can do is prove they are there and name the remedy
 * when they are not — which is exactly what made the first live Q12 run fail
 * on this stack.
 */
export const DESCRIBE_CARRIERS: ReadonlyArray<{ code: string; operationId: string }> = Object.freeze([
  { code: 'DESC-GROUPED-AGGREGATE', operationId: 'describe.grouped_aggregate' },
  { code: 'DESC-COUNT', operationId: 'describe.count' },
  { code: 'DESC-TOP-N', operationId: 'describe.top_n' },
]);

const REMEDY = 'seed it with `npx tsx scripts/create-describe-rules.ts` in axiome-back (idempotent, API-only)';

/** The published rule that carries `operationId`, resolved the way the runner resolves it: by tag. */
export function findCarrier(rules: readonly RuleDetail[], operationId: string): RuleDetail | undefined {
  return rules
    .filter((r) => r.status === 'published' && (r.tags ?? []).includes(`op:${operationId}`))
    .sort((a, b) => b.version - a.version)[0];
}

export function carrierProblems(code: string, operationId: string, rule: RuleDetail | undefined): string[] {
  if (!rule) return [`no published rule tagged op:${operationId} — describe runs citing ${code} cannot resolve a ruleId; ${REMEDY}`];
  return [];
}

/** FR34 — the carrier rules Q12–Q21's describe nodes need, proved present. */
export async function checkDescribeCarriers(client: RestClient, opts: EnsureConnectorsOptions = {}): Promise<ConnectorReport[]> {
  const log = opts.log ?? (() => undefined);
  const rules = asList<RuleDetail>(must(await client.as<unknown>(ADMIN_HANDLE, 'GET', '/api/v1/rules?limit=500'), 'listing rules for the describe carriers'));
  return DESCRIBE_CARRIERS.map(({ code, operationId }) => {
    const rule = findCarrier(rules, operationId);
    const problems = carrierProblems(code, operationId, rule);
    if (!problems.length) log(`carrier ${rule?.code ?? code} v${rule?.version ?? '?'} resolves op:${operationId}`);
    return { code, ruleId: rule?.id ?? null, version: rule?.version ?? null, scope: rule?.scope ?? null, operationId: rule ? operationId : null, action: (problems.length ? 'missing' : 'visible') as ConnectorAction, problems };
  });
}
