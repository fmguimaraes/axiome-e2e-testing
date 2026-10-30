import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { test, expect, request as apiRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { sleep } from '../AXI-1400/harness/api';
import { carrierRuleId } from '../AXI-1400/harness/seed';
import { PrivateProjectsWorld, refusalOf, type Actor } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2311 (epic AXI-2309 Platform Opening: Headless) — the client report
 * profile: ONE report per run, generated automatically when the run completes
 * (§17 D8), downloaded through
 * `GET /api/v1/projects/:projectId/rule-runs/:ruleRunId/client-report?format=zip|md|pdf`.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2311 — Client report profile" (AXI-2311.1 .. AXI-2311.6).
 *
 * API-level by design: the download UI is the Guided epic's (AXI-2331).
 * Self-provisioned: a fresh workspace (PrivateProjectsWorld), a fresh project,
 * and a dataset whose content carries a per-run token — so the run can never
 * DEDUP onto an earlier one and always completes (SUCCEEDED) itself.
 *
 * Requires organization-service with `SAP_RUN_BINDING` unset (fail-closed
 * default): the run is bound to a SAP version, which the report echoes.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const TAGS = { tag: ['@SI-016', '@SI-018', '@SI-010', '@SI-002'] };
const OPERATION = 'stats.mann_whitney_u';
const RUN_TIMEOUT_MS = 150_000;
const POLL_MS = 2_000;
/** The report is written by the run-completion listener AFTER the run row reads
 * SUCCEEDED (the bus publishes after the status write). This is the bounded
 * wait for that listener before the first download — a download that won the
 * race would (correctly) say "on first download" and turn AXI-2311.1 red. */
const COMPLETION_LISTENER_GRACE_MS = 8_000;

const NEVER_CREATED_RUN = '00000000-0000-4000-8000-000000000000';
const TOKEN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const QUESTION_TEXT = `Q1: is CD8 % different between arm A and arm B?\n  (run ${TOKEN})`;
const PLAN_TEXT = 'Mann–Whitney U, two-sided, α = 0.05.\n```\nliteral fence inside the plan\n```\n# not a heading — kept verbatim';

let world: PrivateProjectsWorld;
let admin: APIRequestContext;
let viewer: Actor;
let outsider: Actor;
let projectId: string;
let otherProjectId: string;
let ruleRunId: string;

const reportUrl = (project: string, run: string, format?: string) =>
  apiUrl(`/api/v1/projects/${project}/rule-runs/${run}/client-report${format === undefined ? '' : `?format=${format}`}`);

async function ok(res: APIResponse, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok()) throw new Error(`AXI-2311 ${what} -> ${res.status()}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function ws(): { headers: Record<string, string> } {
  return { headers: { 'X-Workspace-Id': world.workspaceId } };
}

async function newProject(name: string): Promise<string> {
  const body = await ok(
    await admin.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2311 ${name} ${TOKEN}`, workspaceId: world.workspaceId }, ...ws() }),
    'create project',
  );
  return body.id;
}

/** A dataset unique to this run (its rows carry TOKEN), ingested and linked. */
async function uploadDataset(): Promise<string> {
  const base = `/api/v1/workspaces/${world.workspaceId}/datasets`;
  const filename = `axi2311-${TOKEN}.csv`;
  const rows = ['subject,arm,cd8_pct,batch'];
  for (let i = 0; i < 8; i++) rows.push(`a${i},A,${(10 + i * 1.5).toFixed(1)},${TOKEN}`);
  for (let i = 0; i < 8; i++) rows.push(`b${i},B,${(14 + i * 1.7).toFixed(1)},${TOKEN}`);
  const init = await ok(await admin.post(apiUrl(base), { data: { organizationId: world.orgId, originalFilename: filename, contentType: 'text/csv' }, ...ws() }), 'initiate upload');
  const datasetId: string = init.dataset.id;
  const put = await fetch(init.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: `${rows.join('\n')}\n` });
  if (!put.ok) throw new Error(`AXI-2311 presigned PUT -> ${put.status}`);
  await ok(await admin.patch(apiUrl(`${base}/${datasetId}/finalize`), ws()), 'finalize');
  await waitFor(async () => (await ok(await admin.get(apiUrl(`${base}/${datasetId}`), ws()), 'dataset')).latestIngestion?.status, ['ready'], ['failed'], 'ingestion');
  await ok(await admin.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId }, ...ws() }), 'link dataset');
  return datasetId;
}

async function waitFor(read: () => Promise<string | undefined>, done: string[], failed: string[], what: string): Promise<string> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await read();
    if (status && done.includes(status)) return status;
    if (status && failed.includes(status)) throw new Error(`AXI-2311 ${what} ended ${status}`);
    await sleep(POLL_MS);
  }
  throw new Error(`AXI-2311 ${what} timed out`);
}

async function analysisWithReferent(datasetId: string): Promise<{ analysisId: string; snapshotId: string }> {
  const analysis = await ok(await admin.post(apiUrl('/api/v1/view-analyses'), { data: { projectId, datasetId, name: `AXI-2311 ${TOKEN}` }, ...ws() }), 'create analysis');
  const snapshot = await ok(await admin.post(apiUrl('/api/v1/view-analyses/snapshots'), { data: { viewAnalysisId: analysis.id, filters: [] }, ...ws() }), 'create snapshot');
  return { analysisId: analysis.id, snapshotId: snapshot.id };
}

async function sapVersion(): Promise<string> {
  const sap = await ok(
    await admin.post(apiUrl(`/api/v1/projects/${projectId}/saps`), {
      data: { title: `AXI-2311 SAP ${TOKEN}`, questionText: QUESTION_TEXT, planText: PLAN_TEXT, linkedMethods: [{ operationId: OPERATION }] },
      ...ws(),
    }),
    'create SAP',
  );
  return sap.sapVersionId;
}

async function runToCompletion(datasetId: string): Promise<string> {
  const { analysisId, snapshotId } = await analysisWithReferent(datasetId);
  const submitted = await ok(
    await admin.post(apiUrl('/api/v1/rule-runs'), {
      data: {
        ruleId: await carrierRuleId(OPERATION),
        runKind: 'STATISTICAL',
        operationId: OPERATION,
        roleBindings: { groupColumn: 'arm' },
        pivot: { valueColumns: ['cd8_pct'] },
        operationParams: { groupFrom: 'A', groupTo: 'B' },
        projectId, workspaceId: world.workspaceId, datasetId, snapshotId, viewAnalysisId: analysisId, scope: 'FILTERED',
        sapVersionId: await sapVersion(),
      },
      ...ws(),
    }),
    'submit run',
  );
  const id: string = submitted.ruleRunId;
  const read = async () => (await ok(await admin.get(apiUrl(`/api/v1/rule-runs/${id}`), ws()), 'run')).status;
  expect(await waitFor(read, ['SUCCEEDED'], ['FAILED', 'DEDUPED', 'CANCELLED'], 'run')).toBe('SUCCEEDED');
  return id;
}

function readZip(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const name = zip.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength;
    entries.set(name, inflateRawSync(zip.subarray(start, start + size)));
    offset = start + size;
  }
  return entries;
}

/** The published verification rule: SHA-256 of report.md minus its two variable lines. */
function recomputeReportHash(markdown: string): string {
  const kept = markdown.split('\n').filter((l) => !l.startsWith('Generated: ') && !l.startsWith('Report SHA-256: '));
  return createHash('sha256').update(kept.join('\n'), 'utf8').digest('hex');
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  admin = world.admin;
  viewer = await world.actor('viewer');
  outsider = await world.actor('outsider');
  await world.addMember(viewer, 'viewer');
  projectId = await newProject('report');
  otherProjectId = await newProject('other');
  ruleRunId = await runToCompletion(await uploadDataset());
  await sleep(COMPLETION_LISTENER_GRACE_MS);
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2311 — client report profile', TAGS, () => {
  let markdown: string;

  test('AC3 — AXI-2311.1: a completed run has its report without any user action, in FR8\'s order, SAP verbatim (@SI-016)', async () => {
    const res = await admin.get(reportUrl(projectId, ruleRunId, 'md'), ws());

    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    expect(res.headers()['content-disposition']).toBe(`attachment; filename="client-report-${ruleRunId}.md"`);
    markdown = await res.text();
    // Generated by the completion listener — never by this download.
    expect(markdown).toMatch(/^Generated: .* — automatically, when the run completed$/m);
    const headings = ['## Question', '## Statistical Analysis Plan — version 1', '## Answer', '## Figure', '## Results', '## Methods', '## Record'];
    const at = headings.map((h) => markdown.indexOf(h));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The SAP texts verbatim, each inside a fence longer than any backtick run it holds.
    expect(markdown).toContain(['```', ...QUESTION_TEXT.split('\n'), '```'].join('\n'));
    expect(markdown).toContain(['````', ...PLAN_TEXT.split('\n'), '````'].join('\n'));
    expect(markdown).toContain('- n per test:');
    expect(markdown).toContain('  - groupFrom: A');
    expect(markdown).toContain('- Family size (multiple-testing correction):');
    expect(markdown).toContain('- Mode: not recorded');
    expect(markdown).toContain('with the Mann-Whitney U test');
    expect(markdown).toMatch(/^- SAP version: [0-9a-f-]{36} · version 1 · content hash sha256:[0-9a-f]{64}$/m);
    // NFR7: no row of the data in the body.
    expect(markdown).not.toContain(`,${TOKEN}`);
  });

  test('AC4 — AXI-2311.2: every download ships the SAME stored report, and its hash is recomputable from the file (FR10) (@SI-016)', async () => {
    const again = await admin.get(reportUrl(projectId, ruleRunId, 'md'), ws());
    const text = await again.text();

    expect(text).toBe(markdown);
    const hash = recomputeReportHash(text);
    expect(again.headers()['x-report-hash']).toBe(hash);
    expect(text).toContain(`Report SHA-256: sha256:${hash}`);
  });

  test('AC3, AC4 — AXI-2311.3: the zip (default format) ships report.md byte for byte, the result CSV and a manifest naming every file (@SI-016 @SI-018)', async () => {
    const res = await admin.get(reportUrl(projectId, ruleRunId), ws());

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/zip');
    const entries = readZip(await res.body());
    expect(entries.get('report.md')?.toString('utf8')).toBe(markdown);
    expect(entries.has(`data/runs/${ruleRunId}.csv`)).toBe(true);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    expect(manifest).toMatchObject({ profile: 'client_report', ruleRunId, generationSource: 'run_completion', containsSourceData: false });
    expect(manifest.reportSha256).toBe(`sha256:${recomputeReportHash(markdown)}`);
    const listed = manifest.files.map((f: { filename: string }) => f.filename).sort();
    expect(listed).toEqual([...entries.keys()].filter((n) => n !== 'manifest.json').sort());
  });

  test('AC4/EC10 — AXI-2311.4: the PDF either ships, or its absence is a bounded pdfNotProduced while md + CSV + manifest still ship (@SI-016)', async () => {
    const zip = readZip(await (await admin.get(reportUrl(projectId, ruleRunId, 'zip'), ws())).body());
    const manifest = JSON.parse(zip.get('manifest.json')!.toString('utf8'));
    const pdf = await admin.get(reportUrl(projectId, ruleRunId, 'pdf'), ws());

    expect(zip.has('report.md')).toBe(true);
    if (zip.has('report.pdf')) {
      expect(manifest.pdfNotProduced).toBeUndefined();
      expect(pdf.status()).toBe(200);
      expect((await pdf.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    } else {
      expect(manifest.pdfNotProduced).toMatch(/^report\.pdf not produced: (PDF rendering is not available in this environment|PDF generation failed)$/);
      expect(pdf.status()).toBe(409);
      expect((await pdf.json()).errorCode).toBe('CLIENT_REPORT_PDF_NOT_PRODUCED');
    }
  });

  test('FR11/NFR1 — AXI-2311.5: the download is deny-by-default; a refusal never says whether the run exists (@SI-010)', async () => {
    const anonymous = await apiRequest.newContext();
    const unauthenticated = await anonymous.get(reportUrl(projectId, ruleRunId), ws());
    await anonymous.dispose();
    const viewerRun = await viewer.api.get(apiUrl(`/api/v1/rule-runs/${ruleRunId}`));
    const viewerRead = await viewer.api.get(reportUrl(projectId, ruleRunId, 'md'));
    const viewerUnknown = await viewer.api.get(reportUrl(projectId, NEVER_CREATED_RUN, 'md'));
    const outsiderRead = await outsider.api.get(reportUrl(projectId, ruleRunId, 'md'));
    const otherProject = await admin.get(reportUrl(otherProjectId, ruleRunId, 'md'), ws());
    const neverCreated = await admin.get(reportUrl(otherProjectId, NEVER_CREATED_RUN, 'md'), ws());

    expect(unauthenticated.status()).toBe(401);
    // The report is readable EXACTLY when the run is: it asks the rule-run read
    // predicate itself (workspace scope + AXI-1290 system-rule hiding), never a
    // second rule. A self-registered viewer holds no system-rule entitlement, so
    // the run is hidden from them — and the report's refusal is then the same 404
    // as for a run that was never created.
    expect(viewerRead.status()).toBe(viewerRun.status());
    if (viewerRun.ok()) expect(await viewerRead.text()).toBe(markdown);
    else expect(await refusalOf(viewerRead)).toEqual(await refusalOf(viewerUnknown));
    expect(outsiderRead.status()).toBe(404);
    const [crossProject, unknown] = [await refusalOf(otherProject), await refusalOf(neverCreated)];
    expect(crossProject.status).toBe(404);
    expect(crossProject).toEqual(unknown);
  });

  test('FR11 — AXI-2311.6: an undeclared format is a 400, never a guessed file (@SI-010 @SI-002)', async () => {
    const res = await admin.get(reportUrl(projectId, ruleRunId, 'docx'), ws());

    expect(res.status()).toBe(400);
  });
});
