import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { API_BASE_URL } from '../../config/env';
import { createApiClient, fetchTransport, loginForToken } from './harness/prod-suite/api-client';
import { prodSuiteEnabled, readProdSuiteConfig, type ProdSuiteConfig } from './harness/prod-suite/config';
import { dailyExecutor } from './harness/prod-suite/executor';
import { PAUL_OPERATIONS } from './harness/prod-suite/run-plan';
import { PROD_SUITE_FIXTURES } from './harness/prod-suite/fixtures';
import { findSecretShapes } from './harness/prod-suite/publish';
import { writeReport, type ProdSuiteReport } from './harness/prod-suite/report';
import { configAbortReport, runProdSuite } from './harness/prod-suite/suite';

/**
 * AXI-2318 (epic AXI-2309 Platform Opening: Headless) — THE DAILY PROD E2E
 * SUITE. Run by `.github/workflows/prod-e2e-daily.yml` against production, in
 * the dedicated test org, as the confined test identity. Never runs unless
 * `PROD_E2E_SUITE=1` (so an ordinary suite run skips it, and it never runs as
 * an admin), and once enabled a missing setting is a hard failure, not a skip.
 *
 * The first test runs the whole suite (isolation → fixtures by ID → plan →
 * cases) and ALWAYS writes `report.json`/`report.md` to `PROD_E2E_REPORT_DIR`
 * (default `prod-suite-report/`), so an aborted day is still published. The
 * following tests turn the report into the run's verdict per requirement.
 * Pass/fail of each case is AXI-2319's pass rule (FR31/AC12 — Paul's methods on
 * slide targets + R parity, every other rule on run SUCCEEDED + default chart
 * rendered; harness/prod-suite/pass-rule-executor.ts); the last three tests
 * below turn those outcomes into the day's verdict. The 60-min budget covers
 * the measured stand-in run (~4 min catalogue with the render breaker) plus a
 * worst case where every gallery chart waits its full 45 s render window.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2318 — Prod E2E suite infra" (AXI-2318.1) and § "AXI-2319 — Prod E2E pass rule".
 */

test.use({ storageState: { cookies: [], origins: [] }, trace: 'off', video: 'off', screenshot: 'off' });
test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-042', '@SI-041'] };
const REPORT_DIR = path.resolve(process.env.PROD_E2E_REPORT_DIR?.trim() || 'prod-suite-report');

let config: ProdSuiteConfig;
let report: ProdSuiteReport;

/** Log in as the confined test identity; the client carries the EC9 forbidden-id tripwire. */
async function connect(cfg: ProdSuiteConfig) {
  const token = await loginForToken(cfg.apiBaseUrl, cfg.email, cfg.password);
  return createApiClient(
    { apiBaseUrl: cfg.apiBaseUrl, token, workspaceId: cfg.workspaceId, forbiddenIds: cfg.forbiddenOrgIds },
    fetchTransport,
  );
}

test.describe('AXI-2318 — prod E2E daily suite', TAGS, () => {
  test.skip(!prodSuiteEnabled(process.env), 'prod E2E daily suite is opt-in — set PROD_E2E_SUITE=1 (the daily workflow does)');

  test('FR28 FR33 NFR6 — the daily suite runs and writes its report', async () => {
    test.setTimeout(60 * 60_000);
    const env = { ...process.env, API_BASE_URL };
    const result = readProdSuiteConfig(env);
    if (result.ok) {
      config = result.config;
      report = await runProdSuite({ connect: () => connect(config), config, executor: dailyExecutor });
    } else {
      report = configAbortReport(result.missing, env);
    }
    const files = writeReport(REPORT_DIR, report);
    expect(files.map((f) => path.basename(f))).toEqual(['report.json', 'report.md']);
    // NFR3/NFR6: what gets published carries no URL, host or credential —
    // checked on the files as written, for an aborted report too.
    const host = new URL(API_BASE_URL).host;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(findSecretShapes(text), `${path.basename(file)} secret shapes`).toEqual([]);
      expect(text, `${path.basename(file)} URL`).not.toMatch(/https?:\/\//i);
      expect(text.includes(host), `${path.basename(file)} names the API host`).toBe(false);
      if (result.ok) {
        expect(text.includes(result.config.email), `${path.basename(file)} names the test identity`).toBe(false);
        expect(text.includes(result.config.password), `${path.basename(file)} carries the password`).toBe(false);
      }
    }
    expect(report.abort?.phase === 'config' ? report.abort : null, 'configuration / login').toBeNull();
  });

  test('AC11 EC9 NFR5 — the run is confined to the dedicated test org', async () => {
    expect(report.abort?.phase === 'isolation' ? report.abort : null, 'isolation guard').toBeNull();
    expect(report.testOrg).toEqual({ organizationId: config.organizationId, workspaceId: config.workspaceId });
  });

  test('AC11 FR29 — the fixtures are resolved by ID, never re-uploaded', async () => {
    expect(report.abort?.phase === 'fixtures' ? report.abort : null, 'fixture resolution').toBeNull();
    expect(report.fixtures.map((f) => f.key)).toEqual(PROD_SUITE_FIXTURES.map((f) => f.key).sort());
    for (const fixture of report.fixtures) expect(fixture.rawFileHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("AC11 FR30 — Paul's methods run first, then the full active catalogue", async () => {
    expect(report.abort, 'run aborted').toBeNull();
    // Non-vacuous: Paul's methods and the rest of the catalogue both actually ran.
    expect(report.summary.byPhase['paul-methods'], "Paul's-methods cases").toBeGreaterThan(0);
    expect(report.summary.byPhase.catalogue, 'catalogue cases').toBeGreaterThan(0);
    expect(report.plan.missingPaulOperations, "Paul's operations with no active rule").toEqual([]);
    expect(report.plan.caseCount).toBe(report.cases.length);
    const phases = report.cases.map((c) => c.phase);
    const firstCatalogue = phases.indexOf('catalogue');
    expect(phases.slice(firstCatalogue === -1 ? phases.length : firstCatalogue)).not.toContain('paul-methods');
    expect(report.cases.filter((c) => c.phase === 'paul-methods').every((c) => PAUL_OPERATIONS.includes(c.operationId ?? ''))).toBe(true);
    expect(report.cases.map((c) => c.order)).toEqual(report.cases.map((_, i) => i + 1));
    expect(report.summary.total).toBeGreaterThan(0);
  });

  // ── AXI-2319 (FR31, AC12, SI-053) — the PASS RULE verdicts ─────────────
  // The executor (harness/prod-suite/pass-rule-executor.ts) has already judged
  // every case; these tests turn its outcomes into the day's verdict. Each
  // lists the offending cases (code · outcome · reason) so a red day says why.

  const listed = (cases: ProdSuiteReport['cases']) => cases.map((c) => `${c.order} ${c.code} ${c.operationId ?? '—'} · ${c.outcome} · ${c.reason ?? ''}`);

  test("AC12 FR31 — Paul's methods pass on their expected values (slide targets + R parity)", { tag: ['@SI-053'] }, async () => {
    expect(report.abort, 'run aborted').toBeNull();
    const paul = report.cases.filter((c) => c.phase === 'paul-methods');
    expect(paul.length, "Paul's-methods cases").toBeGreaterThan(0);
    expect(listed(paul.filter((c) => c.outcome !== 'pass')), "Paul's methods not passing").toEqual([]);
  });

  test('AC12 FR31 FR14 — no evaluated catalogue rule fails (run SUCCEEDED + default chart rendered)', async () => {
    expect(report.abort, 'run aborted').toBeNull();
    const catalogue = report.cases.filter((c) => c.phase === 'catalogue');
    expect(catalogue.filter((c) => c.outcome === 'pass' || c.outcome === 'fail').length, 'catalogue rules actually judged').toBeGreaterThan(0);
    expect(listed(catalogue.filter((c) => c.outcome === 'fail' || c.outcome === 'error')), 'catalogue rules failing').toEqual([]);
  });

  test('AC12 FR31 — every active rule is evaluated (none left not-evaluated)', async () => {
    expect(report.abort, 'run aborted').toBeNull();
    // Strict on purpose: FR31 says EVERY active rule passes, so a rule the suite
    // cannot judge (no recipe, no server-renderable default chart, not runnable)
    // is a gap in AC12, reported here separately from real failures above.
    expect(listed(report.cases.filter((c) => c.outcome === 'not-evaluated')), 'rules not evaluated').toEqual([]);
  });
});
