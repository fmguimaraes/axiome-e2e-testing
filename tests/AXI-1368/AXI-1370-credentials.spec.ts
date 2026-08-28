import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { envVarName, resolvePassword, selectPassword } from '../../staging/identities/credentials';

/**
 * AXI-1370 — credential resolution (FR4/NFR5/AC20: "accept all credentials
 * from environment or a local untracked file. No credential may be
 * committed, logged, or embedded in a fixture."). API-level, no browser.
 *
 * @SI-044.
 */

test.describe('FR4 — selectPassword (pure decision, no fs/crypto)', () => {
  test('FR4 — an env value wins over a stored value', () => {
    const result = selectPassword('  from-env  ', 'from-store', () => 'from-generate');
    expect(result).toEqual({ password: 'from-env', source: 'env' });
  });

  test('FR4 — a stored value wins over generating a new one', () => {
    const result = selectPassword(undefined, 'from-store', () => 'from-generate');
    expect(result).toEqual({ password: 'from-store', source: 'store' });
  });

  test('FR4 — generates only when neither env nor store has a value', () => {
    let calls = 0;
    const result = selectPassword(undefined, undefined, () => {
      calls += 1;
      return 'from-generate';
    });
    expect(result).toEqual({ password: 'from-generate', source: 'generated' });
    expect(calls).toBe(1);
  });

  test('FR4 — an empty/whitespace-only env value is treated as unset', () => {
    const result = selectPassword('   ', 'from-store', () => 'from-generate');
    expect(result.source).toBe('store');
  });
});

test.describe('NFR5 AC20 — envVarName never leaks the value, only names the slot', () => {
  test('NFR5 — uppercases and underscore-izes the handle', () => {
    expect(envVarName('cast-bioinformatician')).toBe('STAGING_PASSWORD_CAST_BIOINFORMATICIAN');
  });
});

test.describe('NFR1 — resolvePassword persists a generated value for idempotent re-runs', () => {
  let dir: string;

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'axi-1370-creds-'));
  });

  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('NFR1 — a second call for the same handle returns the same generated password', () => {
    const storePath = join(dir, 'identities.local.json');
    const first = resolvePassword('service', {} as NodeJS.ProcessEnv, storePath);
    const second = resolvePassword('service', {} as NodeJS.ProcessEnv, storePath);
    expect(second).toBe(first);
    expect(existsSync(storePath)).toBe(true);
  });

  test('AC20 — an env-sourced password is never written to the local store', () => {
    const storePath = join(dir, 'identities.local.json');
    const env = { STAGING_PASSWORD_SERVICE: 'operator-supplied' } as unknown as NodeJS.ProcessEnv;
    const password = resolvePassword('service', env, storePath);
    expect(password).toBe('operator-supplied');
    expect(existsSync(storePath)).toBe(false);
  });

  test('NFR1 — different handles get different generated passwords', () => {
    const storePath = join(dir, 'identities.local.json');
    const a = resolvePassword('cast-biologist', {} as NodeJS.ProcessEnv, storePath);
    const b = resolvePassword('cast-clinician', {} as NodeJS.ProcessEnv, storePath);
    expect(a).not.toBe(b);
    const stored = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(Object.keys(stored).sort()).toEqual(['cast-biologist', 'cast-clinician']);
  });
});
