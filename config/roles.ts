import path from 'node:path';

/**
 * Role registry for the auth setup project (AXI-1264 — FR12).
 *
 * Each role authenticates once in the setup project; its `storageState` is
 * persisted and consumed by specs, so no test logs in through the UI unless the
 * login flow itself is under test. Credentials are synthetic local defaults
 * (NFR7), overridable by env / the platform secret store — never a committed
 * production secret (NFR6).
 *
 * `admin`'s identity (AXI-1895 — FR27/NFR3): every e2e test runs as
 * `test@axiomebio.com` by default — see `docs/TEST-IDENTITY.md` for where the
 * password lives and how to create the account on a fresh stack.
 * `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD` are the canonical override; the older
 * `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` names still work (checked second) so
 * nothing already setting those breaks.
 */
export interface Role {
  /** Stable key used in `test.use({ storageState: storageStateFor(name) })`. */
  name: 'admin' | 'user';
  email: string;
  password: string;
  /** Whether the account is created via public self-registration when absent
   *  (the seed provides `admin`; a non-admin is registered on demand). */
  selfRegister: boolean;
}

/** Directory holding per-role storageState files (gitignored). */
export const AUTH_DIR = path.resolve(process.cwd(), '.auth');

/** Absolute path to a role's persisted storageState. */
export function storageStateFor(name: Role['name']): string {
  return path.join(AUTH_DIR, `${name}.json`);
}

export const ROLES: Role[] = [
  {
    name: 'admin',
    email:
      process.env.E2E_TEST_EMAIL?.trim() ||
      process.env.E2E_ADMIN_EMAIL?.trim() ||
      'test@axiomebio.com',
    password:
      process.env.E2E_TEST_PASSWORD?.trim() ||
      process.env.E2E_ADMIN_PASSWORD?.trim() ||
      'admin',
    selfRegister: false,
  },
  {
    name: 'user',
    email: process.env.E2E_USER_EMAIL?.trim() || 'e2e-user@axiome.local',
    password: process.env.E2E_USER_PASSWORD?.trim() || 'E2eUser!23',
    selfRegister: true,
  },
];
