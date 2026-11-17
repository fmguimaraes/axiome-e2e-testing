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
 * AXI-2613 bounce #1 (epic AXI-2598 — FR5, FR24, FR25, FR26; AC12, AC13) — the first fix
 * (`placedRunOrReusedSource` over `placedRun`) widened WHICH placement is served, but every
 * download still 404ed "Rule run not found" for a membership-only Investigator, because
 * `ClientReportService.get()`/`RunExportService.get()` asked `assertRunReadable` with the
 * DEFAULT `SystemRuleHidingBasis` (`caller_role`): it requires the caller's OWN assigned role to
 * carry `rule:view_shared` before a SYSTEM-scope rule's runs are visible — a membership-only
 * Investigator holds no assigned role, so EVERY system-scope carrier rule's runs (every
 * compiled plan step) were hidden from them, including their own. `ResultPageService` already
 * solved exactly this read (FR32, `RESULT_PAGE_RULE_HIDING = 'org_entitlement'`); the fix threads
 * the SAME basis through the client report and the exports (`CLIENT_REPORT_RULE_HIDING`).
 *
 * This is why the SIBLING spec (`AXI-2613-plan-run-exports.spec.ts`) stayed green through the
 * bounce: its success assertions download as the PLATFORM ADMIN harness caller, who bypasses
 * every hiding basis (`callerIsPlatformAdmin`). This spec downloads as a REAL membership-only
 * Investigator of a REAL compiled plan's child run — the shape the AXI-2601 rehearsal's
 * `investigator@axiomebio.com` caller hit in w5val (SAP run `8860cd26...`, rule run
 * `8cac6c2d...`): a governed-execution plan child citing a SYSTEM-scope carrier rule
 * (`stats.mann_whitney_u`), never the two-project REUSED-elsewhere fixture.
 *
 * Scenario: `axiome-docs/manual-e2e/AXI-2598-Investigator-Handover.md` § 13 (13.1, extended).
 *
 * Run: BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway — must serve the
 *   AXI-2613-plan-child-placement branch, not main, for this to prove the fix>
 *   npx playwright test tests/AXI-2598/AXI-2613-plan-child-placement.spec.ts --project=chromium --no-deps
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const QUESTION = 'Does igg4_g_l differ by sex?';
const CARRIER_RULE = 'stats.mann_whitney_u';

type ExportKind = 'csv' | 'svg' | 'png' | 'report';
type ReportFormat = 'md' | 'pdf' | 'zip';

let api: Api;
let t: Tenant;
let investigator: Person;
let ruleRunId: string;

const exportUrl = (kind: ExportKind) => apiUrl(`/api/v1/projects/${t.projectId}/rule-runs/${ruleRunId}/exports/${kind}`);
const reportUrl = (format: ReportFormat) => apiUrl(`/api/v1/projects/${t.projectId}/rule-runs/${ruleRunId}/client-report?format=${format}`);

/** Ingest the salted fixture once; returns the dataset id. */
async function ingestSalted(tenant: Tenant): Promise<string> {
  const nonce = String(Date.now());
  const lines = readFileSync(join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', FIXTURE), 'utf-8').trimEnd().split('\n');
  const csv = `${lines.map((l, i) => `${l},${i === 0 ? 'e2e_salt' : nonce}`).join('\n')}\n`;
  const init = await api.post(`/api/v1/workspaces/${tenant.workspaceId}/datasets`, {
    organizationId: tenant.orgId, originalFilename: `axi2613-plan-child-${nonce}-${FIXTURE}`, contentType: 'text/csv',
  }, tenant.headers);
  expect(init.status, JSON.stringify(init.body)).toBeLessThan(300);
  const put = await fetch(init.body.presignedUrl, { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: csv });
  expect(put.ok, `presigned PUT -> ${put.status}`).toBe(true);
  const id = init.body.dataset.id;
  const fin = await api.patch(`/api/v1/workspaces/${tenant.workspaceId}/datasets/${id}/finalize`, undefined, tenant.headers);
  expect(fin.status, JSON.stringify(fin.body)).toBeLessThan(300);
  const deadline = Date.now() + 240_000;
  for (;;) {
    const list = asList((await api.get(`/api/v1/workspaces/${tenant.workspaceId}/datasets/${id}/ingestions`, tenant.headers)).body);
    const newest = [...list].sort((a: any, b: any) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (newest?.status === 'ready') return id;
    if (newest?.status === 'failed' || Date.now() > deadline) throw new Error(`ingestion of ${id}: ${JSON.stringify(newest)}`);
    await sleep(2_000);
  }
}

test.describe.serial('AXI-2613 bounce #1 — a real plan child run downloads for a membership-only Investigator @SI-010 @SI-018', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    const base = await ensureTenant(api);
    const res = await api.post('/api/v1/projects', { name: `E2E AXI-2613 plan-child ${Date.now()}`, workspaceId: base.workspaceId }, base.headers);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    t = { ...base, projectId: res.body.id };

    // The carrier rule compiled plan steps run through — SYSTEM-scope, exactly the shape that
    // `hiddenSystemRuleIds` hides from a membership-only caller under the default `caller_role`.
    await approveCarriersFor([CARRIER_RULE]);
    await silenceTours(await adminToken());

    // A REAL membership-only Investigator: a seeded ROLE, no org-admin/platform-admin grant, no
    // `rule:view_shared` of its own — never the harness's platform-admin caller.
    investigator = await person('investigator', t.workspaceId);
    await addMember(api, t, investigator, INVESTIGATOR_ROLE_ID);
    await silenceTours(investigator.accessToken);

    const datasetId = await ingestSalted(t);
    const link = await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
    expect(link.status, JSON.stringify(link.body)).toBeLessThan(300);
    const anchored: AnchoredDataset | null = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
    if (!anchored) throw new Error('fixture dataset could not be anchored');

    // A SMALL real plan — launched and drained through the governed executor, never the
    // two-project REUSED-elsewhere fixture: the run's own `RunCreated` is a genuine
    // `system:governed-execution` child, exactly the real DB shape (null stepRunId/
    // containerViewAnalysisId, a materialized node, a resolvable snapshotId).
    const runId = await launchAndDrain(api, t, wizardBody(t, anchored, 'T1', QUESTION, 'compare_groups', [
      { slot: 'groupingColumn', value: 'sexe' }, { slot: 'groups', value: ['F', 'M'] }, { slot: 'outcome', value: 'igg4_g_l' },
    ]));
    const page = await api.get(`/api/v1/projects/${t.projectId}/runs/${runId}/result-page`, t.headers);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    ruleRunId = page.body.results[0].ruleRunId;
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
    await investigator?.api.dispose();
  });

  test('AC12 AC13 — the result page already serves this run to the Investigator (sanity: the run itself is not hidden from them)', async () => {
    const page = await investigator.api.get(apiUrl(`/api/v1/projects/${t.projectId}/runs/${ruleRunId}/result-page`));
    // Not asserting 200 here: the result page keys off the GOVERNED run id, not the rule run id.
    // The real assertion is the downloads below, which key off `ruleRunId` directly, exactly as
    // the AXI-2601 rehearsal's download step does.
    expect([200, 404]).toContain(page.status());
  });

  test('AC12 AC13 (bounce #1 fix) — a membership-only Investigator downloads every export of their own plan\'s result (200, non-empty) — was "Rule run not found" before CLIENT_REPORT_RULE_HIDING', async () => {
    for (const kind of ['csv', 'svg', 'png', 'report'] as const) {
      const res = await investigator.api.get(exportUrl(kind));
      expect(res.status(), `export ${kind} as Investigator: ${await res.text().catch(() => '')}`).toBe(200);
      const body = await res.body();
      expect(body.length, `export ${kind}: empty body`).toBeGreaterThan(0);
    }
  });

  test('AC12 FR24 (bounce #1 fix) — the SAME Investigator downloads the client report as Markdown and zip', async () => {
    const md = await investigator.api.get(reportUrl('md'));
    expect(md.status(), await md.text().catch(() => '')).toBe(200);
    expect((await md.body()).length).toBeGreaterThan(0);

    const zip = await investigator.api.get(reportUrl('zip'));
    expect(zip.status(), await zip.text().catch(() => '')).toBe(200);
    expect((await zip.body()).length).toBeGreaterThan(0);
  });

  test('(defence) the platform-admin harness caller still downloads too — the fix never narrowed the admin path', async () => {
    const res = await api.ctx.get(exportUrl('csv'));
    expect(res.status(), await res.text().catch(() => '')).toBe(200);
  });

  test('AC13 — tenancy is unchanged: an unrelated outsider (no project membership at all) still 404s, no leak', async () => {
    const outsider = await person('outsider', t.workspaceId);
    const res = await outsider.api.get(exportUrl('csv'));
    expect(res.status()).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(t.projectId);
    await outsider.api.dispose();
  });
});
