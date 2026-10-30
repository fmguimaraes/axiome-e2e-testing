import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AbortPhase } from './abort';
import { CASE_OUTCOMES, type CaseOutcome, type ExecutedCase } from './cases';
import type { ResolvedFixture } from './fixtures';
import type { CasePhase } from './run-plan';

/**
 * AXI-2318 — the daily prod E2E report (FR33, NFR6). Schema v1.
 *
 * THIS IS THE CONTRACT the next stories consume: AXI-2319 fills `cases[]`
 * outcomes through its executor, AXI-2320's admin page lists the S3 objects
 * (`<prefix>/<YYYY-MM-DD>/<runId>/report.json`) and reads `status`,
 * `summary` and `run`. Additive changes only; a breaking change bumps
 * `schemaVersion`.
 *
 * Deterministic: the JSON is serialized with fixed key order and cases in plan
 * order, and the Markdown is rendered ONLY from the JSON, so two renders of the
 * same run are byte-identical (NFR6 "reproducible"). It carries ids, hashes and
 * counts only — no URL, hostname, token, storage key or bucket name (NFR3).
 */

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_JSON = 'report.json';
export const REPORT_MD = 'report.md';

export interface ReportCase {
  order: number;
  phase: CasePhase;
  ruleId: string;
  code: string;
  operationId: string | null;
  runKind: string | null;
  runnable: boolean | null;
  outcome: CaseOutcome;
  reason: string | null;
  facts: Record<string, string | number | boolean | null>;
}

export interface ProdSuiteReport {
  schemaVersion: number;
  suite: 'axiome-prod-e2e-daily';
  story: 'AXI-2318';
  status: 'completed' | 'aborted';
  run: { runId: string; trigger: string; gitSha: string | null; targetLabel: string; startedAt: string; finishedAt: string };
  abort: { phase: AbortPhase; code: string; message: string } | null;
  testOrg: { organizationId: string; workspaceId: string } | null;
  fixtures: ResolvedFixture[];
  plan: { paulOperations: string[]; missingPaulOperations: string[]; caseCount: number };
  summary: { total: number; byOutcome: Record<CaseOutcome, number>; byPhase: Record<CasePhase, number> };
  cases: ReportCase[];
}

export interface ReportInput {
  run: ProdSuiteReport['run'];
  abort: ProdSuiteReport['abort'];
  testOrg: ProdSuiteReport['testOrg'];
  fixtures: ResolvedFixture[];
  plan: { paulOperations: string[]; missingPaulOperations: string[] } | null;
  cases: ExecutedCase[];
}

function toReportCase(c: ExecutedCase): ReportCase {
  return {
    order: c.order, phase: c.phase, ruleId: c.id, code: c.code, operationId: c.operationId,
    runKind: c.runKind, runnable: c.runnable, outcome: c.outcome, reason: c.reason, facts: sortedFacts(c.facts),
  };
}

function sortedFacts(facts: ExecutedCase['facts']): ReportCase['facts'] {
  return Object.fromEntries(Object.keys(facts).sort().map((k) => [k, facts[k]]));
}

function summarize(cases: ReportCase[]): ProdSuiteReport['summary'] {
  const byOutcome = Object.fromEntries(CASE_OUTCOMES.map((o) => [o, 0])) as Record<CaseOutcome, number>;
  const byPhase: Record<CasePhase, number> = { 'paul-methods': 0, catalogue: 0 };
  for (const c of cases) {
    byOutcome[c.outcome] += 1;
    byPhase[c.phase] += 1;
  }
  return { total: cases.length, byOutcome, byPhase };
}

export function buildReport(input: ReportInput): ProdSuiteReport {
  const cases = [...input.cases].sort((a, b) => a.order - b.order).map(toReportCase);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    suite: 'axiome-prod-e2e-daily',
    story: 'AXI-2318',
    status: input.abort ? 'aborted' : 'completed',
    run: input.run,
    abort: input.abort,
    testOrg: input.testOrg,
    fixtures: [...input.fixtures].sort((a, b) => a.key.localeCompare(b.key)),
    plan: { paulOperations: input.plan?.paulOperations ?? [], missingPaulOperations: input.plan?.missingPaulOperations ?? [], caseCount: cases.length },
    summary: summarize(cases),
    cases,
  };
}

export function serializeReport(report: ProdSuiteReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const cell = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|'));

function headerLines(r: ProdSuiteReport): string[] {
  return [
    `# Prod E2E daily report — ${r.run.runId}`,
    '',
    `- **Status:** ${r.status}${r.abort ? ` (${r.abort.phase}/${r.abort.code}: ${r.abort.message})` : ''}`,
    `- **Target:** ${r.run.targetLabel} · **Trigger:** ${r.run.trigger} · **Commit:** ${cell(r.run.gitSha)}`,
    `- **Started:** ${r.run.startedAt} · **Finished:** ${r.run.finishedAt}`,
    `- **Test org:** ${cell(r.testOrg?.organizationId)} · **Workspace:** ${cell(r.testOrg?.workspaceId)}`,
    `- **Outcomes:** ${CASE_OUTCOMES.map((o) => `${o} ${r.summary.byOutcome[o]}`).join(' · ')} (total ${r.summary.total})`,
    `- **Paul's methods missing from the active catalogue:** ${r.plan.missingPaulOperations.join(', ') || 'none'}`,
    '',
  ];
}

function fixtureLines(r: ProdSuiteReport): string[] {
  const rows = r.fixtures.map((f) => `| ${f.key} | ${f.datasetId} | ${f.rawFileHash} |`);
  return ['## Fixtures (by ID)', '', '| key | dataset id | rawFileHash |', '| --- | --- | --- |', ...rows, ''];
}

function caseLines(r: ProdSuiteReport): string[] {
  const rows = r.cases.map((c) =>
    `| ${c.order} | ${c.phase} | ${cell(c.code)} | ${cell(c.operationId)} | ${c.outcome} | ${cell(c.reason)} |`);
  return ['## Cases (plan order)', '', '| # | phase | rule | operation | outcome | reason |', '| --- | --- | --- | --- | --- | --- |', ...rows, ''];
}

/** Markdown view, rendered only from the report object (deterministic). */
export function renderReportMarkdown(r: ProdSuiteReport): string {
  return [...headerLines(r), ...fixtureLines(r), ...caseLines(r)].join('\n');
}

/** Write `report.json` + `report.md` into `dir` (created if absent). */
export function writeReport(dir: string, report: ProdSuiteReport): string[] {
  mkdirSync(dir, { recursive: true });
  const files = [path.join(dir, REPORT_JSON), path.join(dir, REPORT_MD)];
  writeFileSync(files[0], serializeReport(report));
  writeFileSync(files[1], renderReportMarkdown(report));
  return files;
}
