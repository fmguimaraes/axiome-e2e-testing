import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Epic acceptance figure (AXI-1270 — FR34/FR35, AC17).
 *
 * For Workflow 5 step 3: runs an epic's whole suite (`tests/<EPIC>/`, including
 * the cross-story `epic-*.spec.ts` flows) and derives the acceptance package's
 * integrated-E2E figure from the JUnit results — total / passed / failed, plus
 * the cross-story flows executed. The human adds the walked `manual` residue.
 * A green figure against a deployed environment is the citable machine record
 * for Workflow 6 PQ (FR35).
 */

export interface EpicFigure {
  epic: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  crossStoryFlows: string[];
  green: boolean;
}

/** Parse the totals from a Playwright JUnit XML report (root `<testsuites>`).
 *  Only `failures` counts as a real defect — Playwright emits benign `errors`
 *  (retry/stderr noise) on green runs, so those are not folded into failures. */
export function parseJUnitTotals(xml: string): { total: number; failures: number; skipped: number } {
  const root = /<testsuites\b[^>]*>/.exec(xml)?.[0] ?? '';
  const num = (attr: string): number => Number(new RegExp(`${attr}="(\\d+)"`).exec(root)?.[1] ?? 0);
  return { total: num('tests'), failures: num('failures'), skipped: num('skipped') };
}

/** Names of the epic's cross-story `epic-*.spec.ts` flows. */
export function crossStoryFlows(testsDir: string): string[] {
  if (!existsSync(testsDir)) return [];
  return readdirSync(testsDir).filter((f) => /^epic-.*\.spec\.ts$/.test(f)).sort();
}

/** Build the epic figure from a JUnit report and the epic's test dir. */
export function buildFigure(epic: string, xml: string, testsDir: string): EpicFigure {
  const t = parseJUnitTotals(xml);
  const passed = t.total - t.failures - t.skipped;
  return {
    epic, total: t.total, passed, failed: t.failures, skipped: t.skipped,
    crossStoryFlows: crossStoryFlows(testsDir),
    green: t.failures === 0 && t.total > 0,
  };
}

/** Render the acceptance-package markdown block (citable in W5 / W6 PQ). */
export function renderFigure(f: EpicFigure): string {
  const flows = f.crossStoryFlows.length ? f.crossStoryFlows.join(', ') : '(none)';
  return [
    `### Integrated E2E — ${f.epic}`,
    `- Result: **${f.green ? 'GREEN' : 'RED'}** — ${f.passed}/${f.total} specs passed` +
      (f.failed ? `, ${f.failed} failed` : '') + (f.skipped ? `, ${f.skipped} skipped` : ''),
    `- Cross-story flows executed: ${flows}`,
    `- Manual residue: _<walked by the approver — record count + result>_`,
  ].join('\n');
}

function main(): void {
  const epic = process.env.EPIC || process.argv[2];
  if (!epic) { console.error('usage: epic-acceptance <EPIC-KEY>'); process.exit(2); }
  const testsDir = path.resolve(process.cwd(), 'tests', epic);
  const junit = path.resolve(process.cwd(), 'test-results/junit.xml');
  const res = spawnSync('npx', ['playwright', 'test', `tests/${epic}/`], { stdio: 'inherit', cwd: process.cwd() });
  const xml = existsSync(junit) ? readFileSync(junit, 'utf8') : '';
  const figure = buildFigure(epic, xml, testsDir);
  console.log('\n' + renderFigure(figure));
  process.exit(res.status ?? 1);
}

if (process.argv[1] && process.argv[1].endsWith('epic-acceptance.ts')) main();
