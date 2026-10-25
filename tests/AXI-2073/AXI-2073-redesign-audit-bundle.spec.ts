import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, asList, type Api } from '../AXI-1400/harness/api';
import {
  ensureTenant, ingestFixture, assignProfileAndVerify, ensureAnalysis, pollTerminal,
  type Tenant, type Analysis,
} from '../AXI-1435/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { frozenRenderPayload, uniq } from '../AXI-1233/harness/seed-axi1234';

/**
 * AXI-2073 redesign (owner brief 2026-10-24, Phases 1–4; FR4, FR12, FR13,
 * FR17, FR18, AC12–AC16, EC11). Scenarios R1–R6 of
 * `axiome-docs/manual-e2e/AXI-2073-Evidence-Audit-Report.md` § "Redesign".
 *
 * REST-only: the bundle is a gateway download, there is no UI surface beyond
 * AXI-2078's button. Everything is produced by the platform: a real
 * `stats.correlation` run over a fresh analysis's baseline snapshot (the
 * AXI-2081 recipe), one evidence citing the run's rule-derived snapshot
 * (complete run link) and one citing the baseline snapshot the run READ
 * (broken run link + the run listed as "not linked", Q1/EC11).
 */

let api: Api;
let tenant: Tenant;
let analysis: Analysis;
let datasetId: string;
let resultRunId: string;
let runEvidence: { id: string; versionNumber: number };
let baselineEvidence: { id: string; versionNumber: number };

const CORRELATION_OP = 'stats.correlation';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Bundle {
  files: string[];
  reportMd: string;
  manifest: {
    includeSource: boolean; containsSourceData: boolean; reportSha256: string; notice?: string;
    files: Array<{ filename: string; sha256: string }>;
    excludedFiles?: Array<{ datasetId: string; filename: string; reason: string; sizeBytes: number | null; limitBytes: number; rawFileHash: string | null }>;
  };
  read(name: string): Buffer;
}

async function runCorrelationOnBaseline(): Promise<{ snapshotId: string; runId: string }> {
  const submit = await api.post('/api/v1/rule-runs', {
    ruleId: tenant.ruleIds[CORRELATION_OP],
    runKind: 'STATISTICAL',
    operationId: CORRELATION_OP,
    roleBindings: { xColumn: 'score', yColumn: 'score2' },
    operationParams: {},
    projectId: tenant.projectId,
    workspaceId: tenant.workspaceId,
    datasetId,
    snapshotId: analysis.snapshotId,
    viewAnalysisId: analysis.analysisId,
    scope: 'FILTERED',
  }, tenant.headers);
  expect(submit.status, `submit -> ${submit.status}: ${JSON.stringify(submit.body)}`).toBeLessThan(300);
  const run = await pollTerminal(api, tenant, submit.body.ruleRunId);
  expect(['SUCCEEDED', 'DEDUPED'], `run: ${run.statusMessage ?? run.errorMessage ?? ''}`).toContain(run.status);
  const runId: string = run.status === 'DEDUPED' ? submit.body.dedupedFromRunId ?? run.dedupedFromRunId : run.id;
  const snapshots = await api.get(`/api/v1/view-analyses/${analysis.analysisId}/snapshots?page=1&limit=100`, tenant.headers);
  const snapshotId: string | undefined =
    asList(snapshots.body).find((s: any) => s.ruleRunId === runId)?.id
    ?? (submit.body.existingSnapshotId as string | undefined);
  expect(snapshotId, `no rule-derived snapshot for run ${runId}`).toBeTruthy();
  return { snapshotId: snapshotId!, runId };
}

async function createEvidence(snapshotId: string, label: string): Promise<{ id: string; versionNumber: number }> {
  const specId = `spec-${uniq()}`;
  const res = await api.post('/api/v1/view-analyses/evidences', {
    viewAnalysisId: analysis.analysisId,
    chartEntries: [{
      chartArtifactId: specId,
      snapshotId,
      datasetVersionId: datasetId,
      frozenRender: frozenRenderPayload({ dataviewSpecId: specId, datasetVersionId: datasetId }),
    }],
    title: `AXI-2073 redesign ${label} ${uniq()}`,
    createdBy: 'e2e-axi-2073-redesign',
  }, tenant.headers);
  expect(res.status, `createEvidence -> ${res.status}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return { id: res.body.id, versionNumber: res.body.currentVersion.versionNumber };
}

function reportUrl(evidence: { id: string; versionNumber: number }, query = ''): string {
  return apiUrl(`/api/v1/view-analyses/evidences/${evidence.id}/versions/${evidence.versionNumber}/audit-report${query}`);
}

async function download(evidence: { id: string; versionNumber: number }, query = ''): Promise<Bundle> {
  const response = await api.ctx.get(reportUrl(evidence, query), { headers: tenant.headers });
  expect(response.status(), await response.text().catch(() => '')).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), 'axi-2073-redesign-'));
  const zipPath = join(dir, 'bundle.zip');
  writeFileSync(zipPath, await response.body());
  execFileSync('unzip', ['-q', zipPath, '-d', join(dir, 'x')]);
  const files = execFileSync('unzip', ['-Z1', zipPath]).toString('utf8').split('\n').filter(Boolean);
  const read = (name: string) => readFileSync(join(dir, 'x', name));
  return { files, reportMd: read('report.md').toString('utf8'), manifest: JSON.parse(read('manifest.json').toString('utf8')), read };
}

/** Dark pixels in a horizontal band of a PNG (fractions of its height).
 * pngjs ships inside playwright-core; no extra dependency. */
function inkInBand(png: Buffer, from: number, to: number): number {
  const { PNG } = createRequire(join(process.cwd(), 'package.json'))('playwright-core/lib/utilsBundle');
  const image = PNG.sync.read(png) as { width: number; height: number; data: Buffer };
  let dark = 0;
  for (let y = Math.floor(from * image.height); y < Math.floor(to * image.height); y++) {
    for (let x = 0; x < image.width; x += 2) {
      const i = (y * image.width + x) * 4;
      const luminance = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
      if (image.data[i + 3] > 0 && luminance < 128) dark++;
    }
  }
  return dark;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function line(md: string, prefix: string): string | undefined {
  return md.split('\n').find((l) => l.startsWith(prefix))?.slice(prefix.length);
}

/** The report hash rule (FR13): drop the "Generated: " and "Report SHA-256: " lines. */
function hashBody(md: string): string {
  return md.split(/(?<=\n)/).filter((l) => !l.startsWith('Generated: ') && !l.startsWith('Report SHA-256: ')).join('');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  api = await adminApi();
  tenant = await ensureTenant(api);
  await approveCarriersFor([CORRELATION_OP]);
  datasetId = await ingestFixture(api, tenant, 'statistical-trigger.csv');
  await assignProfileAndVerify(api, tenant, ['patient_id', 'timepoint']);
  analysis = await ensureAnalysis(api, tenant, `AXI-2073 redesign ${uniq()}`, datasetId);
  const run = await runCorrelationOnBaseline();
  resultRunId = run.runId;
  runEvidence = await createEvidence(run.snapshotId, 'run');
  baselineEvidence = await createEvidence(analysis.snapshotId, 'baseline');
});

test.afterAll(async () => {
  await api?.ctx.dispose();
});

test.describe('AXI-2073 redesign — clinician report + source bundle', { tag: ['@SI-016', '@SI-018', '@SI-010'] }, () => {
  test('R1 AC14/FR12 — the bundle carries the source file whose SHA-256 equals the recorded rawFileHash, the run CSV, and a manifest that verifies', async () => {
    const bundle = await download(runEvidence);

    expect(bundle.files).toEqual(expect.arrayContaining(['report.md', 'manifest.json', `data/runs/${resultRunId}.csv`]));
    const source = bundle.files.filter((f) => f.startsWith('data/source/'));
    expect(source, bundle.files.join(', ')).toHaveLength(1);
    expect(source[0]).toBe('data/source/statistical-trigger.csv');

    const rawHash = line(bundle.reportMd, '- Raw file SHA-256: ') ?? '';
    expect(rawHash, bundle.reportMd).toBe(`sha256:${sha256(bundle.read(source[0]))} — matches the attached file ${source[0]}`);

    for (const entry of bundle.manifest.files) {
      expect(entry.sha256, entry.filename).toBe(`sha256:${sha256(bundle.read(entry.filename))}`);
    }
    expect(bundle.manifest.files.map((f) => f.filename).sort()).toEqual(bundle.files.filter((f) => f !== 'manifest.json').sort());
    expect(bundle.manifest.includeSource).toBe(true);
    expect(bundle.manifest.containsSourceData).toBe(true);
    expect(bundle.manifest.notice).toContain('patient-level data');
  });

  test('R2 AC13/FR17/AC16 — names come first: the run is named by its operation label, people by name, and the Methods section lists aggregate rows', async () => {
    const md = (await download(runEvidence)).reportMd;

    expect(md).toContain('### Correlation — produced the cited result');
    expect(md).not.toContain(`### ${CORRELATION_OP}`);
    const generatedBy = (line(md, 'Generated: ') ?? '').split(' by ')[1] ?? '';
    expect(generatedBy, 'Generated by a name').toBeTruthy();
    expect(generatedBy).not.toMatch(UUID);
    const runLine = line(md, `- Run: ${resultRunId} · status SUCCEEDED · started `) ?? '';
    expect(runLine, md).toMatch(/ UTC by .+/);
    expect(runLine.split(' by ')[1]).not.toMatch(UUID);
    expect(md).toContain(`Full result table: data/runs/${resultRunId}.csv.`);
    expect(md).toContain('| Row | Statistic | p | Adjusted p | Effect size | Interval (declared) |');
    for (const prefix of ['- Units: ', '- Function called: ', '- R-equivalent call: ', '- Rows excluded: ']) {
      expect(line(md, prefix), prefix).toBe('not recorded');
    }
  });

  test('R3 FR13/AC7 — two downloads differ only in the Generated line; the stated report hash is recomputable from report.md alone', async () => {
    const first = await download(runEvidence);
    const second = await download(runEvidence);

    expect(hashBody(second.reportMd)).toBe(hashBody(first.reportMd));
    const stated = line(first.reportMd, 'Report SHA-256: ');
    expect(stated).toBe(`sha256:${sha256(hashBody(first.reportMd))}`);
    expect(first.manifest.reportSha256).toBe(stated);
    expect(second.manifest.reportSha256).toBe(stated);
  });

  test('R4 AC15/FR12/NFR5 — includeSource=false leaves out the source file and every row-level chart CSV, and says so', async () => {
    const bundle = await download(runEvidence, '?includeSource=false');

    expect(bundle.files.filter((f) => f.startsWith('data/source/') || f.startsWith('data/charts/'))).toEqual([]);
    expect(bundle.files).toContain(`data/runs/${resultRunId}.csv`);
    expect(bundle.manifest.includeSource).toBe(false);
    expect(bundle.manifest.containsSourceData).toBe(false);
    expect(bundle.manifest.notice).toBeUndefined();
    expect(line(bundle.reportMd, 'Source data: ')).toBe('not included (includeSource=false).');
  });

  test('R5 FR12 — an includeSource value other than true/false is refused 400', async () => {
    const response = await api.ctx.get(reportUrl(runEvidence, '?includeSource=maybe'), { headers: tenant.headers });
    expect(response.status(), await response.text()).toBe(400);
  });

  test('R6 AC12/FR4/FR18/EC11 — evidence over the snapshot the run only READ is a broken link; the run is listed as not linked, never as the producer', async () => {
    const md = (await download(baselineEvidence)).reportMd;

    expect(md).toContain('**Incomplete — the chain has a broken link (error).**');
    expect(md).toMatch(/\| broken link \(error\) \| Result · Run \| The evidence does not record the computation behind its result\./);
    expect(md).toContain('### Runs not linked to this evidence (read the cited snapshot)');
    expect(md).toContain('#### Correlation — not linked to this evidence (read the cited snapshot)');
    expect(md).not.toContain('produced the cited result');
    expect(md).toContain(`- Run: ${resultRunId} · status SUCCEEDED`);
  });
});

/**
 * AXI-2073 owner fixes O1/O3/O4 (2026-10-25) on SEEDED demo data: the
 * CeRAINOM-IgG4 Microbiote evidences 949d5bcf v3 (filtered `filter`
 * snapshot, spec 4c6138e6 with `params {}`) and b305a9bf v1 (unfiltered
 * `filter` snapshot, spec 18606f58 with explicit params incl. `x_title ""`).
 * Skipped when the demo workspace is not reachable from this stack.
 */
const DEMO_WS = '8946e06a-4fe6-45ee-8d9a-58f7142e803a';
const DEMO_949 = { id: '949d5bcf-926d-43ec-bfeb-aeae93b3faf2', versionNumber: 3 };
const DEMO_B305 = { id: 'b305a9bf-19b4-4cb7-be72-dc866562346a', versionNumber: 1 };

async function downloadDemo(evidence: { id: string; versionNumber: number }, query = ''): Promise<Bundle | null> {
  const response = await api.ctx.get(reportUrl(evidence, query), { headers: { 'X-Workspace-Id': DEMO_WS } });
  if (response.status() === 404 || response.status() === 403) return null;
  expect(response.status(), await response.text().catch(() => '')).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), 'axi-2073-o134-'));
  const zipPath = join(dir, 'bundle.zip');
  writeFileSync(zipPath, await response.body());
  execFileSync('unzip', ['-q', zipPath, '-d', join(dir, 'x')]);
  const files = execFileSync('unzip', ['-Z1', zipPath]).toString('utf8').split('\n').filter(Boolean);
  const read = (name: string) => readFileSync(join(dir, 'x', name));
  return { files, reportMd: read('report.md').toString('utf8'), manifest: JSON.parse(read('manifest.json').toString('utf8')), read };
}

function appendixRow(md: string, step: string): string[] {
  const row = md.split('\n').find((l) => new RegExp(`^\\| \\d+ \\| ${step} \\|`).test(l)) ?? '';
  return row.split(' | ');
}

test.describe('AXI-2073 owner fixes O1/O3/O4', { tag: ['@SI-016', '@SI-018'] }, () => {
  test('O1 fixture — chart template/version in the chart line and Appendix A Details; snapshot origin in Population', async () => {
    const run = (await download(runEvidence)).reportMd;
    const baseline = (await download(baselineEvidence)).reportMd;

    expect(run).toMatch(/^- Chart: .+ — scatter \(template scatter_v1 v1\), origin not recorded — /m);
    expect(appendixRow(run, 'Chart')[5]).toBe('template scatter_v1 v1');
    expect(line(run, '- Cited data: ')).toMatch(/^the output of a computation \(origin: rule_derived\); snapshot v\d+, saved /);
    expect(appendixRow(run, 'Result snapshot')[5]).toBe('origin rule_derived');
    expect(appendixRow(baseline, 'Result snapshot')[5]).toMatch(/^origin (filter|linked)$/);
    for (const step of ['Source file', 'Dataset version', 'Analysis', 'Run', 'Evidence']) {
      expect(appendixRow(run, step)[5], step).toBe('—');
    }
  });

  test('O4 fixture — an unfiltered slice reads "the whole dataset (no filter)" with the RECORDED row count; no raw filter JSON anywhere', async () => {
    const md = (await download(baselineEvidence)).reportMd;

    expect(line(md, '- Cited data: ')).toMatch(/^the whole dataset \(no filter\) — a saved (filtered|linked) view \(origin: (filter|linked)\), not a computed result; /);
    const size = (line(md, '- Size: ') ?? '').match(/^(\d+) rows × /)?.[1];
    expect(size, 'Data section row count').toBeTruthy();
    const version = (line(md, '- Dataset version: ') ?? '').split(' ')[0];
    expect(line(md, '- Rows: ')).toBe(`all ${size} rows of dataset version ${version} (no filter)`);
    expect(md).not.toContain('Rows in the slice');
    expect(md).not.toMatch(/"filters"|filterCombinator|as recorded:/);
  });

  test('O1/O4 demo 949d5bcf v3 — box plot template + "made by a user"; filtered view keeps "Rows in the slice: not recorded"', async () => {
    const bundle = await downloadDemo(DEMO_949);
    test.skip(!bundle, 'demo workspace not reachable on this stack');
    const md = bundle!.reportMd;

    expect(md).toContain('- Chart: synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis) — box plot (template boxplot_v1 v1.0.0), made by a user — image charts/4c6138e6-1640-48cb-9745-7b49658daf7b.png');
    expect(line(md, '- Cited data: ')).toMatch(/^a filtered view of the dataset — a saved filtered view \(origin: filter\), not a computed result; snapshot v2, /);
    expect(line(md, '- Rows kept: ')).toBe('group is one of HD, IgG4-RD, SD and reference = CER 228');
    expect(line(md, '- Rows in the slice: ')).toBe('not recorded (the row count of a slice is not stored)');
    expect(appendixRow(md, 'Chart')[5]).toBe('template boxplot_v1 v1.0.0 · origin user');
    expect(appendixRow(md, 'Result snapshot')[5]).toBe('origin filter');
  });

  test('O4 demo b305a9bf v1 — whole dataset, "Rows: all 23 rows of dataset version 2", cohort filters in words, no raw JSON', async () => {
    const bundle = await downloadDemo(DEMO_B305);
    test.skip(!bundle, 'demo workspace not reachable on this stack');
    const md = bundle!.reportMd;

    expect(line(md, '- Data: ')).toBe('the whole dataset (no filter) — a saved filtered view (origin: filter), not a computed result');
    expect(line(md, '- Rows: ')).toBe('all 23 rows of dataset version 2 (no filter)');
    expect(line(md, '- Cohort: ')).toMatch(/^Cohort v1 \(rows: no filter — all rows\), locked by .+ on \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} UTC; cohort SHA-256 sha256:[0-9a-f]{64}$/);
    expect(md).not.toMatch(/"filters"|filterCombinator|as recorded:/);
  });

  test('O3 demo — the audit PNG of a params-{} spec has a title band and an x-label band; an explicit x_title "" stays empty', async () => {
    const b949 = await downloadDemo(DEMO_949);
    const b305 = await downloadDemo(DEMO_B305);
    test.skip(!b949 || !b305, 'demo workspace not reachable on this stack');
    const untitled = b949!.read('charts/4c6138e6-1640-48cb-9745-7b49658daf7b.png');
    const explicit = b305!.read('charts/18606f58-43a1-45b0-bfd1-dc15d8b83439.png');

    // Title band (top 6%) and x-label band (bottom 4.5%), below the tick labels.
    expect(inkInBand(untitled, 0, 0.06), '4c6138e6 title (fallback: spec title)').toBeGreaterThan(500);
    expect(inkInBand(untitled, 0.955, 1), '4c6138e6 x label (fallback: grouping column)').toBeGreaterThan(100);
    expect(inkInBand(explicit, 0, 0.06), '18606f58 explicit chart_title').toBeGreaterThan(500);
    expect(inkInBand(explicit, 0.955, 1), '18606f58 explicit x_title "" wins').toBe(0);
  });
});

/**
 * AXI-2073 review points (owner, 2026-10-25; FR12, FR19, AC20–AC22).
 * 1 — with includeSource=false no chart image is attached, for any chart
 *     type (a strip chart draws one point per patient).
 * 2 — the source file is streamed under a size limit
 *     (AUDIT_BUNDLE_SOURCE_MAX_BYTES, default 64 MiB), and the base64-encoded
 *     bundle is kept under the 96 MiB transport ceiling (review gate). The
 *     over-limit and over-ceiling paths are covered by the back unit tests
 *     (UT-GRAPH-2300..2307, 2314..2318): every live source file is far below
 *     64 MiB and the sidecar is not restarted with smaller limits here.
 */
const WITHHELD = /Chart image withheld — source data excluded from this bundle \(chart [^\s,]{1,8}, template [^)]+\)/;

test.describe('AXI-2073 review points — chart image withheld without source data; source size limit', { tag: ['@SI-016', '@SI-018', '@SI-010'] }, () => {
  test('RP1 fixture AC20 — includeSource=false: no PNG in the zip or the manifest; the chart line says the image is withheld', async () => {
    const bundle = await download(runEvidence, '?includeSource=false');

    expect(bundle.files.filter((f) => f.endsWith('.png') || f.startsWith('charts/')), bundle.files.join(', ')).toEqual([]);
    expect(bundle.manifest.files.filter((f) => f.filename.endsWith('.png'))).toEqual([]);
    const chartLine = line(bundle.reportMd, '- Chart: ') ?? '';
    expect(chartLine, bundle.reportMd).toMatch(WITHHELD);
    expect(chartLine).toMatch(/\(chart [^\s,]{1,8}, template scatter_v1 v1\)$/);
    expect(bundle.reportMd).not.toContain('.png');
    expect(bundle.reportMd).toContain('- Chart images are withheld from this bundle because the source data is excluded');
  });

  test('RP2 fixture AC20/FR13 — includeSource=false is deterministic: same report hash, every other file byte-identical', async () => {
    const first = await download(runEvidence, '?includeSource=false');
    const second = await download(runEvidence, '?includeSource=false');

    expect(hashBody(second.reportMd)).toBe(hashBody(first.reportMd));
    expect(second.manifest.reportSha256).toBe(first.manifest.reportSha256);
    const others = (b: Bundle) => b.manifest.files.filter((f) => f.filename !== 'report.md');
    expect(others(second)).toEqual(others(first));
  });

  test('RP3 demo 949d5bcf v3 AC20 — box plot: withheld with includeSource=false, attached with includeSource=true', async () => {
    const withheld = await downloadDemo(DEMO_949, '?includeSource=false');
    const included = await downloadDemo(DEMO_949, '?includeSource=true');
    test.skip(!withheld || !included, 'demo workspace not reachable on this stack');

    expect(withheld!.files.filter((f) => f.endsWith('.png'))).toEqual([]);
    expect(withheld!.manifest.files.filter((f) => f.filename.endsWith('.png'))).toEqual([]);
    expect(withheld!.reportMd).toContain(
      '- Chart: synthetic — CER228 IgG4 microbiote by group (Kruskal-Wallis) — box plot (template boxplot_v1 v1.0.0), made by a user — Chart image withheld — source data excluded from this bundle (chart 4c6138e6, template boxplot_v1 v1.0.0)',
    );
    const png = 'charts/4c6138e6-1640-48cb-9745-7b49658daf7b.png';
    expect(included!.files).toContain(png);
    expect(included!.manifest.files.map((f) => f.filename)).toContain(png);
    expect(included!.reportMd).toContain(`— image ${png}`);
    expect(included!.reportMd).not.toMatch(WITHHELD);
  });

  test('RP4 fixture FR19 — under the default 64 MiB limit and the 96 MiB transport ceiling the source is streamed in whole and the manifest records no exclusion', async () => {
    const bundle = await download(runEvidence);

    const source = bundle.files.filter((f) => f.startsWith('data/source/'));
    expect(source).toEqual(['data/source/statistical-trigger.csv']);
    expect(bundle.manifest.files.find((f) => f.filename === source[0])?.sha256).toBe(`sha256:${sha256(bundle.read(source[0]))}`);
    expect(bundle.manifest.excludedFiles).toBeUndefined();
    expect(bundle.reportMd).not.toContain('Source file not included');
  });
});
