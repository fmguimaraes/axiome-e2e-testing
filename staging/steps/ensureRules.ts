import { RestClient } from '../client/RestClient';
import { ensureIdentities } from '../identities/ensureIdentities';
import { checkProtocol } from '../rules/protocolBuilders';
import { RIAZ_RULE_LIBRARY, rulesForQuestion, type LibraryEntry } from '../rules/riazRuleLibrary';
import { ensureRule, type EnsureRuleAction } from '../rules/ensureRule';
import { checkDescribeCarriers, ensureConnectorsVisible, RIAZ_CONNECTORS, type ConnectorAction, type ConnectorReport } from '../rules/riazConnectorRules';
import { isDescribeQuestion } from './riazDescribeExpectations';
import { resolveTenant } from './stageRiazGuided';

/**
 * `npm run stage:rules` — publish the Riaz 2017 rule library (every protocol:
 * QC, FEATURE, SUMMARY, STRATIFY, INTERPRET, DECISION) onto the staged Riaz
 * project's tenant. Idempotent: published rules are reused, drafts are
 * re-authored + published, nothing is versioned up (bump the code instead).
 *
 *   npm run stage:rules                          # every rule in the library
 *   npm run stage:rules -- --list                # print the library, no HTTP
 *   npm run stage:rules -- --check               # offline protocol check only
 *   npm run stage:rules -- --dry-run             # resolve tenant, report, no writes
 *   npm run stage:rules -- --question Q4         # only what one question cites
 *   npm run stage:rules -- --codes A,B           # explicit codes
 *   npm run stage:rules -- --protocol FEATURE_RULE
 *   npm run stage:rules -- --json                # machine-readable summary on stdout
 *
 * Env: STAGING_BASE_URL (default http://localhost:3000), STAGING_ADMIN_EMAIL /
 * STAGING_ADMIN_PASSWORD (admin@axiome.local / admin), STAGING_RIAZ_WORKSPACE /
 * STAGING_RIAZ_PROJECT (the fixture names; `stage:riaz` must have run).
 */
interface Args { list: boolean; check: boolean; dryRun: boolean; json: boolean; question?: string; codes?: string[]; protocol?: string }

function parseArgs(argv: string[]): Args {
  const a: Args = { list: false, check: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    const next = () => inline ?? argv[++i];
    if (flag === '--list') a.list = true;
    else if (flag === '--check') a.check = true;
    else if (flag === '--dry-run') a.dryRun = true;
    else if (flag === '--json') a.json = true;
    else if (flag === '--question') a.question = next();
    else if (flag === '--codes') a.codes = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === '--protocol') a.protocol = next();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return a;
}

export function selectEntries(a: Pick<Args, 'question' | 'codes' | 'protocol'>): LibraryEntry[] {
  let entries = RIAZ_RULE_LIBRARY;
  if (a.question) entries = rulesForQuestion(a.question);
  if (a.codes) {
    const wanted = new Set(a.codes);
    const unknown = a.codes.filter((c) => !RIAZ_RULE_LIBRARY.some((e) => e.code === c));
    if (unknown.length) throw new Error(`not in the library: ${unknown.join(', ')}`);
    entries = entries.filter((e) => wanted.has(e.code));
  }
  if (a.protocol) entries = entries.filter((e) => e.protocol === a.protocol);
  return entries;
}

function log(msg: string): void {
  console.log(`[stage:rules] ${msg}`);
}

export interface RuleReport { code: string; protocol: string; executable: boolean; questions: string[]; action: EnsureRuleAction | ConnectorAction | 'checked' | 'invalid'; id?: string; version?: number; problems: string[] }

export async function ensureRules(client: RestClient | null, a: Args): Promise<RuleReport[]> {
  const entries = selectEntries(a);
  // Q12–Q21 cite the SUM-* connectors and no library rule, so an empty library
  // selection is legitimate for them — but only for them.
  if (entries.length === 0 && !isDescribeQuestion((a.question ?? '').toUpperCase())) throw new Error('nothing selected');
  const reports: RuleReport[] = entries.map((e) => ({ code: e.code, protocol: e.protocol, executable: e.executable, questions: e.questions, action: 'checked', problems: checkProtocol(e.make()) }));
  reports.filter((r) => r.problems.length).forEach((r) => (r.action = 'invalid'));
  if (a.list || a.check || !client) return reports;
  const invalid = reports.filter((r) => r.action === 'invalid');
  if (invalid.length) throw new Error(`protocol check failed:\n${invalid.flatMap((r) => r.problems).join('\n')}`);

  const tenant = await resolveTenant(client);
  log(`workspace ${tenant.workspaceId} / project ${tenant.projectId} / org ${tenant.organizationId ?? '(none → system scope)'}`);
  for (const [i, e] of entries.entries()) {
    const { row, action } = await ensureRule(client, e.make(), tenant, { log, dryRun: a.dryRun, justification: `Riaz 2017 rule library (${e.protocol}) — cited by ${e.questions.join(', ')} in axiome-docs/demo/riaz-2017/Riaz-Guided-Questions.md` });
    Object.assign(reports[i], { action, id: row.id || undefined, version: row.version || undefined });
  }
  reports.push(...(await connectorReports(client, tenant, a)));
  return reports;
}

/**
 * AXI-1565 (FR34) — the four SUM-* connector rules Q12–Q21 cite, reported in the
 * same table as the library. They are system seeds, so the only tenant-level
 * action is entitlement (see `riazConnectorRules.ts`); a selection that names
 * neither a describe question nor a SUMMARY protocol skips them entirely.
 */
async function connectorReports(client: RestClient, tenant: { organizationId: string | null }, a: Args): Promise<RuleReport[]> {
  if (a.codes && !a.codes.some((c) => RIAZ_CONNECTORS.some((k) => k.code === c))) return [];
  if (a.protocol && a.protocol !== 'SUMMARY_RULE') return [];
  const connectors = await ensureConnectorsVisible(client, tenant, { log, dryRun: a.dryRun });
  // The carriers are what the describe NODE cites; without them the connectors
  // are selectable and the run still cannot resolve a ruleId (AXI-1556 seed).
  const carriers = await checkDescribeCarriers(client, { log });
  return [...connectors.map(toRuleReport), ...carriers.map((c) => ({ ...toRuleReport(c), protocol: 'DESCRIBE_CARRIER' }))];
}

const toRuleReport = (c: ConnectorReport): RuleReport => ({
  code: c.code,
  protocol: 'SUMMARY_RULE',
  executable: true,
  questions: ['Q12-Q21'],
  action: c.action === 'missing' || c.action === 'unentitled' ? 'invalid' : (c.action as RuleReport['action']),
  id: c.ruleId ?? undefined,
  version: c.version ?? undefined,
  problems: c.problems,
});

function printTable(reports: RuleReport[]): void {
  const w = Math.max(...reports.map((r) => r.code.length));
  for (const r of reports) {
    const tail = r.problems.length ? `  ✗ ${r.problems.join('; ')}` : r.id ? `  ${r.id} v${r.version ?? '?'}` : '';
    console.log(`  ${r.code.padEnd(w)}  ${r.protocol.padEnd(15)}  ${(r.executable ? 'executes' : 'authoring').padEnd(9)}  ${r.action.padEnd(13)}  ${r.questions.join(',').padEnd(18)}${tail}`);
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  let client: RestClient | null = null;
  if (!a.list && !a.check) {
    const baseUrl = (process.env.STAGING_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
    client = new RestClient({ baseUrl });
    await ensureIdentities(client, process.env.STAGING_ADMIN_EMAIL?.trim() || 'admin@axiome.local', process.env.STAGING_ADMIN_PASSWORD?.trim() || 'admin');
  }
  const reports = await ensureRules(client, a);
  if (a.json) console.log(JSON.stringify(reports, null, 2));
  else printTable(reports);
  const bad = reports.filter((r) => r.action === 'invalid');
  const byProtocol = [...new Set(reports.map((r) => r.protocol))].map((p) => `${p}=${reports.filter((r) => r.protocol === p).length}`).join(' ');
  console.log(`\n${bad.length ? 'FAILED' : 'PASSED'} — stage:rules: ${reports.length} rule(s) [${byProtocol}]; ${reports.filter((r) => r.action === 'reused').length} reused, ${reports.filter((r) => r.action === 'created' || r.action === 'published').length} published, ${bad.length} invalid.`);
  if (bad.length) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('ensureRules.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
