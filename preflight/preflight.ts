import { request } from '@playwright/test';
import { BASE_URL, API_BASE_URL } from '../config/env';

/**
 * Fail-closed preflight (AXI-1263 — FR9/FR10/FR11/FR28, AC4/AC5/AC6).
 *
 * Verifies the front-end and API are reachable and the expected seed baseline
 * is present *before any test runs*. It only **verifies** the seed — it never
 * seeds. Seeding is the platform's single idempotent, fail-closed procedure
 * (`cd axiome-infra && make seed`, per AXI-1001); the suite must not maintain a
 * parallel one (FR11/AC6). When a check fails the run aborts with a reserved
 * exit code distinct from Playwright's test-failure code, so an environment
 * fault is never read as a wall of test failures (FR10/FR28).
 */

/** Reserved infrastructure-fault exit code (sysexits EX_CONFIG), distinct from
 *  Playwright's test-failure code (1). A preflight abort exits with this. */
export const INFRA_FAULT_EXIT_CODE = 78;

export interface PreflightResult {
  ok: boolean;
  failures: string[];
}

/** True if a GET on `url` returns any HTTP response (reachable), within timeout. */
async function reachable(url: string, timeoutMs = 5000): Promise<boolean> {
  const ctx = await request.newContext();
  try {
    const res = await ctx.get(url, { timeout: timeoutMs });
    return res.status() > 0;
  } catch {
    return false;
  } finally {
    await ctx.dispose();
  }
}

/** Seed is present if the bootstrap admin can authenticate (AXI-1001 baseline). */
async function seedPresent(apiBase: string, timeoutMs = 5000): Promise<boolean> {
  const ctx = await request.newContext();
  try {
    const res = await ctx.post(`${apiBase}/api/v1/auth/login`, {
      data: { email: seedAdminEmail(), password: seedAdminPassword() },
      timeout: timeoutMs,
    });
    return res.ok();
  } catch {
    return false;
  } finally {
    await ctx.dispose();
  }
}

/** Bootstrap admin identity — overridable by env, defaults match the local seed. */
export function seedAdminEmail(): string {
  return process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@axiome.local';
}
export function seedAdminPassword(): string {
  return process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin';
}

/** Run all preflight checks and collect every failure (no early return, so the
 *  operator sees the full picture in one abort). */
export async function runPreflight(
  baseUrl: string = BASE_URL,
  apiBaseUrl: string = API_BASE_URL,
): Promise<PreflightResult> {
  const checks: Array<[string, Promise<boolean>]> = [
    [`front-end unreachable at ${baseUrl}`, reachable(baseUrl)],
    [`API unreachable at ${apiBaseUrl}/api/v1/health/live`, reachable(`${apiBaseUrl}/api/v1/health/live`)],
    [`seed baseline absent (admin login failed at ${apiBaseUrl}) — run: cd axiome-infra && make seed`, seedPresent(apiBaseUrl)],
  ];
  const results = await Promise.all(checks.map(([, p]) => p));
  const failures = checks.filter((_, i) => !results[i]).map(([msg]) => msg);
  return { ok: failures.length === 0, failures };
}
