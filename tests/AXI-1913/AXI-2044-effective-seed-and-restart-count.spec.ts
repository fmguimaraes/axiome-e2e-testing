import { test, expect } from '@playwright/test';
import { adminApi, type Api } from '../AXI-1435/harness/api';
import {
  ensureRoundTripTenant,
  ingestRoundTripFixture,
  ensureRoundTripAnalysis,
  submitRoundTrip,
  type RoundTripFixture,
  type Tenant,
} from '../AXI-1911/harness/round-trip';
import { carrierRuleId } from '../AXI-1400/harness/seed';

/**
 * AXI-2044 (epic AXI-1913 — FR15) — the run record's own effective seed and
 * restart count, persisted on the callback, exposed on read, and forced back
 * into a re-execution of the SAME run. Manual-E2E
 * `axiome-docs/manual-e2e/AXI-1913-Bioinformatics-Method-Validation.md`
 * §AXI-2044.
 *
 * API-level (no browser): this story's surface is two REST endpoints
 * (`POST /rule-runs`, `POST /rule-runs/:id/re-execute`) and a response field —
 * there is no UI for either yet. Reuses AXI-1911's round-trip harness
 * (`ingestRoundTripFixture`/`ensureRoundTripAnalysis`/`submitRoundTrip`)
 * rather than re-deriving CSV upload + referent setup, and
 * `tests/AXI-1400/harness/seed.ts#carrierRuleId` for the served carrier the
 * run executes under.
 *
 * Fixture is inline (not a committed JSON file): `stats.cutoff_roc_youden`
 * over a numeric `value` column split by a `group` column, with enough
 * separation that Youden's statistic is well-defined and the bootstrap
 * interval resolves — the SAME shape `cutoff-proposal-operations.ts` declares
 * (`groupColumn`/`valueColumns`, `positiveGroup` required).
 *
 * @SI-050 (bio-compute pipeline), @SI-017 (rule-runs kernel + persistence)
 */

const FIXTURE = {
  method_id: 'stats.cutoff_roc_youden.axi-2044',
  operation_id: 'stats.cutoff_roc_youden',
  // `valueColumns` is `cardinality: 'many'` (cutoff-proposal-operations.ts);
  // `RoundTripFixtureCommon.operand_roles` is typed `Record<string, string>`
  // because every fixture it has carried so far binds single-valued roles —
  // widened here via the cast below rather than loosening that shared type
  // for every OTHER fixture that relies on it staying `string`.
  operand_roles: { groupColumn: 'group', valueColumns: ['value'] } as unknown as Record<string, string>,
  operation_params: { positiveGroup: 'A', bootstrapSeed: 777, bootstrapIterations: 200 },
  csv_columns: ['group', 'value'],
  rows: [
    { group: 'A', value: '12.1' },
    { group: 'A', value: '13.4' },
    { group: 'A', value: '14.0' },
    { group: 'A', value: '15.2' },
    { group: 'A', value: '13.8' },
    { group: 'A', value: '14.6' },
    { group: 'B', value: '3.1' },
    { group: 'B', value: '4.2' },
    { group: 'B', value: '2.8' },
    { group: 'B', value: '5.0' },
    { group: 'B', value: '3.6' },
    { group: 'B', value: '4.4' },
  ],
  case_kind: 'nominal',
} as unknown as RoundTripFixture;

test.describe('AXI-2044 — effective seed and restart count on the run record', () => {
  let api: Api;
  let t: Tenant;
  let datasetId: string;

  test.beforeAll(async () => {
    api = await adminApi();
    t = await ensureRoundTripTenant(api);
    await carrierRuleId(FIXTURE.operation_id);
    datasetId = await ingestRoundTripFixture(api, t, FIXTURE);
  });

  test.afterAll(async () => {
    await api.ctx.dispose();
  });

  // AC1 (persist) + AC2 (expose) — the SAME declared seed the submission
  // supplied is persisted and read back; restartCount is the recorded 0
  // (no production method implements optimizer restarts today).
  test('persists and exposes the submitted bootstrapSeed as effectiveSeed/restartCount (AC1, AC2)', { tag: ['@SI-050', '@SI-017'] }, async () => {
    const analysis = await ensureRoundTripAnalysis(api, t, 'AXI-2044 effective seed', datasetId);
    const run = await submitRoundTrip(api, t, analysis, datasetId, FIXTURE);

    expect(run.status, `run did not succeed: ${JSON.stringify(run)}`).toBe('SUCCEEDED');
    // RuleRunResponse.effectiveSeed is a STRING (BigInt serialized for JSON).
    expect(run.effectiveSeed).toBe('777');
    expect(run.restartCount).toBe(0);

    const read = await api.get(`/api/v1/rule-runs/${run.id}`, t.headers);
    expect(read.status).toBe(200);
    expect(read.body.effectiveSeed).toBe('777');
    expect(read.body.restartCount).toBe(0);
  });

  // AC3 (re-execute from the record) — the replay forces the RECORDED seed
  // back into operationParams (never bio-compute's current default) and is
  // excluded from the fingerprint dedup lookup, so it is a genuinely NEW run
  // that reports the SAME effectiveSeed — never a dedup pointer back to the
  // original.
  test('re-executes from the record with the recorded seed forced back in, as a new run (AC3)', { tag: ['@SI-050', '@SI-017'] }, async () => {
    const analysis = await ensureRoundTripAnalysis(api, t, 'AXI-2044 effective seed', datasetId);
    const original = await submitRoundTrip(api, t, analysis, datasetId, FIXTURE);
    expect(original.status).toBe('SUCCEEDED');

    const replaySubmit = await api.post(
      `/api/v1/rule-runs/${original.id}/re-execute`,
      { projectId: t.projectId },
      t.headers,
    );
    expect(replaySubmit.status, `re-execute submit failed: ${JSON.stringify(replaySubmit.body)}`).toBeLessThan(300);
    expect(replaySubmit.body.id).not.toBe(original.id);

    const deadline = Date.now() + 120_000;
    let replay: any;
    while (Date.now() < deadline) {
      const polled = await api.get(`/api/v1/rule-runs/${replaySubmit.body.id}`, t.headers);
      if (['SUCCEEDED', 'FAILED', 'CANCELED', 'DEDUPED'].includes(polled.body?.status)) {
        replay = polled.body;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(replay, 'replay run did not reach a terminal status').toBeTruthy();

    // The whole point of excludeRunIdFromDedup: this must be a REAL new
    // execution, not a dedup pointer back to the original run it replays.
    expect(replay.status).toBe('SUCCEEDED');
    expect(replay.id).not.toBe(original.id);
    expect(replay.effectiveSeed).toBe('777');
    expect(replay.restartCount).toBe(0);
  });

  // AC4 (refusal) — a non-STATISTICAL / non-existent run is refused, not
  // silently accepted.
  test('refuses to re-execute an unknown run id (AC4)', { tag: ['@SI-017'] }, async () => {
    const res = await api.post(
      '/api/v1/rule-runs/00000000-0000-0000-0000-000000000000/re-execute',
      { projectId: t.projectId },
      t.headers,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
