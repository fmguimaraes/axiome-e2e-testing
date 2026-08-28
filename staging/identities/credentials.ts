import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
 *  2. A generated value persisted under `.auth/` — already gitignored here
 *     for exactly this reason (AXI-1264's per-role storageState). Generated
 *     once per handle so a second `ensureIdentities()` run logs in with the
 *     same credential instead of minting a new user every time (NFR1).
 *
 * Never logged: nothing in this module calls `console.*` on a password value.
 */

const LOCAL_STORE_PATH = join('.auth', 'identities.local.json');

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
 * callers use the default `.auth/identities.local.json`.
 */
export function resolvePassword(
  handle: IdentityHandle,
  env: NodeJS.ProcessEnv = process.env,
  storePath: string = LOCAL_STORE_PATH,
): string {
  const store = readLocalStore(storePath);
  const selected = selectPassword(env[envVarName(handle)], store[handle], generatePassword);
  if (selected.source === 'generated') writeLocalStore(storePath, { ...store, [handle]: selected.password });
  return selected.password;
}
