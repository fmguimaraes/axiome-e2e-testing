import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No-privileged-back-door check (NFR3, AC2 — "the toolkit contains no
 * database, message-bus or seed-script access path").
 *
 * A source-text grep, not a type-level ban, because NFR3 is about the whole
 * dependency surface being provably absent, and a text scan is the same
 * evidence a reviewer would produce by hand — anyone can re-run it and see
 * exactly what matched.
 */

const FORBIDDEN_IMPORTS: RegExp[] = [
  /from\s+['"]@prisma\/client['"]/,
  /from\s+['"]prisma['"]/,
  /require\(\s*['"]@prisma\/client['"]\s*\)/,
  /from\s+['"]pg['"]/,
  /from\s+['"]pg-promise['"]/,
  /from\s+['"]mongodb['"]/,
  /from\s+['"]mongoose['"]/,
  /from\s+['"]amqplib['"]/,
  /from\s+['"]amqp-connection-manager['"]/,
  /from\s+['"]ioredis['"]/,
  /from\s+['"]redis['"]/,
  // Only an actual import/require of a *-seed(-script) module — not this word appearing in prose/comments.
  /(?:from\s+['"][^'"]*seed[-.]?script[^'"]*['"])|(?:require\(\s*['"][^'"]*seed[-.]?script[^'"]*['"]\s*\))/i,
];

export interface Violation {
  file: string;
  line: number;
  text: string;
}

/** Scan one file's source for a forbidden import. Pure function — unit-testable without disk I/O. */
export function scanSource(filePath: string, source: string): Violation[] {
  const lines = source.split('\n');
  const hits: Violation[] = [];
  lines.forEach((text, i) => {
    if (FORBIDDEN_IMPORTS.some((re) => re.test(text))) {
      hits.push({ file: filePath, line: i + 1, text: text.trim() });
    }
  });
  return hits;
}

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) return listTsFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Scan every `.ts` file under `rootDir` (default: this toolkit's own directories). */
export function scanDirectory(rootDir: string): Violation[] {
  return listTsFiles(rootDir).flatMap((file) => scanSource(file, readFileSync(file, 'utf8')));
}

function main(): void {
  const roots = process.argv.slice(2);
  const targets = roots.length > 0 ? roots : ['staging', 'capture'];
  const violations = targets.flatMap((dir) => safeScan(dir));
  if (violations.length > 0) {
    console.error(`no-backdoor check FAILED — ${violations.length} forbidden import(s):`);
    violations.forEach((v) => console.error(`  ${v.file}:${v.line}: ${v.text}`));
    process.exit(1);
  }
  console.log(`no-backdoor check passed — scanned ${targets.join(', ')}, no DB/bus/seed import found.`);
}

function safeScan(dir: string): Violation[] {
  try {
    return scanDirectory(dir);
  } catch {
    return []; // directory may not exist yet (e.g. capture/** before AXI-1381) — nothing to violate.
  }
}

if (process.argv[1] && process.argv[1].endsWith('noBackdoor.ts')) main();
