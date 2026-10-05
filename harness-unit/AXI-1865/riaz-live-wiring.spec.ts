import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideBudgetCap, runShadowBankGuarded, type ShadowRunAuth } from '../../tests/AXI-1462/harness/shadow';
import { loadRiazBank } from '../../tests/AXI-1865/harness/riazBank';

/**
 * AXI-1865 — zero-spend coverage for the Riaz 10-question live wiring. No
 * network: every case either never reaches a call (budget / guard refusal) or
 * only inspects a fixture.
 */

test('the Riaz bank is exactly the 10 catalog questions Q2..Q11', () => {
  const bank = loadRiazBank();
  assert.equal(bank.length, 10);
  assert.deepEqual(
    bank.map((q) => q.id),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  for (const q of bank) assert.ok(q.question.endsWith('?'), `Q${q.id} must be a question`);
});

test('budget cap: no cap set means no cap', () => {
  assert.equal(decideBudgetCap({}, 10).allowed, true);
});

test('budget cap: 10 x 0.103 USD fits exactly within 1.03 USD', () => {
  const d = decideBudgetCap(
    { SHADOW_RUN_BUDGET_USD: '1.03', SHADOW_RUN_MAX_USD_PER_QUESTION: '0.103' },
    10,
  );
  assert.equal(d.allowed, true);
  assert.equal(d.reason, 'within_cap');
});

test('budget cap: 11 questions at 0.103 USD abort over 1.03 USD', () => {
  const d = decideBudgetCap(
    { SHADOW_RUN_BUDGET_USD: '1.03', SHADOW_RUN_MAX_USD_PER_QUESTION: '0.103' },
    11,
  );
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'over_cap');
});

test('budget cap: a cap without a per-question ceiling fails closed', () => {
  const d = decideBudgetCap({ SHADOW_RUN_BUDGET_USD: '1.03' }, 10);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'missing_per_question');
});

test('budget cap: a non-numeric or non-positive cap fails closed', () => {
  assert.equal(decideBudgetCap({ SHADOW_RUN_BUDGET_USD: 'abc' }, 1).allowed, false);
  assert.equal(decideBudgetCap({ SHADOW_RUN_BUDGET_USD: '0' }, 1).allowed, false);
});

test('guarded run: an over-cap live selection is refused before any call', async () => {
  // Live transport + a registered GO row would otherwise allow the spend; the
  // cap must still refuse it. `auth` is a throwing stub: any network call fails the test.
  const noCall = {
    api: () => {
      throw new Error('network call attempted');
    },
    refresh: async () => {
      throw new Error('network call attempted');
    },
  } as unknown as ShadowRunAuth;
  const rowId = 'RUN-2026-10-05-01';
  const result = await runShadowBankGuarded(noCall, 'ws', 'proj', 'compiled', [], {
    env: {
      SHADOW_RUN_BANK: 'riaz',
      GUIDED_ANALYSIS_LIVE_SPEND_GO: rowId,
      SHADOW_RUN_BUDGET_USD: '1.03',
      SHADOW_RUN_MAX_USD_PER_QUESTION: '0.2',
    },
    registryText: `| ${rowId} | GO: owner |`,
    transport: { mode: 'live', source: 'backend' },
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.rows.length, 10);
  assert.ok(result.rows.every((r) => r.outcome === 'not_answered'));
});

test('guarded run: an unknown bank name throws before any call', async () => {
  const noCall = {} as ShadowRunAuth;
  await assert.rejects(
    runShadowBankGuarded(noCall, 'ws', 'proj', 'compiled', [], {
      env: { SHADOW_RUN_BANK: 'nope' },
      transport: { mode: 'recorded', source: 'backend' },
    }),
    /not a known bank/,
  );
});
