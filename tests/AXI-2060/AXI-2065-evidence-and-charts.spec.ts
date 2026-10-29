import { test, expect, APIRequestContext, request } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2065 — evidence + charts for the Microbiote IgG4 reproduction
 * (manual-e2e AXI-2060-Microbiote-IgG4-Study-Reproduction.md §AXI-2065,
 * FR17-FR19, AC8). READ-ONLY against the seeded demo project `Microbiote
 * IgG4 — synthetic reproduction (AXI-2064)` (org CeRAINOM-IgG4, workspace
 * Mag4), own admin login (not the fixture-org `setup` project).
 *
 * AXI-2247 (2026-10-29, bounce 1) — the evidence/analysis chain kept
 * moving after this spec was written (AXI-2178/AXI-2154/AXI-2244/AXI-2245
 * each superseded/updated evidence this spec never re-pointed at), so it
 * silently went 9/11 red (the suite does not run in CI). Fixed by never
 * hardcoding a "current" evidence id/analysis name/text: `currentEvidences`
 * keeps only the evidences no sibling evidence names as its
 * `datasetBinding.parentEvidenceId` (AC1); `perReferenceEvidences` further
 * scopes to this story's own `"<reference>: ..."` title convention, since
 * later demo-polish work added a cross-reference evidence sharing the
 * same analysis under a different convention; `resolveHeatmapEvidence`
 * pools every analysis sharing the heatmap's name prefix (superseded 4x
 * under different names/ids) and applies the same filter; every evidence
 * under test also has its cited dataset asserted non-empty via
 * `assertCitedDatasetNonEmpty` (AC2 — bounce 1 found the ORIGINAL spec's
 * `chartArtifactIds.length > 0` + text-content checks pass straight
 * through a dataset that is `available` but `rowCount: 0`, exactly
 * AXI-2244's defect class on the live-but-superseded v3 heatmap dataset
 * `f6625291`) and its cited chart(s) resolved to an actual, existing chart
 * spec via `assertCitedChartExists` (not just a non-zero id count).
 * `latestNonNullText()` reads the SAME (current) evidence's own version
 * history for the latest version carrying text, because the current
 * heatmap evidence's live `currentVersion.text` is `null` as of AXI-2245
 * (a display-only chart-binding PATCH that did not resend provenance
 * text — a real platform fact, not fixed here).
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_NAME = 'Microbiote IgG4 — synthetic reproduction (AXI-2064)';
const HEATMAP_ANALYSIS_NAME_V1 = 'synthetic — Spearman correlation heatmap (6 x 7, AXI-2065)';
const HEATMAP_NAME_PREFIX = 'synthetic — Spearman correlation heatmap (6 x 7, AXI-2065';

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

type Evidence = {
  id: string;
  currentVersion: {
    versionNumber: number;
    title: string;
    chartArtifactIds: string[];
    text: string | null;
    datasetBinding?: { parentEvidenceId?: string | null; datasetId?: string | null };
    charts?: Array<{ chartArtifactId: string; datasetVersionId: string; frozen?: boolean }>;
  };
};

async function allAnalyses(): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  let page = 1;
  for (;;) {
    const res = await api.get(apiUrl('/api/v1/view-analyses'), {
      headers: headers(token),
      params: { projectId, limit: 100, page },
    });
    const body = await res.json();
    out.push(...body.data);
    if (!body.meta?.hasNextPage) break;
    page += 1;
  }
  return out;
}

async function analysisByName(name: string) {
  return (await allAnalyses()).find((a) => a.name === name);
}

async function evidencesFor(analysisId: string): Promise<Evidence[]> {
  const res = await api.get(apiUrl(`/api/v1/view-analyses/${analysisId}/evidences`), {
    headers: headers(token),
    params: { page: 1, limit: 30 },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data as Evidence[];
}

// AC1 — "current" = no OTHER evidence in the pool names this one as its
// datasetBinding.parentEvidenceId. Structural, never a hardcoded id/text.
function currentEvidences(evidences: Evidence[]): Evidence[] {
  const superseded = new Set(
    evidences
      .map((e) => e.currentVersion.datasetBinding?.parentEvidenceId)
      .filter((id): id is string => Boolean(id)),
  );
  return evidences.filter((e) => !superseded.has(e.id));
}

// Demo-polish work since this spec's own story (e.g. the ENT059 analysis
// also carries a combined, later, cross-reference "Slide 2 (IgG4)..."
// facet evidence spanning ENT059/CER229/CER215+234) adds evidence kinds
// FR17's "3 per-reference questions" never described and that use their
// own, different text convention. Scope the per-reference boxplot/Dunn/
// correlation check to the single-reference evidence family this story
// actually builds — identified structurally by its own title convention
// (`"<reference>: ..."`), never by excluding a specific hardcoded id.
function perReferenceEvidences(evidences: Evidence[], reference: string): Evidence[] {
  return currentEvidences(evidences).filter((e) => e.currentVersion.title.startsWith(`${reference}:`));
}

// The heatmap analysis itself has been superseded repeatedly under
// different names/ids (v1..v4+). Pool every analysis under the shared
// name prefix, pool their evidences, and apply the same parentEvidenceId
// filter across the whole pool to land on today's one surviving evidence.
async function resolveHeatmapEvidence(): Promise<{ analysis: { id: string; name: string }; evidence: Evidence }> {
  const candidates = (await allAnalyses()).filter((a) => a.name.startsWith(HEATMAP_NAME_PREFIX));
  const pool: Array<{ analysis: { id: string; name: string }; evidence: Evidence }> = [];
  for (const analysis of candidates) {
    for (const evidence of await evidencesFor(analysis.id)) {
      pool.push({ analysis, evidence });
    }
  }
  const current = currentEvidences(pool.map((p) => p.evidence));
  const currentIds = new Set(current.map((e) => e.id));
  const survivors = pool.filter((p) => currentIds.has(p.evidence.id));
  expect(survivors.length, 'exactly one current (non-superseded) heatmap evidence must exist').toBe(1);
  return survivors[0];
}

// A later PATCH can replace a version's text with null without
// superseding the evidence (AXI-2245: a display-only chart-binding
// update). Walk the SAME evidence's own version history for the most
// recent version that still carries provenance text.
async function latestNonNullText(evidenceId: string): Promise<string> {
  const res = await api.get(apiUrl(`/api/v1/view-analyses/evidences/${evidenceId}/versions`), {
    headers: headers(token),
  });
  expect(res.ok()).toBeTruthy();
  const versions = (await res.json()) as Array<{ versionNumber: number; text: string | null }>;
  const withText = [...versions].sort((a, b) => b.versionNumber - a.versionNumber).find((v) => v.text);
  expect(withText, `evidence ${evidenceId} has no version carrying any text`).toBeTruthy();
  return withText!.text as string;
}

// AC2 (bounce 1) — "a chart exists and has a chartArtifactId" is not the
// same fact as "the dataset it cites actually has rows". Bounce 1 found
// the live, structurally-identical counter-example: the superseded v3
// heatmap evidence (d576b8d2) cites dataset f6625291, `available` but
// `rowCount: 0` — AXI-2244's own defect class. Same endpoint/shape as
// AXI-2244-heatmap-dataset.spec.ts's own check, just applied to every
// CURRENT evidence this spec resolves, not hardcoded to one heatmap name.
async function assertCitedDatasetNonEmpty(evidence: Evidence): Promise<void> {
  const datasetId = evidence.currentVersion.datasetBinding?.datasetId;
  expect(datasetId, `evidence ${evidence.id} must bind a dataset`).toBeTruthy();
  const res = await api.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}`), {
    headers: headers(token),
  });
  expect(res.ok()).toBeTruthy();
  const dataset = (await res.json()) as { availability: string; latestIngestion: { rowCount: number } | null };
  expect(dataset.availability, `evidence ${evidence.id}'s cited dataset ${datasetId} must be available`).toBe(
    'available',
  );
  expect(
    dataset.latestIngestion?.rowCount ?? 0,
    `evidence ${evidence.id}'s cited dataset ${datasetId} must not be empty (rowCount)`,
  ).toBeGreaterThan(0);
}

// AC2 — resolve each cited chartArtifactId to an actual, existing chart
// spec, not just a non-zero id count (same `.../candidates/:specId`
// resolution AXI-2178-slide2-strip-median.spec.ts's specById() uses).
// Confirmed live that NEITHER a chart entry's own `datasetVersionId` NOR
// the evidence's `datasetBinding.datasetId` is reliably the right id to
// resolve against: for the Dunn/KW-group evidences both happen to agree;
// for the Dunn/MWU/partial-correlation evidences only the chart entry's
// own `datasetVersionId` resolves (datasetBinding.datasetId 404s — the
// chart was built against a different, cohort-derived dataset than the
// evidence's own citation); for the heatmap evidence only
// `datasetBinding.datasetId` resolves (the chart entry's own
// `datasetVersionId` there holds the ingestion id, not a dataset id).
// Try both and accept whichever resolves, rather than hardcode either
// field as "the" dataset id. Only covers non-frozen charts: a frozen
// render's chartArtifactId is a render fingerprint (`dvi_…`,
// AXI-1234/AXI-2296), not a live candidate spec id, and none of this
// story's hand-built evidence charts are frozen — if a future evidence
// here ever is, this check cannot resolve it and should be extended
// rather than silently skipped.
async function candidateResolves(datasetId: string, specId: string): Promise<boolean> {
  const res = await api.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates/${specId}`), {
    headers: headers(token),
  });
  return res.ok();
}

async function assertCitedChartExists(evidence: Evidence): Promise<void> {
  const charts = evidence.currentVersion.charts ?? [];
  expect(charts.length, `evidence ${evidence.id} must cite at least one chart`).toBeGreaterThan(0);
  const boundDatasetId = evidence.currentVersion.datasetBinding?.datasetId;
  for (const chart of charts) {
    expect(
      chart.frozen,
      `evidence ${evidence.id}'s chart ${chart.chartArtifactId} is frozen — assertCitedChartExists cannot resolve a frozen render fingerprint`,
    ).toBeFalsy();
    const candidateIds = [chart.datasetVersionId, boundDatasetId].filter(
      (id, idx, arr): id is string => Boolean(id) && arr.indexOf(id) === idx,
    );
    let resolved = false;
    for (const datasetId of candidateIds) {
      if (await candidateResolves(datasetId, chart.chartArtifactId)) {
        resolved = true;
        break;
      }
    }
    expect(
      resolved,
      `evidence ${evidence.id}'s cited chart ${chart.chartArtifactId} must actually exist (tried dataset ids: ${candidateIds.join(', ')})`,
    ).toBeTruthy();
  }
}

for (const reference of REFERENCES) {
  test(`AC8 — ${reference} carries boxplot/Dunn/correlation evidences, each with a chart citing its own run (FR17) @SI-053`, async () => {
    const analysisName = `synthetic — ${reference} reproduction`;
    const analysis = await analysisByName(analysisName);
    expect(analysis, `analysis "${analysisName}" must exist`).toBeTruthy();

    const evidences = await evidencesFor(analysis!.id);
    // AC1/AC3 — only the CURRENT, per-reference evidences (never the ones
    // a sibling evidence's parentEvidenceId names as superseded, e.g. the
    // AXI-2178-superseded Q1/Dunn pair still live, read-only, on main; and
    // never a later cross-reference evidence that shares this analysis
    // but is not one of FR17's 3 per-reference questions).
    const current = perReferenceEvidences(evidences, reference);
    const titles = current.map((e) => e.currentVersion.title);

    expect(titles.some((t) => t.includes(reference) && t.includes('Kruskal-Wallis') && !t.includes('cluster'))).toBeTruthy();
    expect(titles.some((t) => t.includes(reference) && t.includes('pancreato-biliary'))).toBeTruthy();
    expect(titles.some((t) => t.includes(reference) && t.includes('ACR/EULAR'))).toBeTruthy();

    for (const evidence of current) {
      expect(evidence.currentVersion.chartArtifactIds.length).toBeGreaterThan(0);
      expect(evidence.currentVersion.text).toContain('hand_built');
      // Review bounce #1 (AXI-2065) — every current evidence cites its source run id.
      expect(evidence.currentVersion.text).toContain('Source run:');
      // AC3 — a CURRENT evidence must never itself read as superseded text.
      expect(evidence.currentVersion.text).not.toContain('SUPERSEDED');
      // AC2 (bounce 1) — the cited dataset must actually have rows, and
      // the cited chart must actually resolve, not just exist by id count.
      await assertCitedDatasetNonEmpty(evidence);
      await assertCitedChartExists(evidence);
    }
  });
}

test('AC8/FR19 — the current Spearman heatmap evidence covers 6 variables x 7 references with a hand-built heatmap chart @SI-053', async () => {
  const { evidence } = await resolveHeatmapEvidence();

  expect(evidence.currentVersion.chartArtifactIds.length).toBe(1);
  // AC2 (bounce 1) — same live counter-example as the per-reference loop:
  // the superseded v3 heatmap evidence's dataset is `available` with
  // `rowCount: 0`. Assert the CURRENT evidence's own cited dataset/chart
  // are real, not just non-zero ids.
  await assertCitedDatasetNonEmpty(evidence);
  await assertCitedChartExists(evidence);

  const text = await latestNonNullText(evidence.id);
  expect(text).toContain('hand_built');
  // AC3 — never satisfied by a SUPERSEDED version's text.
  expect(text).not.toContain('SUPERSEDED');

  // FR19 — every one of the 7 references appears in the per-cell significance table.
  for (const reference of REFERENCES) {
    expect(text).toContain(reference);
  }
});

test('AC1/AC3 (AXI-2247) — the current heatmap evidence states its 42 cells are copied, not recomputed, and cites the withheld recommended chart @SI-053', async () => {
  const { evidence } = await resolveHeatmapEvidence();

  await assertCitedDatasetNonEmpty(evidence);
  await assertCitedChartExists(evidence);

  const text = await latestNonNullText(evidence.id);
  expect(text).toContain('COPIED');
  expect(text).toContain('recomputed');
  expect(text).not.toContain('SUPERSEDED');
  // the hand-built-vs-correlation_heatmap_v1 reasoning from review bounce #1 (AXI-2065).
  expect(text).toContain('correlation_heatmap_v1');
});

test('Review bounce #1 — the superseded v1 heatmap evidence is labelled SUPERSEDED, never deleted', async () => {
  const v1Analysis = await analysisByName(HEATMAP_ANALYSIS_NAME_V1);
  expect(v1Analysis, `v1 heatmap analysis "${HEATMAP_ANALYSIS_NAME_V1}" must still exist`).toBeTruthy();

  const evidences = await evidencesFor(v1Analysis!.id);
  expect(evidences.length).toBeGreaterThanOrEqual(1);
  expect(evidences[0].currentVersion.text).toContain('SUPERSEDED');
});

test('FR20/FR21 — no analysis has been published yet (interpretation + publish are human acts owed to AXI-2066+)', async () => {
  for (const reference of REFERENCES) {
    const analysisName = `synthetic — ${reference} reproduction`;
    const analysis = await analysisByName(analysisName);
    const res = await api.get(apiUrl(`/api/v1/view-analyses/${analysis!.id}/published-versions`), {
      headers: headers(token),
      params: { status: 'published' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).data).toEqual([]);
  }
});
