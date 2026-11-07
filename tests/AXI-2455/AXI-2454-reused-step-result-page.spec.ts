import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminApi, adminToken, asList, sleep, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { INVESTIGATOR_ROLE_ID, addMember, launchAndDrain, person, signIn, wizardBody, type Person } from '../AXI-2308/harness/result-page';
import { apiUrl } from '../../config/env';

/**
 * AXI-2454 (epic AXI-2455 - SAP FR48) - the result page of a run whose step was REUSED from a run
 * placed in ANOTHER project: it resolves the reused result when the viewer may open the source
 * project, and shows the typed `source_no_access` state (never a 404, never source data) when not.
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2454.
 * Fixture: the shared fixture salted with a per-run constant column (so project A COMPUTES, never
 * reusing an older project's run), ingested ONCE and linked to both projects, so project B's step
 * REUSES project A's run - the exact case AXI-2446 had to work around.
 *
 * Run: BASE_URL=<Vite serving the branch> API_BASE_URL=<its gateway>
 *   npx playwright test tests/AXI-2455/AXI-2454-* --project=chromium --no-deps
 */

const FIXTURE = 'opening-templates-paul-header.csv';
const QUESTION = 'Does igg4_g_l differ by sex?';

let api: Api;
let tA: Tenant;
let tB: Tenant;
let investigator: Person;
let runA: string;
let runB: string;
let sourceRuleRunId: string;

const pageUrl = (t: Tenant, runId: string) => `/api/v1/projects/${t.projectId}/runs/${runId}/result-page`;

/** Ingest the salted fixture once (the shared one would reuse an unknown older project's run); returns the dataset id. */
async function ingestSalted(t: Tenant): Promise<string> {
  const nonce = String(Date.now());
  const lines = readFileSync(join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', FIXTURE), 'utf-8').trimEnd().split('\n');
  const csv = `${lines.map((l, i) => `${l},${i === 0 ? 'e2e_salt' : nonce}`).join('\n')}\n`;
  const init = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: `axi2454-${nonce}-${FIXTURE}`, contentType: 'text/csv',
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

test.describe.serial('AXI-2454 result page of a step reused across projects @SI-013 @SI-066', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    const base = await ensureTenant(api);
    const mk = async (name: string, visibility: 'private' | 'public'): Promise<Tenant> => {
      const res = await api.post('/api/v1/projects', { name: `E2E AXI-2454 ${name} ${Date.now()}`, workspaceId: base.workspaceId }, base.headers);
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
    const anchors: AnchoredDataset[] = [];
    const datasetId = await ingestSalted(base);
    for (const t of [tA, tB]) {
      const link = await api.post(`/api/v1/projects/${t.projectId}/datasets`, { datasetId }, t.headers);
      expect(link.status, JSON.stringify(link.body)).toBeLessThan(300);
      const anchored = await anchorDataset(api, t.workspaceId, t.projectId, { datasetId });
      if (!anchored) throw new Error('fixture dataset could not be anchored');
      anchors.push(anchored);
    }
    runA = await launchIn(tA, anchors[0]);
    runB = await launchIn(tB, anchors[1]);
  });

  test('AC1 a viewer with access to the source project reads the reused result (200, ready, the SOURCE run)', async () => {
    const source = await api.get(pageUrl(tA, runA), tA.headers);
    expect(source.status, JSON.stringify(source.body)).toBe(200);
    sourceRuleRunId = source.body.results[0].ruleRunId;

    const reused = await api.get(pageUrl(tB, runB), tB.headers);

    expect(reused.status, JSON.stringify(reused.body)).toBe(200);
    expect(reused.body).toMatchObject({ state: 'ready', projectId: tB.projectId });
    expect(reused.body.results[0].ruleRunId).toBe(sourceRuleRunId);
  });

  test('AC2 a viewer WITHOUT access to the source project gets the typed no-access state: no result, no source identity', async () => {
    const res = await investigator.api.get(apiUrl(pageUrl(tB, runB)));
    const text = await res.text();

    expect(res.status(), text).toBe(200);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ state: 'source_no_access', results: [], answer: [], verdicts: [] });
    expect(text).not.toContain(tA.projectId);
    expect(text).not.toContain(sourceRuleRunId);
  });

  test('AC3 the source project itself stays closed to that viewer (the 404 is unchanged)', async () => {
    const res = await investigator.api.get(apiUrl(pageUrl(tA, runA)));

    expect(res.status()).toBe(404);
  });

  test('AC4 the page shows the no-access message, not "not available"', async ({ browser }) => {
    // A fresh context: the project's default storageState is the admin's, which would skip the login form.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await signIn(page, investigator, tB, `/investigator/projects/${tB.projectId}/runs/${runB}`);

    await expect(page.getByTestId('rp-source-no-access')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId('rp-unavailable')).toHaveCount(0);
    await context.close();
  });
});
