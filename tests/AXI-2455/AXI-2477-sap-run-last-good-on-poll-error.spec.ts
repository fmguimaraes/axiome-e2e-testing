import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureAuthTokens, type AuthTokens } from '../../config/auth';
import { apiUrl } from '../../config/env';
import { ROLES } from '../../config/roles';
import { adminApi, adminToken, asList, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { apiCallOf, pinNewestT1 } from '../AXI-2433/harness/sap-api-stub';

/**
 * AXI-2477 (epic AXI-2455 — SAP FR64, FR65, AC21; AXI-2446 review A3–A5) — the SAP-run detail page
 * keeps the last run it read when a poll fails, instead of blanking the verdict table.
 *
 * REAL: tenant, salted fixture, finalised SAP (AXI-2438/2439), the Run SAP start (AXI-2441) and every
 * run read. The only intervention is ONE poll answer of `GET …/runs/:sapRunId` replaced by a failure
 * (`route.fulfill`, once) — the transient error this story is about. The first page read is the
 * real, still-running run; if the run finished before the page read it, the test FAILS (it never
 * passes without exercising a poll).
 *
 * Scenario file: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md § AXI-2477.
 * Run with `--no-deps` (signs in through the API, no `setup` storageState).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const FIXTURE = 'opening-templates-paul-header.csv';
const PROFILE_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 240_000;
const POLL_WAIT_MS = 15_000;

let api: Api;
let t: Tenant;
let admin: AuthTokens;
let dataset: AnchoredDataset;
let sapId: string;
let templateVersion: string;
let readyIngestionId: string;

const runsPath = (rest = '') => `/api/v1/projects/${t.projectId}/saps/${sapId}/runs${rest}`;
const runUrl = (sapRunId: string) => `/projects/${t.projectId}/sap/runs/${sapRunId}`;
const ok = (res: { status: number; body: any }, what: string, status = 201) => {
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(status);
  return res.body;
};

function sapQuestion(text: string, role: string, outcome: string) {
  return {
    text,
    role,
    estimand: {
      population: 'All patients', variable: outcome, intercurrentEvents: 'Treatment policy',
      populationSummary: 'Difference in medians', treatmentComparison: 'Female vs male',
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

/** The dataset's current version once READY (latest ingestion by `createdAt`). */
async function waitReady(datasetId: string): Promise<string> {
  let newest: any = null;
  await expect.poll(async () => {
    const ingestions = asList(ok(await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/ingestions`, t.headers), 'ingestions', 200))
      .sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    newest = ingestions[0] ?? null;
    if (newest?.status === 'failed') throw new Error(`ingestion of ${datasetId}: ${JSON.stringify(newest)}`);
    return newest?.status;
  }, { timeout: PROFILE_WAIT_MS, intervals: [2_000] }).toBe('ready');
  return newest.id;
}

/** The fixture salted per run, so its governed steps COMPUTE here (never reused from another project). */
async function ingestSaltedFixture(): Promise<string> {
  const nonce = String(Date.now());
  const lines = readFileSync(join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', FIXTURE), 'utf-8').trimEnd().split('\n');
  const csv = `${lines.map((l, i) => `${l},${i === 0 ? 'e2e_salt' : nonce}`).join('\n')}\n`;
  const init = ok(await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: `axi2477-${nonce}-${FIXTURE}`, contentType: 'text/csv',
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

/** A real final version 1 with three questions (so a run takes several child runs to settle). */
async function finaliseRealSap(): Promise<any> {
  const base = `/api/v1/projects/${t.projectId}`;
  let draft = ok(await api.post(`${base}/saps/draft`, {}, t.headers), 'start draft');
  for (const [text, role, outcome] of [
    ['Does IgG4 differ by sex?', 'primary', 'igg4_g_l'],
    ['Does MAG4-27 differ by sex?', 'key_secondary', 'microbiote_igg4_mag4_27'],
    ['Does MAG4-22 differ by sex?', 'exploratory', 'microbiote_igg4_mag4_22'],
  ]) {
    draft = ok(await api.post(`${base}/saps/${draft.sapId}/draft/questions`, {
      basedOnRevision: draft.revision, analysisDatasetId: dataset.datasetId, question: sapQuestion(text, role, outcome),
    }, t.headers), `add ${role}`);
  }
  const failing = async () => ok(await api.get(`${base}/saps/${draft.sapId}/draft/completeness`, t.headers), 'completeness', 200)
    .results.filter((r: any) => r.status === 'fail').map((r: any) => `${r.checkId}: ${r.message}`);
  await expect.poll(failing, { timeout: PROFILE_WAIT_MS, intervals: [2_000, 5_000] }).toEqual([]);
  return ok(await api.post(`${base}/saps/${draft.sapId}/draft/finalise`, { basedOnRevision: draft.revision, basedOnVersion: null }, t.headers), 'finalise');
}

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

/** A REAL run, started through the API; the page is opened on it at once, while it is running. */
async function startRun(): Promise<string> {
  return ok(await api.post(runsPath(), { version: 1, datasetVersionId: readyIngestionId, clientRequestId: randomUUID() }, t.headers), 'start').sapRunId;
}

/**
 * Fails exactly the FIRST POLL of this run (its second GET) with `status`. The page's first read and
 * every later poll reach the server.
 */
async function failFirstPoll(page: Page, sapRunId: string, status: number): Promise<void> {
  let reads = 0;
  await page.route((url) => url.pathname === runsPath(`/${sapRunId}`), async (route) => {
    if (route.request().method() !== 'GET' || ++reads !== 2) return route.continue();
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ statusCode: status, message: 'injected by AXI-2477 e2e' }) });
  });
}

test.beforeAll(async () => {
  test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
  api = await adminApi();
  const tenant = await ensureTenant(api);
  const created = ok(await api.post('/api/v1/projects', { name: `E2E AXI-2477 SAP run poll ${Date.now()}`, workspaceId: tenant.workspaceId }, tenant.headers), 'project');
  t = { ...tenant, projectId: created.id };
  const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId: await ingestSaltedFixture() });
  if (!anchored) throw new Error('fixture dataset could not be anchored');
  dataset = anchored;
  await approveCarriersFor(['stats.mann_whitney_u']);
  await silenceTours(await adminToken());
  const bootstrap = await apiRequest.newContext();
  admin = await ensureAuthTokens(bootstrap, ROLES.find((r) => r.name === 'admin')!);
  await bootstrap.dispose();
  templateVersion = await pinNewestT1(apiCallOf(api.ctx, t.headers), t.projectId);
  sapId = (await finaliseRealSap()).id;
  readyIngestionId = await waitReady(dataset.datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2477 SAP-run detail keeps the last good run on a poll error @SI-031', () => {
  test('FR65 AC21 AXI-2477.1 a transient poll failure keeps the verdict table with a notice; the next read clears it @SI-031', async ({ page }) => {
    // Arrange — a real running run, on its detail page
    const sapRunId = await startRun();
    await failFirstPoll(page, sapRunId, 503);
    const firstRead = page.waitForResponse((res) => new URL(res.url()).pathname === runsPath(`/${sapRunId}`));
    await openAsAdmin(page, runUrl(sapRunId));
    expect((await firstRead).status(), 'the first page read must be the real run').toBe(200);
    const detail = page.getByTestId('sap-run-detail');
    await expect(detail, 'the run must still be running when the page first reads it (else no poll is exercised)').toHaveAttribute('data-run-status', 'running');

    // Act — the first poll is the injected 503 (route), the next ones are real

    // Assert — the page keeps the run read, says so, and never shows the load error
    await expect(page.getByTestId('sap-run-refresh-failed')).toBeVisible({ timeout: POLL_WAIT_MS });
    await expect(page.getByTestId('sap-run-verdict-table')).toBeVisible();
    await expect(page.getByTestId('sap-run-header')).toBeVisible();
    await expect(page.getByTestId('sap-run-error')).toHaveCount(0);
    await expect(page.getByTestId('sap-run-refresh-failed')).toHaveCount(0, { timeout: POLL_WAIT_MS });
    await expect(detail).toHaveAttribute('data-run-status', 'completed', { timeout: EVALUATION_WAIT_MS });
  });

  test('FR65 AXI-2477.2 a refused poll (403) replaces the run with the access message and stops polling @SI-031', async ({ page }) => {
    // Arrange — a second real run (a reproduction), opened while running
    const sapRunId = await startRun();
    const isRunRead = (res: { url(): string }) => new URL(res.url()).pathname === runsPath(`/${sapRunId}`);
    const reads: number[] = [];
    page.on('response', (res) => { if (isRunRead(res)) reads.push(res.status()); });
    await failFirstPoll(page, sapRunId, 403);
    await openAsAdmin(page, runUrl(sapRunId));
    await expect(page.getByTestId('sap-run-detail'), 'the run must still be running when the page first reads it').toHaveAttribute('data-run-status', 'running');

    // Assert — the server's refusal wins over the last good run, and no further read is sent
    await expect(page.getByTestId('sap-run-error')).toHaveText(/You do not have access to this SAP run\./, { timeout: POLL_WAIT_MS });
    await expect(page.getByTestId('sap-run-verdict-table')).toHaveCount(0);
    expect(reads.at(-1)).toBe(403);
    // No read follows within > 2 poll intervals (SAP_RUN_POLL_MS = 3 s).
    const another = await page.waitForResponse(isRunRead, { timeout: 8_000 }).then(() => true, () => false);
    expect(another, 'polling must stop after a refused read').toBe(false);
  });
});
