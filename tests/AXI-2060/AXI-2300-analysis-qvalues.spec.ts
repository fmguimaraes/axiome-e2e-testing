import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2300 (epic AXI-2060): the analysis page links to a q-values page SCOPED
 * to that analysis's own completed correlation runs, grouped by x (reference)
 * column, with a select-group control that feeds the existing
 * correlation-family-adjust endpoint.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2300 (S1–S6). Tags: @SI-035, @SI-017, @SI-010.
 *
 * Read-only on the reference analysis A4 (project 4ff39166): S1 only reads and
 * never clicks Adjust. Every write goes to THROWAWAY analyses (names prefixed
 * `[e2e AXI-2300 throwaway]`) in the synthetic reproduction project 22585add:
 * T gets 4 fresh Spearman runs (2 x columns × 2 y columns), each on its own
 * snapshot carrying a unique no-op filter so no run is DEDUPED onto an older
 * one; U gets none. Analyses with governed runs are not deletable (EC3), so
 * they stay.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';

const A4_PROJECT_ID = '4ff39166-071e-4cec-92f3-697373592710';
const A4_ANALYSIS_ID = '4b27bce3-cd5f-4c0d-a02e-448214d66e50';

const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const DATASET_ID = '4d4daa79-e414-477b-87d4-79d53f4a967e';
const CORRELATION_RULE_ID = '582668dc-337e-4077-9d68-1080b7803e45';
const X_COLUMNS = ['microbiote_igg4_ent_059', 'microbiote_igg4_cer_229'];
const Y_COLUMNS = ['igg4_g_l', 'eosinophils'];
const THROWAWAY = '[e2e AXI-2300 throwaway]';

interface Coverage { qValue: number; significance: string; familySize: number }
interface OverviewRun {
  ruleRunId: string;
  ownRuleRunId: string;
  xColumn: string | null;
  yColumn: string | null;
  method: string | null;
  rho: number | null;
  pValue: number | null;
  inputSnapshot: { id: string; name: string | null; version: number } | null;
  coverage: Coverage | null;
}
interface Overview { groups: { xColumn: string | null; runs: OverviewRun[] }[]; total: number; truncated: boolean }
interface Count { total: number; truncated: boolean }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let tAnalysisId = '';
let uAnalysisId = '';
const tRunIds: string[] = [];

async function ok<T>(label: string, res: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const r = await res;
  expect(r.ok(), `${label}: ${r.status()} ${await r.text()}`).toBeTruthy();
  return (await r.json()) as T;
}

function overview(analysisId: string): Promise<Overview> {
  return ok<Overview>('overview', api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/correlation-family-overview`)));
}

function count(analysisId: string): Promise<Count> {
  return ok<Count>('count', api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/correlation-family-overview/count`)));
}

async function createAnalysis(label: string): Promise<string> {
  const created = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId: DATASET_ID, name: `${THROWAWAY} ${label} ${new Date().toISOString()}` },
  }));
  return created.id;
}

/** One snapshot + one Spearman run on it; the unique no-op filter keeps the run's fingerprint fresh. */
async function runCorrelation(analysisId: string, xColumn: string, yColumn: string, tag: string): Promise<string> {
  const filters = [{ column: 'patient_id', operator: 'neq', value: `e2e-AXI-2300-${tag}` }];
  const snapshot = await ok<{ id: string }>('snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysisId, filters, name: `${xColumn} × ${yColumn}` },
  }));
  const created = await ok<{ ruleRunId: string }>('rule run', api.post(apiUrl('/api/v1/rule-runs'), {
    data: {
      ruleId: CORRELATION_RULE_ID, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, datasetId: DATASET_ID,
      snapshotId: snapshot.id, viewAnalysisId: analysisId, runKind: 'STATISTICAL', operationId: 'stats.correlation',
      scope: 'FILTERED', filters, operationParams: { method: 'spearman', alternative: 'two_sided' },
      roleBindings: { xColumn, yColumn },
    },
  }));
  let run: { status: string; errorMessage?: string | null } = { status: 'QUEUED' };
  await expect.poll(async () => {
    run = await ok('get rule run', api.get(apiUrl(`/api/v1/rule-runs/${created.ruleRunId}`)));
    return run.status;
  }, { timeout: 120_000, intervals: [1000] }).toMatch(/^(SUCCEEDED|DEDUPED|FAILED)$/);
  expect(run.status, JSON.stringify(run)).toBe('SUCCEEDED');
  return created.ruleRunId;
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

function allRuns(o: Overview): OverviewRun[] {
  return o.groups.flatMap((g) => g.runs);
}

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('AXI-2300 - Analysis-scoped correlation q-values page', { tag: ['@SI-035', '@SI-017', '@SI-010'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });

    tAnalysisId = await createAnalysis('T');
    uAnalysisId = await createAnalysis('U');
    const stamp = Date.now();
    for (const x of X_COLUMNS) {
      for (const y of Y_COLUMNS) tRunIds.push(await runCorrelation(tAnalysisId, x, y, `${stamp}-${x}-${y}`));
    }
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test('AC1/AC2 (S1) - A4 links "Correlation q-values (42)" to its own 7 groups × 6 runs, all adjusted (read-only)', async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${A4_PROJECT_ID}/view-analyses/${A4_ANALYSIS_ID}`);
    const link = page.getByTestId('analysis-qvalues-link');
    await expect(link).toHaveText('Correlation q-values (42)', { timeout: 60_000 });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${A4_PROJECT_ID}/view-analyses/${A4_ANALYSIS_ID}/q-values$`));
    await expect(page.getByTestId('analysis-qvalues-summary')).toHaveText('42 runs in 7 groups · 42 of 42 adjusted', { timeout: 60_000 });
    await expect(page.locator('[data-testid^="qvalues-group-checkbox-"]')).toHaveCount(7);
    const rows = page.locator('[data-testid^="qvalues-row-"]');
    await expect(rows).toHaveCount(42);
    for (const heading of await page.locator('[data-testid^="qvalues-group-heading-"]').allTextContents()) {
      expect(heading).toMatch(/ — 6 of 6 adjusted$/);
    }
    const first = rows.first();
    await expect(first.getByTestId('qvalues-cell-pair')).toHaveText(/^.+ vs .+$/);
    await expect(first.getByTestId('qvalues-cell-method')).toHaveText('spearman');
    await expect(first.getByTestId('qvalues-cell-input')).toHaveText(/v\d+ · \d{2}\/\d{2} \d{2}:\d{2}$/);
    for (const cell of ['qvalues-cell-rho', 'qvalues-cell-p', 'qvalues-cell-q']) {
      await expect(first.getByTestId(cell)).toHaveText(/^-?\d/);
    }
    await expect(first.getByTestId('qvalues-cell-adjustment')).toHaveText(/\(family of 6, \d{2}\/\d{2} \d{2}:\d{2}\)$/);
    await expect(page.getByTestId('analysis-qvalues-selected-count')).toHaveText('0 selected');
  });

  test('AC1/AC2 (S2) - a fresh analysis lists exactly its 4 runs, grouped 2 × 2 by x column, none adjusted', async () => {
    expect(await count(tAnalysisId)).toEqual({ total: 4, truncated: false });
    const o = await overview(tAnalysisId);
    expect(o.total).toBe(4);
    expect(o.truncated).toBe(false);
    expect(o.groups.map((g) => g.xColumn).sort()).toEqual([...X_COLUMNS].sort());
    for (const g of o.groups) {
      expect(g.runs.map((r) => r.yColumn).sort()).toEqual([...Y_COLUMNS].sort());
      for (const r of g.runs) {
        expect(r.xColumn).toBe(g.xColumn);
        expect(r.method).toBe('spearman');
        expect(r.rho).not.toBeNull();
        expect(r.pValue).not.toBeNull();
        expect(r.coverage).toBeNull();
      }
    }
    const runs = allRuns(o);
    expect(runs.map((r) => r.ruleRunId).sort()).toEqual([...tRunIds].sort());
    expect(new Set(runs.map((r) => r.inputSnapshot?.id)).size, 'each run read its own snapshot').toBe(4);
  });

  test('AC3 (S3) - ticking one group and adjusting covers exactly that group (family of 2); the other stays "Not adjusted"', async ({ page }) => {
    await signIn(page);
    await page.goto(`/projects/${PROJECT_ID}/view-analyses/${tAnalysisId}`);
    const link = page.getByTestId('analysis-qvalues-link');
    await expect(link).toHaveText('Correlation q-values (4)', { timeout: 60_000 });
    await link.click();
    await expect(page.getByTestId('analysis-qvalues-summary')).toHaveText('4 runs in 2 groups · 0 of 4 adjusted', { timeout: 60_000 });

    const before = await overview(tAnalysisId);
    const [picked, other] = before.groups;
    await page.getByTestId(`qvalues-group-checkbox-${picked.xColumn}`).check();
    await expect(page.getByTestId('analysis-qvalues-selected-count')).toHaveText('2 selected');
    for (const r of picked.runs) await expect(page.getByTestId(`qvalues-run-checkbox-${r.ruleRunId}`)).toBeChecked();
    for (const r of other.runs) await expect(page.getByTestId(`qvalues-run-checkbox-${r.ruleRunId}`)).not.toBeChecked();

    await page.getByTestId('analysis-qvalues-adjust').click();
    const result = page.getByTestId('analysis-qvalues-result');
    await expect(result).toBeVisible({ timeout: 120_000 });
    for (const r of picked.runs) await expect(page.getByTestId(`analysis-qvalues-result-${r.ruleRunId}`)).toContainText(' vs ');
    await expect(page.locator('[data-testid^="analysis-qvalues-result-"]')).toHaveCount(2);

    await expect(page.getByTestId('analysis-qvalues-summary')).toHaveText('4 runs in 2 groups · 2 of 4 adjusted', { timeout: 60_000 });
    for (const r of picked.runs) {
      await expect(page.getByTestId(`qvalues-row-${r.ruleRunId}`).getByTestId('qvalues-cell-adjustment')).toContainText('(family of 2');
      await expect(page.getByTestId(`qvalues-row-${r.ruleRunId}`).getByTestId('qvalues-cell-q')).toHaveText(/^\d/);
    }
    for (const r of other.runs) {
      await expect(page.getByTestId(`qvalues-row-${r.ruleRunId}`).getByTestId('qvalues-cell-adjustment')).toHaveText('Not adjusted');
    }

    const after = await overview(tAnalysisId);
    for (const r of allRuns(after)) {
      const inPicked = picked.runs.some((p) => p.ruleRunId === r.ruleRunId);
      if (inPicked) expect(r.coverage?.familySize, JSON.stringify(r)).toBe(2);
      else expect(r.coverage).toBeNull();
    }
  });

  test('AC1 (S4) - an analysis with no correlation runs shows no link and an empty scoped page; A4 never lists T\'s runs', async ({ page }) => {
    expect(await count(uAnalysisId)).toEqual({ total: 0, truncated: false });
    const a4 = allRuns(await overview(A4_ANALYSIS_ID));
    expect(a4).toHaveLength(42);
    for (const id of tRunIds) expect(a4.map((r) => r.ruleRunId)).not.toContain(id);

    await signIn(page);
    // The positive control first (T's link renders), so the absence below is not latently green.
    await page.goto(`/projects/${PROJECT_ID}/view-analyses/${tAnalysisId}`);
    await expect(page.getByTestId('analysis-qvalues-link')).toHaveText('Correlation q-values (4)', { timeout: 60_000 });

    const countRead = page.waitForResponse((r) => r.url().includes(`/view-analyses/${uAnalysisId}/correlation-family-overview/count`) && r.ok());
    await page.goto(`/projects/${PROJECT_ID}/view-analyses/${uAnalysisId}`);
    await countRead;
    await expect(page.getByText(`${THROWAWAY} U`).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('analysis-qvalues-link')).toHaveCount(0);

    await page.goto(`/projects/${PROJECT_ID}/view-analyses/${uAnalysisId}/q-values`);
    await expect(page.getByTestId('analysis-qvalues-empty')).toHaveText('This analysis has no completed correlation runs.', { timeout: 60_000 });
    await expect(page.getByTestId('analysis-qvalues-adjust')).toHaveCount(0);
  });

  test('AC5 (S5) - an unknown analysis is refused with the analysis\'s own not-found, on both endpoints', async () => {
    const unknown = '00000000-0000-4000-8000-0000000a2300';
    for (const suffix of ['', '/count']) {
      const r = await api.get(apiUrl(`/api/v1/view-analyses/${unknown}/correlation-family-overview${suffix}`));
      expect(r.status()).toBe(404);
      expect((await r.json()).message).toBe(`Analysis ${unknown} not found.`);
    }
  });

  test('AC4 (S6) - the global q-values page is unchanged', async ({ page }) => {
    await signIn(page);
    await page.goto('/rules/correlation-q-values');
    await expect(page.getByText('Adjust for multiple comparisons (q-values)').first()).toBeVisible({ timeout: 60_000 });
  });
});
