import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IdentityHandle } from './types';

/**
 * Per-identity password resolution (FR4/NFR5/AC20).
 *
 * FR4: "The toolkit MUST accept all credentials from environment or a local
 * untracked file. No credential may be committed, logged, or embedded in a
 * fixture." Two sources, in order:
 *
 *  1. `STAGING_PASSWORD_<HANDLE>` env var, if set.
 *  2. A generated value persisted under a stable local store, generated once
 *     per handle so a second `ensureIdentities()` run logs in with the same
 *     credential instead of minting a new user every time (NFR1).
 *
 * Never logged: nothing in this module calls `console.*` on a password value.
 *
 * **Risk B fix (AXI-1371 handover, done in AXI-1372):** the store used to live
 * at a repo-relative `.auth/identities.local.json`. That path resolves INSIDE
 * whichever worktree the story that ran `stage`/`ensureIdentities` happened to
 * use — and a worktree is destroyed at merge (see the root CLAUDE.md checkout
 * convention). The next story's fresh worktree then found no store, generated
 * BRAND NEW passwords for identities that already existed on the server from
 * the previous run, and every subsequent `login()` 401'd. The store must live
 * somewhere that outlives any single worktree: `STAGING_AUTH_DIR` if set,
 * otherwise `~/.axiome/staging` — outside every repo entirely, so no git
 * operation on any checkout can ever touch it.
 */

/** Pure — where the credential store lives by default. Injectable `env` keeps
 *  this testable without touching the real environment or `os.homedir()`. */
export function defaultStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.STAGING_AUTH_DIR?.trim() || join(homedir(), '.axiome', 'staging');
}

export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultStoreDir(env), 'identities.local.json');
}

export function envVarName(handle: IdentityHandle): string {
  return `STAGING_PASSWORD_${handle.toUpperCase().replace(/-/g, '_')}`;
}

export interface SelectedPassword {
  password: string;
  /** Only 'generated' needs persisting — an env-sourced value is the caller's to manage, and a stored value is already on disk. */
  source: 'env' | 'store' | 'generated';
}

/** Pure decision — env wins, then a previously-stored value, then freshly generated. Injected `generate` keeps this testable without touching crypto or disk. */
export function selectPassword(envValue: string | undefined, storedValue: string | undefined, generate: () => string): SelectedPassword {
  const trimmedEnv = envValue?.trim();
  if (trimmedEnv) return { password: trimmedEnv, source: 'env' };
  if (storedValue) return { password: storedValue, source: 'store' };
  return { password: generate(), source: 'generated' };
}

function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

function readLocalStore(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeLocalStore(path: string, store: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2));
}

/**
 * Resolve `handle`'s password, persisting a generated value so repeat runs
 * are idempotent (NFR1). `storePath` is injectable for tests; production
 * callers get the default computed from `env` at CALL time (not at module
 * load) — every default parameter here is evaluated per-call, so a test that
 * sets `STAGING_AUTH_DIR` (or passes its own `env`) before calling never
 * touches the real `~/.axiome/staging` store (Risk B fix must not leak into
 * unit tests writing real files under the developer's home directory).
 */
export function resolvePassword(
  handle: IdentityHandle,
  env: NodeJS.ProcessEnv = process.env,
  storePath: string = defaultStorePath(env),
): string {
  const store = readLocalStore(storePath);
  const selected = selectPassword(env[envVarName(handle)], store[handle], generatePassword);
  if (selected.source === 'generated') writeLocalStore(storePath, { ...store, [handle]: selected.password });
  return selected.password;
}
