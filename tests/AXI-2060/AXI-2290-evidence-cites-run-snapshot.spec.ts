import { test, expect, request as apiRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2290 (epic AXI-2060): a chart linked to a rule run and saved to evidence
 * from the project analysis page cites the run's RESULT snapshot
 * (`origin: 'rule_derived'`, `ruleRunId` = the linked run) — never a filter
 * snapshot re-materialized from the on-screen filters.
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2290 (S1–S4). Rule numbers (2a/2b/2c/3) are the
 * front resolver's (`src/lib/viewAnalysis/evidenceSnapshotForChart.ts`).
 *
 * SETUP via API (the run modal and the Controls → Statistics link are AXI-2253's
 * own, already-E2E'd surfaces); the SAVE AS EVIDENCE step — this story's diff —
 * is driven through the real gallery → "Add to evidence" → AddToEvidenceModal.
 *
 * Isolation: everything lives in a THROWAWAY analysis
 * (`[e2e AXI-2290 throwaway] …`) in the synthetic reproduction project
 * 22585add — never the demo project b7b274bc. Two fresh Dunn runs are rooted
 * on that analysis (a run-unique `pct >= -(1+ε)` predicate — every pct is ≥ 0,
 * so the rows are unchanged — keeps them from DEDUPING onto the demo's runs,
 * because a STATISTICAL dedup copies no result snapshot into the analysis).
 * Cleanup: evidence has no delete endpoint and an analysis holding evidence
 * cannot be deleted, so `afterAll` retires each evidence (`unapproved`), deletes
 * the chart clones and archives the analysis.
 */

const ORGANIZATION_ID = 'e2f053a6-7d65-4dd1-81e1-f40b5d3709a3';
const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const DEMO_PROJECT_ID = 'b7b274bc-48a3-494a-a66f-76390bb433a8';
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const DUNN_RULE_ID = '796cfeb8-5fa7-442c-a062-abe5957c2d00';
const GROUPS = ['HD', 'IgG4-RD', 'SD'];
const THROWAWAY = '[e2e AXI-2290 throwaway]';

type Filter = { column: string; operator: string; value?: unknown };
interface Snapshot { id: string; origin?: string; ruleRunId?: string | null; datasetId?: string }

let api: APIRequestContext;
let accessToken = '';
let refreshToken = '';
let analysisId = '';
let rootSnapshotId = '';
const runs: Record<string, { runId: string; snapshotId: string }> = {};
const clones: string[] = [];
const evidenceIds: string[] = [];
// Run-unique, row-neutral predicate (see header).
const SCOPE_GUARD: Filter = { column: 'pct', operator: 'gte', value: -1 - Math.random() };

function scope(reference: string): Filter[] {
  return [
    { column: 'group', operator: 'in', value: GROUPS },
    { column: 'reference', operator: 'eq', value: reference },
    SCOPE_GUARD,
  ];
}

function candidatesUrl(suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${ENT059_DATASET_ID}/candidates${suffix}`);
}

async function ok<T>(label: string, call: Promise<import('@playwright/test').APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

async function listSnapshots(): Promise<Snapshot[]> {
  const body = await ok<{ data: Snapshot[] }>('snapshots', api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/snapshots?page=1&limit=200`)));
  return body.data;
}

async function createThrowawayAnalysis(): Promise<void> {
  const me = await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')));
  const va = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId: ENT059_DATASET_ID, name: `${THROWAWAY} ${Date.now()}`, createdBy: me.id },
  }));
  analysisId = va.id;
}

/** A filter snapshot of the throwaway analysis — a run's scope is ITS snapshot's filters. */
async function filterSnapshot(filters: Filter[]): Promise<string> {
  const snap = await ok<{ id: string }>('filter snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysisId, filters },
  }));
  return snap.id;
}

async function pollRun(runId: string): Promise<void> {
  await expect.poll(async () => {
    const run = await ok<{ status: string }>('run', api.get(apiUrl(`/api/v1/rule-runs/${runId}`)));
    return run.status;
  }, { timeout: 90_000 }).toBe('SUCCEEDED');
}

async function resultSnapshotOf(runId: string): Promise<string> {
  const find = async () => (await listSnapshots()).find((s) => s.ruleRunId === runId && s.origin === 'rule_derived')?.id ?? '';
  await expect.poll(find, { timeout: 30_000 }).not.toBe('');
  return find();
}

async function runDunn(reference: string): Promise<void> {
  const snapshotId = await filterSnapshot(scope(reference));
  const created = await ok<{ ruleRunId: string; status: string }>(`dunn ${reference}`, api.post(apiUrl('/api/v1/rule-runs'), {
    data: {
      ruleId: DUNN_RULE_ID, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, datasetId: ENT059_DATASET_ID,
      snapshotId, viewAnalysisId: analysisId, runKind: 'STATISTICAL', scope: 'FILTERED',
      operationId: 'stats.dunn_posthoc', roleBindings: { groupColumn: 'group' },
      pivot: { valueColumn: 'pct' }, filters: scope(reference),
    },
  }));
  expect(created.status, 'a fresh, non-deduped run (else no result snapshot lands here)').not.toBe('DEDUPED');
  await pollRun(created.ruleRunId);
  runs[reference] = { runId: created.ruleRunId, snapshotId: await resultSnapshotOf(created.ruleRunId) };
  if (reference === 'ENT 059') rootSnapshotId = snapshotId;
}

function stripBody(title: string, extra: { bindings?: object; params?: object; filters: Filter[] }) {
  return {
    templateId: 'strip_v1', templateVersion: '1.0.0', title: `${THROWAWAY} ${title}`,
    bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' }, ...extra.bindings },
    params: { x_title: 'Reference microbiota', y_title: '% opsonized', group_order: GROUPS, ...extra.params },
    filters: extra.filters, viewAnalysisId: analysisId,
  };
}

async function createChart(title: string, extra: { bindings?: object; params?: object; filters: Filter[] }): Promise<string> {
  const spec = await ok<{ id: string }>(`chart ${title}`, api.post(candidatesUrl(), { data: stripBody(title, extra) }));
  clones.push(spec.id);
  return spec.id;
}

async function createFacetedChart(title: string, facetOrder: string[]): Promise<string> {
  const id = await createChart(title, {
    bindings: { facet: { column_id: 'col_reference' } },
    params: { facet_order: facetOrder },
    filters: [{ column: 'group', operator: 'in', value: GROUPS }, { column: 'reference', operator: 'in', value: ['ENT 059', 'CER 229'] }, SCOPE_GUARD],
  });
  await ok('facet links', api.patch(candidatesUrl(`/${id}/facet-compute-run-links`), {
    data: { facetComputeRunIds: { 'ENT 059': runs['ENT 059'].runId, 'CER 229': runs['CER 229'].runId } },
  }));
  return id;
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

async function openAnalysis(page: Page, snapshotId: string) {
  await signIn(page);
  await page.goto(`/projects/${PROJECT_ID}/view-analyses/${analysisId}?snapshotId=${snapshotId}`);
}

/** The gallery card whose header carries this chart's title (AXI-1877 card walk). */
async function renderedCard(page: Page, title: string): Promise<Locator> {
  // The gallery mounts cards incrementally (36+ charts on this dataset); the
  // search box matches a spec's title, narrowing it to exactly this card.
  await page.getByPlaceholder('Filter by chart type...').fill(`${THROWAWAY} ${title}`);
  const header = page.locator(`h4[title="${THROWAWAY} ${title}"]`).first();
  await expect(header).toBeVisible({ timeout: 60_000 });
  const card = header.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " group ")]').last();
  await expect(card.locator('svg.main-svg').first()).toBeVisible({ timeout: 60_000 });
  return card;
}

async function clickAddToEvidence(card: Locator) {
  await card.getByTitle('More actions').evaluate((el) => (el as HTMLElement).click());
  const item = card.getByRole('menuitem', { name: 'Add to evidence' });
  await item.waitFor({ state: 'attached' });
  await item.evaluate((el) => (el as HTMLElement).click());
}

async function createNewEvidence(page: Page, title: string) {
  await page.getByRole('button', { name: 'Create New' }).click();
  await page.getByPlaceholder('Evidence title').fill(title);
  await page.getByTestId('create-evidence-submit').click();
  const continueAnyway = page.getByTestId('empty-framing-continue');
  if (await continueAnyway.isVisible({ timeout: 3_000 }).catch(() => false)) await continueAnyway.click();
  await expect(page.getByTestId('create-evidence-submit')).not.toBeVisible({ timeout: 20_000 });
}

async function addToExisting(page: Page, title: string) {
  await page.getByRole('button', { name: 'Add to Existing' }).click();
  await page.getByText(title, { exact: true }).click();
  await page.getByRole('button', { name: 'Add to Evidence' }).click();
  await expect(page.getByRole('button', { name: 'Add to Evidence' })).not.toBeVisible({ timeout: 20_000 });
}

type EvidenceChart = { chartArtifactId: string; snapshotId: string };
interface Evidence { id: string; currentVersion: { title?: string; charts: EvidenceChart[] } }

async function evidenceByTitle(title: string): Promise<Evidence> {
  let found: { id: string } | undefined;
  await expect.poll(async () => {
    const list = await ok<{ data: { id: string; currentVersion?: { title?: string } }[] }>('evidences', api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/evidences?page=1&limit=100`)));
    found = list.data.find((e) => e.currentVersion?.title === title);
    return !!found;
  }, { timeout: 20_000 }).toBe(true);
  if (!evidenceIds.includes(found!.id)) evidenceIds.push(found!.id);
  return ok<Evidence>('evidence', api.get(apiUrl(`/api/v1/view-analyses/evidences/${found!.id}`)));
}

test.describe('AXI-2290 - evidence from a run-linked chart cites the run result snapshot', { tag: ['@SI-035', '@SI-015'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  // Own login (below), never the fixture-org `setup` project's storageState.
  test.use({ storageState: { cookies: [], origins: [] } });

  const EVIDENCE_1 = `${THROWAWAY} evidence S1 ${Date.now()}`;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    ({ accessToken, refreshToken } = await res.json());
    await login.dispose();
    api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });

    expect(PROJECT_ID).not.toBe(DEMO_PROJECT_ID);
    await createThrowawayAnalysis();
    await runDunn('ENT 059');
    await runDunn('CER 229');

    const linkedChart = await createChart('S1 linked', { filters: scope('ENT 059') });
    await ok('link', api.patch(candidatesUrl(`/${linkedChart}/compute-run-link`), { data: { computeRunId: runs['ENT 059'].runId } }));

    // S3: CER 229 first in facet_order; its run was created SECOND, so the
    // earliest-created fallback would pick ENT 059 instead.
    await createFacetedChart('S3 faceted', ['CER 229', 'ENT 059']);
    await createFacetedChart('S2 faceted open', ['ENT 059', 'CER 229']);

    await createChart('S4 unlinked', { filters: scope('ENT 059') });
  });

  test.afterAll(async () => {
    if (!api) return;
    for (const id of evidenceIds) {
      await api.patch(apiUrl(`/api/v1/view-analyses/evidences/${id}/status`), { data: { status: 'unapproved' } });
    }
    for (const id of clones) await api.delete(candidatesUrl(`/${id}`));
    if (analysisId) await api.patch(apiUrl(`/api/v1/view-analyses/${analysisId}/archive`), { data: {} });
    await api.dispose();
  });

  test('S1 rule 2b - Create New on a run-linked chart with a FILTER snapshot open cites the run result snapshot and materializes no slice', async ({ page }) => {
    const before = (await listSnapshots()).length;
    await openAnalysis(page, rootSnapshotId);
    await clickAddToEvidence(await renderedCard(page, 'S1 linked'));
    await createNewEvidence(page, EVIDENCE_1);

    const evidence = await evidenceByTitle(EVIDENCE_1);
    expect(evidence.currentVersion.charts).toHaveLength(1);
    expect(evidence.currentVersion.charts[0].snapshotId).toBe(runs['ENT 059'].snapshotId);
    expect((await listSnapshots()).length, 'no filter snapshot materialized by the save').toBe(before);
  });

  test('S2 rule 2a - Add to Existing with a linked run\'s result snapshot OPEN cites the open one; existing entries keep theirs', async ({ page }) => {
    // facet_order names ENT 059 first, so rule 2c alone would pick ENT 059 —
    // opening CER 229's result proves the OPEN snapshot wins (2a).
    await openAnalysis(page, runs['CER 229'].snapshotId);
    // Also the gallery-visibility check: this source-dataset chart is listed
    // while a result snapshot (pinned to another dataset) is open.
    await clickAddToEvidence(await renderedCard(page, 'S2 faceted open'));
    await addToExisting(page, EVIDENCE_1);

    await expect.poll(async () => (await evidenceByTitle(EVIDENCE_1)).currentVersion.charts.length, { timeout: 20_000 }).toBe(2);
    const charts = (await evidenceByTitle(EVIDENCE_1)).currentVersion.charts;
    expect(charts[0].snapshotId, 'the S1 entry is carried forward unchanged').toBe(runs['ENT 059'].snapshotId);
    expect(charts[1].snapshotId).toBe(runs['CER 229'].snapshotId);
  });

  test('S3 rule 2c - a faceted chart linked to two runs, neither open, cites the FIRST facet_order panel\'s run', async ({ page }) => {
    const title = `${THROWAWAY} evidence S3 ${Date.now()}`;
    await openAnalysis(page, rootSnapshotId);
    await clickAddToEvidence(await renderedCard(page, 'S3 faceted'));
    await createNewEvidence(page, title);

    const evidence = await evidenceByTitle(title);
    expect(evidence.currentVersion.charts[0].snapshotId).toBe(runs['CER 229'].snapshotId);
  });

  test('S4 rule 3 - an unlinked chart keeps today\'s behaviour: it cites a filter snapshot, never a run result', async ({ page }) => {
    const title = `${THROWAWAY} evidence S4 ${Date.now()}`;
    await openAnalysis(page, rootSnapshotId);
    await clickAddToEvidence(await renderedCard(page, 'S4 unlinked'));
    await createNewEvidence(page, title);

    const evidence = await evidenceByTitle(title);
    const cited = (await listSnapshots()).find((s) => s.id === evidence.currentVersion.charts[0].snapshotId);
    expect(cited?.origin).toBe('filter');
    expect(cited?.ruleRunId ?? null).toBeNull();
  });
});
