import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { INFRA_FAULT_EXIT_CODE } from '../preflight/preflight';

/**
 * Workflow 4 step-g gate (AXI-1269 — FR32/FR33, AC15/AC16).
 *
 * Runs a story's Playwright suite headless and derives the `e2e-pass` /
 * `e2e-fail` label **from the run's exit code alone** — never an asserted claim
 * (AC16). A preflight infrastructure fault (exit 78) is surfaced as an
 * environment fault, distinct from `e2e-fail`, so a healthy story is not routed
 * to rework (FR28). It also builds the Jira comment citing the run result, the
 * scenario file, and the spec path(s) (FR33). It writes nothing to Jira itself
 * (the suite repo holds no Jira credentials); the orchestrator applies the
 * printed label/comment via the jira scripts.
 */

export type GateLabel = 'e2e-pass' | 'e2e-fail' | 'infra-fault';

/** The label is a pure function of the exit code — the whole point of AC16. */
export function deriveLabel(exitCode: number): GateLabel {
  if (exitCode === 0) return 'e2e-pass';
  if (exitCode === INFRA_FAULT_EXIT_CODE) return 'infra-fault';
  return 'e2e-fail';
}

export interface GateReport {
  label: GateLabel;
  exitCode: number;
  epic: string;
  story: string;
  specGlob: string;
  scenarioFile: string;
  comment: string;
}

/** Build the Jira step-g comment citing run result, scenario file, and specs (FR33). */
export function buildComment(r: Omit<GateReport, 'comment'>): string {
  if (r.label === 'infra-fault') {
    return `E2E infrastructure fault (preflight exit ${r.exitCode}) for ${r.story} — environment down/seed missing, not a defect. Fix the environment and re-run; do not route to rework.`;
  }
  const verdict = r.label === 'e2e-pass' ? 'PASS' : 'FAIL';
  return `Testing: E2E ${verdict} (headless run exit ${r.exitCode}). Scenarios: ${r.scenarioFile} · Specs: ${r.specGlob}`;
}

/** Assemble the full gate report for a story from a run's exit code. */
export function gateReport(epic: string, story: string, exitCode: number, docsDir = 'axiome-docs'): GateReport {
  const specGlob = `tests/${epic}/${story}-*.spec.ts`;
  const scenarioFile = path.posix.join(docsDir, `manual-e2e/${epic}-*.md`);
  const base = { label: deriveLabel(exitCode), exitCode, epic, story, specGlob, scenarioFile };
  return { ...base, comment: buildComment(base) };
}

// ---- CLI ---------------------------------------------------------------

function run(epic: string, story: string): number {
  // The merge gate excludes @flaky-quarantined specs (FR38, AXI-1271); they stay
  // visible via `npm run quarantine`, they just never block the gate.
  const res = spawnSync('npx', ['playwright', 'test', `tests/${epic}/${story}-`, '--grep-invert=@flaky'], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  return res.status ?? 1;
}

function main(): void {
  const epic = process.env.EPIC || process.argv[2];
  const story = process.env.STORY || process.argv[3];
  if (!epic || !story) {
    console.error('usage: story-e2e-gate <EPIC-KEY> <STORY-KEY>');
    process.exit(2);
  }
  const report = gateReport(epic, story, run(epic, story));
  console.log(`\n::e2e-gate:: ${JSON.stringify({ label: report.label, exitCode: report.exitCode })}`);
  console.log(`label: ${report.label}`);
  console.log(`comment: ${report.comment}`);
  process.exit(report.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith('story-e2e-gate.ts')) main();
