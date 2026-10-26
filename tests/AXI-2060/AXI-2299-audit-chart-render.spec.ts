import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, request as apiRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { apiUrl } from '../../config/env';

/**
 * AXI-2299 (epic AXI-2060): the evidence audit report draws a chart cited on a
 * run's RESULT snapshot. "Add to evidence" from a run-linked chart cites the
 * run's `rule_derived` snapshot (AXI-2290), whose dataset is the RESULT table;
 * the audit rendered over that dataset, so the PNG was an empty frame (no
 * marks, `col_…` axis titles, "differ from the linked run's input" banner), a
 * faceted strip got no PNG at all, and a frozen citation's chart CSV was its
 * Plotly traces (`[object Object]` cells).
 * Red on main: S1 (empty frame, trace CSV), S2 (no PNG), S3 (empty frame).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-2060-Microbiote-IgG4-Study-
 * Reproduction.md` § AXI-2299 (S1–S3; S4 is manual).
 *
 * Isolation: two THROWAWAY analyses (`[e2e AXI-2299 throwaway] …`) in the
 * synthetic reproduction project 22585add — never project 4ff39166 or
 * b7b274bc. Each run carries a run-unique, row-neutral predicate so it never
 * DEDUPES onto an existing run (a dedup copies no result snapshot here).
 * Cleanup as AXI-2290: evidences retired (`unapproved`), charts deleted,
 * analyses archived (a governed run keeps its analysis, EC3).
 */

const WORKSPACE_ID = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const PROJECT_ID = '22585add-60ab-4d8e-a8ff-0f1071862553';
const FORBIDDEN_PROJECT_IDS = ['4ff39166-071e-4cec-92f3-697373592710', 'b7b274bc-48a3-494a-a66f-76390bb433a8'];
const ENT059_DATASET_ID = '4c1bd11e-74db-4939-ad9f-c4644a0fde7f'; // tableau1_long_synthetic_v2.csv
const HEATMAP_DATASET_ID = '6779b1df-8591-4510-bc31-a9afe364fc90'; // heatmap_synthetic_v4.csv
const KW_RULE_ID = 'ae9d662e-5c6f-412a-af97-0cf11b9edb45';
const DUNN_RULE_ID = '796cfeb8-5fa7-442c-a062-abe5957c2d00';
const GROUPS = ['HD', 'IgG4-RD', 'SD'];
const THROWAWAY = '[e2e AXI-2299 throwaway]';
/** Share of the PNG's pixels that must be coloured marks. The empty frame of
 * the defect scores <= 0.10 % (the banner's text); the drawn S1 boxplot ~8.8 %. */
const MIN_COLOURED_SHARE = 0.01;

type Filter = { column: string; operator: string; value?: unknown };
interface Analysis { id: string; datasetId: string }
interface RunResult { runId: string; inputSnapshotId: string; resultSnapshotId: string }
interface Bundle { files: string[]; read: (name: string) => Buffer }

let api: APIRequestContext;
let userId = '';
const analyses: Analysis[] = [];
const specs: { datasetId: string; id: string }[] = [];
const evidenceIds: string[] = [];

/** Run-unique, row-neutral predicate (every value of the column is above it). */
function guard(column: string, floor: number): Filter {
  return { column, operator: 'gte', value: floor - Math.random() };
}

async function ok<T>(label: string, call: Promise<APIResponse>): Promise<T> {
  const res = await call;
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? null : await res.json()) as T;
}

function candidatesUrl(datasetId: string, suffix = '') {
  return apiUrl(`/api/v1/workspaces/${WORKSPACE_ID}/datasets/${datasetId}/candidates${suffix}`);
}

async function login(): Promise<void> {
  const ctx = await apiRequest.newContext();
  const res = await ctx.post(apiUrl('/api/v1/auth/login'), {
    data: { email: process.env.E2E_ADMIN_EMAIL?.trim() || 'admin@cro-one.com', password: process.env.E2E_ADMIN_PASSWORD?.trim() || 'admin' },
  });
  expect(res.ok()).toBeTruthy();
  const { accessToken } = await res.json();
  await ctx.dispose();
  api = await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'X-Workspace-Id': WORKSPACE_ID } });
  userId = (await ok<{ id: string }>('me', api.get(apiUrl('/api/v1/auth/me')))).id;
}

async function createAnalysis(datasetId: string): Promise<Analysis> {
  expect(FORBIDDEN_PROJECT_IDS).not.toContain(PROJECT_ID);
  const va = await ok<{ id: string }>('analysis', api.post(apiUrl('/api/v1/view-analyses'), {
    data: { projectId: PROJECT_ID, datasetId, name: `${THROWAWAY} ${Date.now()}`, createdBy: userId },
  }));
  const analysis = { id: va.id, datasetId };
  analyses.push(analysis);
  return analysis;
}

async function resultSnapshotOf(analysis: Analysis, runId: string): Promise<string> {
  const find = async () => {
    const body = await ok<{ data: { id: string; origin?: string; ruleRunId?: string | null }[] }>('snapshots',
      api.get(apiUrl(`/api/v1/view-analyses/${analysis.id}/snapshots?page=1&limit=200`)));
    return body.data.find((s) => s.ruleRunId === runId && s.origin === 'rule_derived')?.id ?? '';
  };
  await expect.poll(find, { timeout: 30_000 }).not.toBe('');
  return find();
}

/** A statistics run on a fresh filter snapshot; returns its input and RESULT snapshots. */
async function runOn(analysis: Analysis, op: { ruleId: string; operationId: string; groupColumn: string; valueColumn: string }, filters: Filter[]): Promise<RunResult> {
  const inputSnapshotId = (await ok<{ id: string }>('filter snapshot', api.post(apiUrl('/api/v1/view-analyses/snapshots'), {
    data: { viewAnalysisId: analysis.id, filters },
  }))).id;
  const created = await ok<{ ruleRunId: string; status: string }>(op.operationId, api.post(apiUrl('/api/v1/rule-runs'), {
    data: {
      ruleId: op.ruleId, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, datasetId: analysis.datasetId,
      snapshotId: inputSnapshotId, viewAnalysisId: analysis.id, runKind: 'STATISTICAL', scope: 'FILTERED',
      operationId: op.operationId, roleBindings: { groupColumn: op.groupColumn }, pivot: { valueColumn: op.valueColumn }, filters,
    },
  }));
  expect(created.status, 'a fresh, non-deduped run (else no result snapshot lands here)').not.toBe('DEDUPED');
  await expect.poll(async () => (await ok<{ status: string }>('run', api.get(apiUrl(`/api/v1/rule-runs/${created.ruleRunId}`)))).status, { timeout: 120_000 }).toBe('SUCCEEDED');
  return { runId: created.ruleRunId, inputSnapshotId, resultSnapshotId: await resultSnapshotOf(analysis, created.ruleRunId) };
}

interface ChartBody { templateId: string; title: string; bindings: object; params: object; filters: Filter[] }

async function createChart(analysis: Analysis, body: ChartBody): Promise<string> {
  const spec = await ok<{ id: string }>(`chart ${body.title}`, api.post(candidatesUrl(analysis.datasetId), {
    data: { templateVersion: '1.0.0', ...body, title: `${THROWAWAY} ${body.title}`, viewAnalysisId: analysis.id },
  }));
  specs.push({ datasetId: analysis.datasetId, id: spec.id });
  return spec.id;
}

/** The evidence, citing `entry` on the run's RESULT snapshot. */
async function citeOnResultSnapshot(analysis: Analysis, title: string, entry: Record<string, unknown>): Promise<{ id: string; version: number }> {
  const created = await ok<{ id: string; currentVersion: { versionNumber: number; charts?: { snapshotId: string }[] } }>('evidence',
    api.post(apiUrl('/api/v1/view-analyses/evidences'), {
      data: { viewAnalysisId: analysis.id, title: `${THROWAWAY} ${title}`, createdBy: userId, chartEntries: [{ datasetVersionId: analysis.datasetId, ...entry }] },
    }));
  evidenceIds.push(created.id);
  return { id: created.id, version: created.currentVersion.versionNumber };
}

async function downloadBundle(evidence: { id: string; version: number }): Promise<Bundle> {
  const res = await api.get(apiUrl(`/api/v1/view-analyses/evidences/${evidence.id}/versions/${evidence.version}/audit-report?includeSource=true`));
  expect(res.status(), await res.text().catch(() => '')).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), 'axi-2299-'));
  writeFileSync(join(dir, 'bundle.zip'), await res.body());
  execFileSync('unzip', ['-q', join(dir, 'bundle.zip'), '-d', join(dir, 'x')]);
  const files = execFileSync('unzip', ['-Z1', join(dir, 'bundle.zip')]).toString('utf8').split('\n').filter(Boolean);
  return { files, read: (name) => readFileSync(join(dir, 'x', name)) };
}

/** Share of a PNG's pixels that are coloured (not white/grey/black) — the
 * marks a chart draws, incl. a box's pale fill; a frame, ticks and black axis
 * text never count.
 * pngjs ships inside playwright-core; no extra dependency. */
function colouredShare(png: Buffer): number {
  const { PNG } = createRequire(join(process.cwd(), 'package.json'))('playwright-core/lib/utilsBundle');
  const image = PNG.sync.read(png) as { width: number; height: number; data: Buffer };
  let coloured = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b, a] = [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
    if (a > 0 && Math.max(r, g, b) - Math.min(r, g, b) > 20) coloured++;
  }
  return coloured / (image.width * image.height);
}

function expectDrawnChartPng(bundle: Bundle, chartId: string): void {
  const name = `charts/${chartId}.png`;
  expect(bundle.files, `the bundle attaches ${name}`).toContain(name);
  const share = colouredShare(bundle.read(name));
  expect(share, `${name} draws marks (coloured share ${(share * 100).toFixed(2)} %), not an empty frame`).toBeGreaterThan(MIN_COLOURED_SHARE);
}

/** The one chart step id a single-chart bundle carries. */
function chartIdOf(bundle: Bundle): string {
  const pngs = bundle.files.filter((f) => /^charts\/[^/]+\.png$/.test(f));
  const csvs = bundle.files.filter((f) => /^data\/charts\/[^/]+\.csv$/.test(f));
  const id = (pngs[0] ?? csvs[0] ?? '').replace(/^(data\/)?charts\//, '').replace(/\.(png|csv)$/, '');
  expect(id, `a chart file in ${JSON.stringify(bundle.files)}`).not.toBe('');
  return id;
}

test.describe('AXI-2299 - the audit report draws a chart cited on a run result snapshot', { tag: ['@SI-016', '@SI-018'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });
  test.use({ storageState: { cookies: [], origins: [] } });

  let ent059: Analysis;
  let kw: RunResult;
  let kwFilters: Filter[];

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    await login();
    ent059 = await createAnalysis(ENT059_DATASET_ID);
    kwFilters = [{ column: 'group', operator: 'in', value: GROUPS }, { column: 'reference', operator: 'eq', value: 'ENT 059' }, guard('pct', -1)];
    kw = await runOn(ent059, { ruleId: KW_RULE_ID, operationId: 'stats.kruskal_wallis', groupColumn: 'group', valueColumn: 'pct' }, kwFilters);
  });

  test.afterAll(async () => {
    if (!api) return;
    for (const id of evidenceIds) await api.patch(apiUrl(`/api/v1/view-analyses/evidences/${id}/status`), { data: { status: 'unapproved' } });
    for (const spec of specs) await api.delete(candidatesUrl(spec.datasetId, `/${spec.id}`));
    for (const analysis of analyses) await api.patch(apiUrl(`/api/v1/view-analyses/${analysis.id}/archive`), { data: {} });
    await api.dispose();
  });

  test('S1 AC1 @SI-016 - a FROZEN boxplot cited on a Kruskal-Wallis result snapshot is drawn, and its CSV is row-level data', async () => {
    const bindings = { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' } };
    const params = { chart_title: 'IgG4-reactive microbiota by group', y_title: '% opsonized', y_scale: 'log', show_points: true, group_order: GROUPS, group_labels: { HD: 'Healthy donors' } };
    // The chart's slice IS the run's input (as on the live chart, where both are
    // unfiltered) — so the linked run is no slice mismatch, only the dataset was.
    const specId = await createChart(ent059, { templateId: 'boxplot_v1', title: 'S1 boxplot', bindings, params, filters: kwFilters });
    await ok('link', api.patch(candidatesUrl(ENT059_DATASET_ID, `/${specId}/compute-run-link`), { data: { computeRunId: kw.runId } }));
    // The frozen payload is a Plotly figure, exactly as the chart card freezes it (AXI-1234).
    const payloadJson = { data: GROUPS.map((g) => ({ type: 'box', name: g, y: [0.4, 5.3, 2.7], line: { width: 1 }, marker: { color: '#8b5cf6' } })), layout: {} };
    const evidence = await citeOnResultSnapshot(ent059, `S1 ${Date.now()}`, {
      chartArtifactId: specId, snapshotId: kw.resultSnapshotId,
      frozenRender: { dataviewSpecId: specId, datasetVersionId: ENT059_DATASET_ID, templateId: 'boxplot_v1', templateVersion: '1.0.0', bindings, params, computeRunId: kw.runId, payloadJson },
    });

    const bundle = await downloadBundle(evidence);
    const chartId = chartIdOf(bundle);

    expectDrawnChartPng(bundle, chartId);
    const csv = bundle.read(`data/charts/${chartId}.csv`).toString('utf8');
    const header = csv.split('\n')[0].split(',');
    expect(header, 'the chart CSV carries the dataset\'s row-level columns').toEqual(expect.arrayContaining(['group', 'pct', 'reference']));
    expect(csv).not.toContain('[object Object]');
    expect(csv.split('\n').length - 1, 'one CSV line per drawn row').toBeGreaterThan(GROUPS.length);
  });

  test('S2 AC1 @SI-016 - a faceted strip chart cited on a Dunn result snapshot is drawn', async () => {
    const runGuard = guard('pct', -1);
    const dunn = await runOn(ent059, { ruleId: DUNN_RULE_ID, operationId: 'stats.dunn_posthoc', groupColumn: 'group', valueColumn: 'pct' },
      [{ column: 'group', operator: 'in', value: GROUPS }, { column: 'reference', operator: 'eq', value: 'CER 229' }, runGuard]);
    // The CER 229 panel's slice (facet value narrowed in) IS the Dunn run's input.
    const specId = await createChart(ent059, {
      templateId: 'strip_v1', title: 'S2 faceted strip',
      bindings: { y: { column_id: 'col_pct' }, group: { column_id: 'col_group' }, facet: { column_id: 'col_reference' } },
      params: { x_title: 'Reference microbiota', y_title: '% opsonized', group_order: GROUPS, facet_order: ['ENT 059', 'CER 229'], show_median: true },
      filters: [{ column: 'group', operator: 'in', value: GROUPS }, { column: 'reference', operator: 'in', value: ['ENT 059', 'CER 229'] }, runGuard],
    });
    await ok('facet links', api.patch(candidatesUrl(ENT059_DATASET_ID, `/${specId}/facet-compute-run-links`), {
      data: { facetComputeRunIds: { 'CER 229': dunn.runId } },
    }));
    const evidence = await citeOnResultSnapshot(ent059, `S2 ${Date.now()}`, { chartArtifactId: specId, snapshotId: dunn.resultSnapshotId });

    const bundle = await downloadBundle(evidence);

    expectDrawnChartPng(bundle, specId);
  });

  test('S3 AC1 @SI-016 - an annotated heatmap cited on a run result snapshot is drawn', async () => {
    const heatmap = await createAnalysis(HEATMAP_DATASET_ID);
    const run = await runOn(heatmap, { ruleId: KW_RULE_ID, operationId: 'stats.kruskal_wallis', groupColumn: 'reference', valueColumn: 'rho' }, [guard('rho', -2)]);
    const specId = await createChart(heatmap, {
      templateId: 'heatmap_annotated_v1', title: 'S3 heatmap',
      bindings: { x: 'reference', y: 'variable', z: 'rho', mark: 'significance' }, params: {}, filters: [],
    });
    const evidence = await citeOnResultSnapshot(heatmap, `S3 ${Date.now()}`, { chartArtifactId: specId, snapshotId: run.resultSnapshotId });

    const bundle = await downloadBundle(evidence);

    expectDrawnChartPng(bundle, specId);
  });
});
