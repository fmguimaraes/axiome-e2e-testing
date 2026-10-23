import { test, expect, APIRequestContext, request } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2244 — the heatmap evidence's CITED DATASET must be populated
 * (manual-e2e AXI-2060-Microbiote-IgG4-Study-Reproduction.md §AXI-2244,
 * AC1; @SI-053).
 *
 * Review round 1 (2026-10-23): the AXI-2065 spec
 * (`AXI-2065-evidence-and-charts.spec.ts:112-140`) asserts only
 * `chartArtifactIds.length === 1` and text substrings on the heatmap
 * evidence — it never checks the CITED DATASET itself, which is exactly
 * why it stayed green while `heatmap_synthetic_v3.csv` (95 bytes, header
 * only, row_count 0) sat behind it. This spec closes that gap: it
 * resolves the dataset the LIVE heatmap evidence's `datasetBinding` cites
 * and asserts the platform's own ingestion reports `availability ===
 * 'available'` and `rowCount === 42` — the exact two facts a reused,
 * empty, same-filename dataset would fail.
 *
 * READ-ONLY against the seeded demo project `Microbiote IgG4 — synthetic
 * reproduction (AXI-2064)` (org CeRAINOM-IgG4, workspace Mag4), same
 * discovery-by-name convention as the AXI-2065 spec (NFR4 — one project,
 * ids are not pinned here because the idempotent build scripts keep
 * names stable, not ids).
 *
 * Confirmed manually (not re-asserted here — see RUNBOOK.md's 2026-10-23
 * rehearsal-log row): pointed this spec's dataset-lookup step at the
 * pre-fix v3 dataset id (`f6625291-4c6d-4675-a1a0-027376ce9999`) and it
 * FAILED on `rowCount === 42` (actual: 0); re-pointed at the live
 * (dynamically-resolved) dataset and it PASSED.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_NAME = 'Microbiote IgG4 — synthetic reproduction (AXI-2064)';
const HEATMAP_ANALYSIS_NAME_V4 = 'synthetic — Spearman correlation heatmap (6 x 7, AXI-2065, v4 — AXI-2244 empty-dataset fix)';
const EXPECTED_ROW_COUNT = 42;

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, 'X-Workspace-Id': WORKSPACE_ID };
}

let api: APIRequestContext;
let token: string;
let projectId: string;

test.beforeAll(async () => {
  api = await request.newContext();
  const login = await api.post(apiUrl('/api/v1/auth/login'), {
    data: { email: 'admin@cro-one.com', password: 'admin' },
  });
  expect(login.ok()).toBeTruthy();
  token = (await login.json()).accessToken;

  const projects = await api.get(apiUrl('/api/v1/projects'), {
    headers: headers(token),
    params: { workspaceId: WORKSPACE_ID, limit: 100, page: 1 },
  });
  const body = await projects.json();
  const project = body.data.find((p: { name: string }) => p.name === PROJECT_NAME);
  expect(project, `seeded project "${PROJECT_NAME}" must exist — run AXI-2064's script first`).toBeTruthy();
  projectId = project.id;
});

test.afterAll(async () => {
  await api?.dispose();
});

async function analysisByName(name: string) {
  const res = await api.get(apiUrl('/api/v1/view-analyses'), {
    headers: headers(token),
    params: { projectId, limit: 100, page: 1 },
  });
  const body = await res.json();
  return body.data.find((a: { name: string }) => a.name === name);
}

async function firstEvidence(analysisId: string) {
  const res = await api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/evidences`), {
    headers: headers(token),
    params: { page: 1, limit: 30 },
  });
  expect(res.ok()).toBeTruthy();
  const evidences = (await res.json()).data as Array<{
    currentVersion: { datasetBinding: { datasetId: string } };
  }>;
  expect(evidences.length).toBeGreaterThanOrEqual(1);
  return evidences[0];
}

async function datasetById(datasetId: string) {
  const res = await api.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}`), {
    headers: headers(token),
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { availability: string; latestIngestion: { rowCount: number } | null };
}

test('AC1 — the heatmap evidence cites a dataset that is available with all 42 rows (@SI-053)', async () => {
  const analysis = await analysisByName(HEATMAP_ANALYSIS_NAME_V4);
  expect(analysis, `heatmap analysis "${HEATMAP_ANALYSIS_NAME_V4}" must exist`).toBeTruthy();

  const evidence = await firstEvidence(analysis.id);
  const datasetId = evidence.currentVersion.datasetBinding.datasetId;
  expect(datasetId, 'the heatmap evidence must bind a dataset').toBeTruthy();

  const dataset = await datasetById(datasetId);

  // This is exactly the pair of facts `heatmap_synthetic_v3.csv` failed:
  // it WAS `availability: 'available'` but its ingestion reported
  // `rowCount: 0` — a check the AXI-2065 spec never made.
  expect(dataset.availability).toBe('available');
  expect(dataset.latestIngestion?.rowCount).toBe(EXPECTED_ROW_COUNT);
});
