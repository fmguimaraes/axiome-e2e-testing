import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1400/harness/api';
import { carrierRuleId, ensureAnalysis, ensureTenant, type Tenant } from '../AXI-1400/harness/seed';
import { approveCarriersFor } from '../AXI-1762/seeded-rule-approval';
import { ingestCsvFixture } from '../AXI-2308/harness/opening-templates';

/**
 * AXI-2346 (epic AXI-2358 — Headless FR31 restored): a rule-run replay
 * (`POST /rule-runs/:id/re-execute`) is indistinguishable in shape from the original — same
 * roles, params, referent, tenancy and therefore the same `runFingerprint`; only
 * `replayOfRuleRunId` differs. The prod daily suite (AXI-2318/AXI-2319) judges a replay from
 * day 2 on, when every submission dedups onto day 1's run.
 *
 * The pivot and workspace halves are pinned by `tests/AXI-2455/AXI-2451-*` / `AXI-2452-*`; this
 * spec pins the whole shape via the fingerprint, the FULL-scope member of the class, and the
 * day-N repeat.
 *
 * Scenario doc: axiome-docs/manual-e2e/AXI-2358-Platform-Opening-Headless-Fast-Follow-Defects.md
 * § "AXI-2346". API-level by design: re-execute has no screen. World: the AXI-1400 admin harness
 * tenant with the AXI-2308 Paul-header CSV.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const TAGS = { tag: ['@SI-042', '@SI-053', '@SI-017'] };
const KRUSKAL = 'stats.kruskal_wallis';
const CORRELATION = 'stats.correlation';
const FIXTURE = 'opening-templates-paul-header.csv';
const OUTCOME = 'microbiote_igg4_mag4_27';
const GROUP = 'cluster_selon_acr_eular_2019';
const RULE_RUN_WAIT_MS = 120_000;
const SETUP_TIMEOUT_MS = 4 * 60_000;

let api: Api;
let t: Tenant;
let datasetId: string;
let kruskalOriginalId: string;
let kruskalOriginal: any;

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

/** Submit a direct run and return its SUCCEEDED canonical (itself, or what it deduped onto). */
async function succeededCanonical(body: Record<string, unknown>): Promise<{ id: string; run: any }> {
  const submitted = await api.post('/api/v1/rule-runs', {
    ...body, projectId: t.projectId, workspaceId: t.workspaceId, datasetId,
  }, t.headers);
  expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
  const first = await settledRuleRun(submitted.body.ruleRunId);
  const id: string = first.dedupedFromRunId ?? first.id;
  const run = await settledRuleRun(id);
  expect(run.status, JSON.stringify(run)).toBe('SUCCEEDED');
  expect(run.runFingerprint).toEqual(expect.any(String));
  return { id, run };
}

/** Re-execute a run and return the settled replay. */
async function replayOf(originalId: string): Promise<any> {
  const replayed = await api.post(`/api/v1/rule-runs/${originalId}/re-execute`, { projectId: t.projectId }, t.headers);
  expect(replayed.status, JSON.stringify(replayed.body)).toBe(201);
  expect(replayed.body.ruleRunId).not.toBe(originalId);
  return settledRuleRun(replayed.body.ruleRunId);
}

test.describe.serial('AXI-2346 — A rule-run replay is indistinguishable in shape from the original', TAGS, () => {
  test.beforeAll(async () => {
    test.setTimeout(SETUP_TIMEOUT_MS); // hooks are governed by setTimeout, never describe.configure
    await approveCarriersFor([KRUSKAL, CORRELATION]);
    api = await adminApi();
    t = await ensureTenant(api);
    datasetId = await ingestCsvFixture(api, t, FIXTURE);
  });

  test.afterAll(async () => {
    await api?.ctx.dispose();
  });

  test('FR31 — AXI-2346.1: a pivot-bound Kruskal–Wallis run replays SUCCEEDED with the original shape and fingerprint', async () => {
    // Arrange
    const analysis = await ensureAnalysis(api, t, 'AXI-2346 replay shape', datasetId);
    const original = await succeededCanonical({
      ruleId: await carrierRuleId(KRUSKAL), runKind: 'STATISTICAL', operationId: KRUSKAL,
      roleBindings: { groupColumn: GROUP }, pivot: { valueColumns: [OUTCOME] }, operationParams: {},
      snapshotId: analysis.snapshotId, viewAnalysisId: analysis.analysisId, scope: 'FILTERED',
    });
    kruskalOriginalId = original.id;
    kruskalOriginal = original.run;
    expect(kruskalOriginal.operandRoles).toMatchObject({ groupColumn: GROUP, valueColumns: [OUTCOME] });

    // Act
    const replay = await replayOf(kruskalOriginalId);

    // Assert — readable by its caller (was 404), accepted (was 400), and the same run shape
    expect(replay).toMatchObject({
      status: 'SUCCEEDED',
      operationId: KRUSKAL,
      replayOfRuleRunId: kruskalOriginalId,
      sapVersionId: null,
      workspaceId: t.workspaceId,
      organizationId: t.orgId,
      datasetId: kruskalOriginal.datasetId,
      snapshotId: kruskalOriginal.snapshotId,
      runFingerprint: kruskalOriginal.runFingerprint,
    });
    expect(replay.operandRoles).toEqual(kruskalOriginal.operandRoles);
    expect(replay.operationParams).toEqual(kruskalOriginal.operationParams);
  });

  test('FR31 — AXI-2346.2: a FULL-scope run over a filtered snapshot replays FULL (same fingerprint)', async () => {
    // Arrange — a snapshot narrowed to one sex, and a FULL-scope run on it (every row)
    const analysis = await ensureAnalysis(api, t, 'AXI-2346 replay FULL scope', datasetId);
    const narrowed = await api.post('/api/v1/view-analyses/snapshots', {
      viewAnalysisId: analysis.analysisId, filters: [{ column: 'sexe', operator: 'eq', value: 'F' }],
    }, t.headers);
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBeLessThan(300);
    const ruleId = await carrierRuleId(CORRELATION);
    const correlation = (scope: 'FULL' | 'FILTERED') => succeededCanonical({
      ruleId, runKind: 'STATISTICAL', operationId: CORRELATION,
      roleBindings: { xColumn: OUTCOME, yColumn: 'igg4_g_l' }, operationParams: {},
      snapshotId: narrowed.body.id, viewAnalysisId: analysis.analysisId, scope,
    });
    const full = await correlation('FULL');
    const filtered = await correlation('FILTERED');
    // control: on this snapshot the two scopes are distinct identities
    expect(filtered.run.runFingerprint).not.toBe(full.run.runFingerprint);

    // Act
    const replay = await replayOf(full.id);

    // Assert — the FULL population again, not the snapshot's `sexe = F` rows
    expect(replay).toMatchObject({
      status: 'SUCCEEDED',
      replayOfRuleRunId: full.id,
      runFingerprint: full.run.runFingerprint,
    });
  });

  test('FR31 — AXI-2346.3: day N — replaying the same canonical run again re-executes again', async () => {
    test.skip(!kruskalOriginalId, 'needs AXI-2346.1');

    // Act — the cron's day-3 call: the same original, already replayed once above
    const again = await replayOf(kruskalOriginalId);

    // Assert — a fresh run, never DEDUPED onto the earlier replay
    expect(again).toMatchObject({
      status: 'SUCCEEDED',
      replayOfRuleRunId: kruskalOriginalId,
      runFingerprint: kruskalOriginal.runFingerprint,
    });
    expect(again.dedupedFromRunId ?? null).toBeNull();
  });
});
