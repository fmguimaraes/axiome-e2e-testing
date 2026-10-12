import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { BASE_URL } from '../../config/env';
import { adminApi, asList, sleep, workspaceHeader, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, ensureAnalysis, carrierRuleId, type Tenant, type Analysis } from '../AXI-1400/harness/seed';

/**
 * AXI-2034 (epic AXI-2031 — FR10, NFR4, AC5, EC4, EC5): q-values over a
 * caller-chosen set of completed correlation runs.
 *
 * Scenario doc: manual-e2e/AXI-2031-Non-Parametric-Statistics-Coverage.md
 * (`### AXI-2034` section).
 *
 * STATUS: authored against the design contract (gateway
 * `POST /rule-runs/correlation-family-adjust`, panel at
 * `/rules/correlation-q-values`) but NOT RUN this story — no Docker stack
 * was brought up and no database/bucket was written to, per story scope.
 * Do not read a green/red result from this file until it has actually been
 * executed (`npx playwright test tests/AXI-2031/AXI-2034-*`).
 *
 * Seeding reuses the AXI-1400 harness (`ensureTenant`/`ensureAnalysis`/
 * `carrierRuleId`) read-only; this story owns only its own fixture CSV
 * (`tests/AXI-2031/fixtures/correlation-family.csv`) and its own ingestion
 * helper below, so it never writes into another story's fixtures directory.
 */

const FIXTURES_DIR = join(process.cwd(), 'tests', 'AXI-2031', 'fixtures');
const FIXTURE_FILE = 'correlation-family.csv';
const INGEST_TIMEOUT_MS = 90_000;
const INGEST_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 120_000;
const RUN_POLL_MS = 2_000;

async function ingestCorrelationFixture(api: Api, t: Tenant): Promise<string> {
  const ws = t.workspaceId;
  const existing = await api.get(`/api/v1/workspaces/${ws}/datasets?search=${encodeURIComponent(FIXTURE_FILE)}`, t.headers);
  const prior = asList(existing.body).find((d: any) => d.originalFilename === FIXTURE_FILE && d.availability === 'available');
  const datasetId = prior ? prior.id : await uploadAndFinalize(api, t);
  await ensureLink(api, t, datasetId);
  return datasetId;
}

async function uploadAndFinalize(api: Api, t: Tenant): Promise<string> {
  const ws = t.workspaceId;
  const bytes = readFileSync(join(FIXTURES_DIR, FIXTURE_FILE));
  const init = await api.post(`/api/v1/workspaces/${ws}/datasets`, {
    organizationId: t.orgId, originalFilename: FIXTURE_FILE, contentType: 'text/csv',
  }, t.headers);
  const datasetId = init.body.dataset.id;
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes) });
  if (!put.ok) throw new Error(`presigned PUT of ${FIXTURE_FILE} failed (${put.status})`);
  const fin = await api.patch(`/api/v1/workspaces/${ws}/datasets/${datasetId}/finalize`, undefined, t.headers);
  if (fin.status >= 300) throw new Error(`finalize ${FIXTURE_FILE} failed (${fin.status})`);
  await waitForIngestion(api, t, datasetId);
  return datasetId;
}

async function waitForIngestion(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const deadline = Date.now() + INGEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const d = await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}`, t.headers);
    const status = d.body?.latestIngestion?.status;
    if (status === 'ready') return;
    if (status === 'failed') throw new Error(`ingestion of ${FIXTURE_FILE} failed`);
    await sleep(INGEST_POLL_MS);
  }
  throw new Error(`ingestion of ${FIXTURE_FILE} timed out`);
}

async function ensureLink(api: Api, t: Tenant, datasetId: string): Promise<void> {
  const linked = async () => {
    const res = await api.get(`/api/v1/projects/${t.projectId}/datasets`, t.headers);
    return asList(res.body).some((l: any) => l.datasetId === datasetId);
  };
  if (await linked()) return;
  await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
  if (!(await linked())) throw new Error(`dataset ${datasetId} did not link to project ${t.projectId}`);
}

interface CorrelationRunArgs {
  roleBindings: Record<string, string>;
  operationParams: Record<string, unknown>;
  operationId?: string;
}

/** Submits a run and polls until it leaves a non-terminal status. Returns the final run body. */
async function runAndWait(api: Api, t: Tenant, a: Analysis, datasetId: string, args: CorrelationRunArgs): Promise<any> {
  const operationId = args.operationId ?? 'stats.correlation';
  const body = {
    ruleId: await carrierRuleId(operationId),
    runKind: 'STATISTICAL',
    operationId,
    roleBindings: args.roleBindings,
    operationParams: args.operationParams,
    projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
    snapshotId: a.snapshotId, viewAnalysisId: a.analysisId, scope: 'FILTERED',
  };
  const submitted = await api.post('/api/v1/rule-runs', body, t.headers);
  expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
  const ruleRunId = submitted.body.ruleRunId;

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = await api.get(`/api/v1/rule-runs/${ruleRunId}`, t.headers);
    if (run.body.status === 'SUCCEEDED' || run.body.status === 'FAILED') return run.body;
    await sleep(RUN_POLL_MS);
  }
  throw new Error(`run of ${operationId} timed out`);
}

test.describe.configure({ mode: 'serial', timeout: 240_000 });

let api: Api;
let t: Tenant;
let analysis: Analysis;
let datasetId: string;
/** Two DIFFERENT completed stats.correlation runs over the same referent — distinct
 *  fingerprints (pearson vs spearman) so they are two real, independent family members. */
let runPearsonId: string;
let runSpearmanId: string;
/** A completed stats.correlation run against a CONSTANT column (y_const): no variance
 *  means no defined coefficient — exercises EC4's "no testable p-value" exclusion. */
let runUndefinedPId: string;
/** A completed run of an UNRELATED operation — exercises the "wrong operation" refusal. */
let runWrongOperationId: string;

test.beforeAll(async () => {
  api = await adminApi();
  t = await ensureTenant(api);
  datasetId = await ingestCorrelationFixture(api, t);
  analysis = await ensureAnalysis(api, t, 'AXI-2034 correlation family', datasetId);

  const pearson = await runAndWait(api, t, analysis, datasetId, {
    roleBindings: { xColumn: 'x', yColumn: 'y' },
    operationParams: { method: 'pearson' },
  });
  runPearsonId = pearson.ruleRunId ?? pearson.id;

  const spearman = await runAndWait(api, t, analysis, datasetId, {
    roleBindings: { xColumn: 'x', yColumn: 'y' },
    operationParams: { method: 'spearman' },
  });
  runSpearmanId = spearman.ruleRunId ?? spearman.id;

  const undefinedP = await runAndWait(api, t, analysis, datasetId, {
    roleBindings: { xColumn: 'x', yColumn: 'y_const' },
    operationParams: { method: 'pearson' },
  });
  runUndefinedPId = undefinedP.ruleRunId ?? undefinedP.id;

  const wrongOp = await runAndWait(api, t, analysis, datasetId, {
    operationId: 'stats.mann_whitney_u',
    roleBindings: { groupColumn: 'group' },
    operationParams: { groupFrom: 'A', groupTo: 'B' },
  });
  runWrongOperationId = wrongOp.ruleRunId ?? wrongOp.id;
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

/** Pin workspace/org scope the SPA reads from localStorage (mirrors AXI-1419/AXI-1418's precedent) —
 *  the panel resolves `workspaceId` from `useTopMenuStore().activeWorkspaceId`, which is seeded here
 *  rather than driven through the top-menu UI picker. */
async function seedWorkspaceScope(page: Page): Promise<void> {
  await page.addInitScript(
    ([ws, org]) => {
      localStorage.setItem('axiome-active-workspace', ws);
      localStorage.setItem('axiome-top-org', org);
    },
    [t.workspaceId, t.orgId] as const,
  );
}

async function openPanel(page: Page) {
  await seedWorkspaceScope(page);
  await page.goto(`${BASE_URL}/rules/correlation-q-values`);
  await expect(page.getByTestId('correlation-family-adjust-panel')).toBeVisible();
}

test('AC5 — a selected set of completed correlation runs is adjusted and shows a q-value per run (@SI-017 @SI-035)', async ({ page }) => {
  await openPanel(page);
  await page.getByTestId(`correlation-family-candidate-checkbox-${runPearsonId}`).check();
  await page.getByTestId(`correlation-family-candidate-checkbox-${runSpearmanId}`).check();
  await page.getByTestId('correlation-family-adjust-trigger').click();

  await expect(page.getByTestId(`correlation-family-result-row-${runPearsonId}`)).toBeVisible();
  await expect(page.getByTestId(`correlation-family-result-row-${runSpearmanId}`)).toBeVisible();
});

test('EC4 — a member with no recorded p-value is excluded by name, never refused (@SI-017 @SI-035)', async ({ page }) => {
  await openPanel(page);
  await page.getByTestId(`correlation-family-candidate-checkbox-${runPearsonId}`).check();
  await page.getByTestId(`correlation-family-candidate-checkbox-${runUndefinedPId}`).check();
  await page.getByTestId('correlation-family-adjust-trigger').click();

  await expect(page.getByTestId(`correlation-family-result-row-${runPearsonId}`)).toBeVisible();
  await expect(page.getByTestId(`correlation-family-excluded-${runUndefinedPId}`)).toBeVisible();
});

test('EC5 — a family of one returns q equal to the raw p (@SI-017 @SI-035)', async ({ page }) => {
  await openPanel(page);
  await page.getByTestId(`correlation-family-candidate-checkbox-${runPearsonId}`).check();
  await page.getByTestId('correlation-family-adjust-trigger').click();

  const row = page.getByTestId(`correlation-family-result-row-${runPearsonId}`);
  await expect(row).toBeVisible();
  const cells = await row.locator('td').allTextContents();
  // columns: Run, Raw p, q-value, Significance, Method, Alpha
  expect(cells[1]).toBe(cells[2]);
});

test('NFR4 — named refusals via the API, never a silent failure (@SI-017 @SI-010)', async () => {
  const empty = await api.post('/api/v1/rule-runs/correlation-family-adjust', { ruleRunIds: [] }, t.headers);
  expect(empty.status).toBeGreaterThanOrEqual(400);

  const duplicate = await api.post('/api/v1/rule-runs/correlation-family-adjust', { ruleRunIds: [runPearsonId, runPearsonId] }, t.headers);
  expect(duplicate.status).toBeGreaterThanOrEqual(400);

  const wrongOperation = await api.post('/api/v1/rule-runs/correlation-family-adjust', { ruleRunIds: [runWrongOperationId] }, t.headers);
  expect(wrongOperation.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(wrongOperation.body)).toContain('stats.mann_whitney_u');

  // A foreign/absent run reports NOT FOUND, never FORBIDDEN (existence leak, NFR4).
  const foreign = await api.post(
    '/api/v1/rule-runs/correlation-family-adjust',
    { ruleRunIds: ['00000000-0000-4000-8000-000000000000'] },
    t.headers,
  );
  expect(foreign.status).toBe(404);
});
