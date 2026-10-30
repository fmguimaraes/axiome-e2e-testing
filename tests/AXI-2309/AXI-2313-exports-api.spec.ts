import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { test, expect, request as apiRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { sleep } from '../AXI-1400/harness/api';
import { carrierRuleId } from '../AXI-1400/harness/seed';
import { PrivateProjectsWorld, refusalOf, type Actor } from '../AXI-2265/private-projects-fixtures';

/**
 * AXI-2313 (epic AXI-2309 Platform Opening: Headless) — the exports of ONE
 * run, through
 * `GET /api/v1/projects/:projectId/rule-runs/:ruleRunId/exports/:kind`
 * (kind = csv | svg | png | report).
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2309-Platform-Opening-Headless.md
 * § "AXI-2313 — Exports API" (AXI-2313.1 .. AXI-2313.8).
 *
 * API-level by design: the export buttons are the Guided epic's (FR34).
 * Self-provisioned like AXI-2311's spec: a fresh workspace, two fresh projects
 * and a dataset whose rows carry a per-run token, so the first run never
 * DEDUPs onto an earlier one; AXI-2313.5 then re-submits it on purpose.
 *
 * Requires organization-service with `SAP_RUN_BINDING` unset, bio-compute
 * reachable and Chromium for the server-side chart render.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const TAGS = { tag: ['@SI-018', '@SI-010', '@SI-002'] };
const OPERATION = 'stats.mann_whitney_u';
const RUN_TIMEOUT_MS = 150_000;
const POLL_MS = 2_000;
/** The run-completion listener writes the run's report just after SUCCEEDED (see AXI-2311's spec). */
const COMPLETION_LISTENER_GRACE_MS = 8_000;

const PNG_PIXELS = { width: 3750, height: 2500 };
const PX_PER_METRE_300_DPI = 11811;

const NEVER_CREATED_RUN = '00000000-0000-4000-8000-000000000000';
const TOKEN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** NFR3 — nothing an export may carry (the audit report's scan, plus this stack's own host names). */
const FORBIDDEN = [
  /AKIA[0-9A-Z]{16}/,
  /s3:\/\/\S+/i,
  /amazonaws\.com/i,
  /\bpostgres(?:ql)?:\/\//i,
  /\bmongodb(?:\+srv)?:\/\//i,
  /\bamqp:\/\//i,
  /\blocalhost\b/i,
  /\bminio\b/i,
  /\brabbitmq\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // a JWT
];

let world: PrivateProjectsWorld;
let admin: APIRequestContext;
let outsider: Actor;
let projectId: string;
let otherProjectId: string;
let ruleRunId: string;
let dedupedRunId: string;
let submission: Record<string, unknown>;
let csvBytes: Buffer;
const scanned: Array<{ what: string; text: string }> = [];

const exportUrl = (project: string, run: string, kind: string) =>
  apiUrl(`/api/v1/projects/${project}/rule-runs/${run}/exports/${kind}`);
const reportUrl = (project: string, run: string) =>
  apiUrl(`/api/v1/projects/${project}/rule-runs/${run}/client-report?format=zip`);

async function ok(res: APIResponse, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok()) throw new Error(`AXI-2313 ${what} -> ${res.status()}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function ws(): { headers: Record<string, string> } {
  return { headers: { 'X-Workspace-Id': world.workspaceId } };
}

async function newProject(name: string): Promise<string> {
  const body = await ok(
    await admin.post(apiUrl('/api/v1/projects'), { data: { name: `E2E AXI-2313 ${name} ${TOKEN}`, workspaceId: world.workspaceId }, ...ws() }),
    'create project',
  );
  return body.id;
}

async function waitFor(read: () => Promise<string | undefined>, done: string[], failed: string[], what: string): Promise<string> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await read();
    if (status && done.includes(status)) return status;
    if (status && failed.includes(status)) throw new Error(`AXI-2313 ${what} ended ${status}`);
    await sleep(POLL_MS);
  }
  throw new Error(`AXI-2313 ${what} timed out`);
}

/** A dataset unique to this run (its rows carry TOKEN), ingested and linked. */
async function uploadDataset(): Promise<string> {
  const base = `/api/v1/workspaces/${world.workspaceId}/datasets`;
  // TWO measurements ⇒ a two-row result: a one-row result is below the
  // recommended chart's row floor (MIN_CHARTABLE_ROWS) and withholds the
  // figure by design (AXI-2312) — the figure scenarios need a chart.
  const rows = ['subject,arm,cd8_pct,cd4_pct,batch'];
  for (let i = 0; i < 8; i++) rows.push(`a${i},A,${(10 + i * 1.5).toFixed(1)},${(40 + i * 2.1).toFixed(1)},${TOKEN}`);
  for (let i = 0; i < 8; i++) rows.push(`b${i},B,${(14 + i * 1.7).toFixed(1)},${(37 + i * 1.3).toFixed(1)},${TOKEN}`);
  const init = await ok(
    await admin.post(apiUrl(base), { data: { organizationId: world.orgId, originalFilename: `axi2313-${TOKEN}.csv`, contentType: 'text/csv' }, ...ws() }),
    'initiate upload',
  );
  const datasetId: string = init.dataset.id;
  const put = await fetch(init.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: `${rows.join('\n')}\n` });
  if (!put.ok) throw new Error(`AXI-2313 presigned PUT -> ${put.status}`);
  await ok(await admin.patch(apiUrl(`${base}/${datasetId}/finalize`), ws()), 'finalize');
  await waitFor(async () => (await ok(await admin.get(apiUrl(`${base}/${datasetId}`), ws()), 'dataset')).latestIngestion?.status, ['ready'], ['failed'], 'ingestion');
  await ok(await admin.post(apiUrl(`/api/v1/projects/${projectId}/datasets`), { data: { datasetId }, ...ws() }), 'link dataset');
  return datasetId;
}

async function sapVersion(title: string): Promise<string> {
  const sap = await ok(
    await admin.post(apiUrl(`/api/v1/projects/${projectId}/saps`), {
      data: { title, questionText: `Is CD8 % different between arm A and arm B? (${TOKEN})`, planText: 'Mann–Whitney U, two-sided, α = 0.05.', linkedMethods: [{ operationId: OPERATION }] },
      ...ws(),
    }),
    'create SAP',
  );
  return sap.sapVersionId;
}

async function runToCompletion(datasetId: string): Promise<string> {
  const analysis = await ok(await admin.post(apiUrl('/api/v1/view-analyses'), { data: { projectId, datasetId, name: `AXI-2313 ${TOKEN}` }, ...ws() }), 'create analysis');
  const snapshot = await ok(await admin.post(apiUrl('/api/v1/view-analyses/snapshots'), { data: { viewAnalysisId: analysis.id, filters: [] }, ...ws() }), 'create snapshot');
  submission = {
    ruleId: await carrierRuleId(OPERATION),
    runKind: 'STATISTICAL',
    operationId: OPERATION,
    roleBindings: { groupColumn: 'arm' },
    pivot: { valueColumns: ['cd8_pct', 'cd4_pct'] },
    operationParams: { groupFrom: 'A', groupTo: 'B' },
    projectId, workspaceId: world.workspaceId, datasetId, snapshotId: snapshot.id, viewAnalysisId: analysis.id, scope: 'FILTERED',
  };
  const submitted = await ok(
    await admin.post(apiUrl('/api/v1/rule-runs'), { data: { ...submission, sapVersionId: await sapVersion(`AXI-2313 SAP ${TOKEN}`) }, ...ws() }),
    'submit run',
  );
  const id: string = submitted.ruleRunId;
  const read = async () => (await ok(await admin.get(apiUrl(`/api/v1/rule-runs/${id}`), ws()), 'run')).status;
  expect(await waitFor(read, ['SUCCEEDED'], ['FAILED', 'DEDUPED', 'CANCELLED'], 'run')).toBe('SUCCEEDED');
  return id;
}

/** The candidate list is the recommended-chart self-heal: wait until the run's chart is minted. */
async function exportOk(run: string, kind: string): Promise<APIResponse> {
  const deadline = Date.now() + 60_000;
  let res = await admin.get(exportUrl(projectId, run, kind), ws());
  while (res.status() === 409 && Date.now() < deadline) {
    const body = await res.json();
    if (body.errorCode !== 'RUN_EXPORT_NO_FIGURE') break;
    await sleep(POLL_MS);
    res = await admin.get(exportUrl(projectId, run, kind), ws());
  }
  return res;
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

function pngFacts(png: Buffer): { width: number; height: number; phys: [number, number, number] | null; physBeforeIdat: boolean } {
  expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  let offset = 8;
  let phys: [number, number, number] | null = null;
  let physBeforeIdat = false;
  let seenIdat = false;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'IDAT') seenIdat = true;
    if (type === 'pHYs') {
      phys = [png.readUInt32BE(offset + 8), png.readUInt32BE(offset + 12), png[offset + 16]];
      physBeforeIdat = !seenIdat;
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), phys, physBeforeIdat };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Re-submit the SAME computation bound to a DIFFERENT SAP — the SAP is not dedup identity. */
async function dedupedRerun(): Promise<string> {
  const reply = await ok(
    await admin.post(apiUrl('/api/v1/rule-runs'), { data: { ...submission, sapVersionId: await sapVersion(`AXI-2313 re-run SAP ${TOKEN}`) }, ...ws() }),
    'resubmit run',
  );
  expect(reply.status, JSON.stringify(reply)).toBe('DEDUPED');
  expect(reply.dedupedFromRunId).toBe(ruleRunId);
  return reply.ruleRunId;
}

test.beforeAll(async () => {
  world = await PrivateProjectsWorld.create();
  admin = world.admin;
  outsider = await world.actor('outsider');
  projectId = await newProject('exports');
  otherProjectId = await newProject('other');
  ruleRunId = await runToCompletion(await uploadDataset());
  await sleep(COMPLETION_LISTENER_GRACE_MS);
});

test.afterAll(async () => {
  await world?.dispose();
});

test.describe('AXI-2313 — exports API', TAGS, () => {
  test('AC6 — AXI-2313.1: the results CSV is the run\'s result table, byte-stable and byte for byte the report bundle\'s CSV (FR16, FR17) (@SI-018)', async () => {
    const res = await admin.get(exportUrl(projectId, ruleRunId, 'csv'), ws());

    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
    expect(res.headers()['content-disposition']).toBe(`attachment; filename="results-${ruleRunId}.csv"`);
    csvBytes = await res.body();
    expect(res.headers()['x-content-sha256']).toBe(sha256(csvBytes));
    expect(res.headers()['x-result-run-id']).toBe(ruleRunId);
    expect(res.headers()['x-reused-from-run-id']).toBeUndefined();
    const text = csvBytes.toString('utf8');
    expect(text.split('\n').length).toBeGreaterThan(1);
    scanned.push({ what: 'results CSV', text });

    const again = await (await admin.get(exportUrl(projectId, ruleRunId, 'csv'), ws())).body();
    expect(again.equals(csvBytes)).toBe(true);
    const zip = readZip(await (await admin.get(reportUrl(projectId, ruleRunId), ws())).body());
    expect(zip.get(`data/runs/${ruleRunId}.csv`)?.equals(csvBytes)).toBe(true);
  });

  test('AC6 — AXI-2313.2: the figure PNG is 3750x2500 px and declares 300 dpi in its pHYs chunk; a second export is the same bytes (NFR4, FR17) (@SI-018)', async () => {
    const res = await exportOk(ruleRunId, 'png');

    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    expect(res.headers()['content-disposition']).toBe(`attachment; filename="figure-${ruleRunId}.png"`);
    const png = await res.body();
    expect(res.headers()['x-content-sha256']).toBe(sha256(png));
    const facts = pngFacts(png);
    expect({ width: facts.width, height: facts.height }).toEqual(PNG_PIXELS);
    expect(facts.phys).toEqual([PX_PER_METRE_300_DPI, PX_PER_METRE_300_DPI, 1]);
    expect(facts.physBeforeIdat).toBe(true);

    const again = await (await admin.get(exportUrl(projectId, ruleRunId, 'png'), ws())).body();
    expect(sha256(again)).toBe(sha256(png));
  });

  test('AC6 — AXI-2313.3: the figure SVG is a vector document of the same 1200x800 layout; a second export is the same bytes (NFR4, FR17) (@SI-018)', async () => {
    const res = await exportOk(ruleRunId, 'svg');

    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/svg+xml');
    expect(res.headers()['content-disposition']).toBe(`attachment; filename="figure-${ruleRunId}.svg"`);
    const svg = (await res.body()).toString('utf8');
    expect(svg).toMatch(/^<svg[^>]*\swidth="1200"/);
    expect(svg).toMatch(/^<svg[^>]*\sheight="800"/);
    expect(svg).toContain('<path');
    expect(svg).not.toContain('<image');
    scanned.push({ what: 'figure SVG', text: svg });

    const again = (await (await admin.get(exportUrl(projectId, ruleRunId, 'svg'), ws())).body()).toString('utf8');
    expect(again).toBe(svg);
  });

  test('AC6 — AXI-2313.4: the report export is the client report bundle — the same report.md, hash and manifest as the report route (FR16) (@SI-016 @SI-018)', async () => {
    const res = await admin.get(exportUrl(projectId, ruleRunId, 'report'), ws());
    const routed = await admin.get(reportUrl(projectId, ruleRunId), ws());

    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/zip');
    expect(res.headers()['content-disposition']).toBe(`attachment; filename="client-report-${ruleRunId}.zip"`);
    expect(res.headers()['x-report-hash']).toBe(routed.headers()['x-report-hash']);
    const body = await res.body();
    expect(res.headers()['x-content-sha256']).toBe(sha256(body));
    const exported = readZip(body);
    const viaRoute = readZip(await routed.body());
    expect(exported.get('report.md')?.equals(viaRoute.get('report.md')!)).toBe(true);
    const manifest = JSON.parse(exported.get('manifest.json')!.toString('utf8'));
    expect(manifest.reportSha256).toBe(JSON.parse(viaRoute.get('manifest.json')!.toString('utf8')).reportSha256);
    expect(manifest).toMatchObject({ profile: 'client_report', ruleRunId });
    expect(exported.has(`data/runs/${ruleRunId}.csv`)).toBe(true);
    scanned.push({ what: 'report.md', text: exported.get('report.md')!.toString('utf8') });
    scanned.push({ what: 'manifest.json', text: exported.get('manifest.json')!.toString('utf8') });
  });

  test('AC6 — AXI-2313.5: a DEDUPED run exports the reused result — never a 404 — and names the reused run (FR16) (@SI-018)', async () => {
    dedupedRunId = await dedupedRerun();

    const csv = await admin.get(exportUrl(projectId, dedupedRunId, 'csv'), ws());
    const png = await exportOk(dedupedRunId, 'png');

    for (const res of [csv, png]) {
      expect(res.status(), await res.text()).toBe(200);
      expect(res.headers()['x-result-run-id']).toBe(ruleRunId);
      expect(res.headers()['x-reused-from-run-id']).toBe(ruleRunId);
    }
    expect(csv.headers()['content-disposition']).toBe(`attachment; filename="results-${dedupedRunId}.csv"`);
    expect((await csv.body()).equals(csvBytes)).toBe(true);
    expect(png.headers()['content-disposition']).toBe(`attachment; filename="figure-${dedupedRunId}.png"`);
    const facts = pngFacts(await png.body());
    expect({ width: facts.width, height: facts.height }).toEqual(PNG_PIXELS);
    expect(facts.phys).toEqual([PX_PER_METRE_300_DPI, PX_PER_METRE_300_DPI, 1]);
  });

  test('AC6 — AXI-2313.6: no export carries a secret, storage key, credential or host name (NFR3, FR17) (@SI-018)', async () => {
    expect(scanned.map((s) => s.what).sort()).toEqual(['figure SVG', 'manifest.json', 'report.md', 'results CSV']);
    for (const { what, text } of scanned) {
      for (const pattern of FORBIDDEN) expect(text, `${what} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  test('NFR1 — AXI-2313.7: the exports are deny-by-default; a refusal never says whether the run exists (@SI-010)', async () => {
    const anonymous = await apiRequest.newContext();
    const unauthenticated = await anonymous.get(exportUrl(projectId, ruleRunId, 'csv'), ws());
    await anonymous.dispose();
    const outsiderRead = await outsider.api.get(exportUrl(projectId, ruleRunId, 'csv'));
    const otherProject = await admin.get(exportUrl(otherProjectId, ruleRunId, 'csv'), ws());
    const neverCreated = await admin.get(exportUrl(otherProjectId, NEVER_CREATED_RUN, 'csv'), ws());

    expect(unauthenticated.status()).toBe(401);
    expect(outsiderRead.status()).toBe(404);
    const [crossProject, unknown] = [await refusalOf(otherProject), await refusalOf(neverCreated)];
    expect(crossProject.status).toBe(404);
    expect(crossProject).toEqual(unknown);
  });

  test('FR18 — AXI-2313.8: an undeclared export kind is a 400, never a guessed file (@SI-010 @SI-002)', async () => {
    for (const kind of ['pdf', 'jpeg']) {
      const res = await admin.get(exportUrl(projectId, ruleRunId, kind), ws());
      expect(res.status()).toBe(400);
      expect(res.headers()['content-disposition']).toBeUndefined();
    }
  });
});
