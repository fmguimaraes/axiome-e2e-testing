import { test, expect, request as apiRequest, type APIRequestContext, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2297 (epic AXI-2060): in the analysis page, Run rule → Mann-Whitney U, once
 * the measurement and the group column are chosen, the Reference / Comparison
 * group selects list the group column's levels (`0`, `1` for the 0/1-coded
 * `atteinte_pancreatique`) BEFORE a level is chosen; until both are chosen the
 * preflight panel names what is missing (a BLOCK, never "Preflight resolution
 * unavailable"); choosing them enables Run rule, and the run reproduces slide 3
 * (U = 77.5, p = 0.3705, n 9 vs 14).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2297 (S1–S3).
 *
 * Isolation: a THROWAWAY analysis (`[e2e AXI-2297 throwaway] …`) over the
 * synthetic Tableau 2 dataset of project 22585add — never project 4ff39166 or the
 * demo project b7b274bc. Its root snapshot carries a run-unique, row-neutral
 * `age >= -(1+ε)` predicate (every age is ≥ 29, none missing) so the run never
 * dedups onto another analysis's run. The analysis is archived in `afterAll`.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
/** Projects this spec must never write into (live demo data) — matched by id prefix. */
const FORBIDDEN_PROJECT_PREFIXES = ['4ff39166', 'b7b274bc'];
const T2_DATASET_ID = '4d4daa79-e414-477b-87d4-79d53f4a967e';
const MWU_RULE_CODE = 'STAT-MANN-WHITNEY-U';
const MEASUREMENT = 'microbiote_igg4_ent_059';
const GROUP_COLUMN = 'atteinte_pancreatique';
const THROWAWAY = '[e2e AXI-2297 throwaway]';

type ResultRow = Record<string, unknown>;

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let analysisId = '';
let rootSnapshotId = '';

async function ok<T>(label: string, call: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

async function createThrowawayAnalysis(): Promise<void> {
  const me = await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')));
  const va = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId: T2_DATASET_ID, name: `${THROWAWAY} ${Date.now()}`, createdBy: me.id },
  }));
  analysisId = va.id;
  const root = await ok<{ id: string }>('root snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysisId, filters: [{ column: 'age', operator: 'gte', value: -1 - Math.random() }] },
  }));
  rootSnapshotId = root.id;
}

async function openMannWhitneyConfig(page: Page): Promise<void> {
  await page.addInitScript(
    ([access, refresh, org, ws]) => {
      localStorage.setItem('access_token', access);
      localStorage.setItem('refresh_token', refresh);
      localStorage.setItem('axiome-top-org', org);
      localStorage.setItem('axiome-active-workspace', ws);
    },
    [accessToken, refreshToken, ORGANIZATION_ID, WORKSPACE_ID] as const,
  );
  await page.goto(`/projects/${PROJECT_ID}/view-analyses/${analysisId}?snapshotId=${rootSnapshotId}`);
  await expect(page.getByRole('button', { name: /Snapshot v\d+/ }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Run rule' }).click();
  await expect(page.getByRole('heading', { name: /Run relationship rule/i })).toBeVisible({ timeout: 30_000 });
  // The shared stack carries several served copies of the system carrier (one per
  // seeding org) plus workspace clones (`…-clone`); every one binds the same
  // operation, so any exact-code row exercises the same config path.
  const row = page.getByRole('radio').filter({ hasText: new RegExp(`${MWU_RULE_CODE}(?!-)`) }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await page.getByRole('button', { name: 'Adjust parameters' }).click();
  await expect(page.getByRole('heading', { name: /^Configure / })).toBeVisible({ timeout: 30_000 });
}

function fieldSelect(page: Page, key: string) {
  return page.locator(`[data-testid="rule-run-field"][data-field="${key}"] select`).first();
}

async function chooseMeasurementAndGroup(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: MEASUREMENT, exact: true }).check();
  await fieldSelect(page, 'role:groupColumn').selectOption(GROUP_COLUMN);
}

async function optionValues(page: Page, key: string): Promise<string[]> {
  return fieldSelect(page, key).locator('option').evaluateAll((options) =>
    options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''),
  );
}

type RunRead = { id: string; status: string; statusMessage?: string; dedupedFromRunId?: string | null };

async function pollTerminal(ruleRunId: string): Promise<RunRead> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const run = await ok<RunRead>('run', api.get(apiUrl(`/api/v1/rule-runs/${ruleRunId}`)));
    if (!['PENDING', 'QUEUED', 'RUNNING'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`rule run ${ruleRunId} never reached a terminal status`);
}

test.describe('AXI-2297 - Mann-Whitney level selects list the group levels before one is chosen', { tag: ['@SI-035', '@SI-047'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
    expect(FORBIDDEN_PROJECT_PREFIXES.some((prefix) => PROJECT_ID.startsWith(prefix))).toBe(false);
    await createThrowawayAnalysis();
  });

  test.afterAll(async () => {
    if (!api) return;
    if (analysisId) await api.patch(apiUrl(`/api/v1/view-analyses/${analysisId}/archive`), { data: {} });
    await api.dispose();
  });

  test('S1 AC1 - with measurement + group chosen, Reference and Comparison offer the levels 0 and 1 before a level is picked', async ({ page }) => {
    await openMannWhitneyConfig(page);
    await chooseMeasurementAndGroup(page);

    await expect.poll(() => optionValues(page, 'param:groupFrom'), { timeout: 30_000 }).toEqual(['0', '1']);
    await expect.poll(() => optionValues(page, 'param:groupTo'), { timeout: 30_000 }).toEqual(['0', '1']);
    await expect(fieldSelect(page, 'param:groupFrom')).toHaveValue('');
    await expect(page.getByText('No candidates found')).toHaveCount(0);
  });

  test('S2 AC2 - until both levels are chosen the panel names the missing level as a block and Run rule stays disabled', async ({ page }) => {
    await openMannWhitneyConfig(page);
    await chooseMeasurementAndGroup(page);

    await expect(page.getByText(/groupFrom is required/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Preflight resolution unavailable.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Run rule' }).last()).toBeDisabled();
  });

  test('S3 AC3 - picking 0 / 1 enables Run rule and the run gives U = 77.5, p = 0.3705 (n 9 vs 14)', async ({ page }) => {
    await openMannWhitneyConfig(page);
    await chooseMeasurementAndGroup(page);
    await expect.poll(() => optionValues(page, 'param:groupFrom'), { timeout: 30_000 }).toEqual(['0', '1']);
    await fieldSelect(page, 'param:groupFrom').selectOption('0');
    await fieldSelect(page, 'param:groupTo').selectOption('1');

    await expect(page.getByText(/groupFrom is required/)).toHaveCount(0, { timeout: 30_000 });
    const submit = page.getByRole('button', { name: 'Run rule' }).last();
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    const [runResponse] = await Promise.all([
      page.waitForResponse((r) => /\/rule-runs$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST'),
      submit.click(),
    ]);
    const runBody = await runResponse.json();
    const ruleRunId: string = runBody.ruleRunId ?? runBody.existingRuleRunId;
    expect(ruleRunId, `execute() returned no ruleRunId: ${JSON.stringify(runBody)}`).toBeTruthy();
    const run = await pollTerminal(ruleRunId);
    // A reuse is a correct outcome too: read the canonical run's table then.
    const resultRunId = run.status === 'DEDUPED' && run.dedupedFromRunId ? run.dedupedFromRunId : ruleRunId;
    if (run.status !== 'DEDUPED') expect(run.status, run.statusMessage ?? '').toBe('SUCCEEDED');

    const table = await ok<{ rows: ResultRow[] }>('result table', api.get(apiUrl(`/api/v1/rule-runs/${resultRunId}/table`)));
    expect(table.rows).toHaveLength(1);
    const row = table.rows[0];
    expect(Number(row.pValue)).toBeCloseTo(0.3705, 4);
    expect(Number(row.uStatistic)).toBeCloseTo(77.5, 6);
    expect([Number(row.nGroupFrom), Number(row.nGroupTo)]).toEqual([9, 14]);
  });
});
