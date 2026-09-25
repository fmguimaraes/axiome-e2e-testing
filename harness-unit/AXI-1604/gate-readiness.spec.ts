import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api } from '../../tests/AXI-1435/harness/api';
import {
  isRefusalPlan,
  outcomeOf,
  runShadowBank,
  ShadowRunAuthError,
  shouldRunArm,
  type PlanApiBody,
  type ShadowRunAuth,
} from '../../tests/AXI-1462/harness/shadow';

/**
 * UT-SHADOW-1677-1..15 (epic AXI-1604 — FR28/FR30, SI-042). The three offline
 * halves of AXI-1677: the refusal classifier, the arm selector, and the run
 * loop's 401 policy.
 *
 * THE DEFECT THE FIRST GROUP PINS. `outcomeOf()` scored ANY response carrying a
 * `body.plan` as `planned` unless `intentUnsupported`/`plannerFallback` was set.
 * A legacy-arm response of ONE `profile` node, every inferential analysis in
 * `declined[]` and `datasetsUsed: []` satisfied that. On the 2026-09-25 run that
 * made six questions read `planned` on the legacy arm and `unsupported` on the
 * compiled arm when both arms had given the SAME answer — "this envelope has no
 * schema; nothing can be planned" — and the FR30 report calls it the single most
 * misleading thing in the table
 * (`axiome-docs/reports/2026-09-25-compiled-planner-shadow-run.md`).
 *
 * The fixtures below are NOT invented. They are the plan shapes that actually
 * occurred, transcribed from the committed artifact
 * `axiome-docs/reports/artifacts/2026-09-25-compiled-planner-shadow-run/db-plan-rows.md`
 * (§3 carries PL-ac2885c4 in full; the seven-row table carries the node types,
 * `declined` and `datasetsUsed` counts for all of them). Reproducing them live
 * would mean re-creating the empty-schema envelope AXI-1661 removed.
 *
 * THE DEFECT THE THIRD GROUP PINS. The same run's access token expired at Q8 of
 * the legacy arm and 39 of its 46 rows were 4-13 ms `401 Invalid token`
 * responses written as the outcome `unavailable` — a harness artefact sitting in
 * the gate evidence, indistinguishable in the table from a planner that failed
 * to answer. A 401 is now either recovered from or fatal, never a row.
 *
 * `node:test`, stubbed `Api`, no backend. Run via `npm run harness:unit`.
 * See `UT.md` in `harness-unit/`.
 */

// ── The 2026-09-25 legacy-arm refusals, as recorded ──────────────────────────

/**
 * PL-ac2885c4 (Q1) — the full persisted plan, abridged to the fields the
 * classifier reads. One `profile` node, both comparisons declined, no dataset
 * used. The legacy arm explicitly REFUSED to fabricate columns; the harness
 * called it `planned`.
 */
const PL_AC2885C4: PlanApiBody = {
  correlationId: 'fefdcb1a-d6dd-44e2-a74c-eb99612fa5c6',
  plan: {
    attemptCount: 3,
    nodes: [{ nodeType: 'profile', params: {} }],
    declined: [
      { analysis: 'compare_groups of TH2/TFH2 marker expression across IgG4-RD, HC, and pSS' },
      { analysis: 'compare_groups of TH17/TFH17 marker expression across IgG4-RD, HC, and pSS' },
    ],
    datasetsUsed: [],
  },
};

/** All seven legacy "plans" of that run: `profile` only, n declined, 0 datasets used. */
const RECORDED_LEGACY_REFUSALS: ReadonlyArray<{ planId: string; q: number; declined: number }> = [
  { planId: 'PL-ac2885c4', q: 1, declined: 2 },
  { planId: 'PL-c28921fd', q: 2, declined: 5 },
  { planId: 'PL-78422dfe', q: 3, declined: 4 },
  { planId: 'PL-6eb45ec4', q: 4, declined: 1 },
  { planId: 'PL-a926c53c', q: 5, declined: 2 },
  { planId: 'PL-2951e870', q: 6, declined: 1 },
  { planId: 'PL-0bfa7b76', q: 7, declined: 1 },
];

function recordedRefusal(declined: number): PlanApiBody {
  return {
    plan: {
      attemptCount: 3,
      nodes: [{ nodeType: 'profile' }],
      declined: Array.from({ length: declined }, (_, i) => ({ analysis: `declined ${i}` })),
      datasetsUsed: [],
    },
  };
}

test('UT-SHADOW-1677-1: the recorded legacy Q1 plan PL-ac2885c4 scores `refused`, not `planned`', () => {
  assert.equal(outcomeOf(PL_AC2885C4, 200), 'refused');
});

test('UT-SHADOW-1677-2: all seven recorded legacy plans of the 2026-09-25 run score `refused`', () => {
  for (const { planId, q, declined } of RECORDED_LEGACY_REFUSALS) {
    assert.equal(
      outcomeOf(recordedRefusal(declined), 200),
      'refused',
      `${planId} (Q${q}) is a refusal: one profile node, ${declined} declined, datasetsUsed []`,
    );
  }
});

test('UT-SHADOW-1677-3: a plan that USED a dataset and carries an analysis node is `planned`', () => {
  const body: PlanApiBody = {
    plan: {
      nodes: [{ nodeType: 'profile' }, { nodeType: 'compare_groups' }],
      declined: [],
      datasetsUsed: [{ datasetId: 'ds-1' }],
    },
  };
  assert.equal(outcomeOf(body, 200), 'planned');
});

test('UT-SHADOW-1677-4: a genuine profiling plan that DID use a dataset is not libelled as a refusal', () => {
  // The other direction of the same mistake: "all nodes are profile/filter" on
  // its own would score a legitimate profiling answer as a refusal.
  const body: PlanApiBody = {
    plan: { nodes: [{ nodeType: 'profile' }], declined: [], datasetsUsed: [{ datasetId: 'ds-1' }] },
  };
  assert.equal(outcomeOf(body, 200), 'planned');
  assert.equal(isRefusalPlan(body.plan), false);
});

test('UT-SHADOW-1677-5: a plan that used no dataset and declined nothing is still a refusal — it analysed nothing', () => {
  assert.equal(isRefusalPlan({ nodes: [{ nodeType: 'profile' }, { nodeType: 'filter' }] }), true);
  assert.equal(isRefusalPlan({ nodes: [] }), true);
});

test('UT-SHADOW-1677-6: the planner’s own `intentUnsupported` outranks the inferred refusal', () => {
  // FR30(a) counts `unsupported` specifically; an inference must never mask the
  // planner's own explicit statement about what it did.
  const body: PlanApiBody = { ...PL_AC2885C4, intentUnsupported: true };
  assert.equal(outcomeOf(body, 200), 'unsupported');
});

test('UT-SHADOW-1677-7: the planner’s own `plannerFallback` outranks the inferred refusal', () => {
  // FR30(b) counts fallbacks; same reasoning as UT-SHADOW-1677-6.
  const body: PlanApiBody = { ...PL_AC2885C4, plannerFallback: true };
  assert.equal(outcomeOf(body, 200), 'fallback');
});

test('UT-SHADOW-1677-8: a non-2xx or a body with no plan stays `unavailable`, and a plan with neither field is not invented into a refusal', () => {
  assert.equal(outcomeOf({}, 500), 'unavailable');
  assert.equal(outcomeOf({}, 200), 'unavailable');
  // No `declined`, no `datasetsUsed`, but a real analysis node: nothing here
  // says "refusal", and the classifier does not guess one.
  assert.equal(outcomeOf({ plan: { nodes: [{ nodeType: 'correlate' }] } }, 200), 'planned');
});

// ── SHADOW_RUN_ARMS ──────────────────────────────────────────────────────────

test('UT-SHADOW-1677-9: SHADOW_RUN_ARMS unset or empty runs every arm — the default is unchanged', () => {
  assert.equal(shouldRunArm(undefined, 'compiled'), true);
  assert.equal(shouldRunArm(undefined, 'anthropic'), true);
  assert.equal(shouldRunArm('', 'anthropic'), true);
  assert.equal(shouldRunArm('   ', 'anthropic'), true);
});

test('UT-SHADOW-1677-10: SHADOW_RUN_ARMS=compiled runs the compiled arm and skips the legacy one', () => {
  // FR30(c) v0.5 withdrew the "no lower than the legacy arm's" clause, so the
  // amended gate no longer compares the arms — and no longer needs to pay for a
  // second 46-question live run.
  assert.equal(shouldRunArm('compiled', 'compiled'), true);
  assert.equal(shouldRunArm('compiled', 'anthropic'), false);
});

test('UT-SHADOW-1677-11: SHADOW_RUN_ARMS accepts a list, and tolerates spacing and case', () => {
  assert.equal(shouldRunArm('compiled, anthropic', 'anthropic'), true);
  assert.equal(shouldRunArm(' Compiled ', 'compiled'), true);
  assert.equal(shouldRunArm('compiled', ' COMPILED '), true);
});

test('UT-SHADOW-1677-12: an arm not named in SHADOW_RUN_ARMS never runs by accident', () => {
  assert.equal(shouldRunArm('compiled', 'unspecified'), false);
  assert.equal(shouldRunArm('anthropic', 'compiled'), false);
});

// ── The run loop's 401 policy ────────────────────────────────────────────────

const ANCHORED_DATASET = [
  {
    datasetId: '33333333-3333-4333-8333-333333333333',
    displayName: 'synthetic-grados-cohort.csv',
    versionHash: `sha256:${'a'.repeat(64)}`,
    columns: [{ name: 'tfh2_pct', type: 'numeric' }],
  },
];

/** A plan response the classifier scores `planned`. */
const OK_PLAN = {
  status: 200,
  body: {
    correlationId: 'corr-ok',
    plan: {
      attemptCount: 1,
      nodes: [{ nodeType: 'compare_groups' }],
      declined: [],
      datasetsUsed: [{ datasetId: 'ds-1' }],
    },
  },
};

const UNAUTHORIZED_RESPONSE = { status: 401, body: { message: 'Invalid token' } };

/** An `Api` stub whose plan endpoint answers from a caller-supplied function. */
function stubApi(name: string, answer: (callIndex: number) => { status: number; body: unknown }): Api {
  let calls = 0;
  const notUsed = () => {
    throw new Error(`${name}: this stub only answers POST /guided-analysis/plan`);
  };
  return {
    ctx: { dispose: async () => undefined } as unknown as Api['ctx'],
    get: notUsed as unknown as Api['get'],
    patch: notUsed as unknown as Api['patch'],
    post: (async () => answer(calls++)) as unknown as Api['post'],
  };
}

test('UT-SHADOW-1677-13: a 401 that survives re-authentication FAILS the run — it is never written as a row', async () => {
  // The 2026-09-25 failure: 39 of 46 rows were 401s recorded as `unavailable`,
  // and the exclusion set had to be reconstructed by hand from row latencies.
  const alwaysUnauthorized = stubApi('always401', () => UNAUTHORIZED_RESPONSE);
  let refreshes = 0;
  const auth: ShadowRunAuth = {
    api: () => alwaysUnauthorized,
    refresh: async () => {
      refreshes += 1;
      return alwaysUnauthorized;
    },
  };

  await assert.rejects(
    () => runShadowBank(auth, 'ws', 'proj', 'compiled', ANCHORED_DATASET, { reauthEveryQuestions: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof ShadowRunAuthError, 'the run aborts with ShadowRunAuthError');
      assert.match((err as Error).message, /401/);
      return true;
    },
  );
  assert.equal(refreshes, 1, 'exactly one re-authentication was attempted before giving up');
});

test('UT-SHADOW-1677-14: a 401 followed by a successful refresh is retried and recorded normally', async () => {
  const expired = stubApi('expired', () => UNAUTHORIZED_RESPONSE);
  const fresh = stubApi('fresh', () => OK_PLAN);
  let current = expired;
  let refreshes = 0;
  const auth: ShadowRunAuth = {
    api: () => current,
    refresh: async () => {
      refreshes += 1;
      current = fresh;
      return current;
    },
  };

  const rows = await runShadowBank(auth, 'ws', 'proj', 'compiled', ANCHORED_DATASET, {
    reauthEveryQuestions: 0,
  });

  assert.equal(rows.length, 46, 'the whole bank was recorded');
  assert.equal(refreshes, 1, 'the expired token was re-minted once, on the 401');
  assert.equal(rows[0].outcome, 'planned', 'the question that 401’d was retried, not recorded as unavailable');
  assert.ok(
    rows.every((r) => r.outcome !== 'unavailable'),
    'no row in the run is an auth artefact',
  );
});

test('UT-SHADOW-1677-15: the token is re-minted proactively every N questions, before it can expire', async () => {
  // Reactive recovery alone is correct but leaves one question’s latency
  // polluted by a re-login. At the legacy arm’s 104-180 s per question a
  // 46-question run is over an hour, so the token WILL expire mid-run.
  const ok = stubApi('ok', () => OK_PLAN);
  let refreshes = 0;
  const auth: ShadowRunAuth = {
    api: () => ok,
    refresh: async () => {
      refreshes += 1;
      return ok;
    },
  };

  const rows = await runShadowBank(auth, 'ws', 'proj', 'compiled', ANCHORED_DATASET, {
    reauthEveryQuestions: 10,
  });

  assert.equal(rows.length, 46);
  // 46 questions, refreshing before questions 11, 21, 31 and 41 — never before
  // the first, which already holds a token minted moments earlier.
  assert.equal(refreshes, 4);
});
