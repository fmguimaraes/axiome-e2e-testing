import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2295 (epic AXI-2060): the chart Controls -> Statistics run picker offers
 * ONLY the runs made in the chart's own view analysis, and labels each one
 * distinguishably (test · input snapshot (vN) · dd/MM HH:mm), from what the
 * server returns.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2295. Tags: @SI-033, @SI-017, @SI-015.
 *
 * Self-isolating: two THROWAWAY analyses (A and B, names prefixed
 * `[e2e AXI-2295 throwaway]`) in the synthetic reproduction project, on the
 * SAME dataset, each with its own Dunn run over the SAME slice. A's charts are
 * deleted in `afterAll`; the analyses themselves stay (an analysis with
 * governed runs is not deletable, EC3). B's run carries the slice's
 * conditions in a different ORDER, so its fingerprint differs from A's (it is
 * never DEDUPED onto A's run) while it still FITS A's chart — exactly the
 * live defect's shape (two analyses, one dataset, two fitting Dunn runs).
 * Never touches the reference demo project/analysis/chart.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const DUNN_RULE_ID = '796cfeb8-5fa7-442c-a062-abe5957c2d00';
const REFERENCE = 'MAG4 13';
// A non-alphabetical `in` order, so no pre-existing script run (which stored
// the sorted list) shares A's or B's fingerprint.
const GROUPS = ['SD', 'IgG4-RD', 'HD'];
const THROWAWAY = '[e2e AXI-2295 throwaway]';

const GROUP_IN = { column: 'group', operator: 'in', value: GROUPS };
const REFERENCE_EQ = { column: 'reference', operator: 'eq', value: REFERENCE };
const FILTERS_A = [GROUP_IN, REFERENCE_EQ];
const FILTERS_B = [REFERENCE_EQ, GROUP_IN];

/** "Dunn · <snapshot> (vN) · dd/MM HH:mm" or "Dunn · vN · dd/MM HH:mm". */
const DISTINGUISHABLE_DUNN_LABEL = /^Dunn · (.+ \(v\d+\)|v\d+) · \d{2}\/\d{2} \d{2}:\d{2}$/;

interface AnalysisFixture { analysisId: string; snapshotId: string; snapshotVersion: number; runId: string }
interface FittingRun { linkRunId: string; testLabel: string; inputSnapshot: { id: string; name: string | null; version: number } | null }
interface FittingRuns { runs: FittingRun[]; panels?: { facetValue: string; runs: FittingRun[] }[] }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
const specIds: string[] = [];
let a: AnalysisFixture;
let b: AnalysisFixture;
let unfacetedSpecId = '';
let facetedSpecId = '';

function candidatesUrl(suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${DATASET_ID}/candidates${suffix}`);
}

async function ok<T>(label: string, res: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await res;
  expect(r.ok(), `${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

/** POST /rule-runs and wait for a terminal status; a DEDUPED run resolves to
 * its canonical id (the id a link carries, FR29). */
async function runDunn(analysisId: string, snapshotId: string, filters: unknown[]): Promise<string> {
  const created = await ok<{ ruleRunId: string }>('rule run', api.post(apiUrl('/api/v1/rule-runs'), {
    data: {
      ruleId: DUNN_RULE_ID, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, datasetId: DATASET_ID,
      snapshotId, viewAnalysisId: analysisId, runKind: 'STATISTICAL', operationId: 'stats.dunn_posthoc',
      scope: 'FILTERED', filters, operationParams: {}, roleBindings: { groupColumn: 'group' }, pivot: { valueColumn: 'pct' },
    },
  }));
  let run: { status: string; dedupedFromRunId?: string | null } = { status: 'QUEUED' };
  await expect.poll(async () => {
    run = await ok('get rule run', api.get(apiUrl(`/api/v1/rule-runs/${created.ruleRunId}`)));
    return run.status;
  }, { timeout: 90_000, intervals: [1000] }).toMatch(/^(SUCCEEDED|DEDUPED|FAILED)$/);
  expect(run.status, JSON.stringify(run)).not.toBe('FAILED');
  return run.status === 'DEDUPED' ? (run.dedupedFromRunId as string) : created.ruleRunId;
}

async function createAnalysis(label: string, filters: unknown[]): Promise<AnalysisFixture> {
  const name = `${THROWAWAY} ${label} ${new Date().toISOString()}`;
  const analysis = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId: DATASET_ID, name },
  }));
  const snapshot = await ok<{ id: string; version: number }>('snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysis.id, filters, name: `${REFERENCE} ${label}` },
  }));
  const runId = await runDunn(analysis.id, snapshot.id, filters);
  return { analysisId: analysis.id, snapshotId: snapshot.id, snapshotVersion: snapshot.version, runId };
}

async function createChart(body: Record<string, unknown>, title: string): Promise<string> {
  const created = await ok<{ id: string }>('chart', api.post(candidatesUrl(), {
    data: { ...body, title: `${THROWAWAY} ${title}`, viewAnalysisId: a.analysisId },
  }));
  specIds.push(created.id);
  return created.id;
}

function fittingRuns(specId: string): Promise<FittingRuns> {
  return ok<FittingRuns>('fitting-runs', api.get(candidatesUrl(`/${specId}/fitting-runs`)));
}

async function signIn(page: Page) {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [accessToken, refreshToken, ORGANIZATION_ID, WORKSPACE_ID] as const,
  );
}

const strip = {
  templateId: 'strip_v1',
  templateVersion: '1.0.0',
  params: { x_title: 'Group', y_title: '% microbiota opsonized', group_order: ['HD', 'IgG4-RD', 'SD'] },
};

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('AXI-2295 - Statistics run picker is scoped to the chart\'s own analysis', { tag: ['@SI-033', '@SI-017', '@SI-015'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });

    a = await createAnalysis('A', FILTERS_A);
    b = await createAnalysis('B', FILTERS_B);
    expect(b.runId, 'B must be its own run, not deduped onto A').not.toBe(a.runId);
    unfacetedSpecId = await createChart({ ...strip, bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } }, filters: FILTERS_A }, 'unfaceted');
    facetedSpecId = await createChart({
      ...strip,
      bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' }, facet: { column_id: 'col_reference' } },
      filters: [GROUP_IN, { column: 'reference', operator: 'in', value: [REFERENCE] }],
    }, 'faceted');
  });

  test.afterAll(async () => {
    for (const id of specIds) {
      const r = await api.delete(candidatesUrl(`/${id}`));
      expect([204, 404], `delete chart ${id}: ${r.status()}`).toContain(r.status());
    }
    await api.dispose();
  });

  test('AC1 - an unfaceted chart in analysis A offers only A\'s Dunn run, never B\'s (same dataset, same slice)', async () => {
    const result = await fittingRuns(unfacetedSpecId);
    const ids = result.runs.map((r) => r.linkRunId);
    expect(ids, JSON.stringify(result.runs)).not.toContain(b.runId);
    expect(ids).toEqual([a.runId]);
  });

  test('AC1 - a faceted chart\'s panel in analysis A offers only A\'s Dunn run (the live defect\'s shape)', async () => {
    const result = await fittingRuns(facetedSpecId);
    const panel = result.panels?.find((p) => p.facetValue === REFERENCE);
    expect(panel?.runs.map((r) => r.linkRunId), JSON.stringify(result.panels)).toEqual([a.runId]);
  });

  test('AC2 - each offered run carries the input snapshot it read (A\'s own snapshot, its version)', async () => {
    const [run] = (await fittingRuns(unfacetedSpecId)).runs;
    expect(run.testLabel).toBe('Dunn');
    expect(run.inputSnapshot).toMatchObject({ id: a.snapshotId, version: a.snapshotVersion });
  });

  test('AC1/AC2 - the Statistics picker in the UI lists only A\'s run, labelled distinguishably, never a bare "Dunn"', async ({ page }) => {
    await signIn(page);
    await page.goto(`/datasets/${DATASET_ID}/chart/${unfacetedSpecId}`);
    await expect.poll(async () => page.locator('.js-plotly-plot').count(), { timeout: 60_000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Visual' }).click();
    await page.getByRole('button', { name: 'Statistics' }).click();
    const picker = page.getByText('Comparison run', { exact: true }).locator('xpath=..').locator('select');
    await expect(picker).toBeVisible();
    await expect.poll(async () => picker.locator('option').allTextContents(), { timeout: 30_000 }).toHaveLength(2);
    const [none, only] = await picker.locator('option').allTextContents();
    expect(none).toBe('None');
    expect(only).toMatch(DISTINGUISHABLE_DUNN_LABEL);
    expect(only).toContain(`v${a.snapshotVersion}`);
  });
});
