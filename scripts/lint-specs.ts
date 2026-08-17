import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Spec-convention linter (AXI-1265 — FR18/NFR4/NFR5/NFR10, AC10).
 *
 * Enforces the binding conventions mechanically so traceability and determinism
 * are checked, not assumed:
 *  - every `test()` title leads with the requirement IDs it verifies (FR18/AC10),
 *    so a failure line alone identifies the AC (NFR10);
 *  - no fixed-duration sleeps (NFR4);
 *  - selectors prefer ARIA role/name or `data-testid` over raw CSS/XPath (NFR5).
 * Title/sleep issues are errors; selector issues are warnings.
 */

export type Severity = 'error' | 'warning';
export interface Violation {
  file: string;
  line: number;
  severity: Severity;
  rule: string;
  message: string;
}

const TITLE_LEADS_WITH_ID = /^\s*(AC|FR|NFR)\d+/;
// Matches a real test declaration (`test(`, `test.only/skip/fixme(`) but NOT
// `test.describe(` group labels or hooks like `test.beforeEach(`.
const TEST_TITLE = /\btest(?:\.(?:only|skip|fixme))?\(\s*(['"`])(.*?)\1/;
const FIXED_SLEEP = /\b(?:page\.)?waitForTimeout\s*\(|\bsleep\s*\(/;
const RAW_SELECTOR = /\.locator\(\s*(['"`])\s*([.#]|\/\/|xpath=)/;

/** Lint one spec's source; returns every violation with its 1-based line. */
export function lintSource(file: string, source: string): Violation[] {
  const violations: Violation[] = [];
  source.split('\n').forEach((text, i) => {
    const line = i + 1;
    // Escape hatch for a line that deliberately contains a counter-example (e.g.
    // this linter's own fixtures) — same spirit as `eslint-disable-line`.
    if (text.includes('lint-specs-ignore')) return;
    const title = TEST_TITLE.exec(text);
    if (title && !TITLE_LEADS_WITH_ID.test(title[2])) {
      violations.push({ file, line, severity: 'error', rule: 'title-leads-with-ac-id',
        message: `test title must lead with an AC/FR/NFR ID: "${title[2]}"` });
    }
    if (FIXED_SLEEP.test(text)) {
      violations.push({ file, line, severity: 'error', rule: 'no-fixed-sleep',
        message: 'fixed-duration sleep is forbidden — use a web-first assertion or explicit wait' });
    }
    if (RAW_SELECTOR.test(text)) {
      violations.push({ file, line, severity: 'warning', rule: 'prefer-semantic-selector',
        message: 'prefer getByRole/getByTestId over a raw CSS/XPath locator' });
    }
  });
  return violations;
}

/** Recursively collect `*.spec.ts` files under a directory. */
export function findSpecs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findSpecs(full));
    else if (full.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** Lint every spec under `testsDir`. */
export function lintSpecs(testsDir: string): Violation[] {
  return findSpecs(testsDir).flatMap((file) => lintSource(file, readFileSync(file, 'utf8')));
}

/** CLI entry: exit 1 if any error-severity violation is found. */
function main(): void {
  const testsDir = path.resolve(process.cwd(), 'tests');
  const violations = lintSpecs(testsDir);
  for (const v of violations) {
    console.log(`${v.severity === 'error' ? '✗' : '⚠'} ${v.file}:${v.line} [${v.rule}] ${v.message}`);
  }
  const errors = violations.filter((v) => v.severity === 'error').length;
  console.log(`\n${violations.length} issue(s): ${errors} error(s), ${violations.length - errors} warning(s).`);
  process.exit(errors > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('lint-specs.ts')) {
  main();
}
