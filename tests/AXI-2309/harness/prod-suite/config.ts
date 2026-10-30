/**
 * AXI-2318 — configuration of the prod E2E daily suite, read from the
 * environment the `prod-e2e-daily.yml` workflow sets (repo `vars.*` /
 * `secrets.*`; nothing here is ever committed, NFR3/NFR8).
 *
 * Pure: takes an env map, returns a config or the full list of what is missing,
 * so an unconfigured run names every gap at once (the preflight doctrine) and a
 * missing org id can never default to "whatever org the identity sees" (EC9).
 */

export interface ProdSuiteConfig {
  apiBaseUrl: string;
  email: string;
  password: string;
  organizationId: string;
  workspaceId: string;
  /** Raw `PROD_E2E_FIXTURE_IDS` JSON (fixture key → dataset id); parsed by fixtures.ts. */
  fixtureIdsJson: string;
  /**
   * Org ids the suite must never resolve or name (Paul's prod org id goes here).
   * REQUIRED and non-empty (EC9/NFR5): an empty list would silently turn the
   * id-based guard and the request tripwire off, leaving only the name match.
   */
  forbiddenOrgIds: string[];
  targetLabel: string;
  runId: string;
  gitSha: string | null;
  trigger: string;
}

export type ConfigResult = { ok: true; config: ProdSuiteConfig } | { ok: false; missing: string[] };

export const REQUIRED_VARS = [
  'API_BASE_URL',
  'PROD_E2E_TEST_EMAIL',
  'PROD_E2E_TEST_PASSWORD',
  'PROD_E2E_ORG_ID',
  'PROD_E2E_WORKSPACE_ID',
  'PROD_E2E_FIXTURE_IDS',
  'PROD_E2E_FORBIDDEN_ORG_IDS',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The forbidden-org id list, or `null` when it is unusable: empty,
 * separator-only, or holding any entry that is not a UUID (a typo must never
 * quietly shrink the list). Fail closed — EC9.
 */
export function parseForbiddenOrgIds(raw: string): string[] | null {
  const ids = parseIdList(raw);
  return ids.length > 0 && ids.every((id) => UUID.test(id)) ? ids : null;
}

/** True only when the daily suite is deliberately switched on (the workflow sets it). */
export function prodSuiteEnabled(env: Record<string, string | undefined>): boolean {
  return /^(1|true)$/i.test(env.PROD_E2E_SUITE?.trim() ?? '');
}

function read(env: Record<string, string | undefined>, name: string): string {
  return env[name]?.trim() ?? '';
}

/** Split a comma/whitespace-separated id list, dropping blanks. */
export function parseIdList(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** A run id is used in S3 keys and repo paths: refuse anything outside `[A-Za-z0-9._-]`. */
export function safeRunId(raw: string, now: Date): string {
  const candidate = raw || `local-${now.toISOString().replace(/[:.]/g, '-')}`;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(candidate)) throw new Error(`unsafe PROD_E2E_RUN_ID: ${JSON.stringify(candidate)}`);
  return candidate;
}

export function readProdSuiteConfig(env: Record<string, string | undefined>, now = new Date()): ConfigResult {
  const missing: string[] = REQUIRED_VARS.filter((name) => !read(env, name));
  const forbiddenOrgIds = parseForbiddenOrgIds(read(env, 'PROD_E2E_FORBIDDEN_ORG_IDS'));
  if (!forbiddenOrgIds && !missing.includes('PROD_E2E_FORBIDDEN_ORG_IDS')) missing.push('PROD_E2E_FORBIDDEN_ORG_IDS');
  if (missing.length > 0 || !forbiddenOrgIds) return { ok: false, missing };
  return {
    ok: true,
    config: {
      apiBaseUrl: read(env, 'API_BASE_URL').replace(/\/+$/, ''),
      email: read(env, 'PROD_E2E_TEST_EMAIL'),
      password: read(env, 'PROD_E2E_TEST_PASSWORD'),
      organizationId: read(env, 'PROD_E2E_ORG_ID'),
      workspaceId: read(env, 'PROD_E2E_WORKSPACE_ID'),
      fixtureIdsJson: read(env, 'PROD_E2E_FIXTURE_IDS'),
      forbiddenOrgIds,
      targetLabel: read(env, 'PROD_E2E_TARGET_LABEL') || 'unlabelled',
      runId: safeRunId(read(env, 'PROD_E2E_RUN_ID'), now),
      gitSha: read(env, 'GITHUB_SHA') || null,
      trigger: read(env, 'GITHUB_EVENT_NAME') || 'local',
    },
  };
}
