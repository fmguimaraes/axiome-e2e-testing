import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AXI-1930 (epic AXI-1912). Reads the `preconditions:` block of every Method
 * Specification Record (MSR) in axiome-docs, so the spec can compare what the
 * MSR says the CONTROL PLANE refuses with what the running control plane
 * actually declares.
 *
 * The MSR front matter is YAML, and this repo has no YAML dependency. The
 * precondition block has a fixed shape that the bio-compute MSR schema
 * validates (`tests/validation/msr/schema.py`):
 * `- id:` / `  severity:` / `  enforcing_layer:` / `  description:`.
 * The parser reads only that shape. It THROWS on anything it cannot place,
 * and it cross-checks its count against the `enforcing_layer:` lines in the
 * block. A format change therefore turns the spec red; it never silently
 * drops a precondition.
 *
 * MSR directory resolution: `PARITY_MSR_DIR` (the same variable the
 * bio-compute harness uses), then `AXIOME_DOCS_ROOT`, then the sibling
 * worktree `axiome-docs<suffix>`, then the primary `axiome-docs`. If none
 * exists, `MSR_DIR` is `undefined` and the spec FAILS, naming the variables.
 */

export type Severity = 'hard' | 'soft';
export type Layer = 'control_plane' | 'bio_compute';

export interface MsrPrecondition {
  methodId: string;
  id: string;
  severity: Severity;
  layer: Layer;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(HERE, '..', '..', '..');
const SUFFIX = path.basename(E2E_ROOT).replace(/^axiome-e2e-testing/, '');
const PARENT = path.dirname(E2E_ROOT);
const MSR_SUBDIR = path.join('04 - architecture', 'qualification', 'method-validation', 'msr');

function candidateDirs(): string[] {
  const fromEnv = process.env.PARITY_MSR_DIR ? [process.env.PARITY_MSR_DIR] : [];
  const docsRoots = [process.env.AXIOME_DOCS_ROOT, path.join(PARENT, `axiome-docs${SUFFIX}`), path.join(PARENT, 'axiome-docs')];
  return [...fromEnv, ...docsRoots.filter((r): r is string => Boolean(r)).map((r) => path.join(r, MSR_SUBDIR))];
}

export const MSR_DIR: string | undefined = candidateDirs().find((d) => existsSync(d));

function frontMatter(source: string, file: string): string[] {
  const lines = source.split('\n');
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 0) throw new Error(`${file}: no YAML front matter`);
  return lines.slice(1, end);
}

function scalar(lines: string[], key: string, file: string): string {
  const line = lines.find((l) => l.startsWith(`${key}:`));
  if (!line) throw new Error(`${file}: front matter has no '${key}:'`);
  return line.slice(key.length + 1).trim();
}

function preconditionBlock(lines: string[], file: string): string[] {
  const start = lines.indexOf('preconditions:');
  if (start < 0) return lines.includes('preconditions: []') ? [] : fail(`${file}: no 'preconditions:' block`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l) && !l.startsWith('- '));
  return end < 0 ? rest : rest.slice(0, end);
}

function fail(message: string): never {
  throw new Error(message);
}

function field(entry: string[], key: string, file: string): string {
  const line = entry.find((l) => l.replace(/^- /, '  ').startsWith(`  ${key}:`));
  return line ? line.replace(/^- /, '  ').slice(key.length + 3).trim() : fail(`${file}: precondition without '${key}'`);
}

function entries(block: string[]): string[][] {
  const starts = block.map((l, i) => (l.startsWith('- ') ? i : -1)).filter((i) => i >= 0);
  return starts.map((s, n) => block.slice(s, starts[n + 1] ?? block.length));
}

function toPrecondition(methodId: string, entry: string[], file: string): MsrPrecondition {
  const severity = field(entry, 'severity', file);
  const layer = field(entry, 'enforcing_layer', file);
  if (severity !== 'hard' && severity !== 'soft') fail(`${file}: severity '${severity}'`);
  if (layer !== 'control_plane' && layer !== 'bio_compute') fail(`${file}: enforcing_layer '${layer}'`);
  return { methodId, id: field(entry, 'id', file), severity, layer };
}

/** Every precondition one MSR declares. Throws on a shape it cannot place. */
export function parseMsrPreconditions(source: string, file: string): MsrPrecondition[] {
  const lines = frontMatter(source, file);
  const methodId = scalar(lines, 'method_id', file);
  const block = preconditionBlock(lines, file);
  const parsed = entries(block).map((entry) => toPrecondition(methodId, entry, file));
  const declared = block.filter((l) => /^\s*-?\s*enforcing_layer:/.test(l)).length;
  if (declared !== parsed.length) fail(`${file}: parsed ${parsed.length} preconditions, block declares ${declared}`);
  return parsed;
}

/** The MSR files in `dir` (README and the template excluded). */
export function msrFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^MSR-.+\.md$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

export function loadAllPreconditions(dir: string): MsrPrecondition[] {
  return msrFiles(dir).flatMap((f) => parseMsrPreconditions(readFileSync(f, 'utf-8'), path.basename(f)));
}
