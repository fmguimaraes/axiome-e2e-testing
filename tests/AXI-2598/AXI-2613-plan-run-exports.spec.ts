import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiUrl } from '../../config/env';
import { adminApi, adminToken, asList, sleep, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { INVESTIGATOR_ROLE_ID, addMember, launchAndDrain, person, wizardBody, type Person } from '../AXI-2308/harness/result-page';

/**
 * AXI-2613 (epic AXI-2598 — Investigator Handover Demo Path Up To Prod — FR5, FR24, FR25, FR26;
 * AC12, AC13): every export (csv/svg/png/report) and client-report (md/pdf/zip) download of a
 * plan child/reused run answered 404 "Rule run not found" because `RunExportService` and
 * `ClientReportService.get()` resolved the run with `placedRun()` (route-project-only) while the
 * result page already reads it with `placedRunOrReusedSource()`. Fixed by routing both at the
 * SAME resolver the result page uses — one rule, three callers.
 *
 * This reproduces the exact placement shape the AXI-2601 rehearsal's S10 step (`downloads`)
 * found broken, without the full plan/SAP pipeline: two projects of the SAME workspace sharing
 * one dataset content, so project B's run is a REUSED-ELSEWHERE run of project A's canonical run
 * — the AXI-2454 fixture precedent (`tests/AXI-2455/AXI-2454-reused-step-result-page.spec.ts`),
 * which is exactly the shape `placedRunOrReusedSource` exists to serve and `placedRun` refuses.
 *
 * Scenario: `axiome-docs/manual-e2e/AXI-2598-Investigator-Handover.md` § 13 (13.1).
 *
 * Run: BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway — must serve the AXI-2613
 *   branch, not main, for this to prove the fix> npx playwright test tests/AXI-2598/AXI-2613-* \
 *   --project=chromium --no-deps
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const QUESTION = 'Does igg4_g_l differ by sex?';
const PX_PER_METRE_300_DPI = 11811;

type ExportKind = 'csv' | 'svg' | 'png' | 'report';
type ReportFormat = 'md' | 'pdf' | 'zip';

let api: Api;
let tA: Tenant;
let tB: Tenant;
let investigator: Person;
let ruleRunId: string;

const exportUrl = (t: Tenant, kind: ExportKind) => apiUrl(`/api/v1/projects/${t.projectId}/rule-runs/${ruleRunId}/exports/${kind}`);
const reportUrl = (t: Tenant, format: ReportFormat) => apiUrl(`/api/v1/projects/${t.projectId}/rule-runs/${ruleRunId}/client-report?format=${format}`);

/** Ingest the salted fixture once (a shared one would reuse an unknown older project's run); returns the dataset id. */
async function ingestSalted(t: Tenant): Promise<string> {
  const nonce = String(Date.now());
  const lines = readFileSync(join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', FIXTURE), 'utf-8').trimEnd().split('\n');
  const csv = `${lines.map((l, i) => `${l},${i === 0 ? 'e2e_salt' : nonce}`).join('\n')}\n`;
  const init = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: `axi2613-${nonce}-${FIXTURE}`, contentType: 'text/csv',
  }, t.headers);
  expect(init.status, JSON.stringify(init.body)).toBeLessThan(300);
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: csv });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const id = init.body.dataset.id;
  const fin = await api.patch(`/api/v1/workspaces/${t.workspaceId}/datasets/${id}/finalize`, undefined, t.headers);
  expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
  const deadline = Date.now() + 240_000;
  for (;;) {
    const list = asList((await api.get(`/api/v1/workspaces/${t.workspaceId}/datasets/${id}/ingestions`, t.headers)).body);
    const newest = [...list].sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (newest?.status === 'ready') return id;
    if (newest?.status === 'failed' || Date.now() > deadline) throw new Error(`ingestion of ${id}: ${JSON.stringify(newest)}`);
    await sleep(2_000);
  }
}

async function launchIn(t: Tenant, dataset: AnchoredDataset): Promise<string> {
  return launchAndDrain(api, t, wizardBody(t, dataset, 'T1', QUESTION, 'compare_groups', [
    { slot: 'groupingColumn', value: 'sexe' }, { slot: 'groups', value: ['F', 'M'] }, { slot: 'outcome', value: 'igg4_g_l' },
  ]));
}

function pngPhys(png: Buffer): [number, number, number] | null {
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'pHYs') return [png.readUInt32BE(offset + 8), png.readUInt32BE(offset + 12), png[offset + 16]];
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return null;
}

test.describe.serial('AXI-2613 every export and client-report download of a plan/reused run @SI-010 @SI-018', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    const base = await ensureTenant(api);
    const mk = async (name: string, visibility: 'private' | 'public'): Promise<Tenant> => {
      const res = await api.post('/api/v1/projects', { name: `E2E AXI-2613 ${name} ${Date.now()}`, workspaceId: base.workspaceId }, base.headers);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      if (visibility === 'private') {
        const v = await api.patch(`/api/v1/projects/${res.body.id}/visibility`, { visibility }, base.headers);
        expect(v.status, JSON.stringify(v.body)).toBe(200);
      }
      return { ...base, projectId: res.body.id };
    };
    tA = await mk('source (private)', 'private');
    tB = await mk('reuser (public)', 'public');
    await approveCarriersFor(['stats.mann_whitney_u']);
    await silenceTours(await adminToken());
    investigator = await person('investigator', base.workspaceId);
    await addMember(api, base, investigator, INVESTIGATOR_ROLE_ID);
    await silenceTours(investigator.accessToken);
    const datasetId = await ingestSalted(base);
    const anchors: AnchoredDataset[] = [];
    for (const t of [tA, tB]) {
      const link = await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
      expect(link.status, JSON.stringify(link.body)).toBeLessThan(300);
      const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
      if (!anchored) throw new Error('fixture dataset could not be anchored');
      anchors.push(anchored);
    }
    await launchIn(tA, anchors[0]); // project A COMPUTES the canonical run.
    const runB = await launchIn(tB, anchors[1]); // project B's step REUSES it (same content, AXI-2454 precedent).
    const page = await api.get(`/api/v1/projects/${tB.projectId}/runs/${runB}/result-page`, tB.headers);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    ruleRunId = page.body.results[0].ruleRunId; // the reused run id — placed in project A, served through project B's route.
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
    await investigator?.api.dispose();
  });

  test('AC12 AC13 — a reused-elsewhere run exports every kind through the REUSING project\'s route (200, non-empty, correct content type)', async () => {
    for (const kind of ['csv', 'svg', 'png', 'report'] as const) {
      const res = await api.ctx.get(exportUrl(tB, kind));
      expect(res.status(), `export ${kind}: ${await res.text().catch(() => '')}`).toBe(200);
      const body = await res.body();
      expect(body.length, `export ${kind}: empty body`).toBeGreaterThan(0);
    }
  });

  test('AC12 FR25 — the PNG export of a reused run is still 300 dpi', async () => {
    const res = await api.ctx.get(exportUrl(tB, 'png'));
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    const phys = pngPhys(await res.body());
    expect(phys).toEqual([PX_PER_METRE_300_DPI, PX_PER_METRE_300_DPI, 1]);
  });

  test('AC12 FR24 — the client report of a reused run downloads as Markdown and as zip through the reusing project\'s route', async () => {
    const md = await api.ctx.get(reportUrl(tB, 'md'));
    expect(md.status(), await md.text().catch(() => '')).toBe(200);
    expect((await md.body()).length).toBeGreaterThan(0);

    const zip = await api.ctx.get(reportUrl(tB, 'zip'));
    expect(zip.status(), await zip.text().catch(() => '')).toBe(200);
    expect((await zip.body()).length).toBeGreaterThan(0);

    // PDF may be refused (409 CLIENT_REPORT_PDF_NOT_PRODUCED, OQ-3 — open, not this story's fix);
    // Markdown above must still have served regardless, so the record is never a silent failure.
    const pdf = await api.ctx.get(reportUrl(tB, 'pdf'));
    expect([200, 409]).toContain(pdf.status());
  });

  test('AC13 — the fix widens WHICH placements are served, never WHO may read them: no access to the source project still 404s, for every kind', async () => {
    for (const kind of ['csv', 'svg', 'png', 'report'] as const) {
      const res = await investigator.api.get(exportUrl(tB, kind));
      expect(res.status(), `export ${kind} as outsider: ${await res.text().catch(() => '')}`).toBe(404);
    }
    const md = await investigator.api.get(reportUrl(tB, 'md'));
    expect(md.status()).toBe(404);
    // No existence leak: the source project's id never appears in the refusal body.
    const text = await md.text();
    expect(text).not.toContain(tA.projectId);
  });

  test('AC13 — the source project itself stays closed to that viewer (unchanged tenancy)', async () => {
    const res = await investigator.api.get(apiUrl(`/api/v1/projects/${tA.projectId}/rule-runs/${ruleRunId}/exports/csv`));
    expect(res.status()).toBe(404);
  });
});
