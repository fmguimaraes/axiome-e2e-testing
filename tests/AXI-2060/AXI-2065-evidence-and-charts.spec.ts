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
 * superseded in their own text/notes (never deleted). Every
 * boxplot/heatmap text carries its source run id(s).
 *
 * AXI-2247 (2026-10-29) — the evidence/analysis chain kept moving after
 * this spec was written (AXI-2178 per-group slide-2 refit superseded the
 * original 21 boxplot evidences' Q1/Dunn pair; AXI-2154 then AXI-2244
 * then AXI-2245 each superseded/updated the heatmap evidence again), and
 * this spec never followed any of it — it kept asserting against
 * evidence ids/names a prior story's PATCH had already labelled
 * SUPERSEDED, so 9/11 tests went silently red (the e2e suite does not
 * run in CI). Fixed by never hardcoding a "current" evidence id or
 * analysis name: every per-reference boxplot/Dunn/correlation test now
 * discovers the full evidence set for its analysis and filters to the
 * subset no OTHER evidence in that set names as its
 * `datasetBinding.parentEvidenceId` (AC1) — the structural definition of
 * "not superseded", instead of a hardcoded superseded string (AC3). The
 * heatmap tests go one step further: the heatmap analysis itself has
 * been superseded four times under different names/ids
 * (v1→v2→v3→v4, see `HEATMAP_NAME_PREFIX`), so `resolveHeatmapEvidence()`
 * discovers every analysis under that name prefix, pools their
 * evidences, and applies the same parentEvidenceId filter across the
 * whole pool to land on today's one surviving (current) evidence,
 * whatever its id or analysis name turns out to be. That current
 * evidence's own live `currentVersion.text` is `null` as of AXI-2245 (a
 * display-only PATCH that replaced the chart binding without re-sending
 * provenance text — a real, not reproduced-here, platform fact); rather
 * than assert against that null, `latestNonNullText()` walks the
 * evidence's own version history for the most recent version that still
 * carries the provenance text nothing since has contradicted — still the
 * SAME (current) evidence id, just the right version of it (AC1's "or by
 * the latest version['s]" clause).
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
    datasetBinding?: { parentEvidenceId?: string | null };
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

for (const reference of REFERENCES) {
  test(`AC8 — ${reference} carries boxplot/Dunn/correlation evidences, each with a chart citing its own run (FR17)`, async () => {
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
      // Review bounce #1 — every current evidence cites its source run id.
      expect(evidence.currentVersion.text).toContain('Source run:');
    }
  });
}

test('AC8/FR19 — the current Spearman heatmap evidence covers 6 variables x 7 references with a hand-built heatmap chart', async () => {
  const { evidence } = await resolveHeatmapEvidence();

  expect(evidence.currentVersion.chartArtifactIds.length).toBe(1);
  const text = await latestNonNullText(evidence.id);
  expect(text).toContain('hand_built');

  // FR19 — every one of the 7 references appears in the per-cell significance table.
  for (const reference of REFERENCES) {
    expect(text).toContain(reference);
  }
});

test('AC1/AC3 (AXI-2247) — the current heatmap evidence states its 42 cells are copied, not recomputed, and cites the withheld recommended chart', async () => {
  const { evidence } = await resolveHeatmapEvidence();

  const text = await latestNonNullText(evidence.id);
  expect(text).toContain('COPIED');
  expect(text).toContain('recomputed');
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
