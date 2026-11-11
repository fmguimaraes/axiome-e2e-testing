import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminApi, adminToken, asList, sleep, type Api } from '../AXI-1400/harness/api';
import { ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { anchorDataset, type AnchoredDataset } from '../AXI-1604/harness/anchor-dataset';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { silenceTours } from '../AXI-1904/harness/tours';
import { INVESTIGATOR_ROLE_ID, addMember, launchAndDrain, person, wizardBody, type Person } from '../AXI-2308/harness/result-page';
import { apiUrl } from '../../config/env';

/**
 * AXI-2482 (epic AXI-2455 - SAP FR76, EC41, AC43; SECURITY FIX) - the governed run STATUS read of a
 * run whose step was REUSED from a run placed in ANOTHER project withholds the source (its rule run
 * id and output) from a reader who may not open that project - the same `source_no_access` marker
 * the result page serves (AXI-2454) - and still serves it to a reader of both projects.
 *
 * FAILS ON MAIN: main serves the source project's rule run id to the Investigator (AC1).
 *
 * Scenarios: `axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md` § AXI-2482.
 * Fixture: AXI-2454's - the shared fixture salted with a per-run constant column, ingested ONCE and
 * linked to both projects, so project B's step REUSES project A's run.
 *
 * Run: API_BASE_URL=<gateway serving the branch>
 *   npx playwright test tests/AXI-2455/AXI-2482-* --project=chromium --no-deps
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

const statusUrl = (t: Tenant, runId: string) => `/api/v1/governed-execution/status?projectId=${t.projectId}&runId=${runId}`;

/** Ingest the salted fixture once (the shared one would reuse an unknown older project's run); returns the dataset id. */
async function ingestSalted(t: Tenant): Promise<string> {
  const nonce = String(Date.now());
  const lines = readFileSync(join(process.cwd(), 'tests', 'AXI-2308', 'fixtures', FIXTURE), 'utf-8').trimEnd().split('\n');
  const csv = `${lines.map((l, i) => `${l},${i === 0 ? 'e2e_salt' : nonce}`).join('\n')}\n`;
  const init = await api.post(`/api/v1/workspaces/${t.workspaceId}/datasets`, {
    organizationId: t.orgId, originalFilename: `axi2482-${nonce}-${FIXTURE}`, contentType: 'text/csv',
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

test.describe.serial('AXI-2482 reused-step sibling reads withhold the source @SI-017 @SI-065 @SI-010', () => {
  test.beforeAll(async () => {
    test.setTimeout(600_000); // hooks are governed by setTimeout, never describe.configure
    api = await adminApi();
    const base = await ensureTenant(api);
    const mk = async (name: string, visibility: 'private' | 'public'): Promise<Tenant> => {
      const res = await api.post('/api/v1/projects', { name: `E2E AXI-2482 ${name} ${Date.now()}`, workspaceId: base.workspaceId }, base.headers);
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
    const source = await api.get(statusUrl(tA, runA), tA.headers);
    expect(source.status, JSON.stringify(source.body)).toBe(200);
    sourceRuleRunId = source.body.ruleRunId;
    expect(sourceRuleRunId, 'project A computed a rule run').toBeTruthy();
  });

  test('AXI-2482.1 AC1 a reader of B who cannot open A gets ruleRunId null + source_no_access; A\'s rule run id and project id appear nowhere', async () => {
    const res = await investigator.api.get(apiUrl(statusUrl(tB, runB)));
    const text = await res.text();

    expect(res.status(), text).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ ruleRunId: null, reusedSource: 'source_no_access' });
    expect(text).not.toContain(sourceRuleRunId);
    expect(text).not.toContain(tA.projectId);
  });

  test('AXI-2482.2 AC2 a reader of BOTH projects still reads the reused source on B\'s status', async () => {
    const res = await api.get(statusUrl(tB, runB), tB.headers);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ruleRunId).toBe(sourceRuleRunId);
    expect(res.body.reusedSource ?? null).toBeNull();
  });
});
