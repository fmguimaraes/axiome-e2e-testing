import { test, expect, request as apiRequest, type APIRequestContext } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2298 (epic AXI-2060, review follow-up to AXI-2295): the three WRITE
 * paths that can set a chart's linked comparison run — `PATCH
 * …/compute-run-link` (`CandidatesService.updateComputeRunLink`), `PATCH
 * …/facet-compute-run-links` (`updateFacetComputeRunLinks`), and `POST
 * …/candidates` (`createVisualizationSpec`, a chart created WITH a link) —
 * now apply the SAME ownership rule the read-side picker already applies
 * (`fittingRunOwnerWhere`): a run owned by a DIFFERENT analysis is refused
 * (404), never silently linked.
 *
 * Review bounce 2, Finding 1: the CREATE route's tenancy comes from the
 * ROUTE's own `:workspaceId`, never a client-supplied body field — S5c below
 * proves this directly (a bogus body `workspaceId` is ignored).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2298. Tags: @SI-033, @SI-017, @SI-015.
 *
 * Self-isolating, same fixture shape as AXI-2295's spec: two THROWAWAY
 * analyses (A and B, names prefixed `[e2e AXI-2298 throwaway]`) in the
 * synthetic reproduction project, on the SAME dataset, each with its own
 * Dunn run over the SAME slice. A's charts are deleted in `afterAll`; the
 * analyses themselves stay (an analysis with governed runs is not
 * deletable, EC3). Never touches the reference demo project/analysis/chart.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f';
const DUNN_RULE_ID = '796cfeb8-5fa7-442c-a062-abe5957c2d00';
const REFERENCE = 'MAG4 13';
const GROUPS = ['SD', 'IgG4-RD', 'HD'];
const THROWAWAY = '[e2e AXI-2298 throwaway]';

const GROUP_IN = { column: 'group', operator: 'in', value: GROUPS };
const REFERENCE_EQ = { column: 'reference', operator: 'eq', value: REFERENCE };
const FILTERS_A = [GROUP_IN, REFERENCE_EQ];
const FILTERS_B = [REFERENCE_EQ, GROUP_IN];

interface AnalysisFixture { analysisId: string; snapshotId: string; runId: string }

let api: APIRequestContext;
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

/**
 * POST /rule-runs and wait for a terminal status; a DEDUPED run resolves to
 * its canonical id (the id a link carries, FR29).
 *
 * Review fix B4: this is what makes the "still allows a run owned by the
 * chart's OWN analysis" assertions below (S2/S4) robust to A's run coming
 * back DEDUPED — which it legitimately can, across repeated e2e runs on the
 * same dataset/filters/rule. `a.runId` is already the CANONICAL id a link
 * would carry (same as the picker offers); the backend admits it via
 * `admittedLinkRunIds`/`runLinkId` judging A's OWN (possibly DEDUPED) row,
 * never the canonical row directly — exactly the B1 defect this story fixes.
 * No separate "explicit dedup scenario" is needed: every run of this suite
 * on a warm dataset already exercises that path whenever dedup fires.
 */
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
  const snapshot = await ok<{ id: string }>('snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysis.id, filters, name: `${REFERENCE} ${label}` },
  }));
  const runId = await runDunn(analysis.id, snapshot.id, filters);
  return { analysisId: analysis.id, snapshotId: snapshot.id, runId };
}

async function createChart(body: Record<string, unknown>, title: string): Promise<string> {
  const created = await ok<{ id: string }>('chart', api.post(candidatesUrl(), {
    data: { ...body, title: `${THROWAWAY} ${title}`, viewAnalysisId: a.analysisId },
  }));
  specIds.push(created.id);
  return created.id;
}

function getChart(specId: string): Promise<{ computeRunId: string | null; facetComputeRunIds: Record<string, string> | null }> {
  return ok('get chart', api.get(candidatesUrl(`/${specId}`)));
}

/** Raw POST /candidates — returns the response unconsumed so a caller can
 * inspect a 404 as well as a 201 (unlike `ok`, which asserts success). */
function postCandidate(body: Record<string, unknown>) {
  return api.post(candidatesUrl(), { data: body });
}

function patchComputeRunLink(specId: string, computeRunId: string | null) {
  return api.patch(candidatesUrl(`/${specId}/compute-run-link`), { data: { computeRunId } });
}

function patchFacetComputeRunLinks(specId: string, facetComputeRunIds: Record<string, string> | null) {
  return api.patch(candidatesUrl(`/${specId}/facet-compute-run-links`), { data: { facetComputeRunIds } });
}

const strip = {
  templateId: 'strip_v1',
  templateVersion: '1.0.0',
  params: { x_title: 'Group', y_title: '% microbiota opsonized', group_order: ['HD', 'IgG4-RD', 'SD'] },
};

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('AXI-2298 - chart run-link WRITES are scoped to the chart\'s own analysis', { tag: ['@SI-033', '@SI-017', '@SI-015'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const login = await apiRequest.newContext();
    const res = await login.post(apiUrl('/api/v1/auth/login'), {
      data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
    });
    expect(res.ok()).toBeTruthy();
    const { accessToken } = await res.json();
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

  test('AC1 - updateComputeRunLink refuses a run owned by a DIFFERENT analysis (404), nothing persisted', async () => {
    const before = await getChart(unfacetedSpecId);
    const res = await patchComputeRunLink(unfacetedSpecId, b.runId);
    expect(res.status()).toBe(404);
    const after = await getChart(unfacetedSpecId);
    expect(after.computeRunId).toBe(before.computeRunId);
  });

  test('AC1 - updateComputeRunLink still allows a run owned by the chart\'s OWN analysis', async () => {
    const res = await patchComputeRunLink(unfacetedSpecId, a.runId);
    expect(res.ok(), `${res.status()} ${await res.text()}`).toBeTruthy();
    const after = await getChart(unfacetedSpecId);
    expect(after.computeRunId).toBe(a.runId);
  });

  test('AC1 - updateFacetComputeRunLinks refuses a panel run owned by a DIFFERENT analysis (404), nothing persisted', async () => {
    const before = await getChart(facetedSpecId);
    const res = await patchFacetComputeRunLinks(facetedSpecId, { [REFERENCE]: b.runId });
    expect(res.status()).toBe(404);
    const after = await getChart(facetedSpecId);
    expect(after.facetComputeRunIds).toEqual(before.facetComputeRunIds);
  });

  test('AC1 - updateFacetComputeRunLinks still allows every panel run owned by the chart\'s OWN analysis', async () => {
    const res = await patchFacetComputeRunLinks(facetedSpecId, { [REFERENCE]: a.runId });
    expect(res.ok(), `${res.status()} ${await res.text()}`).toBeTruthy();
    const after = await getChart(facetedSpecId);
    expect(after.facetComputeRunIds).toEqual({ [REFERENCE]: a.runId });
  });

  // AXI-2298 review bounce 2, Finding 2: createVisualizationSpec (B2) had no
  // e2e coverage at all — S1-S4 only exercised the two PATCH routes.
  test('AC1 - S5a: POST …/candidates with B\'s run and viewAnalysisId=A 404s, no chart created', async () => {
    const res = await postCandidate({
      ...strip,
      bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
      filters: FILTERS_A,
      title: `${THROWAWAY} create-refused`,
      viewAnalysisId: a.analysisId,
      computeRunId: b.runId,
    });
    expect(res.status()).toBe(404);
  });

  test('AC1 - S5b: POST …/candidates with A\'s OWN run and viewAnalysisId=A creates the chart (201)', async () => {
    const res = await postCandidate({
      ...strip,
      bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
      filters: FILTERS_A,
      title: `${THROWAWAY} create-allowed`,
      viewAnalysisId: a.analysisId,
      computeRunId: a.runId,
    });
    expect(res.ok(), `${res.status()} ${await res.text()}`).toBeTruthy();
    const created = await res.json();
    specIds.push(created.id);
    expect(created.computeRunId).toBe(a.runId);
  });

  // Review bounce 2, Finding 1: proves the gateway fix — a bogus workspaceId
  // asserted in the BODY must be ignored; the ROUTE's own :workspaceId
  // (this fixture's WORKSPACE_ID) is what tenancy is decided from. Before the
  // fix, `{...body, workspaceId}` put the body's value last and this request
  // would have been evaluated (and could 404, or admit a foreign-tenant run)
  // under the ATTACKER-CHOSEN workspace instead of the caller's real one.
  test('AC1 - S5c: a body-supplied workspaceId is ignored — the ROUTE\'s own workspace wins, and A\'s own run still links', async () => {
    const res = await postCandidate({
      ...strip,
      bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } },
      filters: FILTERS_A,
      title: `${THROWAWAY} create-route-wins`,
      viewAnalysisId: a.analysisId,
      computeRunId: a.runId,
      workspaceId: '00000000-0000-4000-8000-000000000099',
    });
    expect(res.ok(), `${res.status()} ${await res.text()}`).toBeTruthy();
    const created = await res.json();
    specIds.push(created.id);
    expect(created.computeRunId).toBe(a.runId);
  });
});
