import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SHADOW_RUN_ROW_KEYS,
  decideHarnessLiveSpend,
  notAnsweredReasonOf,
  outcomeOf,
  runShadowBankGuarded,
  selectQuestions,
  writeShadowRunSummary,
  type ShadowRunAuth,
} from '../../tests/AXI-1462/harness/shadow';
import type { Api } from '../../tests/AXI-1435/harness/api';
import { loadGradosBank } from '../../tests/AXI-1462/harness/governed';

/**
 * AXI-1689 (epic AXI-1687 — FR50, FR51, FR53, FR55, NFR1, EC23–EC25, AC50,
 * AC53, AC55). Pure unit coverage for the harness half of the live-spend guard,
 * the bank subset, the FR51 `not_answered: deadline` outcome, the FR50 abort on
 * a provider 400 and the structural pin of the row shape against the
 * `axiome-back` contract. No live backend; nothing here can spend.
 *
 * Lives outside `tests/` because it is a `node:test` file, not a Playwright
 * spec (see `harness-unit/UT.md`). Run via `npm run harness:unit`.
 */

// The back contract's `SHADOW_RUN_ROW_KEYS`
// (`libs/contracts/src/guided-analysis/shadow-run-row.contract.ts`), copied by
// hand ON PURPOSE: this repo cannot import that package, and a drift on either
// side must fail here (FR55/AC55). Update BOTH sides in one change.
const BACK_CONTRACT_ROW_KEYS = [
  'questionId',
  'provider',
  'outcome',
  'attempts',
  'ruleIdsPerAttempt',
  'shape',
  'latencyMs',
  'usage',
  'correlationId',
  'notAnsweredReason',
];

const ROW_ID = 'RUN-2026-09-26-01';
const REGISTRY_GO = `# run registry\n| ${ROW_ID} | compiled | 3,7,12 | GO: felipe 2026-09-26 |\n`;
const REGISTRY_NO_GO = `# run registry\n| ${ROW_ID} | compiled | 3,7,12 | proposed |\n`;

// ── selectQuestions (FR50) ──────────────────────────────────────────────────

test('UT-SUBSET-1689-1: an unset or blank SHADOW_RUN_QUESTIONS selects the whole bank, in bank order', () => {
  const bank = loadGradosBank();
  assert.equal(bank.length, 46);
  assert.deepEqual(selectQuestions(bank, undefined).map((q) => q.id), bank.map((q) => q.id));
  assert.deepEqual(selectQuestions(bank, '  ').map((q) => q.id), bank.map((q) => q.id));
});

test('UT-SUBSET-1689-2: a comma-separated subset is returned in BANK order, deduplicated, whitespace-tolerant', () => {
  const bank = loadGradosBank();
  assert.deepEqual(selectQuestions(bank, '12, 3,7,,3 ').map((q) => q.id), [3, 7, 12]);
});

test('UT-SUBSET-1689-3: an id the bank does not carry THROWS naming it — never a silent whole-bank run', () => {
  const bank = loadGradosBank();
  assert.throws(() => selectQuestions(bank, '3,99'), /not in the bank: 99/);
  assert.throws(() => selectQuestions(bank, 'Q3'), /'Q3' is not a bank question id/);
});

// ── decideHarnessLiveSpend (FR53, EC23–EC25, NFR1) ──────────────────────────

test('UT-HGUARD-1689-1: unset ⇒ refused `not_configured` — the default spends nothing (EC23)', () => {
  assert.deepEqual(decideHarnessLiveSpend({}, REGISTRY_GO), { allowed: false, reason: 'not_configured' });
  assert.deepEqual(decideHarnessLiveSpend({ GUIDED_ANALYSIS_LIVE_SPEND_GO: '' }, REGISTRY_GO), {
    allowed: false,
    reason: 'not_configured',
  });
});

test('UT-HGUARD-1689-2: a value that is not a registry row id is refused `invalid_row_id` (EC25)', () => {
  for (const bad of ['1', 'true', 'yes', 'RUN-2026-09-26', 'RUN-2026-09-26-1', 'run-2026-09-26-01']) {
    assert.deepEqual(
      decideHarnessLiveSpend({ GUIDED_ANALYSIS_LIVE_SPEND_GO: bad }, REGISTRY_GO),
      { allowed: false, reason: 'invalid_row_id' },
      bad,
    );
  }
});

test('UT-HGUARD-1689-3: a valid row id with no readable registry is refused `no_registry` — unreadable is never a pass', () => {
  assert.deepEqual(decideHarnessLiveSpend({ GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, undefined), {
    allowed: false,
    reason: 'no_registry',
    rowId: ROW_ID,
  });
});

test('UT-HGUARD-1689-4: a row the registry does not carry is refused `row_not_registered`', () => {
  assert.deepEqual(
    decideHarnessLiveSpend({ GUIDED_ANALYSIS_LIVE_SPEND_GO: 'RUN-2026-09-27-02' }, REGISTRY_GO),
    { allowed: false, reason: 'row_not_registered', rowId: 'RUN-2026-09-27-02' },
  );
});

test('UT-HGUARD-1689-5: a registered row with no written go is refused `row_not_go`', () => {
  assert.deepEqual(decideHarnessLiveSpend({ GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, REGISTRY_NO_GO), {
    allowed: false,
    reason: 'row_not_go',
    rowId: ROW_ID,
  });
});

test('UT-HGUARD-1689-6: a registered row with a written go is allowed and the row id is echoed', () => {
  assert.deepEqual(decideHarnessLiveSpend({ GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, REGISTRY_GO), {
    allowed: true,
    reason: 'allowed',
    rowId: ROW_ID,
  });
});

test('UT-HGUARD-1689-7: E2E_LIVE_LLM is NOT a go — the older opt-in never unlocks a paid bank (NFR1, one knob)', () => {
  assert.equal(decideHarnessLiveSpend({ E2E_LIVE_LLM: '1' }, REGISTRY_GO).allowed, false);
  assert.equal(decideHarnessLiveSpend({ E2E_LIVE_LLM: '1', CI: 'true' }, REGISTRY_GO).allowed, false);
});

// ── outcomeOf / notAnsweredReasonOf (FR51) ──────────────────────────────────

test('UT-OUTCOME-1689-1: a deadline is `not_answered: deadline`, never an honest `unsupported` and never a plan', () => {
  const body = { plan: { nodes: [{ nodeType: 'profile' }] }, intentUnsupported: true, unsupportedReason: 'deadline' };
  assert.equal(outcomeOf(body, 200), 'not_answered');
  assert.equal(notAnsweredReasonOf(body, 200), 'deadline');
});

test('UT-OUTCOME-1689-2: every other unsupported reason stays `unsupported`, and an answered row carries NO reason key', () => {
  const none = { plan: { nodes: [{ nodeType: 'profile' }] }, intentUnsupported: true, unsupportedReason: 'no_shape' };
  assert.equal(outcomeOf(none, 200), 'unsupported');
  assert.equal(notAnsweredReasonOf(none, 200), undefined);
  const planned = { plan: { nodes: [{ nodeType: 'compare_groups' }], datasetsUsed: [{}] } };
  assert.equal(outcomeOf(planned, 200), 'planned');
  assert.equal(notAnsweredReasonOf(planned, 200), undefined);
});

// ── row shape pin (FR55/AC55) ───────────────────────────────────────────────

test('UT-ROWKEYS-1689-1: the harness row key set is byte-identical to the axiome-back contract (structural pin)', () => {
  assert.deepEqual([...SHADOW_RUN_ROW_KEYS].sort(), [...BACK_CONTRACT_ROW_KEYS].sort());
});

// ── runShadowBankGuarded (FR50/FR53) ────────────────────────────────────────

function stubAuth(post: Api['post']): ShadowRunAuth {
  const api = {
    get: async () => ({ status: 200, body: {} }),
    post,
    patch: async () => ({ status: 200, body: {} }),
    ctx: undefined as unknown as Api['ctx'],
  } as Api;
  return { api: () => api, refresh: async () => api };
}

test('UT-ABORT-1689-1: an unconfigured guard refuses BEFORE any call — one `not_answered: guard` row per selected question, zero requests', async () => {
  let calls = 0;
  const auth = stubAuth(async () => {
    calls += 1;
    return { status: 200, body: { plan: { nodes: [] } } };
  });
  const result = await runShadowBankGuarded(auth, 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3,7,12' },
    registryText: REGISTRY_GO,
  });
  assert.equal(calls, 0);
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.guard, { allowed: false, reason: 'not_configured' });
  assert.deepEqual(result.questionIds, [3, 7, 12]);
  assert.deepEqual(
    result.rows.map((r) => [r.questionId, r.outcome, r.notAnsweredReason, r.attempts]),
    [
      [3, 'not_answered', 'guard', 0],
      [7, 'not_answered', 'guard', 0],
      [12, 'not_answered', 'guard', 0],
    ],
  );
  for (const row of result.rows) {
    assert.ok(Object.keys(row).every((k) => (SHADOW_RUN_ROW_KEYS as readonly string[]).includes(k)));
  }
});

test('UT-ABORT-1689-2: with a go, the first HTTP 400 aborts the run — the 400 question and every later one are `not_answered: aborted`, status INVALID', async () => {
  const asked: number[] = [];
  const auth = stubAuth(async (_path, body) => {
    const question = (body as { envelope: { question: string } }).envelope.question;
    const id = loadGradosBank().find((q) => q.question === question)!.id;
    asked.push(id);
    if (id === 7) return { status: 400, body: { message: 'schema rejected' } };
    return { status: 200, body: { plan: { nodes: [{ nodeType: 'describe' }], datasetsUsed: [{}] }, correlationId: `c-${id}` } };
  });
  const result = await runShadowBankGuarded(auth, 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3,7,12', GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID },
    registryText: REGISTRY_GO,
    reauthEveryQuestions: 0,
  });
  assert.deepEqual(asked, [3, 7]);
  assert.equal(result.status, 'INVALID');
  assert.equal(result.abortedAtQuestionId, 7);
  assert.deepEqual(
    result.rows.map((r) => [r.questionId, r.outcome, r.notAnsweredReason ?? null]),
    [
      [3, 'planned', null],
      [7, 'not_answered', 'aborted'],
      [12, 'not_answered', 'aborted'],
    ],
  );
  assert.equal(result.rows[0].correlationId, 'c-3');
});

test('UT-ABORT-1689-3: with a go and no 400 the subset completes and the rows are the ordinary ones', async () => {
  const auth = stubAuth(async () => ({
    status: 200,
    body: { plan: { nodes: [{ nodeType: 'profile' }] }, intentUnsupported: true, unsupportedReason: 'deadline' },
  }));
  const result = await runShadowBankGuarded(auth, 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3', GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID },
    registryText: REGISTRY_GO,
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(
    result.rows.map((r) => [r.questionId, r.outcome, r.notAnsweredReason]),
    [[3, 'not_answered', 'deadline']],
  );
});

// ── sidecar ─────────────────────────────────────────────────────────────────

test('UT-SIDECAR-1689-1: the run summary sidecar records status, guard decision, subset and abort point beside the rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'axi-1689-'));
  try {
    const path = writeShadowRunSummary(
      'compiled',
      {
        status: 'INVALID',
        guard: { allowed: true, reason: 'allowed', rowId: ROW_ID },
        questionIds: [3, 7, 12],
        abortedAtQuestionId: 7,
      },
      dir,
    );
    assert.equal(path, join(dir, 'compiled.run.json'));
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.provider, 'compiled');
    assert.equal(written.status, 'INVALID');
    assert.equal(written.abortedAtQuestionId, 7);
    assert.deepEqual(written.questionIds, [3, 7, 12]);
    assert.equal(written.guard.rowId, ROW_ID);
    assert.ok(!Number.isNaN(Date.parse(written.writtenAt)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
