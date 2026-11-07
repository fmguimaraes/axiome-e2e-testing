import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { adminApi, asList, sleep, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { apiCallOf, pinNewestT1 } from './harness/sap-api-stub';
import { apiUrl } from '../../config/env';

/**
 * AXI-2450 (defect in AXI-2442; epic AXI-2433 — FR43, FR44, AC18, EC20, NFR5) — a reproduction
 * of a 3-question plan (primary, key secondary, exploratory) on the SAME version and dataset
 * version stores NO reproduction mismatch. Before the fix it reported `p_value` on the two
 * confirmatory questions although both runs store identical p-values: the comparison used the
 * in-memory doubles while the reproduced run's came back from the JSON column, which moved two of
 * them by 1–2 ULP. The fixture is the one AXI-2446 found it on (`sexe` × IgG4 / MAG4-27 / MAG4-22),
 * so these are exactly the p-values that do not survive the column bit-exact.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2433-Structured-Statistical-Analysis-Plan.md
 * § "AXI-2450 — reproduction of a 3-question plan" (AXI-2450.1, AXI-2450.2). API-level by design.
 * Run with `--no-deps` (signs in through the API, no `setup` storageState).
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const FIXTURE = 'opening-templates-paul-header.csv';
const PROFILE_WAIT_MS = 120_000;
const EVALUATION_WAIT_MS = 240_000;
const QUESTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['Does IgG4 differ by sex?', 'primary', 'igg4_g_l'],
  ['Does MAG4-27 differ by sex?', 'key_secondary', 'microbiote_igg4_mag4_27'],
  ['Does MAG4-22 differ by sex?', 'exploratory', 'microbiote_igg4_mag4_22'],
];

let api: Api;
let t: Tenant;
let dataset: AnchoredDataset;
let sapId: string;
let templateVersion: string;
let ingestionId: string;
let firstRun: any;

const runsPath = (rest = '') => `/api/v1/projects/${t.projectId}/saps/${sapId}/runs${rest}`;
const ok = (res: { status: number; body: any }, what: string, status = 201) => {
  expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(status);
  return res.body;
};

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

/** The dataset's newest READY ingestion (the dataset version every run pins). */
async function waitReady(datasetId: string): Promise<string> {
  const deadline = Date.now() + PROFILE_WAIT_MS;
  for (;;) {
    const ingestions = asList(ok(await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${datasetId}/ingestions`, t.headers), 'ingestions', 200))
      .sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const newest = ingestions[0];
    if (newest?.status === 'ready') return newest.id;
    if (newest?.status === 'failed' || Date.now() > deadline) throw new Error(`ingestion of ${datasetId}: ${JSON.stringify(newest)}`);
    await sleep(2_000);
  }
}

/** The fixture, salted with a per-run constant column so its governed steps COMPUTE in this project (never reuse another's). */
async function ingestSaltedFixture(): Promise<string> {
  const nonce = String(Date.now());
  const lines = readFileSync(join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', FIXTURE), 'utf-8').trimEnd().split('\n');
  const csv = `${lines.map((l, i) => `${l},${i === 0 ? 'e2e_salt' : nonce}`).join('\n')}\n`;
  const init = ok(await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: `axi2450-${nonce}-${FIXTURE}`, contentType: 'text/csv',
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

/** A real final version 1 (AXI-2438 draft + AXI-2439 finalise) with the three questions. */
async function finaliseThreeQuestionSap(): Promise<any> {
  const base = `/api/v1/projects/${t.projectId}`;
  let draft = ok(await api.post(`${base}/saps/draft`, {}, t.headers), 'start draft');
  const titled = await api.ctx.put(apiUrl(`${base}/saps/${draft.sapId}/draft`), { data: { basedOnRevision: draft.revision, title: 'AXI-2450 three-question plan' }, headers: t.headers });
  expect(titled.status(), await titled.text()).toBe(200);
  draft = await titled.json();
  for (const [text, role, outcome] of QUESTIONS) {
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

/** Per question, by questionId: what FR44 compares (main p-value and verdict). */
const comparedOf = (run: any) =>
  Object.fromEntries(run.questions.map((q: any) => [q.questionId, { role: q.role, mainPValue: q.mainPValue, verdict: q.verdict }]));

test.beforeAll(async () => {
  test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
  api = await adminApi();
  const tenant = await ensureTenant(api);
  const created = ok(await api.post('/api/v1/projects', { name: `E2E AXI-2450 reproduction ${Date.now()}`, workspaceId: tenant.workspaceId }, tenant.headers), 'project');
  t = { ...tenant, projectId: created.id };
  const datasetId = await ingestSaltedFixture();
  const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
  if (!anchored) throw new Error('fixture dataset could not be anchored');
  dataset = anchored;
  await approveCarriersFor(['stats.mann_whitney_u']);
  templateVersion = await pinNewestT1(apiCallOf(api.ctx, t.headers), t.projectId);
  sapId = (await finaliseThreeQuestionSap()).id;
  ingestionId = await waitReady(dataset.datasetId);
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2450 — reproduction of a 3-question plan @SI-065 @SI-071', () => {
  test('FR39, FR46 — AXI-2450.1: the first run of a primary + key secondary + exploratory plan completes with a main p-value per question @SI-065 @SI-071', async () => {
    test.setTimeout(EVALUATION_WAIT_MS + 60_000);
    // Act
    const started = ok(await api.post(runsPath(), { version: 1, datasetVersionId: ingestionId, clientRequestId: randomUUID() }, t.headers), 'first run');
    firstRun = await evaluatedRun(started.sapRunId);

    // Assert
    expect(firstRun.status).toBe('completed');
    expect(firstRun.questions.map((q: any) => q.role)).toEqual(['primary', 'key_secondary', 'exploratory']);
    for (const q of firstRun.questions) expect(q.mainPValue, `${q.role} main p-value`).toEqual(expect.any(Number));
  });

  test('FR43, FR44, AC18, EC20, NFR5 — AXI-2450.2: a reproduction on the same version and dataset version stores identical results and NO mismatch on any question @SI-065 @SI-071', async () => {
    test.setTimeout(EVALUATION_WAIT_MS + 60_000);
    // Arrange
    const started = ok(await api.post(runsPath(), { version: 1, datasetVersionId: ingestionId, clientRequestId: randomUUID() }, t.headers), 'reproduction');

    // Act
    const reproduction = await evaluatedRun(started.sapRunId);
    const listed = asList(ok(await api.get(runsPath(), t.headers), 'list', 200)).find((r: any) => r.sapRunId === started.sapRunId);

    // Assert
    expect(started.classification).toBe('reproduction');
    expect(reproduction.status).toBe('completed');
    expect(comparedOf(reproduction)).toEqual(comparedOf(firstRun));
    expect(reproduction.reproductionMismatch, JSON.stringify(reproduction.reproductionMismatch)).toBeUndefined();
    expect(listed?.reproductionMismatch).toBeUndefined();
  });
});
