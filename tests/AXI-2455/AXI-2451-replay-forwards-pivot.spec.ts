import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { carrierRuleId, ensureAnalysis, ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';

/**
 * AXI-2451 (epic AXI-2455 — SAP FR55; tracked pre-existing AXI-2044 gap): a rule-run replay
 * (`POST /rule-runs/:id/re-execute`) forwards the original's recorded `pivot` (and `ordering`),
 * so a run whose `valueColumns` role is pivot-sourced — T1 / Mann–Whitney U, direct or SAP-run
 * child — replays instead of being refused 400 "valueColumns is required to execute a grouped
 * comparison run".
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2455-SAP-And-Template-Library-Follow-ups.md
 * § "AXI-2451 — Rule-run replay forwards the original pivot".
 *
 * API-level by design: re-execute has no screen. World: the AXI-1400 admin harness tenant with the
 * AXI-2308 Paul-header CSV (`sexe` × `microbiote_igg4_mag4_27`, carrier `stats.mann_whitney_u`).
 * The replay's own read (`GET /rule-runs/:replayId`) needs AXI-2452 (the replay row carries the
 * caller's verified workspace); both land together.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-017', '@SI-002'] };
const MWU = 'stats.mann_whitney_u';
const FIXTURE = 'opening-templates-paul-header.csv';
const OUTCOME = 'microbiote_igg4_mag4_27';
const RULE_RUN_WAIT_MS = 120_000;
const SETUP_TIMEOUT_MS = 4 * 60_000;

let api: Api;
let t: Tenant;
let datasetId: string;

/** A rule run read until it is terminal (SUCCEEDED / FAILED / DEDUPED). */
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

/** A SUCCEEDED direct Mann–Whitney U run — its `valueColumns` come from the request's pivot. */
async function mannWhitneyOriginal(): Promise<{ originalId: string; original: any }> {
  const analysis = await ensureAnalysis(api, t, 'AXI-2451 replay of a valueColumns run', datasetId);
  const submitted = await api.post('/api/v1/rule-runs', {
    ruleId: await carrierRuleId(MWU), runKind: 'STATISTICAL', operationId: MWU,
    roleBindings: { groupColumn: 'sexe' }, pivot: { valueColumns: [OUTCOME] },
    operationParams: { groupFrom: 'F', groupTo: 'M' },
    projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
    snapshotId: analysis.snapshotId, viewAnalysisId: analysis.analysisId, scope: 'FILTERED',
  }, t.headers);
  expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
  const first = await settledRuleRun(submitted.body.ruleRunId);
  // on a reused tenant the submission dedups onto the canonical run, which is what is replayed
  const originalId: string = first.dedupedFromRunId ?? first.id;
  const original = await settledRuleRun(originalId);
  expect(original.status, JSON.stringify(original)).toBe('SUCCEEDED');
  expect(original.operandRoles).toMatchObject({ valueColumns: [OUTCOME] });
  return { originalId, original };
}

test.describe.serial('AXI-2451 — Rule-run replay forwards the original pivot', TAGS, () => {
  test.beforeAll(async () => {
    test.setTimeout(SETUP_TIMEOUT_MS); // hooks are governed by setTimeout, never describe.configure
    await approveCarriersFor([MWU]);
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('FR55 — AXI-2451.1: a Mann–Whitney U run (pivot valueColumns) is replayed as a new SUCCEEDED run with the same roles', async () => {
    // Arrange
    const { originalId, original } = await mannWhitneyOriginal();

    // Act
    const replayed = await api.post(`/api/v1/rule-runs/${originalId}/re-execute`, { projectId: t.projectId }, t.headers);

    // Assert — accepted (was 400 "valueColumns is required to execute a grouped comparison run")
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(201);
    expect(replayed.body.ruleRunId).toEqual(expect.any(String));
    expect(replayed.body.ruleRunId).not.toBe(originalId);
    const replay = await settledRuleRun(replayed.body.ruleRunId);
    expect(replay).toMatchObject({
      status: 'SUCCEEDED',
      operationId: MWU,
      replayOfRuleRunId: originalId,
      sapVersionId: null,
    });
    expect(replay.operandRoles).toEqual(original.operandRoles);
    expect(replay.operationParams).toEqual(original.operationParams);
  });
});
