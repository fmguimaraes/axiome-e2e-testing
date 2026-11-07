import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureAuthTokens, type AuthTokens } from '../../config/auth';
import { apiUrl } from '../../config/env';
import { ROLES } from '../../config/roles';
import { adminApi, adminToken, asList, sleep, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { INVESTIGATOR_ROLE_ID, addMember, person, signIn as signInPerson, type Person } from '../AXI-2308/harness/result-page';
import { apiCallOf, pinNewestT1 } from './harness/sap-api-stub';

/**
 * AXI-2446 (epic AXI-2433 — Structured Statistical Analysis Plan) — the SAP-run surface: the Runs
 * tab of `/projects/:id/sap` (table, inline icon buttons, the Run SAP dialog opened by
 * `?tab=runs&run=new`), the run detail `/projects/:id/sap/runs/:sapRunId` (header, classification
 * and reproduction mismatch, progress, verdicts in honest words, breadcrumb, no back button), the
 * ◆ SAP marker (analyses list, analysis detail, result page), the report download, the Settings
 * summary's last-run line and the Investigator mirror.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md`
 * § AXI-2446 (AXI-2446.1 … AXI-2446.8).
 *
 * E2E CONTRACT — REAL on the demo gateway: sign-in; the AXI-1400 fixture tenant with a FRESH
 * project per run; a per-run SALTED copy of the fixture dataset (so its governed steps compute in
 * this project instead of reusing another project's, which the result page 404s) and its READY
 * ingestions; the SAP draft API (AXI-2438), completeness and FINALISE (AXI-2439) on the NEWEST T1
 * (`pinNewestT1`, never a hard-coded version); Run SAP through the dialog and its real pre-flight
 * (AXI-2441: `POST …/saps/:sapId/runs`, refused as `dataset_version_not_current` once a newer
 * ingestion exists); the run list and detail with their evaluation (AXI-2442); a real
 * reproduction (second run, same version and dataset version); `sapRunId` on `GET /view-analyses`
 * and `sapRun` on the child run's result page; a plain view analysis; the Investigator membership;
 * the SAP-run report download (AXI-2444: `GET …/runs/:sapRunId/report`, a write-once Markdown
 * attachment with `X-Report-Hash`). NOTHING is doubled.
 * The reproduction's mismatch is asserted AS THE SERVER
 * STATES IT (badge and per-question names iff `reproductionMismatch` is present); whether an
 * identical reproduction should differ at all is AXI-2442's contract (its spec), not this surface's.
 *
 * Run with `--no-deps` (signs in through the API, no `setup` storageState).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const FIXTURE = 'opening-templates-paul-header.csv';
const PROFILE_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 240_000;
const HONEST_WORDING = /proven|confirmed effect|significant effect confirmed/i;
const VERDICT_LABELS: Record<string, string> = { met: 'Met', met_exploratory: 'Met (exploratory)', not_met: 'Not met', not_tested: 'Not tested', failed_to_run: 'Failed to run' };
const SUMMARY_ORDER = ['met', 'met_exploratory', 'not_met', 'not_tested', 'failed_to_run'];
const VERDICT_SUMMARY_SHAPE = /^\d+ (Met|Met \(exploratory\)|Not met|Not tested|Failed to run)( · \d+ (Met|Met \(exploratory\)|Not met|Not tested|Failed to run))*$/;

let api: Api;
let t: Tenant;
let admin: AuthTokens;
let adminUserId: string;
let dataset: AnchoredDataset;
let investigator: Person;
let sapId: string;
let version: any;
let templateVersion: string;
let readyIngestion: { id: string; ingestionVersion: number };
let plainAnalysisId: string;
/** The run started through the dialog (AXI-2446.2), once evaluated. */
let firstRun: any;
/** A real reproduction of it: same version, same dataset version. */
let reproduction: any;

const runsPath = (rest = '') => `/api/v1/projects/${t.projectId}/saps/${sapId}/runs${rest}`;
const sapUrl = (query = '') => `/projects/${t.projectId}/sap${query}`;
const runUrl = (sapRunId: string) => `/projects/${t.projectId}/sap/runs/${sapRunId}`;
const ok = (res: { status: number; body: any }, what: string, status = 201) => {
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(status);
  return res.body;
};

/** The verdict the surface shows for one stored question result (EC15: `met` on an exploratory question). */
const displayOf = (q: any) => (q.verdict === 'met' && q.role === 'exploratory' ? 'met_exploratory' : q.verdict);
/** `Qn` of each plan question, by its plan position. */
function qLabelOf(questionId: string): string {
  const byPosition = [...version.plan.questions].sort((a: any, b: any) => a.position - b.position);
  return `Q${byPosition.findIndex((q: any) => q.questionId === questionId) + 1}`;
}
/** The questions the SERVER says differ from the reproduced run (absent = no mismatch). */
const mismatchedOf = (run: any): string[] => (run.reproductionMismatch ?? []).map((m: any) => qLabelOf(m.questionId));

/** The Runs-table summary the surface must show for a stored, completed run. */
function expectedSummary(run: any): string {
  const counts = new Map<string, number>();
  for (const q of run.questions) counts.set(displayOf(q), (counts.get(displayOf(q)) ?? 0) + 1);
  return SUMMARY_ORDER.filter((d) => counts.get(d)).map((d) => `${counts.get(d)} ${VERDICT_LABELS[d]}`).join(' · ');
}

function sapQuestion(text: string, role: string, outcome: string) {
  return {
    text,
    role,
    estimand: {
      population: 'All patients',
      variable: outcome,
      intercurrentEvents: 'Treatment policy',
      populationSummary: 'Difference in medians',
      treatmentComparison: 'Female vs male',
    },
    template: { templateId: 'T1', templateVersion },
    bindings: [
      { slot: 'groupingColumn', column: 'sexe', semanticRole: 'grouping_two_levels' },
      { slot: 'outcome', column: outcome, semanticRole: 'continuous' },
    ],
    parameters: { alpha: 0.05, sidedness: 'two_sided' },
    decisionCriterion: { kind: 'p_at_or_below_alpha' },
    sensitivityAnalyses: [],
  };
}

/**
 * The dataset's CURRENT version once READY: its latest ingestion by `createdAt` (the server's rule).
 * `besides` waits for a NEWER one — a re-ingestion keeps the same `ingestionVersion`.
 */
async function waitReady(datasetId: string, besides?: string): Promise<{ id: string; ingestionVersion: number }> {
  const deadline = Date.now() + PROFILE_WAIT_MS;
  for (;;) {
    const ingestions = asList(ok(await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/ingestions`, t.headers), 'ingestions', 200))
      .sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const newest = ingestions[0];
    if (newest && newest.id !== besides && newest.status === 'ready') return newest;
    if (newest?.status === 'failed' || Date.now() > deadline) throw new Error(`ingestion of ${datasetId}: ${JSON.stringify(newest)}`);
    await sleep(2_000);
  }
}

/**
 * The fixture, salted with a per-run constant column so its governed steps COMPUTE in this project.
 * The shared fixture would make the child runs REUSE another project's steps, and the result page
 * refuses a reused step that is not placed in the caller's project (404 "Run not found").
 */
async function ingestSaltedFixture(): Promise<string> {
  const nonce = String(Date.now());
  const lines = readFileSync(join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', FIXTURE), 'utf-8').trimEnd().split('\n');
  const csv = `${lines.map((l, i) => `${l},${i === 0 ? 'e2e_salt' : nonce}`).join('\n')}\n`;
  const filename = `axi2446-${nonce}-${FIXTURE}`;
  const init = ok(await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: filename, contentType: 'text/csv',
  }, t.headers), 'upload init', 201);
  const put = await fetch(init.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: csv });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const id = init.dataset.id;
  const fin = await api.patch(`/api/v1/workspaces/${t.workspaceId}/datasets/${id}/finalize`, undefined, t.headers);
  expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
  await waitReady(id);
  const link = await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId: id }, t.headers);
  expect(link.status, JSON.stringify(link.body)).toBeLessThan(300);
  return id;
}

/** A real final version 1 (AXI-2438 draft + AXI-2439 finalise) with a primary, a key secondary and an exploratory question. */
async function finaliseRealSap(): Promise<any> {
  const base = `/api/v1/projects/${t.projectId}`;
  let draft = ok(await api.post(`${base}/saps/draft`, {}, t.headers), 'start draft');
  const titled = await api.ctx.put(apiUrl(`${base}/saps/${draft.sapId}/draft`), { data: { basedOnRevision: draft.revision, title: 'IgG4 primary plan' }, headers: t.headers });
  expect(titled.status(), await titled.text()).toBe(200);
  draft = await titled.json();
  for (const [text, role, outcome] of [
    ['Does IgG4 differ by sex?', 'primary', 'igg4_g_l'],
    ['Does MAG4-27 differ by sex?', 'key_secondary', 'microbiote_igg4_mag4_27'],
    ['Does MAG4-22 differ by sex?', 'exploratory', 'microbiote_igg4_mag4_22'],
  ]) {
    draft = ok(await api.post(`${base}/saps/${draft.sapId}/draft/questions`, {
      basedOnRevision: draft.revision, analysisDatasetId: dataset.datasetId, question: sapQuestion(text, role, outcome),
    }, t.headers), `add ${role}`);
  }
  const failing = async () => {
    const res = ok(await api.get(`${base}/saps/${draft.sapId}/draft/completeness`, t.headers), 'completeness', 200);
    return res.results.filter((r: any) => r.status === 'fail').map((r: any) => `${r.checkId}: ${r.message}`);
  };
  await expect.poll(failing, { timeout: PROFILE_WAIT_MS, intervals: [2_000, 5_000] }).toEqual([]);
  return ok(await api.post(`${base}/saps/${draft.sapId}/draft/finalise`, { basedOnRevision: draft.revision, basedOnVersion: null }, t.headers), 'finalise');
}

/** The stored run once every child has settled (AXI-2442 evaluates on read). */
async function evaluatedRun(sapRunId: string): Promise<any> {
  let latest: any = null;
  await expect.poll(async () => {
    const res = await api.get(runsPath(`/${sapRunId}`), t.headers);
    latest = res.status === 200 ? res.body : null;
    return latest?.status ?? `http ${res.status}`;
  }, { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] }).not.toBe('running');
  return latest;
}

/** The team surface, signed in as the platform admin through the API. */
async function openAsAdmin(page: Page, url: string): Promise<void> {
  await page.addInitScript(
    ([access, refresh, org, ws, project]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-active-project', project);
    },
    [admin.accessToken, admin.refreshToken, t.orgId, t.workspaceId, t.projectId] as const,
  );
  await gotoSettled(page, url);
}

/** Every Run SAP start the page sends (the REAL route; observed, never fulfilled). */
function recordStarts(page: Page): unknown[] {
  const starts: unknown[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === runsPath()) starts.push(request.postDataJSON());
  });
  return starts;
}

function row(page: Page, sapRunId: string) {
  return page.locator(`[data-testid="sap-run-row"][data-run-id="${sapRunId}"]`);
}

test.beforeAll(async () => {
  test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
  api = await adminApi();
  const tenant = await ensureTenant(api);
  const created = ok(await api.post('/api/v1/projects', { name: `E2E AXI-2446 SAP runs ${Date.now()}`, workspaceId: tenant.workspaceId }, tenant.headers), 'project');
  t = { ...tenant, projectId: created.id };
  const datasetId = await ingestSaltedFixture();
  const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
  if (!anchored) throw new Error('fixture dataset could not be anchored');
  dataset = anchored;
  await approveCarriersFor(['stats.mann_whitney_u']);
  await silenceTours(await adminToken());
  const bootstrap = await apiRequest.newContext();
  admin = await ensureAuthTokens(bootstrap, ROLES.find((r) => r.name === 'admin')!);
  await bootstrap.dispose();
  adminUserId = ok(await api.get('/api/v1/auth/me', t.headers), 'me', 200).id;

  // REAL: the newest T1, the final version every run pins, and the READY ingestion the dialog offers.
  templateVersion = await pinNewestT1(apiCallOf(api.ctx, t.headers), t.projectId);
  version = await finaliseRealSap();
  sapId = version.id;
  readyIngestion = await waitReady(dataset.datasetId);

  plainAnalysisId = ok(await api.post('/api/v1/view-analyses', {
    projectId: t.projectId, datasetId: dataset.datasetId, name: 'Plain analysis (AXI-2446)', createdBy: adminUserId,
  }, t.headers), 'plain analysis').id;

  investigator = await person('investigator', t.workspaceId);
  await addMember(api, t, investigator, INVESTIGATOR_ROLE_ID);
  await silenceTours(investigator.accessToken);
});

test.afterAll(async () => {
  if (investigator) await api?.ctx.delete(apiUrl(`/api/v1/workspaces/${t.workspaceId}/members/${investigator.userId}`), { headers: t.headers }).catch(() => undefined);
  await investigator?.api.dispose();
  await api?.ctx.dispose();
});

test.describe('AXI-2446 SAP surface: Runs tab, run detail and ◆ SAP marker @SI-031 @SI-030', () => {
  test('§7 C.1 FR32 FR45 FR47 AXI-2446.2 Run SAP starts once and opens the run, which progresses to completed @SI-031 @SI-030', async ({ page }) => {
    // Arrange
    const starts = recordStarts(page);
    await openAsAdmin(page, sapUrl());

    // Act
    await page.getByTestId('sap-run').click();
    await expect(page).toHaveURL(/\/sap\?tab=runs&run=new$/);
    await expect(page.getByTestId('sap-run-dialog-version')).toHaveValue('1');
    await expect(page.getByTestId('sap-run-dialog-dataset-version')).toHaveValue(readyIngestion.id);
    await page.getByTestId('sap-run-dialog-confirm').dblclick();

    // Assert — exactly one start, carrying only the client's facts
    await expect(page).toHaveURL(new RegExp(`/projects/${t.projectId}/sap/runs/[0-9a-f-]{36}$`));
    expect(starts).toEqual([{ version: 1, datasetVersionId: readyIngestion.id, clientRequestId: expect.any(String) }]);
    const sapRunId = page.url().split('/').pop()!;
    const listed = ok(await api.get(runsPath(), t.headers), 'list', 200);
    expect(listed.meta.total).toBe(1);
    expect(listed.data[0].sapRunId).toBe(sapRunId);

    // Assert — while running, live progress; then completed without a reload
    const detail = page.getByTestId('sap-run-detail');
    await expect(detail).toHaveAttribute('data-run-status', /^(running|completed)$/);
    if ((await detail.getAttribute('data-run-status')) === 'running') {
      await expect(page.getByTestId('sap-run-running')).toBeVisible();
      await expect(page.getByTestId('sap-run-progress-count')).toHaveText(/^[0-3] of 3 analyses finished$/);
    }
    await expect(detail).toHaveAttribute('data-run-status', 'completed', { timeout: EVALUATION_WAIT_MS });
    firstRun = await evaluatedRun(sapRunId);
    expect(firstRun.status).toBe('completed');
    await expect(page.getByTestId('sap-run-running')).toHaveCount(0);
    await expect(page.getByTestId('sap-run-progress-count')).toHaveText('3 of 3 analyses finished');
    await expect(page.getByTestId('sap-run-verdict-summary')).toHaveText(expectedSummary(firstRun));
    await expect(page.getByTestId('sap-run-detail-report')).toBeEnabled();
  });

  test('FR65 AC21 AXI-2446.1 the Runs tab lists every run with its facts and inline icon actions @SI-031', async ({ page }) => {
    // Arrange — a real reproduction: same version, same dataset version, after the first completed
    const started = ok(await api.post(runsPath(), { version: 1, datasetVersionId: readyIngestion.id, clientRequestId: randomUUID() }, t.headers), 'reproduction');
    expect(started.classification).toBe('reproduction');
    reproduction = await evaluatedRun(started.sapRunId);
    expect(reproduction.status).toBe('completed');
    test.info().annotations.push({ type: 'reproductionMismatch', description: JSON.stringify(reproduction.reproductionMismatch ?? null) });
    await openAsAdmin(page, sapUrl('?tab=runs'));

    // Assert — newest first, with every column
    await expect(page.getByTestId('sap-runs-count')).toHaveText('2 SAP runs, newest first.', { timeout: 30_000 });
    const ids = await page.getByTestId('sap-run-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-run-id')));
    expect(ids).toEqual([reproduction.sapRunId, firstRun.sapRunId]);
    const repro = row(page, reproduction.sapRunId);
    await expect(repro.getByTestId('sap-run-version')).toHaveText('Version 1');
    await expect(repro.getByTestId('sap-run-dataset-version')).toHaveText(`Ingestion v${readyIngestion.ingestionVersion}`);
    await expect(repro.getByTestId('sap-run-by')).not.toHaveText('');
    await expect(repro.getByTestId('sap-run-started')).not.toHaveText('');
    // The badge renders the server's FR44 fact — present iff `reproductionMismatch` is.
    await expect(repro.getByTestId('sap-run-classification')).toContainText('Reproduction');
    await expect(repro.getByTestId('sap-run-mismatch')).toHaveCount(mismatchedOf(reproduction).length > 0 ? 1 : 0);
    await expect(repro.getByTestId('sap-run-status')).toHaveText('Completed');
    await expect(repro.getByTestId('sap-run-verdicts')).toHaveText(VERDICT_SUMMARY_SHAPE);
    await expect(repro.getByTestId('sap-run-verdicts')).toHaveText(expectedSummary(reproduction));
    const first = row(page, firstRun.sapRunId);
    await expect(first.getByTestId('sap-run-classification')).toHaveText('Planned final look');
    await expect(first.getByTestId('sap-run-mismatch')).toHaveCount(0);
    await expect(first.getByTestId('sap-run-verdicts')).toHaveText(expectedSummary(firstRun));

    // Assert — the inline icon buttons (no text buttons, no back button)
    for (const id of ['sap-run-open', 'sap-run-open-analysis', 'sap-run-report']) await expect(repro.getByTestId(id)).toBeVisible();
    await expect(repro.getByTestId('sap-run-report')).toBeEnabled();
    await expect(page.getByRole('button', { name: /^back$/i })).toHaveCount(0);
  });

  test('FR49 AXI-2446.6 a completed run downloads its report @SI-031', async ({ page }) => {
    // Arrange
    await openAsAdmin(page, sapUrl('?tab=runs'));

    // Act
    const reportPath = runsPath(`/${reproduction.sapRunId}/report`);
    const served = page.waitForResponse((res) => new URL(res.url()).pathname === reportPath && res.request().method() === 'GET');
    const download = page.waitForEvent('download');
    await row(page, reproduction.sapRunId).getByTestId('sap-run-report').click();

    // Assert — the real write-once report: the server's filename and its content hash
    const res = await served;
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toBe(`attachment; filename="sap-run-report-${reproduction.sapRunId}.md"`);
    expect(res.headers()['x-report-hash']).toMatch(/^[0-9a-f]{64}$/);
    expect((await download).suggestedFilename()).toBe(`sap-run-report-${reproduction.sapRunId}.md`);
  });

  test('FR44 FR65 NFR11 NFR12 AC21 AC33 AXI-2446.4 the run detail shows header, classification, progress and verdicts in honest words @SI-030 @SI-031', async ({ page }) => {
    // Arrange
    await openAsAdmin(page, sapUrl('?tab=runs'));

    // Act
    await row(page, reproduction.sapRunId).getByTestId('sap-run-open').click();

    // Assert — the route and the header
    await expect(page).toHaveURL(new RegExp(`${runUrl(reproduction.sapRunId)}$`));
    await expect(page.getByTestId('sap-run-detail')).toHaveAttribute('data-run-status', 'completed');
    await expect(page.getByTestId('sap-run-header-version')).toHaveText('Version 1 · IgG4 primary plan');
    await expect(page.getByTestId('sap-run-header-dataset-version')).toHaveText(`Ingestion v${readyIngestion.ingestionVersion}`);
    await expect(page.getByTestId('sap-run-header-status')).toContainText('Completed');

    // Assert — classification, and the mismatch exactly as the server states it (FR44), named per question
    await expect(page.getByTestId('sap-run-classification-label')).toHaveText('Reproduction');
    const mismatched = mismatchedOf(reproduction);
    if (mismatched.length === 0) {
      await expect(page.getByTestId('sap-run-reproduction-mismatch')).toHaveCount(0);
    } else {
      for (const q of mismatched) {
        await expect(page.getByTestId('sap-run-reproduction-mismatch')).toContainText(q);
        await expect(page.getByTestId(`sap-verdict-mismatch-${q}`)).toBeVisible();
      }
    }
    for (const q of ['Q1', 'Q2', 'Q3'].filter((l) => !mismatched.includes(l))) await expect(page.getByTestId(`sap-verdict-mismatch-${q}`)).toHaveCount(0);

    // Assert — progress and the verdict table in the plan's testing order, each verdict as stored
    await expect(page.getByTestId('sap-run-progress-count')).toHaveText('3 of 3 analyses finished');
    const rows = await page.getByTestId('sap-run-verdict-table').locator('tbody tr').evaluateAll((trs) => trs.map((r) => r.getAttribute('data-testid')));
    expect(rows).toEqual(['sap-verdict-row-Q1', 'sap-verdict-row-Q2', 'sap-verdict-row-Q3']);
    const byPosition = [...version.plan.questions].sort((a: any, b: any) => a.position - b.position);
    for (const [i, planned] of byPosition.entries()) {
      const stored = reproduction.questions.find((q: any) => q.questionId === planned.questionId);
      expect(stored, `stored result of Q${i + 1}`).toBeTruthy();
      await expect(page.getByTestId(`sap-verdict-Q${i + 1}`)).toHaveText(VERDICT_LABELS[displayOf({ ...stored, role: planned.role })]);
      await expect(page.getByTestId(`sap-verdict-meaning-Q${i + 1}`)).not.toHaveText('');
    }
    await expect(page.getByTestId('sap-run-procedure-note')).toContainText('not proof of an effect');
    await expect(page.getByText('Research Use Only (RUO)')).toBeVisible();
    expect(await page.getByTestId('sap-run-detail').innerText()).not.toMatch(HONEST_WORDING);

    // Assert — breadcrumb resolves the run; no back button
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs.getByRole('link', { name: 'Statistical Analysis Plan', exact: true })).toHaveAttribute('href', sapUrl());
    await expect(crumbs).toContainText('SAP run · ');
    await expect(page.getByRole('button', { name: /^back$/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^back$/i })).toHaveCount(0);

    // Act — the Runs crumb returns to the Runs tab
    await crumbs.getByRole('link', { name: 'Runs', exact: true }).click();

    // Assert
    await expect(page).toHaveURL(new RegExp(`${sapUrl()}\\?tab=runs$`));
    await expect(page.getByTestId('sap-runs-tab')).toBeVisible();
  });

  test('FR48 EC26 AXI-2446.5 ◆ SAP marks the run\'s analysis on the detail, the list and the result page; never a plain one @SI-035 @SI-066', async ({ page }) => {
    // Arrange
    const marked = firstRun;
    const childRunId = [...marked.questions].find((q: any) => q.childRunId)?.childRunId;
    expect(marked.viewAnalysisId, 'the run stores its ◆ SAP analysis').toEqual(expect.any(String));
    expect(childRunId, 'a child run of the run').toEqual(expect.any(String));
    await openAsAdmin(page, sapUrl('?tab=runs'));

    // Act — Open ◆ SAP analysis
    await row(page, marked.sapRunId).getByTestId('sap-run-open-analysis').click();

    // Assert — the analysis detail carries ◆ SAP, linking back to the run
    await expect(page).toHaveURL(new RegExp(`/projects/${t.projectId}/view-analyses/${marked.viewAnalysisId}$`));
    const detailMarker = page.getByTestId('analysis-detail-sap-marker');
    await expect(detailMarker).toHaveText('◆ SAP', { timeout: 60_000 });
    await expect(detailMarker).toHaveAttribute('href', runUrl(marked.sapRunId));

    // Assert — the analyses list: the run's analysis is marked; a plain one is not
    await gotoSettled(page, `/projects/${t.projectId}/view-analyses`);
    await expect(page.locator(`[data-row-id="${marked.viewAnalysisId}"]`).getByTestId('analysis-sap-marker')).toHaveText('◆ SAP', { timeout: 60_000 });
    await expect(page.locator(`[data-row-id="${plainAnalysisId}"]`)).toBeVisible();
    await expect(page.locator(`[data-row-id="${plainAnalysisId}"]`).getByTestId('analysis-sap-marker')).toHaveCount(0);

    // Assert — the result page of a child run links to its SAP run
    await gotoSettled(page, `/projects/${t.projectId}/runs/${childRunId}`);
    await expect(page.getByTestId('rp-sap-marker')).toHaveText('◆ SAP', { timeout: 120_000 });
    await expect(page.getByTestId('rp-sap-marker')).toHaveAttribute('href', runUrl(marked.sapRunId));

    // Act — the marker opens the run
    await page.getByTestId('rp-sap-marker').click();

    // Assert
    await expect(page).toHaveURL(new RegExp(`${runUrl(marked.sapRunId)}$`));
    await expect(page.getByTestId('sap-run-detail')).toBeVisible();
  });

  test('FR66 AXI-2446.7 Settings → Statistical shows the last run and opens it @SI-031', async ({ page }) => {
    // Arrange
    await openAsAdmin(page, `/projects/${t.projectId}/settings?tab=statistical`);

    // Assert
    const lastRun = page.getByTestId('sap-summary-last-run');
    await expect(lastRun).toContainText(`Completed · Reproduction · ${expectedSummary(reproduction)}`);

    // Act
    await lastRun.getByRole('link').click();

    // Assert
    await expect(page).toHaveURL(new RegExp(`${runUrl(reproduction.sapRunId)}$`));
    await expect(page.getByTestId('sap-run-detail')).toBeVisible();
  });

  test('FR66 NFR12 AXI-2446.8 the Investigator reads the runs and a run on his own surface; Run SAP follows his permissions @SI-066', async ({ browser }) => {
    // Arrange
    const page = await browser.newPage();
    await signInPerson(page, investigator, t, `/investigator/projects/${t.projectId}/sap?tab=runs`);

    // Assert — the table, without a team analysis link; Run SAP exactly as FR64 and HIS server-resolved
    // permissions say (the seeded Investigator role holds `governed_execution:submit`, so it is offered)
    await expect(page.getByTestId('investigator-surface')).toBeVisible();
    await expect(page.getByTestId('sap-run-row')).toHaveCount(2);
    const mine = await investigator.api.get(apiUrl('/api/v1/workspace-permissions/me'), {
      headers: { Authorization: `Bearer ${investigator.accessToken}`, 'X-Workspace-Id': t.workspaceId },
    });
    expect(mine.status(), await mine.text()).toBe(200);
    const holdsSubmit = ((await mine.json()).permissions as string[]).includes('governed_execution:submit');
    await expect(page.getByTestId('sap-runs-run')).toHaveCount(holdsSubmit ? 1 : 0);
    await expect(row(page, reproduction.sapRunId).getByTestId('sap-run-open-analysis')).toHaveCount(0);

    // Act
    await row(page, reproduction.sapRunId).getByTestId('sap-run-open').click();

    // Assert — his route, the verdicts, no team analysis link
    await expect(page).toHaveURL(new RegExp(`/investigator/projects/${t.projectId}/sap/runs/${reproduction.sapRunId}$`));
    await expect(page.getByTestId('sap-run-verdict-table')).toBeVisible();
    await expect(page.getByTestId('sap-run-analysis-link')).toHaveCount(0);
    await page.close();
  });

  // LAST: it makes the runs' dataset version non-current by ingesting the dataset again.
  test('FR35 EC7 AXI-2446.3 a pre-flight refusal names every problem and creates nothing @SI-031', async ({ page }) => {
    // Arrange — a newer READY ingestion of the same dataset, so the older one is no longer current
    const reingest = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets/${dataset.datasetId}/ingestions`, { organizationId: t.orgId }, t.headers);
    expect(reingest.status, JSON.stringify(reingest.body)).toBeLessThan(300);
    const newer = await waitReady(dataset.datasetId, readyIngestion.id);
    const starts = recordStarts(page);
    await openAsAdmin(page, sapUrl());

    // Act — Run SAP on the Plan tab opens the dialog on the Runs tab; pick the older version
    await page.getByTestId('sap-run').click();
    await expect(page.getByTestId('sap-run-dialog')).toBeVisible();
    await expect(page.getByTestId('sap-run-dialog-dataset-version')).toHaveValue(newer.id);
    await page.getByTestId('sap-run-dialog-dataset-version').selectOption(readyIngestion.id);
    await page.getByTestId('sap-run-dialog-confirm').click();

    // Assert — refused by the real pre-flight: a dataset-version problem (no question), nothing created
    await expect(page.getByTestId('sap-run-dialog-error')).toContainText('Nothing was created');
    const problems = page.getByTestId('sap-run-dialog-problems');
    await expect(problems).toContainText(/^Dataset version: .*not the dataset's current version/);
    expect(starts).toHaveLength(1);
    await expect(page).toHaveURL(/\/sap\?tab=runs&run=new$/);
    await page.getByTestId('sap-run-dialog-cancel').click();
    await expect(page.getByTestId('sap-run-dialog')).toHaveCount(0);
    await expect(page.getByTestId('sap-run-row')).toHaveCount(2);
    expect(ok(await api.get(runsPath(), t.headers), 'list', 200).meta.total).toBe(2);
  });
});
