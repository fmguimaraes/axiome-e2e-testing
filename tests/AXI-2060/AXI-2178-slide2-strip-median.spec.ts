import { test, expect, APIRequestContext, request } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2178 — slide-2 strip reproduction fix (manual-e2e
 * AXI-2060-Microbiote-IgG4-Study-Reproduction.md §AXI-2178, FR26/FR27, AC13).
 *
 * READ-ONLY, API-level. Verifies the platform objects that
 * `demo/mag4-microbiote/RUNBOOK.md` §E (AXI-2178 platform re-run) mints:
 *
 * - each slide-2 reference's v2 Q1 Kruskal-Wallis evidence cites a NEW
 *   `strip_v1` spec with `show_median: true` (FR26), on the dataset the
 *   evidence itself is bound to (provenance), and its v2 Dunn evidence cites
 *   the same chart;
 * - the pre-AXI-2178 KW evidence is SUPERSEDED in place, never deleted;
 * - for ENT059 and CER229 the v2 KW text states IgG4-RD above BOTH HD and SD
 *   (FR27) — a sentence the evidence builder derives from the platform's own
 *   Dunn z statistics, and which reads "below" (never "above") on reversed
 *   data.
 *
 * Until §E has run against the stack under test, these tests fail by design
 * (no v2 evidence exists) and this spec is reported AUTHORED, never
 * `e2e-pass`.
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_NAME = 'Microbiote IgG4 — synthetic reproduction (AXI-2064)';
const REFERENCES = ['ENT059', 'CER229', 'CER215+234'];
const V2_MARK = 'v2 — AXI-2178';

type ChartEntry = { chartArtifactId: string; datasetVersionId: string; snapshotId: string };
type Evidence = {
  id: string;
  currentVersion: {
    title: string;
    text: string;
    charts: ChartEntry[];
    datasetBinding: { datasetId: string } | null;
  };
};

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

async function evidencesFor(reference: string): Promise<Evidence[]> {
  const analysisName = `synthetic — ${reference} reproduction`;
  const analysis = await analysisByName(analysisName);
  expect(analysis, `analysis "${analysisName}" must exist`).toBeTruthy();
  const res = await api.get(apiUrl(`/api/v1/view-analyses/${analysis.id}/evidences`), {
    headers: headers(token),
    params: { page: 1, limit: 50 },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data as Evidence[];
}

const isQ1Kw = (e: Evidence, reference: string) =>
  e.currentVersion.title.startsWith(`${reference}: `) &&
  e.currentVersion.title.includes('Kruskal-Wallis') &&
  !e.currentVersion.title.includes('cluster');

function v2Kw(evidences: Evidence[], reference: string) {
  const found = evidences.find((e) => isQ1Kw(e, reference) && e.currentVersion.title.includes(V2_MARK));
  expect(found, `the v2 (AXI-2178) Kruskal-Wallis evidence for ${reference} must exist — run RUNBOOK §E`).toBeTruthy();
  return found!;
}

async function specById(datasetId: string, specId: string) {
  const res = await api.get(apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates/${specId}`), {
    headers: headers(token),
  });
  expect(res.ok(), JSON.stringify(await res.json().catch(() => ({})))).toBeTruthy();
  return res.json();
}

for (const reference of REFERENCES) {
  test(`AC13/FR26 @SI-015 @SI-016 — ${reference}'s v2 Q1 evidences cite one strip_v1 chart with show_median:true on their bound dataset`, async () => {
    const evidences = await evidencesFor(reference);
    const kw = v2Kw(evidences, reference);
    expect(kw.currentVersion.charts.length).toBeGreaterThan(0);
    const chart = kw.currentVersion.charts[0];

    const spec = await specById(chart.datasetVersionId, chart.chartArtifactId);
    expect(spec.templateId, 'FR26: a NEW strip_v1 spec, never a repurposed boxplot_v1').toBe('strip_v1');
    expect(spec.params?.show_median, 'FR26: every point visible plus a per-group median bar').toBe(true);
    expect(kw.currentVersion.datasetBinding?.datasetId, 'the evidence is bound to the data its chart draws').toBe(
      chart.datasetVersionId,
    );

    const dunn = evidences.find(
      (e) => e.currentVersion.title.startsWith(`${reference}: Dunn post-hoc`) && e.currentVersion.title.includes(V2_MARK),
    );
    expect(dunn, `the v2 Dunn evidence for ${reference} must exist`).toBeTruthy();
    expect(dunn!.currentVersion.charts[0]?.chartArtifactId, 'Dunn cites the same Q1 chart').toBe(chart.chartArtifactId);

    const old = evidences.find((e) => isQ1Kw(e, reference) && !e.currentVersion.title.includes(V2_MARK));
    if (old) {
      // A fresh project has no pre-AXI-2178 evidence; where one exists it is superseded, never deleted.
      expect(old.currentVersion.text.startsWith('SUPERSEDED (AXI-2178')).toBe(true);
    }
  });
}

test('AC13/FR27 @SI-053 — ENT059 and CER229 v2 evidences state IgG4-RD above both HD and SD, from the platform Dunn run', async () => {
  for (const reference of ['ENT059', 'CER229']) {
    const kw = v2Kw(await evidencesFor(reference), reference);
    expect(kw.currentVersion.text).toContain('Direction measured by the platform');
    expect(kw.currentVersion.text).toMatch(/IgG4-RD above HD \(z = /);
    expect(kw.currentVersion.text).toMatch(/IgG4-RD above SD \(z = /);
    expect(kw.currentVersion.text).not.toMatch(/IgG4-RD below/);
  }
});
