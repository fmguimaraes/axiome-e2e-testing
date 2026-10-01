import test from 'node:test';
import assert from 'node:assert/strict';
import {
  providerAnswered,
  responseFactsOf,
  runShadowBankGuarded,
  shadowRunEvidenceVerdict,
  tallyShadowRunOutcomes,
  type HarnessTransportStatement,
  type PlanApiBody,
  type ShadowRunAuth,
  type ShadowRunResponseFacts,
  type ShadowRunRow,
} from '../../tests/AXI-1462/harness/shadow';
import type { Api } from '../../tests/AXI-1435/harness/api';
import { loadGradosBank } from '../../tests/AXI-1462/harness/governed';

/**
 * AXI-1830 (epic AXI-1825) — the shadow-run spec passed green when every row
 * was a fallback. `SI-042`, tag `SHADOW`. Run via `npm run harness:unit`.
 *
 * The AXI-1614 spec's pass/fail is now `shadowRunEvidenceVerdict`. These tests
 * drive it the way the spec does — through `runShadowBankGuarded` against a
 * stubbed backend — for the FR113 2026-09-28 reproduction (9/9
 * `provider_not_configured` in ~70 ms) and every sibling run that measured
 * nothing about the provider under test, and pin the runs that MUST stay green.
 * No live backend; nothing here can spend.
 */

const RECORDED: HarnessTransportStatement = { mode: 'recorded', source: 'backend' };
const FR113_SUBSET = '3,4,5,6,8,13,21,31,39';
const FR113_IDS = [3, 4, 5, 6, 8, 13, 21, 31, 39];
const BANK = loadGradosBank();

const ANSWERED_PLAN = { nodes: [{ nodeType: 'describe' }], datasetsUsed: [{}] };

const planned = (planner: string): PlanApiBody => ({ planner, plannerFallback: false, plan: ANSWERED_PLAN });
const fellBack = (fallbackReason?: string): PlanApiBody => ({
  planner: 'fallback',
  plannerFallback: true,
  ...(fallbackReason ? { fallbackReason } : {}),
  plan: ANSWERED_PLAN,
});
const RECORDING_MISSING: PlanApiBody = {
  planner: 'compiled',
  plannerFallback: false,
  intentUnsupported: true,
  unsupportedReason: 'recording_missing',
  unsupportedDetail: 'LLM recording missing abcdef12 (planner) - run llm-debug:record',
  plan: { nodes: [] },
};

type Reply = { status: number; body: PlanApiBody };

/** A backend that answers each bank question id with `reply(id)`. */
function backend(reply: (questionId: number) => Reply): ShadowRunAuth {
  const api = {
    get: async () => ({ status: 200, body: {} }),
    post: async (_path: string, payload: unknown) => {
      const question = (payload as { envelope: { question: string } }).envelope.question;
      return reply(BANK.find((q) => q.question === question)!.id);
    },
    patch: async () => ({ status: 200, body: {} }),
    ctx: undefined as unknown as Api['ctx'],
  } as unknown as Api;
  return { api: () => api, refresh: async () => api };
}

const always = (body: PlanApiBody) => backend(() => ({ status: 200, body }));

async function run(auth: ShadowRunAuth, questions = FR113_SUBSET, env: Record<string, string> = {}) {
  return runShadowBankGuarded(auth, 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: questions, ...env },
    transport: RECORDED,
  });
}

const row = (outcome: ShadowRunRow['outcome'], extra: Partial<ShadowRunRow> = {}): ShadowRunRow => ({
  questionId: 3,
  provider: 'compiled',
  outcome,
  attempts: 1,
  ruleIdsPerAttempt: [],
  shape: 'unknown',
  latencyMs: 1,
  usage: null,
  ...extra,
});

const facts = (f: Partial<ShadowRunResponseFacts> = {}): ShadowRunResponseFacts => ({ plannerFallback: false, ...f });

// ── The FR113 reproduction ──────────────────────────────────────────────────

test('UT-SHADOW-1830-001: the FR113 first pass (9/9 fallback, provider_not_configured) FAILS — it passed the old one-row-per-question check', async () => {
  // Arrange: the 2026-09-28 run — every question served by the deterministic arm.
  const result = await run(always(fellBack('provider_not_configured')));

  // Act
  const verdict = shadowRunEvidenceVerdict(result, 'compiled');

  // Assert: the old assertion still holds (this is exactly why it went green)...
  assert.equal(result.status, 'complete');
  assert.equal(result.rows.length, result.questionIds.length);
  // ...and the new verdict refuses it, naming the cause and the full tally.
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok);
  assert.equal(verdict.failure, 'provider_not_configured');
  assert.equal(verdict.answered, 0);
  assert.equal(verdict.total, 9);
  assert.match(verdict.message, /answered 0 of 9 selected question\(s\); outcomes: fallback:provider_not_configured×9\.$/);
});

test('UT-SHADOW-1830-002: ONE provider_not_configured fallback fails the run even when the provider answered the rest', async () => {
  const result = await run(
    backend((id) => ({ status: 200, body: id === 21 ? fellBack('provider_not_configured') : planned('compiled') })),
  );

  const verdict = shadowRunEvidenceVerdict(result, 'compiled');

  assert.ok(!verdict.ok);
  assert.equal(verdict.failure, 'provider_not_configured');
  assert.equal(verdict.answered, 8);
});

// ── Sibling runs that measured nothing ──────────────────────────────────────

test('UT-SHADOW-1830-003: a guard-refused run (every row not_answered: guard) fails as guard_refused', async () => {
  let calls = 0;
  const auth = backend(() => {
    calls += 1;
    return { status: 200, body: planned('compiled') };
  });
  const result = await runShadowBankGuarded(auth, 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3,4' },
    registryText: undefined,
    transport: { mode: 'live', source: 'backend' },
  });

  const verdict = shadowRunEvidenceVerdict(result, 'compiled');

  assert.equal(calls, 0);
  assert.deepEqual(result.responseFacts, {});
  assert.ok(!verdict.ok);
  assert.equal(verdict.failure, 'guard_refused');
  assert.match(verdict.message, /\(not_configured\)/);
  assert.match(verdict.message, /outcomes: not_answered:guard×2\.$/);
});

test('UT-SHADOW-1830-004: a run aborted on a 400 is INVALID and fails as run_invalid even after answered questions', async () => {
  const result = await run(
    backend((id) => (id === 4 ? { status: 400, body: {} } : { status: 200, body: planned('compiled') })),
    '3,4,5',
  );

  const verdict = shadowRunEvidenceVerdict(result, 'compiled');

  assert.equal(result.status, 'INVALID');
  assert.ok(!verdict.ok);
  assert.equal(verdict.failure, 'run_invalid');
  assert.equal(verdict.answered, 1);
  assert.match(verdict.message, /at question 4 \(FR50\)/);
  assert.deepEqual(Object.keys(result.responseFacts), ['3']);
});

test('UT-SHADOW-1830-005: a recorded run whose every question is recording_missing fails as no_provider_answer', async () => {
  const result = await run(always(RECORDING_MISSING), '3,4,5');

  const verdict = shadowRunEvidenceVerdict(result, 'compiled');

  assert.ok(!verdict.ok);
  assert.equal(verdict.failure, 'no_provider_answer');
  assert.match(verdict.message, /llm-debug:record/);
  assert.match(verdict.message, /outcomes: not_answered:recording_missing×3\.$/);
});

test('UT-SHADOW-1830-006: a run of nothing but HTTP 5xx and provider_unavailable fallbacks fails as no_provider_answer', async () => {
  const result = await run(
    backend((id) => (id === 3 ? { status: 503, body: {} } : { status: 200, body: fellBack('provider_unavailable') })),
    '3,4,5',
  );

  const verdict = shadowRunEvidenceVerdict(result, 'compiled');

  assert.ok(!verdict.ok);
  assert.equal(verdict.failure, 'no_provider_answer');
  assert.match(verdict.message, /outcomes: unavailable×1, fallback:provider_unavailable×2\.$/);
});

test('UT-SHADOW-1830-007: a backend configured with the deterministic arm (planner fallback, plannerFallback false) fails as arm_mismatch', async () => {
  // Every row reads `planned` — the exact shape the old check could not see.
  const result = await run(always(planned('fallback')), '3,4');

  const verdict = shadowRunEvidenceVerdict(result, 'compiled');

  assert.deepEqual(result.rows.map((r) => r.outcome), ['planned', 'planned']);
  assert.ok(!verdict.ok);
  assert.equal(verdict.failure, 'arm_mismatch');
  assert.match(verdict.message, /planned with 'fallback', not 'compiled'/);
});

test('UT-SHADOW-1830-008: a run labelled compiled against a backend serving anthropic fails as arm_mismatch', async () => {
  const result = await run(always(planned('anthropic')), '3,4');

  const verdict = shadowRunEvidenceVerdict(result, 'compiled');

  assert.ok(!verdict.ok);
  assert.equal(verdict.failure, 'arm_mismatch');
  assert.equal(verdict.answered, 0);
});

// ── Runs that MUST stay green ───────────────────────────────────────────────

test('UT-SHADOW-1830-009: a run the provider answered in full is ok', async () => {
  const result = await run(always(planned('compiled')));

  assert.deepEqual(shadowRunEvidenceVerdict(result, 'compiled'), { ok: true, answered: 9, total: 9 });
});

test('UT-SHADOW-1830-010: ONE provider answer among recording misses and provider_unavailable fallbacks is ok — scoring is the gate\'s job', async () => {
  const result = await run(
    backend((id) => {
      if (id === 3) return { status: 200, body: planned('compiled') };
      return { status: 200, body: id === 4 ? fellBack('provider_unavailable') : RECORDING_MISSING };
    }),
    '3,4,5',
  );

  assert.deepEqual(shadowRunEvidenceVerdict(result, 'compiled'), { ok: true, answered: 1, total: 3 });
});

test('UT-SHADOW-1830-011: an all-attempts_exhausted run is ok — the provider answered and was rejected every time', async () => {
  const result = await run(always(fellBack('attempts_exhausted')), '3,4');

  assert.deepEqual(shadowRunEvidenceVerdict(result, 'compiled'), { ok: true, answered: 2, total: 2 });
});

// ── providerAnswered / responseFactsOf / tally — the pure pieces ───────────

test('UT-SHADOW-1830-012: providerAnswered counts a fallback only for attempts_exhausted, never another or an absent reason', () => {
  const fb = row('fallback');
  assert.equal(providerAnswered(fb, facts({ plannerFallback: true, fallbackReason: 'attempts_exhausted' }), 'compiled'), true);
  for (const reason of ['provider_not_configured', 'provider_unavailable', 'provider_request_invalid', undefined]) {
    assert.equal(providerAnswered(fb, facts({ plannerFallback: true, fallbackReason: reason }), 'compiled'), false, String(reason));
  }
});

test('UT-SHADOW-1830-013: a fallback that refused its declared scope reads `unsupported` but is NOT a provider answer', () => {
  // AXI-1730: `outcomeOf` ranks intentUnsupported above plannerFallback.
  const unsupported = row('unsupported');
  const fromFallback = facts({ planner: 'fallback', plannerFallback: true, fallbackReason: 'provider_not_configured' });

  assert.equal(providerAnswered(unsupported, fromFallback, 'compiled'), false);
  assert.equal(providerAnswered(unsupported, facts({ planner: 'compiled' }), 'compiled'), true);
});

test('UT-SHADOW-1830-014: unavailable / not_answered rows and rows with no response facts are never a provider answer', () => {
  const ok = facts({ planner: 'compiled' });
  assert.equal(providerAnswered(row('unavailable'), ok, 'compiled'), false);
  assert.equal(providerAnswered(row('not_answered', { notAnsweredReason: 'deadline' }), ok, 'compiled'), false);
  assert.equal(providerAnswered(row('planned'), undefined, 'compiled'), false);
  // An absent `planner` is not evidence AGAINST the arm.
  assert.equal(providerAnswered(row('planned'), facts(), 'compiled'), true);
});

test('UT-SHADOW-1830-015: responseFactsOf reads planner/plannerFallback/fallbackReason and drops non-string values', () => {
  assert.deepEqual(responseFactsOf(fellBack('provider_not_configured')), {
    planner: 'fallback',
    plannerFallback: true,
    fallbackReason: 'provider_not_configured',
  });
  assert.deepEqual(responseFactsOf({ planner: 7, fallbackReason: null } as unknown as PlanApiBody), {
    plannerFallback: false,
  });
});

test('UT-SHADOW-1830-016: tallyShadowRunOutcomes qualifies each outcome and counts in first-seen order', () => {
  const rows = [
    row('fallback', { questionId: 1 }),
    row('planned', { questionId: 2 }),
    row('fallback', { questionId: 3 }),
    row('not_answered', { questionId: 4, notAnsweredReason: 'recording_missing' }),
    row('fallback', { questionId: 5 }),
  ];
  const table = {
    1: facts({ plannerFallback: true, fallbackReason: 'provider_unavailable' }),
    2: facts({ planner: 'compiled' }),
    3: facts({ plannerFallback: true, fallbackReason: 'provider_unavailable' }),
    5: facts({ plannerFallback: true }),
  };

  assert.equal(
    tallyShadowRunOutcomes(rows, table),
    'fallback:provider_unavailable×2, planned:compiled×1, not_answered:recording_missing×1, fallback:no reason×1',
  );
  assert.equal(tallyShadowRunOutcomes([], {}), 'no rows');
});

test('UT-SHADOW-1830-017: precedence — guard beats INVALID beats provider_not_configured beats arm_mismatch beats no answer', () => {
  const base = { rows: [row('fallback')], guard: { allowed: true, reason: 'allowed' as const } };
  const notConfigured = { 3: facts({ planner: 'fallback', plannerFallback: true, fallbackReason: 'provider_not_configured' }) };
  const both = { ...notConfigured, 4: facts({ planner: 'anthropic' }) };
  const failureOf = (r: Parameters<typeof shadowRunEvidenceVerdict>[0]) => {
    const v = shadowRunEvidenceVerdict(r, 'compiled');
    return v.ok ? 'ok' : v.failure;
  };

  assert.equal(failureOf({ ...base, status: 'refused', responseFacts: both }), 'guard_refused');
  assert.equal(failureOf({ ...base, status: 'INVALID', responseFacts: both, abortedAtQuestionId: 4 }), 'run_invalid');
  assert.equal(failureOf({ ...base, status: 'complete', responseFacts: both }), 'provider_not_configured');
  assert.equal(failureOf({ ...base, status: 'complete', responseFacts: { 4: facts({ planner: 'anthropic' }) } }), 'arm_mismatch');
  assert.equal(failureOf({ ...base, status: 'complete', responseFacts: {} }), 'no_provider_answer');
});

test('UT-SHADOW-1830-018: the provider label is matched case-insensitively, as shouldRunArm reads it', async () => {
  const result = await run(always(planned('compiled')), '3');

  assert.deepEqual(shadowRunEvidenceVerdict(result, ' Compiled '), { ok: true, answered: 1, total: 1 });
});
