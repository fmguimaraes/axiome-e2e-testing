import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SHADOW_RUN_ROW_KEYS,
  decideHarnessLiveSpend,
  notAnsweredReasonOf,
  outcomeOf,
  pendingRecordingShaOf,
  runShadowBankGuarded,
  transportLabelFor,
  type ShadowRunAuth,
} from '../../tests/AXI-1462/harness/shadow';
import type { Api } from '../../tests/AXI-1435/harness/api';

/**
 * AXI-1811 (epic AXI-1687 — R-LLM-1, FR113–FR115). Pure unit coverage for the
 * recorded-transport axis of the harness's ONE live-spend/transport decision
 * (`decideHarnessLiveSpend`): `SHADOW_RUN_TRANSPORT=recorded` allows a 0-USD
 * run with no spend-go, is refused as ambiguous alongside a spend-go, and
 * every other value is byte-for-byte unchanged from AXI-1689. Also covers the
 * `transport` label carried on every row an actual call was attempted under,
 * and the loud `recording_missing` miss (never scored as an answer). No live
 * backend; nothing here can spend. Run via `npm run harness:unit`.
 */

const ROW_ID = 'RUN-2026-09-26-01';
const REGISTRY_GO = `# run registry\n| ${ROW_ID} | compiled | 3,7,12 | GO: felipe 2026-09-26 |\n`;

// ── decideHarnessLiveSpend — the recorded axis (FR113/FR114/FR115) ─────────

test('UT-HGUARD-1811-001: SHADOW_RUN_TRANSPORT=recorded is allowed with NO spend-go and no registry', () => {
  const decision = decideHarnessLiveSpend({ SHADOW_RUN_TRANSPORT: 'recorded' }, undefined);
  assert.deepEqual(decision, { allowed: true, reason: 'recorded' });
});

test('UT-HGUARD-1811-002: SHADOW_RUN_TRANSPORT=recorded is case/whitespace tolerant', () => {
  for (const raw of [' Recorded ', 'RECORDED', 'recorded']) {
    assert.equal(
      decideHarnessLiveSpend({ SHADOW_RUN_TRANSPORT: raw }, undefined).allowed,
      true,
      raw,
    );
  }
});

test('UT-HGUARD-1811-003: SHADOW_RUN_TRANSPORT=recorded together with a spend-go is refused ambiguous_transport', () => {
  const decision = decideHarnessLiveSpend(
    { SHADOW_RUN_TRANSPORT: 'recorded', GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID },
    REGISTRY_GO,
  );
  assert.deepEqual(decision, { allowed: false, reason: 'ambiguous_transport' });
});

test('UT-HGUARD-1811-004: an unset or a non-"recorded" SHADOW_RUN_TRANSPORT leaves the live-spend decision byte-for-byte unchanged', () => {
  for (const raw of [undefined, '', 'live', 'bogus', '  ']) {
    assert.deepEqual(
      decideHarnessLiveSpend({ SHADOW_RUN_TRANSPORT: raw }, REGISTRY_GO),
      { allowed: false, reason: 'not_configured' },
      String(raw),
    );
  }
  assert.deepEqual(
    decideHarnessLiveSpend(
      { SHADOW_RUN_TRANSPORT: 'bogus', GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID },
      REGISTRY_GO,
    ),
    { allowed: true, reason: 'allowed', rowId: ROW_ID },
  );
});

test('UT-HGUARD-1811-005: E2E_LIVE_LLM is still NOT a go on the recorded axis either (NFR1, one knob)', () => {
  assert.equal(decideHarnessLiveSpend({ E2E_LIVE_LLM: '1' }, undefined).allowed, false);
  assert.equal(
    decideHarnessLiveSpend({ E2E_LIVE_LLM: '1', SHADOW_RUN_TRANSPORT: 'live' }, undefined).allowed,
    false,
  );
});

// ── transportLabelFor — the single mapping (design point 1) ────────────────

test('UT-HGUARD-1811-006: transportLabelFor maps allowed→live, recorded→claude-code, any refusal→undefined', () => {
  assert.equal(transportLabelFor({ reason: 'allowed' }), 'live');
  assert.equal(transportLabelFor({ reason: 'recorded' }), 'claude-code');
  assert.equal(transportLabelFor({ reason: 'not_configured' }), undefined);
  assert.equal(transportLabelFor({ reason: 'ambiguous_transport' }), undefined);
});

// ── runShadowBankGuarded — the label reaches the rows ───────────────────────

function stubAuth(post: Api['post']): ShadowRunAuth {
  const api = {
    get: async () => ({ status: 200, body: {} }),
    post,
    patch: async () => ({ status: 200, body: {} }),
    ctx: undefined as unknown as Api['ctx'],
  } as Api;
  return { api: () => api, refresh: async () => api };
}

test('UT-HGUARD-1811-007: a recorded-transport run labels every answered row claude-code, never live', async () => {
  const result = await runShadowBankGuarded(
    stubAuth(async () => ({
      status: 200,
      body: { plan: { nodes: [{ nodeType: 'describe' }], datasetsUsed: [{}] } },
    })),
    'ws',
    'proj',
    'compiled',
    [],
    { env: { SHADOW_RUN_QUESTIONS: '3', SHADOW_RUN_TRANSPORT: 'recorded' } },
  );
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.rows.map((r) => r.transport), ['claude-code']);
});

test('UT-HGUARD-1811-008: a live-go run labels every answered row live', async () => {
  const result = await runShadowBankGuarded(
    stubAuth(async () => ({
      status: 200,
      body: { plan: { nodes: [{ nodeType: 'describe' }], datasetsUsed: [{}] } },
    })),
    'ws',
    'proj',
    'compiled',
    [],
    { env: { SHADOW_RUN_QUESTIONS: '3', GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, registryText: REGISTRY_GO },
  );
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
    { env: { SHADOW_RUN_QUESTIONS: '3' } },
  );
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.rows.map((r) => r.transport), [undefined]);
});

test('UT-HGUARD-1811-010: every row key stays within the closed SHADOW_RUN_ROW_KEYS set (transport included)', async () => {
  const result = await runShadowBankGuarded(
    stubAuth(async () => ({
      status: 200,
      body: { plan: { nodes: [{ nodeType: 'describe' }], datasetsUsed: [{}] } },
    })),
    'ws',
    'proj',
    'compiled',
    [],
    { env: { SHADOW_RUN_QUESTIONS: '3', SHADOW_RUN_TRANSPORT: 'recorded' } },
  );
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
    { env: { SHADOW_RUN_QUESTIONS: '3', SHADOW_RUN_TRANSPORT: 'recorded' } },
  );
  assert.equal(result.status, 'complete');
  assert.deepEqual(
    result.rows.map((r) => [r.outcome, r.notAnsweredReason]),
    [['not_answered', 'recording_missing']],
  );
});
