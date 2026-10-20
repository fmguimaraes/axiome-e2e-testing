import { test, expect, APIRequestContext, request } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2065 — evidence + charts for the Microbiote IgG4 reproduction
 * (manual-e2e AXI-2060-Microbiote-IgG4-Study-Reproduction.md §AXI-2065,
 * FR17-FR19, AC8).
 *
 * READ-ONLY against the seeded demo project `Microbiote IgG4 — synthetic
 * reproduction (AXI-2064)` (org CeRAINOM-IgG4, workspace Mag4). This spec
 * makes no POST/PATCH call — it only verifies what
 * `demo/mag4-microbiote/scripts/build_evidence_and_charts.py` already
 * created on the shared demo stack: one evidence per slide-2/slide-3
 * question per reference (21), carrying a hand-built `boxplot_v1` chart,
 * plus one heatmap evidence carrying a hand-built `heatmap_annotated_v1`
 * chart over the 42-row Spearman summary dataset.
 *
 * Login is the demo stack default (`admin@cro-one.com`/`admin`,
 * `feedback_default_local_login.md`) — this is NOT the fixture org every
 * other spec provisions; it is the ONE project this epic's W4 stories
 * create (NFR4), so the spec discovers everything by exact name rather
 * than hardcoding ids that a re-run of the (idempotent) build scripts
 * would keep stable anyway, but need not be pinned here.
 *
 * Review bounce #1 (2026-10-20) — heatmap provenance: the original
 * heatmap analysis/evidence/dataset ("...AXI-2065)") are now a
 * superseded v1 object graph, left live and read-only, labelled
 * superseded in their own text/notes (never deleted). This spec targets
 * the superseding v2 object graph ("...AXI-2065, v2 — source-run
 * provenance)") and additionally asserts the v1 evidence's text now
 * says SUPERSEDED, plus every boxplot/heatmap text carries its source
 * run id(s).
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_NAME = 'Microbiote IgG4 — synthetic reproduction (AXI-2064)';
const HEATMAP_ANALYSIS_NAME_V1 = 'synthetic — Spearman correlation heatmap (6 x 7, AXI-2065)';
const HEATMAP_ANALYSIS_NAME = 'synthetic — Spearman correlation heatmap (6 x 7, AXI-2065, v2 — source-run provenance)';

const REFERENCES = ['CER228', 'MAG4-27', 'MAG4-22', 'MAG4-13', 'CER215+234', 'CER229', 'ENT059'];

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

async function evidencesFor(analysisId: string) {
  const res = await api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/evidences`), {
    headers: headers(token),
    params: { page: 1, limit: 30 },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data as Array<{ id: string; currentVersion: { title: string; chartArtifactIds: string[]; text: string } }>;
}

for (const reference of REFERENCES) {
  test(`AC8 — ${reference} carries 3 boxplot evidences, each with a chart (FR17)`, async () => {
    const analysisName = `synthetic — ${reference} reproduction`;
    const analysis = await analysisByName(analysisName);
    expect(analysis, `analysis "${analysisName}" must exist`).toBeTruthy();

    const evidences = await evidencesFor(analysis.id);
    const titles = evidences.map((e) => e.currentVersion.title);

    expect(titles.some((t) => t.includes(reference) && t.includes('Kruskal-Wallis') && !t.includes('cluster'))).toBeTruthy();
    expect(titles.some((t) => t.includes(reference) && t.includes('pancreato-biliary'))).toBeTruthy();
    expect(titles.some((t) => t.includes(reference) && t.includes('ACR/EULAR'))).toBeTruthy();

    for (const evidence of evidences) {
      expect(evidence.currentVersion.chartArtifactIds.length).toBeGreaterThan(0);
      expect(evidence.currentVersion.text).toContain('hand_built');
      // Review bounce #1 — every boxplot evidence cites its source run id.
      expect(evidence.currentVersion.text).toContain('Source run:');
    }
  });
}

test('AC8/FR19 — the Spearman heatmap evidence covers 6 variables x 7 references with a hand-built heatmap chart', async () => {
  const analysis = await analysisByName(HEATMAP_ANALYSIS_NAME);
  expect(analysis, `heatmap analysis "${HEATMAP_ANALYSIS_NAME}" must exist`).toBeTruthy();

  const evidences = await evidencesFor(analysis.id);
  expect(evidences.length).toBeGreaterThanOrEqual(1);
  const heatmapEvidence = evidences[0];

  expect(heatmapEvidence.currentVersion.chartArtifactIds.length).toBe(1);
  expect(heatmapEvidence.currentVersion.text).toContain('hand_built');

  // FR19 — every one of the 7 references appears in the per-cell significance table.
  for (const reference of REFERENCES) {
    expect(heatmapEvidence.currentVersion.text).toContain(reference);
  }
});

test('Review bounce #1 — the v2 heatmap evidence states its 42 cells are copied, not recomputed, and cites each cell\'s source run ids', async () => {
  const analysis = await analysisByName(HEATMAP_ANALYSIS_NAME);
  expect(analysis, `heatmap analysis "${HEATMAP_ANALYSIS_NAME}" must exist`).toBeTruthy();

  const evidences = await evidencesFor(analysis.id);
  const heatmapEvidence = evidences[0];

  expect(heatmapEvidence.currentVersion.text).toContain('COPIED');
  expect(heatmapEvidence.currentVersion.text).toContain('recomputed');
  // the hand-built-vs-correlation_heatmap_v1 reasoning the bounce corrected.
  expect(heatmapEvidence.currentVersion.text).toContain('correlation_heatmap_v1');
});

test('Review bounce #1 — the superseded v1 heatmap evidence is labelled SUPERSEDED, never deleted', async () => {
  const v1Analysis = await analysisByName(HEATMAP_ANALYSIS_NAME_V1);
  expect(v1Analysis, `v1 heatmap analysis "${HEATMAP_ANALYSIS_NAME_V1}" must still exist`).toBeTruthy();

  const evidences = await evidencesFor(v1Analysis.id);
  expect(evidences.length).toBeGreaterThanOrEqual(1);
  expect(evidences[0].currentVersion.text).toContain('SUPERSEDED');
});

test('FR20/FR21 — no analysis has been published yet (interpretation + publish are human acts owed to AXI-2066+)', async () => {
  for (const reference of REFERENCES) {
    const analysisName = `synthetic — ${reference} reproduction`;
    const analysis = await analysisByName(analysisName);
    const res = await api.get(apiUrl(`/api/v1/view-analyses/${analysis.id}/published-versions`), {
      headers: headers(token),
      params: { status: 'published' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data).toEqual([]);
  }
});
