import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AXI-1688 (epic AXI-1687). Resolves the SIBLING checkouts a file-level scenario
 * reads — the doctrine's owning doc (axiome-docs), its code carrier and the rulings
 * file (axiome-back), and the PreToolUse hook script (axiome-global superrepo).
 *
 * Resolution order per repo: an explicit env var, then the worktree layout
 * (`_worktrees/<repo>-<suffix>` beside this checkout, suffix taken from this
 * checkout's own directory name), then the primary layout (`axiome-global/<repo>`,
 * where the superrepo is this checkout's parent). A repo that cannot be found is
 * reported by name so the spec can skip loudly rather than pass vacuously.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This checkout's root (tests/AXI-1687/harness → repo root). */
export const E2E_ROOT = path.resolve(HERE, '..', '..', '..');

const suffix = path.basename(E2E_ROOT).replace(/^axiome-e2e-testing/, '');
const parent = path.dirname(E2E_ROOT);

function firstExisting(candidates: readonly string[], marker: string): string | undefined {
  return candidates.find((c) => existsSync(path.join(c, marker)));
}

function resolveRepo(envName: string, repo: string, marker: string): string | undefined {
  const fromEnv = process.env[envName];
  if (fromEnv && existsSync(path.join(fromEnv, marker))) return fromEnv;
  return firstExisting([path.join(parent, `${repo}${suffix}`), path.join(parent, repo)], marker);
}

export const BACK_ROOT = resolveRepo('AXIOME_BACK_ROOT', 'axiome-back', 'libs/contracts/src/index.ts');
export const DOCS_ROOT = resolveRepo('AXIOME_DOCS_ROOT', 'axiome-docs', '05 - product/features');
export const GLOBAL_ROOT =
  (process.env.AXIOME_GLOBAL_ROOT && existsSync(path.join(process.env.AXIOME_GLOBAL_ROOT, 'scripts/hooks'))
    ? process.env.AXIOME_GLOBAL_ROOT
    : undefined) ??
  firstExisting([path.join(parent, `axiome-global${suffix}`), parent, path.join(parent, 'axiome-global')], 'scripts/hooks');

/** The owning doc, whichever lifecycle prefix it carries today (BACKLOG-/IN-PROGRESS-/bare). */
const OWNING_DOC = /^(BACKLOG-|IN-PROGRESS-)?Guided-Analysis-Intent-Compiled-Planner\.md$/;
function owningDoc(root: string | undefined): string | undefined {
  if (!root) return undefined;
  const dir = path.join(root, '05 - product', 'features');
  const matches = readdirSync(dir).filter((f) => OWNING_DOC.test(f));
  return matches.length === 1 ? path.join(dir, matches[0]) : undefined;
}
/** `undefined` with a docs root present means the owning doc is MISSING — the spec fails, never skips. */
export const DOCTRINE_DOC = owningDoc(DOCS_ROOT);
export const HOOK_DIFF_SCRIPT = GLOBAL_ROOT
  ? path.join(GLOBAL_ROOT, 'scripts', 'hooks', 'guard-gate-rulings-diff.py')
  : undefined;
export const DOCTRINE_TS = BACK_ROOT
  ? path.join(BACK_ROOT, 'libs', 'contracts', 'src', 'guided-analysis', 'answer-as-asked-doctrine.ts')
  : undefined;
export const RULINGS_JSON = BACK_ROOT
  ? path.join(
      BACK_ROOT,
      'apps/organization-service/src/guided-analysis/plan/compile/__fixtures__/grados-gate-rulings.json',
    )
  : undefined;
export const CODEOWNERS = BACK_ROOT ? path.join(BACK_ROOT, '.github', 'CODEOWNERS') : undefined;
export const HOOK_SCRIPT = GLOBAL_ROOT ? path.join(GLOBAL_ROOT, 'scripts', 'hooks', 'protect-gate-rulings.py') : undefined;

/** The names of the repos a scenario needs but could not resolve — empty when all are present. */
export function missingRepos(needed: readonly ('back' | 'docs' | 'global')[]): string[] {
  const table = { back: BACK_ROOT, docs: DOCS_ROOT, global: GLOBAL_ROOT } as const;
  return needed.filter((n) => !table[n]).map((n) => `axiome-${n === 'global' ? 'global' : n}`);
}
