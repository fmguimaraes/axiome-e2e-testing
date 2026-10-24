import { execFileSync } from 'node:child_process';
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
  manifest: { includeSource: boolean; containsSourceData: boolean; reportSha256: string; notice?: string; files: Array<{ filename: string; sha256: string }> };
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
