import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_URL } from '../config/env';

/**
 * Epic acceptance figure (AXI-1270 — FR34/FR35, AC17).
 *
 * For Workflow 5 step 3: runs an epic's whole suite (`tests/<EPIC>/`, including
 * the cross-story `epic-*.spec.ts` flows) and derives the acceptance package's
 * integrated-E2E figure from the JUnit results — total / passed / failed, plus
 * the cross-story flows executed. The human adds the walked `manual` residue.
 * A green figure against a deployed environment is the citable machine record
 * for Workflow 6 PQ (FR35).
 *
 * The figure is followed by a per-test Feature/Description/Deeplink table
 * (verifiability for the human sign-off): built from the `json` reporter's
 * step detail, so the deeplink is the *actual* last `page.goto` the test
 * navigated to, not a guessed route.
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

export interface DeeplinkRow {
  feature: string;
  description: string;
  deeplink: string;
}

/** Test titles lead with their AC/FR/NFR IDs (CONVENTIONS.md) — split those
 *  off as the "Feature" column, the rest is the human description. */
export function splitTitle(title: string): { feature: string; description: string } {
  const m = /^((?:(?:AC|FR|NFR)\d+[,\s]*)+)[\s—-]*(.*)$/.exec(title.trim());
  if (!m || !m[2]) return { feature: '(untagged)', description: title.trim() };
  return { feature: m[1].trim(), description: m[2].trim() };
}

/** The last `page.goto(...)` step recorded for a test, i.e. the screen the
 *  test actually finished exercising — searched depth-first in run order so
 *  a later navigation always wins over an earlier one. */
export function lastGotoPath(steps: unknown): string | undefined {
  let found: string | undefined;
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const step of list) {
      const s = step as { title?: string; steps?: unknown };
      const m = /^page\.goto\(['"](.*)['"]\)$/.exec(s.title ?? '');
      if (m) found = m[1];
      walk(s.steps);
    }
  };
  walk(steps);
  return found;
}

/** Resolve a goto path against {@link BASE_URL} into a full, clickable deeplink. */
export function toDeeplink(gotoPath: string | undefined): string {
  if (!gotoPath) return BASE_URL;
  return /^https?:\/\//.test(gotoPath) ? gotoPath : `${BASE_URL}/${gotoPath.replace(/^\/+/, '')}`;
}

/** Flatten the `json` reporter's suite tree into one row per executed test. */
export function buildDeeplinkRows(report: unknown): DeeplinkRow[] {
  const rows: DeeplinkRow[] = [];
  const walkSuite = (suite: unknown): void => {
    const s = suite as { specs?: unknown[]; suites?: unknown[] };
    for (const spec of s.specs ?? []) {
      const sp = spec as { title: string; tests?: unknown[] };
      const { feature, description } = splitTitle(sp.title);
      for (const test of sp.tests ?? []) {
        for (const result of (test as { results?: unknown[] }).results ?? []) {
          const deeplink = toDeeplink(lastGotoPath((result as { steps?: unknown }).steps));
          rows.push({ feature, description, deeplink });
        }
      }
    }
    for (const child of s.suites ?? []) walkSuite(child);
  };
  const report_ = report as { suites?: unknown[] };
  for (const suite of report_.suites ?? []) walkSuite(suite);
  return rows;
}

/** Render the verifiability table — one clickable deeplink per executed test. */
export function renderDeeplinkTable(rows: DeeplinkRow[]): string {
  if (!rows.length) return '';
  const lines = [
    '| Feature | Description | Deeplink |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.feature} | ${r.description} | [Open](${r.deeplink}) |`),
  ];
  return lines.join('\n');
}

function main(): void {
  const epic = process.env.EPIC || process.argv[2];
  if (!epic) { console.error('usage: epic-acceptance <EPIC-KEY>'); process.exit(2); }
  const testsDir = path.resolve(process.cwd(), 'tests', epic);
  const junit = path.resolve(process.cwd(), 'test-results/junit.xml');
  const resultsJson = path.resolve(process.cwd(), 'test-results/results.json');
  const res = spawnSync('npx', ['playwright', 'test', `tests/${epic}/`], { stdio: 'inherit', cwd: process.cwd() });
  const xml = existsSync(junit) ? readFileSync(junit, 'utf8') : '';
  const figure = buildFigure(epic, xml, testsDir);
  console.log('\n' + renderFigure(figure));
  if (existsSync(resultsJson)) {
    const rows = buildDeeplinkRows(JSON.parse(readFileSync(resultsJson, 'utf8')));
    console.log('\n' + renderDeeplinkTable(rows));
  }
  process.exit(res.status ?? 1);
}

if (process.argv[1] && process.argv[1].endsWith('epic-acceptance.ts')) main();
