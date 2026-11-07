import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { test, expect, request as apiRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { sleep } from '../AXI-1400/harness/api';
import { carrierRuleId } from '../AXI-1400/harness/seed';
import { PrivateProjectsWorld, refusalOf, type Actor } from '../AXI-2265/private-projects-fixtures';
import { newProject as newSapProject, provisionSap, runSapChild, type SapRunChildWorld } from './harness/sap-run-child';

/**
 * AXI-2311 (epic AXI-2309 Platform Opening: Headless) — the client report
 * profile: ONE report per run, downloaded through
 * `GET /api/v1/projects/:projectId/rule-runs/:ruleRunId/client-report?format=zip|md|pdf`.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2311 — Client report profile" (AXI-2311.1 .. AXI-2311.8).
 *
 * REWRITTEN by AXI-2480 (epic AXI-2455). The per-run SAP binding (AXI-2443) and the free-text SAP
 * writes (AXI-2438) are gone, so the SAP-bound report is now the report of a RUN SAP CHILD:
 * .1-.6 run on the governed child of a SAP run (`POST …/saps/:sapId/runs`, AXI-2441) on a SAP
 * version minted by draft + finalise (AXI-2439), pinning the NEWEST T1 version the catalog lists.
 * A governed run announces its result with a snapshot, which the completion listener skips by
 * design, so a child's report is written on its FIRST DOWNLOAD (`generationSource: first_download`).
 * What can only be seen on a directly submitted run stays on one (an ORDINARY run, FR51):
 * .8 the report written automatically at completion (§17 D8), .7 a DEDUPED re-run's own report.
 *
 * API-level by design: the download UI is the Guided epic's (AXI-2331).
 * Self-provisioned: a fresh workspace (PrivateProjectsWorld), fresh projects, and datasets whose
 * content carries a per-run token, so no run can DEDUP onto an earlier one by accident;
 * AXI-2311.7 then deliberately re-submits the ordinary run to get a DEDUPED run.
 *
 * Needs organization-service with AXI-2441/2443/2444 (SAP runs, binder retirement, SAP-run child
 * section in the client report) and bio-compute reachable.
 *
 * The ordinary run's answer sentence is MINTED only when statistical minting is on. The spec PUTs
 * the workspace's setting to `all`, but that override does not reach `ResultSentenceService` today
 * (latent AXI-1746 defect, ticketed AXI-2344): the scenarios compare sentences with each other
 * and never require a sentence on the ordinary run.
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

const NOT_A_SAP_RUN = 'This run is not part of a SAP run; its result is exploratory.';
const NEVER_CREATED_RUN = '00000000-0000-4000-8000-000000000000';
const TOKEN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// The SAP question text is printed verbatim. Its `Generated: ` line is a BODY line: it must be hashed
// (only the two header lines are not), and its backtick fence needs a longer fence around it.
const QUESTION_TEXT = `Q1: is the score different between arm A and arm B? (run ${TOKEN})\n\`\`\`\nliteral fence inside the question\n\`\`\`\n# not a heading — kept verbatim\nGenerated: by the steering committee`;

let world: PrivateProjectsWorld;
let admin: APIRequestContext;
let viewer: Actor;
let outsider: Actor;
let sapWorld: SapRunChildWorld;
/** The Run SAP child's project and rule run (.1-.6). */
let projectId: string;
let otherProjectId: string;
let ruleRunId: string;
let sapRunId: string;
let subjectPrefix: string;
/** The ORDINARY (directly submitted) run, its project and its first report (.7, .8). */
let ordinaryProjectId: string;
let ordinaryRunId: string;
let ordinaryMarkdown: string;
let dedupedRunId: string;
let submission: Record<string, unknown>;

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

/** A dataset unique to this run (its rows carry TOKEN), ingested and linked to the ORDINARY run's project. */
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
  await ok(await admin.post(apiUrl(`/api/v1/projects/${ordinaryProjectId}/datasets`), { data: { datasetId }, ...ws() }), 'link dataset');
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
  const analysis = await ok(await admin.post(apiUrl('/api/v1/view-analyses'), { data: { projectId: ordinaryProjectId, datasetId, name: `AXI-2311 ${TOKEN}` }, ...ws() }), 'create analysis');
  const snapshot = await ok(await admin.post(apiUrl('/api/v1/view-analyses/snapshots'), { data: { viewAnalysisId: analysis.id, filters: [] }, ...ws() }), 'create snapshot');
  return { analysisId: analysis.id, snapshotId: snapshot.id };
}

async function runToCompletion(datasetId: string): Promise<string> {
  const { analysisId, snapshotId } = await analysisWithReferent(datasetId);
  submission = {
    ruleId: await carrierRuleId(OPERATION),
    runKind: 'STATISTICAL',
    operationId: OPERATION,
    roleBindings: { groupColumn: 'arm' },
    pivot: { valueColumns: ['cd8_pct'] },
    operationParams: { groupFrom: 'A', groupTo: 'B' },
    projectId: ordinaryProjectId, workspaceId: world.workspaceId, datasetId, snapshotId, viewAnalysisId: analysisId, scope: 'FILTERED',
  };
  const submitted = await ok(
    await admin.post(apiUrl('/api/v1/rule-runs'), { data: submission, ...ws() }),
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

/**
 * The published verification rule (libs/contracts client-report.contract.ts): SHA-256 of
 * report.md minus exactly two HEADER lines, by position — the first `Generated: ` line and
 * the first `Report SHA-256: ` line before the first `## ` heading.
 */
function recomputeReportHash(markdown: string): string {
  const lines = markdown.split('\n');
  const heading = lines.findIndex((l) => l.startsWith('## '));
  const headerEnd = heading === -1 ? lines.length : heading;
  const excluded = new Set(
    ['Generated: ', 'Report SHA-256: ']
      .map((prefix) => lines.findIndex((l) => l.startsWith(prefix)))
      .filter((i) => i !== -1 && i < headerEnd),
  );
  return sha256(lines.filter((_, i) => !excluded.has(i)).join('\n'));
}

/** The rule the audit report profile uses — drops every prefixed line, wherever it is. */
function contentPrefixHash(markdown: string): string {
  return sha256(markdown.split('\n').filter((l) => !l.startsWith('Generated: ') && !l.startsWith('Report SHA-256: ')).join('\n'));
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Mint the answer sentence for an ad-hoc run: the workspace's statistical minting setting
 * (AXI-1739) defaults to plan-driven, under which a direct STATISTICAL run gets no sentence.
 */
async function mintSentencesForAdHocRuns(): Promise<void> {
  await ok(
    await admin.put(apiUrl(`/api/v1/workspaces/${world.workspaceId}/statistical-minting-setting`), { data: { mode: 'all' }, ...ws() }),
    'statistical minting setting',
  );
}

/** The `## Answer` section's body. */
function answerOf(markdown: string): string {
  return markdown.slice(markdown.indexOf('## Answer') + '## Answer'.length, markdown.indexOf('## Figure')).trim();
}

/**
 * B2 (review round 1): overwrite the answer text on EVERY Decision in the workspace through
 * the client PATCH route. The report must never quote it.
 */
async function tamperEveryDecisionSentence(text: string): Promise<number> {
  const list = await ok(await admin.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions?limit=100`), ws()), 'list decisions');
  const drafts: Array<{ id: string; context?: Record<string, unknown> }> = list.data ?? list.items ?? list;
  for (const draft of drafts) {
    const context = { ...(draft.context ?? {}), intendedUse: 'RUO', resultSentence: { ...((draft.context?.resultSentence as object) ?? {}), text } };
    await ok(await admin.patch(apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${draft.id}`), { data: { context }, ...ws() }), 'tamper decision');
    const read = await ok(await admin.get(apiUrl(`/api/v1/workspaces/${world.workspaceId}/decisions/${draft.id}`), ws()), 'read decision');
    expect(read.context?.resultSentence?.text, 'the PATCH must really land').toBe(text);
  }
  return drafts.length;
}

/** Re-submit the SAME computation of the ordinary run (no SAP binding exists any more — AXI-2443). */
async function dedupedRerun(): Promise<string> {
  const reply = await ok(
    await admin.post(apiUrl('/api/v1/rule-runs'), { data: submission, ...ws() }),
    'resubmit run',
  );
  expect(reply.status, JSON.stringify(reply)).toBe('DEDUPED');
  expect(reply.dedupedFromRunId).toBe(ordinaryRunId);
  return reply.ruleRunId;
}

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  world = await PrivateProjectsWorld.create();
  admin = world.admin;
  viewer = await world.actor('viewer');
  outsider = await world.actor('outsider');
  const editor = await world.actor('editor');
  await world.addMember(viewer, 'viewer');
  await world.addMember(editor, 'editor');
  sapWorld = { world, editor };
  await mintSentencesForAdHocRuns();
  // The Run SAP child: its project, its first question's settled governed child and that child's rule run.
  const sap = await provisionSap(sapWorld, TOKEN, 'report', QUESTION_TEXT);
  projectId = sap.project;
  subjectPrefix = sap.subjectPrefix;
  const ran = await runSapChild(sapWorld, sap, 'report');
  ruleRunId = ran.ruleRunId;
  sapRunId = ran.sapRun.sapRunId;
  expect(ruleRunId, JSON.stringify(ran.child.nodes)).toBeTruthy();
  otherProjectId = await newSapProject(sapWorld, 'other');
  // The ordinary run (no SAP at all).
  ordinaryProjectId = await newProject('ordinary');
  ordinaryRunId = await runToCompletion(await uploadDataset());
  await sleep(COMPLETION_LISTENER_GRACE_MS);
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2311 — client report profile', TAGS, () => {
  let markdown: string;

  test('AC3 — AXI-2311.1: a Run SAP child\'s report is complete in FR8\'s order, its SAP-run section quotes the SAP verbatim and points to the SAP-run report (@SI-016)', async () => {
    const res = await admin.get(reportUrl(projectId, ruleRunId, 'md'), ws());

    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/markdown');
    expect(res.headers()['content-disposition']).toBe(`attachment; filename="client-report-${ruleRunId}.md"`);
    markdown = await res.text();
    // A governed child announces its result with a snapshot, which the completion listener skips: this report is
    // written by its first download (the automatic path is AXI-2311.8, on a directly submitted run).
    expect(markdown).toMatch(/^Generated: .* — on first download/m);
    const headings = ['## Question', '## Statistical Analysis Plan — SAP run, version 1', '## Answer', '## Figure', '## Results', '## Methods', '## Record'];
    const at = headings.map((h) => markdown.indexOf(h));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The SAP section: the run, the question's text verbatim inside a fence longer than any backtick run it holds.
    expect(markdown).toContain(`This run is part of SAP run ${sapRunId}, which ran version 1 of the project's Statistical Analysis Plan.`);
    expect(markdown).toContain('Question Q1 (primary), verbatim:');
    expect(markdown).toContain(['````', ...QUESTION_TEXT.split('\n'), '````'].join('\n'));
    expect(markdown).toContain('Population: All randomised subjects');
    expect(markdown).toContain('Treatment comparison: Arm A vs arm B');
    // The verdict is NOT in the child's report: it points at the SAP-run report (FR50).
    expect(markdown).toContain(`/api/v1/projects/${projectId}/saps/`);
    expect(markdown).toContain(`/runs/${sapRunId}/report`);
    expect(markdown).not.toContain('This run is not part of a SAP run');
    expect(markdown).toContain('- n per test:');
    expect(markdown).toContain('  - groupFrom:');
    expect(markdown).toContain('- Family size (multiple-testing correction):');
    expect(markdown).toContain('- Mode: guided (template T1)');
    // The answer is a real rendered sentence.
    expect(answerOf(markdown)).not.toMatch(/^Not recorded/);
    expect(answerOf(markdown).length).toBeGreaterThan(20);
    expect(markdown).toContain('with the Mann-Whitney U test');
    expect(markdown).toMatch(
      new RegExp(`^- SAP run: ${sapRunId} · SAP version [0-9a-f-]{36} · version 1 · content hash sha256:[0-9a-f]{64} · question Q1 \\([0-9a-f-]{36}\\)$`, 'm'),
    );
    // NFR7: no row of the data in the body.
    expect(markdown).not.toContain(subjectPrefix);
  });

  test('AC4 — AXI-2311.2: every download ships the SAME stored report, and its hash is recomputable from the file (FR10) (@SI-016)', async () => {
    const again = await admin.get(reportUrl(projectId, ruleRunId, 'md'), ws());
    const text = await again.text();

    expect(text).toBe(markdown);
    const hash = recomputeReportHash(text);
    expect(again.headers()['x-report-hash']).toBe(hash);
    expect(text).toContain(`Report SHA-256: sha256:${hash}`);
    // The verbatim question line `Generated: by the steering committee` IS hashed:
    // editing it changes the hash, and a rule that dropped it would disagree.
    expect(text).toContain('\nGenerated: by the steering committee\n');
    expect(recomputeReportHash(text.replace('Generated: by the steering committee', 'Generated: edited'))).not.toBe(hash);
    expect(contentPrefixHash(text)).not.toBe(hash);
  });

  test('AC3, AC4 — AXI-2311.3: the zip (default format) ships report.md byte for byte, the result CSV and a manifest naming every file (@SI-016 @SI-018)', async () => {
    const res = await admin.get(reportUrl(projectId, ruleRunId), ws());

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/zip');
    const entries = readZip(await res.body());
    expect(entries.get('report.md')?.toString('utf8')).toBe(markdown);
    expect(entries.has(`data/runs/${ruleRunId}.csv`)).toBe(true);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8'));
    expect(manifest).toMatchObject({ profile: 'client_report', ruleRunId, generationSource: 'first_download', containsSourceData: false });
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

  test('AC3 — AXI-2311.8: an ORDINARY run\'s report is written automatically when the run completes, and its SAP section is the single exploratory sentence (§17 D8, FR7, FR51) (@SI-016)', async () => {
    const res = await admin.get(reportUrl(ordinaryProjectId, ordinaryRunId, 'md'), ws());

    expect(res.status(), await res.text()).toBe(200);
    ordinaryMarkdown = await res.text();
    // Generated by the completion listener — never by this download.
    expect(ordinaryMarkdown).toMatch(/^Generated: .* — automatically, when the run completed$/m);
    const section = ordinaryMarkdown.slice(ordinaryMarkdown.indexOf('## Statistical Analysis Plan'));
    expect(section.split('\n## ')[0].trim()).toBe(['## Statistical Analysis Plan', '', NOT_A_SAP_RUN].join('\n'));
    expect(ordinaryMarkdown).not.toContain('SAP run, version');
    expect(ordinaryMarkdown).not.toContain(subjectPrefix);
    expect(ordinaryMarkdown).not.toContain(`,${TOKEN}`);
    const zip = readZip(await (await admin.get(reportUrl(ordinaryProjectId, ordinaryRunId), ws())).body());
    expect(JSON.parse(zip.get('manifest.json')!.toString('utf8'))).toMatchObject({ generationSource: 'run_completion' });
  });

  test('AC3, AC4 — AXI-2311.7: a DEDUPED re-run has its OWN report: the reused computation and a record naming the reused run, never a client-rewritten sentence (FR7) (@SI-016)', async () => {
    dedupedRunId = await dedupedRerun();
    // B2: a client rewrites the sentence on every Decision BEFORE this report is generated.
    const tampered = `TAMPERED ${TOKEN}`;
    expect(await tamperEveryDecisionSentence(tampered)).toBeGreaterThan(0);

    const res = await admin.get(reportUrl(ordinaryProjectId, dedupedRunId, 'md'), ws());
    const text = await res.text();
    const zip = readZip(await (await admin.get(reportUrl(ordinaryProjectId, dedupedRunId), ws())).body());
    const manifest = JSON.parse(zip.get('manifest.json')!.toString('utf8'));

    expect(res.status(), text).toBe(200);
    expect(text).toContain(`· Run ${dedupedRunId}`);
    expect(text).toMatch(new RegExp(`^- Reused result: run ${ordinaryRunId} — this run was deduplicated onto it`, 'm'));
    expect(text).toContain(NOT_A_SAP_RUN);
    expect(text).toMatch(/^Generated: .* — on first download/m);
    expect(res.headers()['x-report-hash']).toBe(recomputeReportHash(text));
    expect(text).not.toBe(ordinaryMarkdown);
    // The answer is re-rendered from the run's records: the same computation's sentence, never the tampered text.
    expect(text).not.toContain(tampered);
    expect(answerOf(text)).toBe(answerOf(ordinaryMarkdown));
    expect(manifest).toMatchObject({ ruleRunId: dedupedRunId, reusedFromRunId: ordinaryRunId, generationSource: 'first_download' });
    expect(zip.has(`data/runs/${ordinaryRunId}.csv`)).toBe(true);
    // The canonical run's own report is untouched.
    expect(await (await admin.get(reportUrl(ordinaryProjectId, ordinaryRunId, 'md'), ws())).text()).toBe(ordinaryMarkdown);
    // …and so is the Run SAP child's, which a Decision rewrite must not reach either.
    expect(await (await admin.get(reportUrl(projectId, ruleRunId, 'md'), ws())).text()).toBe(markdown);
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
