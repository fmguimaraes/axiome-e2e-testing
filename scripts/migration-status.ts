import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Lazy-migration status (AXI-1272 — FR36/FR37, AC21).
 *
 * Reports each scenario file's conversion state — how many scenarios are
 * `playwright`, `manual` (with a reason), or **untagged** (legacy, reads as
 * manual per FR16 and must be tagged when next touched). Migration is lazy: a
 * file is converted only when a story touches its area or its epic reaches
 * Workflow 5 (FR36); this makes the true state visible rather than pretending
 * everything is done. An untestable scenario is retagged `manual` with a reason
 * (FR37), never left as an unfulfilled gap.
 */

export interface FileStatus {
  file: string;
  playwright: number;
  manual: number;
  untagged: number;
  manualMissingReason: string[];
}

/** Summarise one scenario file's `automation:` tags. */
export function fileStatus(file: string, source: string): FileStatus {
  const blocks = source.split(/^###\s+/m).slice(1);
  const status: FileStatus = { file: path.basename(file), playwright: 0, manual: 0, untagged: 0, manualMissingReason: [] };
  for (const block of blocks) {
    const heading = block.split('\n', 1)[0].trim();
    const tag = /_automation:_\s*([a-z]+)(.*)/i.exec(block);
    if (!tag) { status.untagged += 1; continue; }
    if (tag[1].toLowerCase() === 'playwright') { status.playwright += 1; continue; }
    status.manual += 1;
    // A `manual` tag must carry a one-line reason (FR15/FR37).
    if (!/[—-]\s*\S/.test(tag[2])) status.manualMissingReason.push(heading);
  }
  return status;
}

/** Status for every `AXI-*` scenario file in a directory. */
export function migrationStatus(scenariosDir: string): FileStatus[] {
  if (!existsSync(scenariosDir)) return [];
  return readdirSync(scenariosDir)
    .filter((f) => /^AXI-\d+-.*\.md$/.test(f))
    .map((f) => fileStatus(f, readFileSync(path.join(scenariosDir, f), 'utf8')));
}

function main(): void {
  const docs = process.env.E2E_DOCS_DIR || path.resolve(process.cwd(), '../axiome-docs');
  const all = migrationStatus(path.join(docs, 'manual-e2e'));
  let missing = 0;
  for (const s of all) {
    console.log(`${s.file}: ${s.playwright} playwright · ${s.manual} manual · ${s.untagged} untagged`);
    for (const h of s.manualMissingReason) { console.log(`  ✗ manual scenario without a reason: ${h}`); missing += 1; }
  }
  console.log(`\n${all.length} file(s). Untagged scenarios read as manual (FR16); tag when next touched.`);
  process.exit(missing > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('migration-status.ts')) main();
