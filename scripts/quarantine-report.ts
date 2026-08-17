import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Flake quarantine report (AXI-1271 — FR38/FR39, AC18).
 *
 * A spec that fails intermittently across unchanged commits is annotated
 * `@flaky <AXI-BUG>` in its `test()` title. The merge gate excludes `@flaky`
 * (`playwright test --grep-invert @flaky`, FR38), so a flake never blocks a
 * merge — but quarantine is **never silent**: every quarantined test appears as
 * an explicit line here and MUST carry a linked Jira bug (FR39). A `@flaky`
 * without a bug is an error.
 */

export interface Quarantined { file: string; title: string; bug: string | null; }

const TEST_TITLE = /^[ \t]*test(?:\.(?:only|skip|fixme))?\(\s*(['"`])(.*?)\1/;
const FLAKY = /@flaky(?:\s+(AXI-\d+))?/;

/** Extract every `@flaky`-tagged test in a spec, with its linked bug if present. */
export function parseQuarantine(file: string, source: string): Quarantined[] {
  const out: Quarantined[] = [];
  for (const line of source.split('\n')) {
    if (line.includes('quarantine-ignore')) continue; // escape hatch for this file's own fixtures
    const title = TEST_TITLE.exec(line)?.[2];
    if (!title || !FLAKY.test(title)) continue;
    out.push({ file: path.basename(file), title, bug: FLAKY.exec(title)?.[1] ?? null });
  }
  return out;
}

/** Recursively collect `*.spec.ts` under a directory. */
export function findSpecs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findSpecs(full));
    else if (full.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** Every quarantined test across the suite. */
export function quarantineList(testsDir: string): Quarantined[] {
  return findSpecs(testsDir).flatMap((f) => parseQuarantine(f, readFileSync(f, 'utf8')));
}

function main(): void {
  const list = quarantineList(path.resolve(process.cwd(), 'tests'));
  console.log(`Quarantined specs (@flaky, excluded from the merge gate): ${list.length}`);
  for (const q of list) console.log(`  ⚑ ${q.file} › ${q.title}${q.bug ? ` [${q.bug}]` : ' [NO LINKED BUG]'}`);
  const missing = list.filter((q) => !q.bug);
  if (missing.length) {
    console.error(`\n✗ ${missing.length} quarantined spec(s) have no linked Jira bug (FR39).`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith('quarantine-report.ts')) main();
