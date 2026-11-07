import { expect, request as apiRequest, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureAuthTokens, type AuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';
import { adminApi, adminToken, asList, sleep, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { gotoSettled } from '../AXI-2308/harness/new-analysis';
import { apiCallOf, pinNewestT1 } from '../AXI-2433/harness/sap-api-stub';
import { apiUrl } from '../../config/env';

/**
 * AXI-2472 (epic AXI-2455; SAP FR71, FR43, EC33, AC36; SI-065 SI-010 SI-002 SI-031 SI-030) - the
 * Run SAP dialog's classification preview and its back route
 * `GET /api/v1/projects/:projectId/saps/:sapId/run-classification-preview`.
 *
 * Scenarios: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md § AXI-2472
 * (AXI-2472.1 ... AXI-2472.4). REAL on the gateway: a fresh project, a salted fixture dataset,
 * a one-question plan finalised on the NEWEST T1 (`pinNewestT1`), a real Run SAP, the real dialog.
 * AC36's "another dataset version" D2 is a RE-INGESTION of the SAP's analysis dataset (the
 * AXI-2446.3 pattern): a separate dataset would be refused by pre-flight EC8, never classified.
 * Run with `--no-deps` (signs in through the API, no `setup` storageState).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const FIXTURE = 'opening-templates-paul-header.csv';
const PROFILE_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 240_000;

let api: Api;
let t: Tenant;
let admin: AuthTokens;
let dataset: AnchoredDataset;
let sapId: string;
let templateVersion: string;
let d1: string;
let d2: string;
let firstRunId: string;

const previewPath = (query: string) => `/api/v1/projects/${t.projectId}/saps/${sapId}/run-classification-preview${query}`;
const runsPath = (rest = '') => `/api/v1/projects/${t.projectId}/saps/${sapId}/runs${rest}`;
const ok = (res: { status: number; body: any }, what: string, status = 201) => {
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(status);
  return res.body;
};

/** The newest ingestion of the dataset once it is ready - and, given `after`, a NEWER one than it. */
async function waitReady(datasetId: string, after?: string): Promise<string> {
  const deadline = Date.now() + PROFILE_WAIT_MS;
  for (;;) {
    const newest = asList(ok(await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/ingestions`, t.headers), 'ingestions', 200))
      .sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (newest?.status === 'ready' && newest.id !== after) return newest.id;
    if (newest?.status === 'failed' || Date.now() > deadline) throw new Error(`ingestion of ${datasetId}: ${JSON.stringify(newest)}`);
    await sleep(2_000);
  }
}

/** The fixture, salted per run so its governed steps COMPUTE in this project. */
async function ingestSaltedFixture(): Promise<string> {
  const nonce = `${Date.now()}`;
  const lines = readFileSync(join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', FIXTURE), 'utf-8').trimEnd().split('\n');
  const csv = `${lines.map((l, i) => `${l},${i === 0 ? 'e2e_salt' : nonce}`).join('\n')}\n`;
  const init = ok(await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: `axi2472-${nonce}-${FIXTURE}`, contentType: 'text/csv',
  }, t.headers), 'upload init');
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

async function finaliseOneQuestionSap(): Promise<any> {
  const base = `/api/v1/projects/${t.projectId}`;
  let draft = ok(await api.post(`${base}/saps/draft`, {}, t.headers), 'start draft');
  const titled = await api.ctx.put(apiUrl(`${base}/saps/${draft.sapId}/draft`), { data: { basedOnRevision: draft.revision, title: 'AXI-2472 preview plan' }, headers: t.headers });
  expect(titled.status(), await titled.text()).toBe(200);
  draft = await titled.json();
  draft = ok(await api.post(`${base}/saps/${draft.sapId}/draft/questions`, {
    basedOnRevision: draft.revision,
    analysisDatasetId: dataset.datasetId,
    question: {
      text: 'Does IgG4 differ by sex?',
      role: 'primary',
      estimand: { population: 'All patients', variable: 'igg4_g_l', intercurrentEvents: 'Treatment policy', populationSummary: 'Difference in medians', treatmentComparison: 'Female vs male' },
      template: { templateId: 'T1', templateVersion },
      bindings: [
        { slot: 'groupingColumn', column: 'sexe', semanticRole: 'grouping_two_levels' },
        { slot: 'outcome', column: 'igg4_g_l', semanticRole: 'continuous' },
      ],
      parameters: { alpha: 0.05, sidedness: 'two_sided' },
      decisionCriterion: { kind: 'p_at_or_below_alpha' },
      sensitivityAnalyses: [],
    },
  }, t.headers), 'add question');
  const failing = async () => {
    const res = ok(await api.get(`${base}/saps/${draft.sapId}/draft/completeness`, t.headers), 'completeness', 200);
    return res.results.filter((r: any) => r.status === 'fail').map((r: any) => `${r.checkId}: ${r.message}`);
  };
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

const runCount = async () => asList(ok(await api.get(runsPath(), t.headers), 'runs', 200)).length;

test.beforeAll(async () => {
  test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
  api = await adminApi();
  const tenant = await ensureTenant(api);
  const created = ok(await api.post('/api/v1/projects', { name: `E2E AXI-2472 preview ${Date.now()}`, workspaceId: tenant.workspaceId }, tenant.headers), 'project');
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
  templateVersion = await pinNewestT1(apiCallOf(api.ctx, t.headers), t.projectId);
  sapId = (await finaliseOneQuestionSap()).id;
  d1 = await waitReady(dataset.datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2472 Run SAP classification preview @SI-065 @SI-010 @SI-002 @SI-031 @SI-030', () => {
  test('FR71, FR43 - AXI-2472.1: with no SAP run the preview is a planned final look and writes nothing @SI-065 @SI-010', async () => {
    // Act
    const body = ok(await api.get(previewPath(`?version=1&datasetVersionId=${d1}`), t.headers), 'preview', 200);
    const latest = ok(await api.get(previewPath(`?datasetVersionId=${d1}`), t.headers), 'preview latest', 200);

    // Assert
    expect(body).toEqual({ classification: 'planned_final_look', reproducesSapRunId: null });
    expect(latest).toEqual(body);
    expect(await runCount()).toBe(0);
  });

  test('FR71, NFR1 - AXI-2472.2: the preview refuses as Run SAP does - 400 / 422 / 404 - and is never captured by runs/:sapRunId @SI-065 @SI-010', async () => {
    // Act
    const noDataset = await api.get(previewPath('?version=1'), t.headers);
    const notFinal = await api.get(previewPath(`?version=99&datasetVersionId=${d1}`), t.headers);
    const foreignDataset = await api.get(previewPath(`?version=1&datasetVersionId=${randomUUID()}`), t.headers);
    const badVersion = await api.get(previewPath(`?version=0&datasetVersionId=${d1}`), t.headers);
    const otherSap = await api.get(`/api/v1/projects/${t.projectId}/saps/${randomUUID()}/run-classification-preview?datasetVersionId=${d1}`, t.headers);

    // Assert
    expect(noDataset.status, JSON.stringify(noDataset.body)).toBe(400);
    expect(JSON.stringify(noDataset.body)).toContain('SAP_DATASET_VERSION_REQUIRED');
    expect(notFinal.status, JSON.stringify(notFinal.body)).toBe(422);
    expect(JSON.stringify(notFinal.body)).toContain('SAP_VERSION_NOT_FINAL');
    expect(foreignDataset.status).toBe(404);
    expect(badVersion.status).toBe(400);
    expect(otherSap.status).toBe(404);
    expect(await runCount()).toBe(0);
  });

  test('FR71, AC36, EC33 - AXI-2472.3: after a completed run on D1 the preview of D1 is a reproduction naming it; another version D2 of the same dataset previews unplanned; no run is written by a preview @SI-031 @SI-030 @SI-065', async ({ page }) => {
    test.setTimeout(EVALUATION_WAIT_MS + PROFILE_WAIT_MS + 120_000);
    // Arrange - a real completed run on D1
    const started = ok(await api.post(runsPath(), { version: 1, datasetVersionId: d1, clientRequestId: randomUUID() }, t.headers), 'first run');
    firstRunId = started.sapRunId;
    expect(started.classification).toBe('planned_final_look');
    await expect.poll(async () => (await api.get(runsPath(`/${firstRunId}`), t.headers)).body?.status, { timeout: EVALUATION_WAIT_MS, intervals: [3_000, 5_000] }).toBe('completed');
    const before = await runCount();

    // Act - preview D1, and the dialog while D1 is still current
    const same = ok(await api.get(previewPath(`?version=1&datasetVersionId=${d1}`), t.headers), 'preview D1', 200);
    await openAsAdmin(page, `/projects/${t.projectId}/sap?tab=runs&run=new`);
    await expect(page.getByTestId('sap-run-dialog-dataset-version')).toHaveValue(d1);

    // Assert
    expect(same).toEqual({ classification: 'reproduction', reproducesSapRunId: firstRunId });
    await expect(page.getByTestId('sap-run-dialog-classification')).toHaveText('Reproduction');
    await expect(page.getByTestId('sap-run-dialog-reproduces')).toContainText(firstRunId);

    // Arrange - D2: a newer READY ingestion of the SAP's analysis dataset (D1 is no longer current)
    const reingest = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets/${dataset.datasetId}/ingestions`, { organizationId: t.orgId }, t.headers);
    expect(reingest.status, JSON.stringify(reingest.body)).toBeLessThan(300);
    d2 = await waitReady(dataset.datasetId, d1);

    // Act - preview D2
    const other = ok(await api.get(previewPath(`?version=1&datasetVersionId=${d2}`), t.headers), 'preview D2', 200);

    // Assert
    expect(d2).not.toBe(d1);
    expect(other).toEqual({ classification: 'unplanned', reproducesSapRunId: null });
    expect(await runCount()).toBe(before);
  });

  test('FR71, AC36, EC33 - AXI-2472.4: the dialog opens on the current version D2 showing "Unplanned"; picking D1 shows "Reproduction" naming the run; the real start on D2 agrees with the preview @SI-031 @SI-030 @SI-065', async ({ page }) => {
    test.setTimeout(120_000);
    // Arrange
    const before = await runCount();
    await openAsAdmin(page, `/projects/${t.projectId}/sap?tab=runs&run=new`);
    const datasetVersion = page.getByTestId('sap-run-dialog-dataset-version');

    // Assert - D2 is current, so it is preselected and previews unplanned
    await expect(datasetVersion).toHaveValue(d2);
    await expect(page.getByTestId('sap-run-dialog-classification')).toHaveText('Unplanned');
    await expect(page.getByTestId('sap-run-dialog-reproduces')).toHaveCount(0);

    // Act - pick the older version D1
    await datasetVersion.selectOption(d1);

    // Assert - the preview refreshes for D1: a reproduction naming the completed run; nothing written
    await expect(page.getByTestId('sap-run-dialog-classification')).toHaveText('Reproduction');
    await expect(page.getByTestId('sap-run-dialog-reproduces')).toContainText(firstRunId);
    expect(await runCount()).toBe(before);

    // Act / Assert - the real start on D2 gets the class the dialog previewed for it (FR43; EC33
    // allows a race, this one has none). LAST: it writes a run on D2.
    const second = ok(await api.post(runsPath(), { version: 1, datasetVersionId: d2, clientRequestId: randomUUID() }, t.headers), 'run on D2');
    expect(second.classification).toBe('unplanned');
    expect(await runCount()).toBe(before + 1);
  });
});
