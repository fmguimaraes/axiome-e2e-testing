import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Coverage report (AXI-1266 — FR19/FR20/FR21, AC11).
 *
 * Emits an acceptance-criterion-ID → spec-file map and flags:
 *  - **gaps**   — a `playwright`-tagged scenario whose AC IDs no spec verifies;
 *  - **orphans** — a spec citing an AC/FR/NFR ID that does not exist in any
 *    Feature doc.
 * The core is pure functions over parsed inputs; the CLI resolves the spec dir
 * (local), the scenario library, and the Feature docs (both in `axiome-docs`)
 * and exits non-zero when any gap or orphan exists, so a story cannot be
 * reported complete with an open gap (FR21).
 */

const ID = /\b(?:AC|FR|NFR)\d+\b/g;

export interface Scenario { file: string; heading: string; automation: string; acs: string[]; }
export interface Coverage {
  acToSpec: Record<string, string[]>;
  gaps: Array<{ file: string; heading: string; acs: string[] }>;
  orphans: Array<{ spec: string; id: string }>;
}

// Anchored to line-start so only real `test()` declarations count — a title
// string embedded mid-line inside a fixture (e.g. this suite's own linter/
// coverage tests) is not mistaken for a spec.
const TEST_LINE = /^[ \t]*test(?:\.(?:only|skip|fixme))?\(\s*(['"`])(.*?)\1/;

/** Map each ID cited in a `test()` title to the spec files that verify it. */
export function specAcMap(specFiles: Array<{ file: string; source: string }>): Record<string, string[]> {
  const map: Record<string, Set<string>> = {};
  for (const { file, source } of specFiles) {
    for (const line of source.split('\n')) {
      const title = TEST_LINE.exec(line)?.[2];
      for (const id of title?.match(ID) ?? []) (map[id] ??= new Set()).add(path.basename(file));
    }
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].sort()]));
}

/** Parse scenario sub-sections carrying `_automation:_` and `_ACs:_` lines. */
export function parseScenarios(scenarioFiles: Array<{ file: string; source: string }>): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const { file, source } of scenarioFiles) {
    const blocks = source.split(/^###\s+/m).slice(1);
    for (const block of blocks) {
      const heading = block.split('\n', 1)[0].trim();
      const automation = /_automation:_\s*([a-z]+)/i.exec(block)?.[1]?.toLowerCase();
      if (!automation) continue; // no tag → legacy manual, not a playwright obligation (FR16)
      const acsLine = /_ACs:_\s*(.+)/i.exec(block)?.[1] ?? '';
      scenarios.push({ file: path.basename(file), heading, automation, acs: acsLine.match(ID) ?? [] });
    }
  }
  return scenarios;
}

/** All valid requirement IDs defined across the Feature docs. */
export function featureIds(featureFiles: Array<{ source: string }>): Set<string> {
  const ids = new Set<string>();
  for (const { source } of featureFiles) for (const id of source.match(ID) ?? []) ids.add(id);
  return ids;
}

/** Build the coverage view: map, gaps (playwright scenarios no spec covers), orphans. */
export function buildCoverage(
  acToSpec: Record<string, string[]>,
  scenarios: Scenario[],
  validIds: Set<string>,
): Coverage {
  const covered = new Set(Object.keys(acToSpec));
  const gaps = scenarios
    .filter((s) => s.automation === 'playwright' && !s.acs.some((ac) => covered.has(ac)))
    .map(({ file, heading, acs }) => ({ file, heading, acs }));
  const orphans: Coverage['orphans'] = [];
  for (const [id, specs] of Object.entries(acToSpec)) {
    if (validIds.size > 0 && !validIds.has(id)) for (const spec of specs) orphans.push({ spec, id });
  }
  return { acToSpec, gaps, orphans };
}

// ---- CLI plumbing -------------------------------------------------------

function readDir(dir: string, ext: string): Array<{ file: string; source: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ file: string; source: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...readDir(full, ext));
    else if (full.endsWith(ext)) out.push({ file: full, source: readFileSync(full, 'utf8') });
  }
  return out;
}

function main(): void {
  const docs = process.env.E2E_DOCS_DIR || path.resolve(process.cwd(), '../axiome-docs');
  // Scenario files follow the `<EPIC-KEY>-<Feature>.md` naming; skip TEMPLATE/README.
  const scenarioFiles = readDir(path.join(docs, 'manual-e2e'), '.md')
    .filter((f) => /^AXI-\d+-/.test(path.basename(f.file)));
  const cov = buildCoverage(
    specAcMap(readDir(path.resolve(process.cwd(), 'tests'), '.spec.ts')),
    parseScenarios(scenarioFiles),
    featureIds(readDir(path.join(docs, '05 - product/features'), '.md')),
  );
  console.log('AC ID → spec map:');
  for (const [id, specs] of Object.entries(cov.acToSpec).sort()) console.log(`  ${id} → ${specs.join(', ')}`);
  console.log(`\nGaps (playwright scenario, no spec): ${cov.gaps.length}`);
  for (const g of cov.gaps) console.log(`  ✗ ${g.file} › ${g.heading} [${g.acs.join(', ')}]`);
  console.log(`\nOrphans (spec cites unknown ID): ${cov.orphans.length}`);
  for (const o of cov.orphans) console.log(`  ✗ ${o.spec} cites ${o.id}`);
  process.exit(cov.gaps.length + cov.orphans.length > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('coverage-report.ts')) main();
