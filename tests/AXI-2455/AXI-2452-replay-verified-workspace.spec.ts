import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { carrierRuleId, ensureAnalysis, ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { Actor, PrivateProjectsWorld } from '../AXI-2265/private-projects-fixtures';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';

/**
 * AXI-2452 (epic AXI-2455 — SAP FR55, FR57; tracked pre-existing AXI-2044 gap): a rule-run replay
 * row carries the caller's VERIFIED workspace — the workspace of the original run's data, checked
 * against the caller's own memberships — never a client-supplied one and never the record's own
 * stamp. Before, the row was written with `workspaceId` null and the workspace-scoped
 * `GET /rule-runs/:replayId` answered 404.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md
 * § "AXI-2452 — Replay row carries the caller's verified workspace". The AXI-2443.6 lineage read
 * (tests/AXI-2433/AXI-2443-retire-run-sap-binding.spec.ts) is un-fixme'd by this story too.
 *
 * API-level by design. Worlds: (A) the AXI-1400 admin harness tenant with the AXI-2308 Paul-header
 * CSV and a direct `stats.correlation` run (xColumn / yColumn only); (B) a fresh AXI-2265
 * `PrivateProjectsWorld` — an editor who is NOT a member of world A's workspace, and a project of
 * another workspace for the admin.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-017', '@SI-042', '@SI-002'] };
const CORRELATION = 'stats.correlation';
const FIXTURE = 'opening-templates-paul-header.csv';
const OUTCOME = 'microbiote_igg4_mag4_27';
const RULE_RUN_WAIT_MS = 120_000;
const SETUP_TIMEOUT_MS = 4 * 60_000;

let api: Api;
let t: Tenant;
let datasetId: string;
let world: PrivateProjectsWorld;
let outsider: Actor;
let outsiderProject: string;
let originalId: string;

async function settledRuleRun(ruleRunId: string): Promise<any> {
  let body: any = null;
  await expect
    .poll(async () => {
      const res = await api.get(`/api/v1/rule-runs/${ruleRunId}`, t.headers);
      body = res.body;
      return res.status === 200 ? body?.status : `HTTP ${res.status}`;
    }, { timeout: RULE_RUN_WAIT_MS, intervals: [1_000, 2_000, 5_000] })
    .toMatch(/^(SUCCEEDED|FAILED|DEDUPED)$/);
  return body;
}

async function ruleRunsTotal(): Promise<number> {
  const res = await api.get(`/api/v1/rule-runs?workspaceId=${t.workspaceId}&limit=1`, t.headers);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.total;
}

/** A SUCCEEDED, unbound, direct correlation run in world A (its canonical, if deduped). */
async function correlationOriginal(): Promise<string> {
  const analysis = await ensureAnalysis(api, t, 'AXI-2452 replay workspace', datasetId);
  const submitted = await api.post('/api/v1/rule-runs', {
    ruleId: await carrierRuleId(CORRELATION), runKind: 'STATISTICAL', operationId: CORRELATION,
    roleBindings: { xColumn: OUTCOME, yColumn: 'igg4_g_l' }, operationParams: {},
    projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
    snapshotId: analysis.snapshotId, viewAnalysisId: analysis.analysisId, scope: 'FILTERED',
  }, t.headers);
  expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
  const first = await settledRuleRun(submitted.body.ruleRunId);
  const id: string = first.dedupedFromRunId ?? first.id;
  expect((await settledRuleRun(id)).status).toBe('SUCCEEDED');
  return id;
}

test.describe.serial('AXI-2452 — Replay row carries the caller verified workspace', TAGS, () => {
  test.beforeAll(async () => {
    test.setTimeout(SETUP_TIMEOUT_MS); // hooks are governed by setTimeout, never describe.configure
    await approveCarriersFor([CORRELATION]);
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
    originalId = await correlationOriginal();

    world = await PrivateProjectsWorld.create();
    outsider = await world.actor('outsider');
    await world.addMember(outsider, 'editor');
    const created = await outsider.api.post(apiUrl('/api/v1/projects'), {
      data: { name: `E2E AXI-2452 outsider ${Date.now()}`, workspaceId: world.workspaceId },
    });
    expect(created.status(), await created.text()).toBe(201);
    outsiderProject = (await created.json()).id;
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
    await world?.dispose();
  });

  test('FR55, FR57 — AXI-2452.1: the replay is readable on GET /rule-runs/:id and carries the run data workspace', async () => {
    // Act
    const replayed = await api.post(`/api/v1/rule-runs/${originalId}/re-execute`, { projectId: t.projectId }, t.headers);

    // Assert
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(201);
    const replay = await settledRuleRun(replayed.body.ruleRunId);
    expect(replay).toMatchObject({
      id: replayed.body.ruleRunId,
      workspaceId: t.workspaceId,
      replayOfRuleRunId: originalId,
      sapVersionId: null,
      sapRun: null,
    });
  });

  test('FR57 — AXI-2452.2: a caller outside the run workspace is answered 404 "RuleRun … not found" and nothing is written', async () => {
    // Arrange
    const before = await ruleRunsTotal();

    // Act — the outsider names their OWN project (gateway-authorized) and another tenant's run id
    const res = await outsider.api.post(apiUrl(`/api/v1/rule-runs/${originalId}/re-execute`), {
      data: { projectId: outsiderProject },
    });

    // Assert — indistinguishable from an absent run (not a rule/snapshot refusal that confirms it)
    expect(res.status(), await res.text()).toBe(404);
    expect(String((await res.json()).message)).toBe(`RuleRun ${originalId} not found`);
    expect(await ruleRunsTotal()).toBe(before);
  });

  test('FR55 — AXI-2452.3: a replay cannot be filed into a project of another workspace', async () => {
    // Arrange — a project in world B's workspace (the admin is a member there as well)
    const other = await world.admin.post(apiUrl('/api/v1/projects'), {
      data: { name: `E2E AXI-2452 other ws ${Date.now()}`, workspaceId: world.workspaceId },
      headers: { 'X-Workspace-Id': world.workspaceId },
    });
    expect(other.status(), await other.text()).toBe(201);

    // Act
    const res = await api.post(`/api/v1/rule-runs/${originalId}/re-execute`, { projectId: (await other.json()).id }, t.headers);

    // Assert
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(String(res.body.message)).toMatch(/is not in the workspace of the run being replayed/);
  });
});
