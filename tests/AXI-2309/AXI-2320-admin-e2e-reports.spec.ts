import { test, expect, request as apiRequest, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import {
  BASE_URL,
  HAS_REPORT_STORE,
  REPORT_STORE_BUCKET,
  REPORT_STORE_ENDPOINT,
  REPORT_STORE_PREFIX,
  REPORT_STORE_SKIP_REASON,
  apiUrl,
} from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';
import { buildReport, serializeReport } from './harness/prod-suite/report';
import type { ExecutedCase, CaseOutcome } from './harness/prod-suite/cases';
import { deleteReportObject, ensureReportBucket, putReportObject, reportKey } from './AXI-2320-report-store';

/**
 * AXI-2320 (epic AXI-2309 Platform Opening: Headless — FR34, AC14, NFR1, NFR3):
 * the admin page listing the daily production E2E reports.
 *
 * The reports are PLATFORM-LEVEL, not tenant data: one dedicated test org, one
 * bucket. Access is therefore platform ADMIN only (JWT role `ADMIN`), with no
 * tenancy dimension — a workspace admin, a member, or any self-registered user
 * is refused 403 (never an empty 200), and no client-sent field buys access.
 *
 * Seeded data: the fixture reports are built by the REAL AXI-2318 generator
 * (`harness/prod-suite/report.ts:buildReport`) and written at the publisher's
 * key layout into the bucket the backend lists, so what is asserted is the
 * real S3 → organization-service → gateway → page path. The seeded-data
 * scenarios need a writable store (`E2E_REPORTS_S3_*`, config/env.ts) and skip
 * without one; the access-boundary scenarios always run.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2320 — Admin page listing daily E2E reports" (AXI-2320.1 .. .7).
 */

test.describe.configure({ mode: 'serial' });

const TAGS = { tag: ['@SI-013', '@SI-010', '@SI-031'] };
const LIST = '/api/v1/admin/e2e-reports';
const STAMP = `${Date.now()}`;
const DATE = '2099-12-31';
const OLDER = '2099-12-30';

interface Seeded {
  key: string;
  date: string;
  runId: string;
}

const RUN = {
  pass: { date: DATE, runId: `axi2320-${STAMP}-pass` },
  fail: { date: DATE, runId: `axi2320-${STAMP}-fail` },
  notEvaluated: { date: DATE, runId: `axi2320-${STAMP}-ne` },
  aborted: { date: OLDER, runId: `axi2320-${STAMP}-abort` },
  unreadable: { date: OLDER, runId: `axi2320-${STAMP}-bad` },
};

const rowId = (r: { date: string; runId: string }) => `${r.date}-${r.runId}`;
const detailPath = (r: { date: string; runId: string }) => `${LIST}/${r.date}/${r.runId}`;

function executed(order: number, outcome: CaseOutcome): ExecutedCase {
  return {
    id: `rule-${order}`, code: `E2E-RULE-${order}`, operationId: 'stats.mann_whitney_u', runKind: 'STATISTICAL',
    runnable: true, order, phase: order === 1 ? 'paul-methods' : 'catalogue', outcome,
    reason: outcome === 'pass' ? null : `fixture ${outcome} reason`, facts: { ruleRunId: `run-${order}`, pValue: 0.04 },
  };
}

function reportText(runId: string, outcomes: CaseOutcome[], aborted = false): string {
  return serializeReport(buildReport({
    run: { runId, trigger: 'workflow_dispatch', gitSha: 'abcdef1234567890', targetLabel: 'local-e2e',
      startedAt: '2099-12-31T02:00:00.000Z', finishedAt: '2099-12-31T02:07:30.000Z' },
    abort: aborted ? { phase: 'fixtures', code: 'FIXTURE_MISSING', message: 'fixture dataset absent' } : null,
    testOrg: { organizationId: 'org-test', workspaceId: 'ws-test' },
    fixtures: [{ key: 'riaz', datasetId: 'ds-1', rawFileHash: 'sha256:00' }],
    plan: { paulOperations: ['stats.mann_whitney_u'], missingPaulOperations: [] },
    cases: outcomes.map((o, i) => executed(i + 1, o)),
  }));
}

const seeded: Seeded[] = [];

async function seed(r: { date: string; runId: string }, text: string, file = 'report.json'): Promise<void> {
  const key = reportKey(r.date, r.runId, file);
  await putReportObject(key, text);
  seeded.push({ key, ...r });
}

/** A throwaway self-registered user: authenticated, but no platform role. */
async function nonAdmin(): Promise<{ api: APIRequestContext; tokens: { accessToken: string; refreshToken: string } }> {
  const email = `axi2320-${STAMP}-${Math.floor(Math.random() * 1e6)}@axiome.local`;
  const password = 'AXI2320-e2e-pw!';
  const boot = await apiRequest.newContext();
  const reg = await boot.post(apiUrl('/api/v1/auth/register'), { data: { email, password, firstName: 'AXI2320', lastName: 'User' } });
  expect(reg.ok(), await reg.text()).toBeTruthy();
  const login = await boot.post(apiUrl('/api/v1/auth/login'), { data: { email, password } });
  expect(login.ok(), await login.text()).toBeTruthy();
  const tokens = await login.json();
  await boot.dispose();
  const api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` } });
  return { api, tokens };
}

async function body(res: APIResponse): Promise<any> {
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** NFR3 — no storage location, key layout, endpoint or credential may leave the server. */
function expectNoStorageLeak(text: string): void {
  for (const needle of [REPORT_STORE_BUCKET, REPORT_STORE_ENDPOINT, REPORT_STORE_PREFIX, 'report.json', 's3://']) {
    if (needle) expect(text, `response leaks "${needle}"`).not.toContain(needle);
  }
  expect(text).not.toMatch(/https?:\/\/|X-Amz-|AKIA|ASIA[0-9A-Z]{16}/);
}

let admin: APIRequestContext;

test.beforeAll(async () => {
  admin = await adminApiContext();
  if (!HAS_REPORT_STORE) return;
  await ensureReportBucket();
  await seed(RUN.pass, reportText(RUN.pass.runId, ['pass', 'pass']));
  await seed(RUN.pass, '# markdown twin\n', 'report.md');
  await seed(RUN.fail, reportText(RUN.fail.runId, ['pass', 'fail', 'not-evaluated', 'error']));
  await seed(RUN.notEvaluated, reportText(RUN.notEvaluated.runId, ['pass', 'not-evaluated', 'not-evaluated']));
  await seed(RUN.aborted, reportText(RUN.aborted.runId, [], true));
  await seed(RUN.unreadable, '{"schemaVersion": 1, "status": "completed", "run": ');
});

test.afterAll(async () => {
  for (const s of seeded) await deleteReportObject(s.key);
  await admin?.dispose();
});

test.describe('AXI-2320 admin E2E reports — seeded data (AC14, FR34)', () => {
  test.skip(!HAS_REPORT_STORE, REPORT_STORE_SKIP_REASON);

  test('AC14 — AXI-2320.1 (FR34): the admin list shows each daily run, newest first, with its verdict and pass/fail/not-evaluated counts', TAGS, async () => {
    const list = await body(await admin.get(apiUrl(`${LIST}?page=1&limit=100`)));
    expect(list.configured).toBe(true);
    const rows = new Map<string, any>(list.data.map((r: any) => [rowId(r), r]));

    expect(rows.get(rowId(RUN.pass))).toMatchObject({ verdict: 'pass', status: 'completed', counts: { total: 2, pass: 2, fail: 0, error: 0, notEvaluated: 0 } });
    expect(rows.get(rowId(RUN.fail))).toMatchObject({ verdict: 'fail', counts: { total: 4, pass: 1, fail: 1, error: 1, notEvaluated: 1 } });
    // Tri-state: a run whose only non-pass cases were not evaluated is NOT a failure.
    expect(rows.get(rowId(RUN.notEvaluated))).toMatchObject({ verdict: 'not-evaluated', counts: { total: 3, pass: 1, fail: 0, error: 0, notEvaluated: 2 } });
    expect(rows.get(rowId(RUN.aborted))).toMatchObject({ verdict: 'aborted', status: 'aborted', abort: { phase: 'fixtures', code: 'FIXTURE_MISSING' } });
    // A malformed object is listed as unreadable, never silently dropped.
    expect(rows.get(rowId(RUN.unreadable))).toMatchObject({ verdict: 'unreadable', counts: null });

    // The markdown twin is not a second row; ordering is newest date first.
    expect(list.data.filter((r: any) => r.runId === RUN.pass.runId)).toHaveLength(1);
    const dates = list.data.map((r: any) => r.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expectNoStorageLeak(JSON.stringify(list));
  });

  test('AC14 — AXI-2320.2 (FR34): the admin opens one report and sees every case outcome; absent and malformed refs are refused', TAGS, async () => {
    const detail = await body(await admin.get(apiUrl(detailPath(RUN.fail))));
    expect(detail).toMatchObject({ date: RUN.fail.date, runId: RUN.fail.runId, verdict: 'fail', gitSha: 'abcdef1234567890' });
    expect(detail.cases.map((c: any) => c.outcome)).toEqual(['pass', 'fail', 'not-evaluated', 'error']);
    expect(detail.cases[2]).toMatchObject({ order: 3, code: 'E2E-RULE-3', reason: 'fixture not-evaluated reason' });
    expectNoStorageLeak(JSON.stringify(detail));

    expect((await admin.get(apiUrl(`${LIST}/${DATE}/axi2320-${STAMP}-absent`))).status()).toBe(404);
    expect((await admin.get(apiUrl(`${LIST}/2099-02-30/${RUN.pass.runId}`))).status()).toBe(400);
    expect((await admin.get(apiUrl(detailPath(RUN.unreadable)))).status()).toBe(422);
  });

  test('AC14 — AXI-2320.3 (FR34): the admin page lists the runs with not-evaluated shown apart from fail, and opens a report', TAGS, async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/e2e-reports`);
    await expect(page.getByTestId('e2e-reports-table')).toBeVisible();
    for (const [run, verdict] of [[RUN.pass, 'pass'], [RUN.fail, 'fail'], [RUN.notEvaluated, 'not-evaluated'], [RUN.aborted, 'aborted'], [RUN.unreadable, 'unreadable']] as const) {
      await expect(page.getByTestId(`e2e-report-verdict-${rowId(run)}`)).toHaveAttribute('data-verdict', verdict);
    }
    const neBadge = page.getByTestId(`e2e-report-verdict-${rowId(RUN.notEvaluated)}`);
    const failBadge = page.getByTestId(`e2e-report-verdict-${rowId(RUN.fail)}`);
    await expect(neBadge).toHaveText('Not evaluated');
    expect(await neBadge.getAttribute('class')).not.toEqual(await failBadge.getAttribute('class'));
    await expect(page.getByTestId(`e2e-report-not-evaluated-${rowId(RUN.notEvaluated)}`)).toHaveText('2');
    await expect(page.getByTestId(`e2e-report-fail-${rowId(RUN.notEvaluated)}`)).toHaveText('0');
    await expect(page.getByTestId(`e2e-report-view-${rowId(RUN.unreadable)}`)).toBeDisabled();

    await page.getByTestId(`e2e-report-view-${rowId(RUN.fail)}`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/e2e-reports/${RUN.fail.date}/${RUN.fail.runId}$`));
    await expect(page.getByTestId('e2e-report-verdict')).toHaveAttribute('data-verdict', 'fail');
    await expect(page.getByTestId('e2e-report-counts')).toHaveText('1 / 1 / 1 / 1 (of 4)');
    await expect(page.getByTestId('e2e-case-row-3')).toHaveAttribute('data-outcome', 'not-evaluated');
    await expect(page.getByTestId('e2e-case-outcome-3')).toHaveText('Not evaluated');
    await page.getByTestId('e2e-report-filter').selectOption('not-evaluated');
    await expect(page.locator('[data-testid^="e2e-case-row-"]')).toHaveCount(1);
    // Rendered TEXT, not raw HTML (the markup legitimately carries SVG namespace URLs).
    expectNoStorageLeak(await page.locator('body').innerText());
  });

  test('AC14 — AXI-2320.4 (FR34): an aborted run shows where it stopped', TAGS, async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/e2e-reports/${RUN.aborted.date}/${RUN.aborted.runId}`);
    await expect(page.getByTestId('e2e-report-abort')).toContainText('fixtures/FIXTURE_MISSING');
    await expect(page.getByTestId('e2e-report-verdict')).toHaveAttribute('data-verdict', 'aborted');
    await expect(page.getByTestId('e2e-report-cases-empty')).toBeVisible();
  });
});

test.describe('AXI-2320 admin E2E reports — access boundary (NFR1)', () => {
  test('NFR1 — AXI-2320.5 (AC14): a non-admin user is refused 403 on the list and on a report — never an empty list', TAGS, async () => {
    const { api } = await nonAdmin();
    const ref = `${LIST}/${RUN.fail.date}/${RUN.fail.runId}`;
    for (const path of [LIST, `${LIST}?page=1&limit=10`, ref]) {
      const res = await api.get(apiUrl(path));
      expect(res.status(), `${path}: ${await res.text()}`).toBe(403);
      expect(await res.text()).not.toContain('"data"');
    }
    // Client-asserted authority buys nothing: query fields, role/tenancy headers.
    const spoofed = await api.get(apiUrl(`${LIST}?isPlatformAdmin=true&role=ADMIN`), {
      headers: { 'X-Role': 'ADMIN', 'X-Platform-Admin': 'true', 'X-Workspace-Id': '00000000-0000-0000-0000-000000000000' },
    });
    expect(spoofed.status()).toBe(403);
    await api.dispose();
  });

  test('NFR1 — AXI-2320.6 (AC14): an anonymous caller is refused 401', TAGS, async () => {
    const anon = await apiRequest.newContext();
    expect((await anon.get(apiUrl(LIST))).status()).toBe(401);
    expect((await anon.get(apiUrl(`${LIST}/${DATE}/any-run`))).status()).toBe(401);
    await anon.dispose();
  });

  test('NFR1 — AXI-2320.7 (AC14): a non-admin opening the page sees "Admin access required", not a report', TAGS, async ({ browser }) => {
    const { api, tokens } = await nonAdmin();
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page: Page = await context.newPage();
    await page.goto(BASE_URL);
    await page.evaluate(([a, r]) => {
      localStorage.setItem('access_token', a);
      localStorage.setItem('refresh_token', r);
    }, [tokens.accessToken, tokens.refreshToken] as const);
    for (const path of ['/admin/e2e-reports', `/admin/e2e-reports/${RUN.fail.date}/${RUN.fail.runId}`]) {
      await page.goto(`${BASE_URL}${path}`);
      await expect(page.getByTestId('e2e-reports-table')).toHaveCount(0);
      await expect(page.getByTestId('e2e-report-cases')).toHaveCount(0);
      await expect(page.getByTestId('e2e-reports-forbidden')).toContainText('Admin access required');
    }
    await context.close();
    await api.dispose();
  });
});
