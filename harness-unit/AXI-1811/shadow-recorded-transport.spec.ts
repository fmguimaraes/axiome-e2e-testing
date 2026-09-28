import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHADOW_RUN_ROW_KEYS,
  notAnsweredReasonOf,
  outcomeOf,
  pendingRecordingShaOf,
  runShadowBankGuarded,
  shadowRunProvenanceOf,
  transportLabelFor,
  type HarnessTransportStatement,
  type ShadowRunAuth,
} from '../../tests/AXI-1462/harness/shadow';
import type { Api } from '../../tests/AXI-1435/harness/api';

/**
 * AXI-1811 (epic AXI-1687 — R-LLM-1, FR113–FR115). The `transport` label
 * carried on every row an actual call was attempted under, and the loud
 * `recording_missing` miss (never scored as an answer). No live backend;
 * nothing here can spend. Run via `npm run harness:unit`.
 *
 * AXI-1857 (fixes AXI-1811). AXI-1811's harness-side `SHADOW_RUN_TRANSPORT=recorded`
 * axis is DELETED — it let the harness's own env buy a free run against a
 * backend that was really `live`. UT-HGUARD-1811-001..005 pinned that axis and
 * are retired; the free path is now decided by the backend's own statement
 * (`decideHarnessBankRun`, AXI-1716, `UT-SHADOW-1716-*`). The row label is
 * derived from that decision's `spendMode`, so every test below drives the
 * transport through a backend statement, never through env.
 */

const ROW_ID = 'RUN-2026-09-26-01';
const REGISTRY_GO = `# run registry\n| ${ROW_ID} | compiled | 3,7,12 | GO: felipe 2026-09-26 |\n`;

const RECORDED: HarnessTransportStatement = { mode: 'recorded', source: 'backend' };
const LIVE: HarnessTransportStatement = { mode: 'live', source: 'backend' };

// ── transportLabelFor — the single mapping (design point 1) ────────────────

test('UT-HGUARD-1811-006: transportLabelFor maps free_recorded→claude-code, registered_live→live, any refusal→undefined', () => {
  assert.equal(transportLabelFor({ allowed: true, spendMode: 'free_recorded' }), 'claude-code');
  assert.equal(transportLabelFor({ allowed: true, spendMode: 'registered_live' }), 'live');
  assert.equal(transportLabelFor({ allowed: false }), undefined);
  // AXI-1857: an allowed decision that states no spend mode is not labelled
  // `live` by default — `reason: 'allowed'` alone says nothing about payment.
  assert.equal(transportLabelFor({ allowed: true }), undefined);
});

// ── runShadowBankGuarded — the label reaches the rows ───────────────────────

function stubAuth(post: Api['post'], onPost?: () => void): ShadowRunAuth {
  const api = {
    get: async () => ({ status: 200, body: {} }),
    post: async (...args: Parameters<Api['post']>) => {
      onPost?.();
      return post(...args);
    },
    patch: async () => ({ status: 200, body: {} }),
    ctx: undefined as unknown as Api['ctx'],
  } as Api;
  return { api: () => api, refresh: async () => api };
}

const PLANNED = async () => ({
  status: 200,
  body: { plan: { nodes: [{ nodeType: 'describe' }], datasetsUsed: [{}] } },
});

test('UT-HGUARD-1811-007: a run against a RECORDED backend labels every answered row claude-code, never live', async () => {
  const result = await runShadowBankGuarded(stubAuth(PLANNED), 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3' },
    transport: RECORDED,
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.rows.map((r) => r.transport), ['claude-code']);
});

test('UT-HGUARD-1811-008: a registered live-go run labels every answered row live', async () => {
  const result = await runShadowBankGuarded(stubAuth(PLANNED), 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3', GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID },
    registryText: REGISTRY_GO,
    transport: LIVE,
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.rows.map((r) => r.transport), ['live']);
});

test('UT-HGUARD-1811-009: a guard-refused run carries no transport label — no call was made to label', async () => {
  const result = await runShadowBankGuarded(
    stubAuth(async () => ({ status: 200, body: { plan: { nodes: [] } } })),
    'ws',
    'proj',
    'compiled',
    [],
    { env: { SHADOW_RUN_QUESTIONS: '3' }, transport: LIVE },
  );
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.rows.map((r) => r.transport), [undefined]);
});

test('UT-HGUARD-1811-010: every row key stays within the closed SHADOW_RUN_ROW_KEYS set (transport included)', async () => {
  const result = await runShadowBankGuarded(stubAuth(PLANNED), 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3' },
    transport: RECORDED,
  });
  for (const row of result.rows) {
    assert.ok(Object.keys(row).every((k) => (SHADOW_RUN_ROW_KEYS as readonly string[]).includes(k)));
  }
  assert.ok((SHADOW_RUN_ROW_KEYS as readonly string[]).includes('transport'));
});

// ── recording_missing — loud, never an answer ───────────────────────────────

test('UT-HGUARD-1811-011: a recording_missing response is not_answered, never an honest unsupported verdict', () => {
  const body = {
    plan: { nodes: [{ nodeType: 'profile' }] },
    intentUnsupported: true,
    unsupportedReason: 'recording_missing',
    unsupportedDetail: 'LLM recording missing abc123def456 (compiled-planner) - run llm-debug:record',
  };
  assert.equal(outcomeOf(body, 200), 'not_answered');
  assert.equal(notAnsweredReasonOf(body, 200), 'recording_missing');
});

test('UT-HGUARD-1811-012: pendingRecordingShaOf names the pending payload sha from the miss detail', () => {
  assert.equal(
    pendingRecordingShaOf({
      unsupportedDetail: 'LLM recording missing abc123def456 (compiled-planner) - run llm-debug:record',
    }),
    'abc123def456',
  );
  assert.equal(pendingRecordingShaOf({}), undefined);
  assert.equal(pendingRecordingShaOf({ unsupportedDetail: 'something unrelated' }), undefined);
});

test('UT-HGUARD-1811-013: a recording_missing row from a guarded run is scored not_answered and named in the result, never counted as an answer', async () => {
  const result = await runShadowBankGuarded(
    stubAuth(async () => ({
      status: 200,
      body: {
        plan: { nodes: [{ nodeType: 'profile' }] },
        intentUnsupported: true,
        unsupportedReason: 'recording_missing',
        unsupportedDetail: 'LLM recording missing deadbeef00 (compiled-planner) - run llm-debug:record',
      },
    })),
    'ws',
    'proj',
    'compiled',
    [],
    { env: { SHADOW_RUN_QUESTIONS: '3' }, transport: RECORDED },
  );
  assert.equal(result.status, 'complete');
  assert.deepEqual(
    result.rows.map((r) => [r.outcome, r.notAnsweredReason]),
    [['not_answered', 'recording_missing']],
  );
});

// ── AXI-1857 — the deleted axis cannot come back through the run entry ─────

test('UT-HGUARD-1857-001: SHADOW_RUN_TRANSPORT=recorded against a LIVE backend is refused before any call, and labels nothing free', async () => {
  let posts = 0;
  const result = await runShadowBankGuarded(
    stubAuth(PLANNED, () => {
      posts += 1;
    }),
    'ws',
    'proj',
    'compiled',
    [],
    { env: { SHADOW_RUN_QUESTIONS: '3', SHADOW_RUN_TRANSPORT: 'recorded' }, transport: LIVE },
  );
  assert.equal(result.status, 'refused');
  assert.equal(result.guard.reason, 'not_configured');
  assert.equal(posts, 0);
  assert.deepEqual(result.rows.map((r) => r.transport), [undefined]);
  assert.equal(result.provenance.label, 'none');
});

test('UT-HGUARD-1857-002: SHADOW_RUN_TRANSPORT=recorded alongside a registered go against a LIVE backend is a PAID run, labelled live, never claude-code', async () => {
  const result = await runShadowBankGuarded(stubAuth(PLANNED), 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3', SHADOW_RUN_TRANSPORT: 'recorded', GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID },
    registryText: REGISTRY_GO,
    transport: LIVE,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.guard.spendMode, 'registered_live');
  assert.deepEqual(result.rows.map((r) => r.transport), ['live']);
  assert.equal(result.provenance.label, 'live');
});

test('UT-HGUARD-1857-003: shadowRunProvenanceOf never labels an allowed decision live unless it states registered_live', () => {
  const unstated = shadowRunProvenanceOf({ allowed: true, reason: 'allowed' });
  assert.equal(unstated.label, 'none');
  assert.notEqual(unstated.budget.startsWith('0 USD'), true);
  assert.equal(shadowRunProvenanceOf({ allowed: true, reason: 'allowed', spendMode: 'registered_live', rowId: ROW_ID }).label, 'live');
  assert.equal(shadowRunProvenanceOf({ allowed: true, reason: 'allowed', spendMode: 'free_recorded' }).label, 'claude-code');
});
