import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideHarnessBankRun,
  decideHarnessLiveSpend,
  interpretTransportProbe,
  readBackendTransportMode,
  runShadowBankGuarded,
  shadowRunProvenanceOf,
  writeShadowRunSummary,
  LLM_TRANSPORT_PROBE_PATH,
  TRANSPORT_STATEMENT_SERVICE,
  type HarnessTransportStatement,
  type ShadowRunAuth,
} from '../../tests/AXI-1462/harness/shadow';
import type { Api } from '../../tests/AXI-1435/harness/api';
import { loadGradosBank } from '../../tests/AXI-1462/harness/governed';

/**
 * AXI-1716 (epic AXI-1687) — the recorded-bank-run blocker. `SI-042`, tag `SHADOW`.
 *
 * Before this story `runShadowBankGuarded` gated EVERY bank run on
 * `GUIDED_ANALYSIS_LIVE_SPEND_GO` + an FR116 registry row, whatever transport
 * the backend was serving. A run against a `recorded` backend — which reads no
 * key, touches no network and spends nothing — was refused, every question came
 * back `not_answered: 'guard'`, and the gate scored those `not_answered`,
 * failing condition (a). The recorded strategy could not produce a scoreable
 * bank run at all.
 *
 * The rule this suite exists to hold: a run is free ONLY when the backend that
 * will serve the calls says so. Nothing in the harness's own environment can
 * make a run free, and the FR116 procedure for a paid run is byte-for-byte what
 * it was.
 */

const ROW_ID = 'RUN-2026-09-27-01';
const REGISTRY_GO = `| 2026-09-27 | shas | hashes | 3 | 0.02 USD | GO: felipe 2026-09-27 ${ROW_ID} | pending | no |`;
const REGISTRY_NO_GO = `| 2026-09-27 | shas | hashes | 3 | 0.02 USD | ${ROW_ID} requested | pending | no |`;

const RECORDED: HarnessTransportStatement = { mode: 'recorded', source: 'backend' };
const LIVE: HarnessTransportStatement = { mode: 'live', source: 'backend' };
const UNKNOWN: HarnessTransportStatement = { mode: 'unknown', source: 'unavailable', detail: 'probe failed' };

// ── interpretTransportProbe — what counts as an authoritative statement ──────

test('UT-SHADOW-1716-001: a 200 naming organization-service and a legal mode IS the statement', () => {
  // Arrange
  const body = { mode: 'recorded', service: TRANSPORT_STATEMENT_SERVICE, resolvedAt: '2026-09-28T00:00:00.000Z' };
  // Act
  const statement = interpretTransportProbe(200, body);
  // Assert
  assert.deepEqual(statement, { mode: 'recorded', source: 'backend' });
});

test('UT-SHADOW-1716-002: a non-200 probe is `unknown`, never a mode', () => {
  const statement = interpretTransportProbe(404, { mode: 'recorded', service: TRANSPORT_STATEMENT_SERVICE });
  assert.equal(statement.mode, 'unknown');
  assert.equal(statement.source, 'unavailable');
});

test('UT-SHADOW-1716-003: a reply that does not name organization-service is `unknown`, even when it says recorded', () => {
  // The gateway does not construct the transport; a statement from anything
  // else is a guess about another process and must not buy a free run.
  const statement = interpretTransportProbe(200, { mode: 'recorded', service: 'gateway' });
  assert.equal(statement.mode, 'unknown');
});

test('UT-SHADOW-1716-004: an unrecognised or absent mode is `unknown`, never defaulted to recorded', () => {
  assert.equal(interpretTransportProbe(200, { mode: 'REPLAY', service: TRANSPORT_STATEMENT_SERVICE }).mode, 'unknown');
  assert.equal(interpretTransportProbe(200, { service: TRANSPORT_STATEMENT_SERVICE }).mode, 'unknown');
  assert.equal(interpretTransportProbe(200, null).mode, 'unknown');
});

test('UT-SHADOW-1716-005: a `live` statement is read as live, so a paid backend is never mistaken for a free one', () => {
  const statement = interpretTransportProbe(200, { mode: 'live', service: TRANSPORT_STATEMENT_SERVICE });
  assert.deepEqual(statement, { mode: 'live', source: 'backend' });
});

// ── readBackendTransportMode — an unreachable backend refuses, never throws ──

function apiReturning(get: Api['get']): Api {
  return {
    get,
    post: async () => ({ status: 200, body: {} }),
    patch: async () => ({ status: 200, body: {} }),
    ctx: undefined as unknown as Api['ctx'],
  } as Api;
}

test('UT-SHADOW-1716-006: the probe reads the documented route and passes the workspace header', async () => {
  let seenPath = '';
  let seenHeaders: Record<string, string> | undefined;
  const api = apiReturning(async (path, headers) => {
    seenPath = path;
    seenHeaders = headers;
    return { status: 200, body: { mode: 'recorded', service: TRANSPORT_STATEMENT_SERVICE } };
  });

  const statement = await readBackendTransportMode(api, 'ws-42');

  assert.equal(seenPath, LLM_TRANSPORT_PROBE_PATH);
  assert.deepEqual(seenHeaders, { 'X-Workspace-Id': 'ws-42' });
  assert.equal(statement.mode, 'recorded');
});

test('UT-SHADOW-1716-007: a backend that cannot be asked yields `unknown` and does not throw the run', async () => {
  const api = apiReturning(async () => {
    throw new Error('ECONNREFUSED');
  });

  const statement = await readBackendTransportMode(api, 'ws');

  assert.equal(statement.mode, 'unknown');
  assert.match(statement.detail ?? '', /ECONNREFUSED/);
});

// ── decideHarnessBankRun — the one gate ─────────────────────────────────────

test('UT-SHADOW-1716-008: a RECORDED backend is allowed with NO registry, NO go and NO row id', () => {
  // Arrange: the state the whole story exists for — nothing configured at all.
  const env: Record<string, string | undefined> = {};
  // Act
  const decision = decideHarnessBankRun(env, undefined, RECORDED);
  // Assert
  assert.deepEqual(decision, {
    allowed: true,
    reason: 'allowed',
    transport: 'recorded',
    spendMode: 'free_recorded',
  });
});

test('UT-SHADOW-1716-009: a LIVE backend keeps the FR116 guard exactly — every refusal reason is still reachable', () => {
  const cases: Array<[Record<string, string | undefined>, string | undefined, string]> = [
    [{}, REGISTRY_GO, 'not_configured'],
    [{ GUIDED_ANALYSIS_LIVE_SPEND_GO: 'yes-please' }, REGISTRY_GO, 'invalid_row_id'],
    [{ GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, undefined, 'no_registry'],
    [{ GUIDED_ANALYSIS_LIVE_SPEND_GO: 'RUN-2026-09-27-09' }, REGISTRY_GO, 'row_not_registered'],
    [{ GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, REGISTRY_NO_GO, 'row_not_go'],
  ];
  for (const [env, registry, expected] of cases) {
    const decision = decideHarnessBankRun(env, registry, LIVE);
    assert.equal(decision.allowed, false, expected);
    assert.equal(decision.reason, expected);
    assert.equal(decision.transport, 'live');
    assert.equal(decision.spendMode, undefined);
  }
});

test('UT-SHADOW-1716-010: a LIVE backend with a registered written go is allowed, `registered_live`, row id echoed', () => {
  const decision = decideHarnessBankRun({ GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, REGISTRY_GO, LIVE);
  assert.deepEqual(decision, {
    allowed: true,
    reason: 'allowed',
    rowId: ROW_ID,
    transport: 'live',
    spendMode: 'registered_live',
  });
});

test('UT-SHADOW-1716-011: an UNKNOWN transport never buys a free run — it falls through to the unchanged guard', () => {
  const refused = decideHarnessBankRun({}, undefined, UNKNOWN);
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'not_configured');
  assert.equal(refused.transport, 'unknown');

  // And an unknown transport does NOT break a properly registered live run:
  // FR116 is what it always was, probe or no probe.
  const allowed = decideHarnessBankRun({ GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, REGISTRY_GO, UNKNOWN);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.spendMode, 'registered_live');
});

test('UT-SHADOW-1716-012: BYPASS — a harness claiming `recorded` in its OWN env against a LIVE backend is REFUSED', () => {
  // Arrange: every self-assertion an operator could plausibly reach for.
  const env = {
    SHADOW_RUN_TRANSPORT: 'recorded',
    GUIDED_ANALYSIS_LLM_TRANSPORT: 'recorded',
    LLM_TRANSPORT: 'recorded',
    NODE_ENV: 'test',
    CI: 'true',
  };

  // Act: the backend that will serve the calls says `live`.
  const decision = decideHarnessBankRun(env, REGISTRY_GO, LIVE);

  // Assert: refused, and refused for the ONE reason that matters — no go.
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'not_configured');
  assert.equal(decision.transport, 'live');
  assert.equal(decision.spendMode, undefined);
});

test('UT-SHADOW-1716-013: BYPASS — a `recorded` claim made by something other than organization-service is refused end to end', () => {
  // A proxy/gateway answering for a service it does not run must not buy a free run.
  const spoofed = interpretTransportProbe(200, { mode: 'recorded', service: 'gateway' });
  const decision = decideHarnessBankRun({}, undefined, spoofed);
  assert.equal(decision.allowed, false);
  assert.equal(decision.transport, 'unknown');
});

test('UT-SHADOW-1716-014: `decideHarnessLiveSpend` itself is untouched — it states no transport and no spend mode', () => {
  // The FR116 decider keeps its exact old shape, so every report string that
  // reads its five refusal labels still reads the same thing.
  assert.deepEqual(decideHarnessLiveSpend({}, REGISTRY_GO), { allowed: false, reason: 'not_configured' });
  assert.deepEqual(decideHarnessLiveSpend({ GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, REGISTRY_GO), {
    allowed: true,
    reason: 'allowed',
    rowId: ROW_ID,
  });
});

// ── shadowRunProvenanceOf — the artefact can never be read as paid ───────────

test('UT-SHADOW-1716-015: a recorded run is labelled `claude-code` at `0 USD (claude-code, blind)`, never `live`', () => {
  const provenance = shadowRunProvenanceOf(decideHarnessBankRun({}, undefined, RECORDED));
  assert.deepEqual(provenance, {
    transport: 'recorded',
    label: 'claude-code',
    budget: '0 USD (claude-code, blind)',
  });
});

test('UT-SHADOW-1716-016: a registered live run is labelled `live` and points at its registry row for the budget', () => {
  const provenance = shadowRunProvenanceOf(
    decideHarnessBankRun({ GUIDED_ANALYSIS_LIVE_SPEND_GO: ROW_ID }, REGISTRY_GO, LIVE),
  );
  assert.equal(provenance.transport, 'live');
  assert.equal(provenance.label, 'live');
  assert.equal(provenance.registryRowId, ROW_ID);
  assert.match(provenance.budget, new RegExp(ROW_ID));
});

test('UT-SHADOW-1716-017: a refused run is labelled `none` and names the refusal — no call, no claim', () => {
  const provenance = shadowRunProvenanceOf(decideHarnessBankRun({}, undefined, UNKNOWN));
  assert.equal(provenance.label, 'none');
  assert.equal(provenance.transport, 'unknown');
  assert.match(provenance.budget, /not_configured/);
});

// ── runShadowBankGuarded — the run end to end ───────────────────────────────

function stubAuth(post: Api['post'], get?: Api['get']): ShadowRunAuth {
  const api = apiReturning(get ?? (async () => ({ status: 200, body: {} })));
  const withPost = { ...api, post } as Api;
  return { api: () => withPost, refresh: async () => withPost };
}

test('UT-SHADOW-1716-018: against a RECORDED backend the bank actually runs with no go — the blocker is gone', async () => {
  // Arrange: no registry, no go; the backend's probe answers `recorded`.
  const asked: number[] = [];
  const auth = stubAuth(
    async (_path, body) => {
      const question = (body as { envelope: { question: string } }).envelope.question;
      asked.push(loadGradosBank().find((q) => q.question === question)!.id);
      return { status: 200, body: { plan: { nodes: [{ nodeType: 'describe' }], datasetsUsed: [{}] } } };
    },
    async () => ({ status: 200, body: { mode: 'recorded', service: TRANSPORT_STATEMENT_SERVICE } }),
  );

  // Act
  const result = await runShadowBankGuarded(auth, 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3,7,12' },
    registryText: undefined,
  });

  // Assert: every selected question was asked and answered, not refused.
  assert.deepEqual(asked, [3, 7, 12]);
  assert.equal(result.status, 'complete');
  assert.equal(result.guard.spendMode, 'free_recorded');
  assert.deepEqual(result.rows.map((r) => r.outcome), ['planned', 'planned', 'planned']);
  assert.equal(result.rows.some((r) => r.notAnsweredReason === 'guard'), false);
});

test('UT-SHADOW-1716-019: against a LIVE backend with no go the run is still refused before any call', async () => {
  let calls = 0;
  const auth = stubAuth(
    async () => {
      calls += 1;
      return { status: 200, body: { plan: { nodes: [] } } };
    },
    async () => ({ status: 200, body: { mode: 'live', service: TRANSPORT_STATEMENT_SERVICE } }),
  );

  const result = await runShadowBankGuarded(auth, 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3,7' },
    registryText: REGISTRY_GO,
  });

  assert.equal(calls, 0);
  assert.equal(result.status, 'refused');
  assert.equal(result.transport.mode, 'live');
  assert.equal(result.provenance.label, 'none');
  assert.deepEqual(result.rows.map((r) => r.notAnsweredReason), ['guard', 'guard']);
});

test('UT-SHADOW-1716-020: a backend whose probe cannot be reached is `unknown` and the run is refused, not crashed', async () => {
  const auth = stubAuth(
    async () => ({ status: 200, body: { plan: { nodes: [] } } }),
    async () => {
      throw new Error('socket hang up');
    },
  );

  const result = await runShadowBankGuarded(auth, 'ws', 'proj', 'compiled', [], {
    env: { SHADOW_RUN_QUESTIONS: '3' },
    registryText: undefined,
  });

  assert.equal(result.status, 'refused');
  assert.equal(result.transport.mode, 'unknown');
});

test('UT-SHADOW-1716-021: the run sidecar records the transport statement and the provenance beside the guard', () => {
  // Arrange
  const dir = mkdtempSync(join(tmpdir(), 'axi1716-'));
  const decision = decideHarnessBankRun({}, undefined, RECORDED);

  // Act
  const path = writeShadowRunSummary(
    'compiled',
    {
      status: 'complete',
      guard: decision,
      transport: RECORDED,
      provenance: shadowRunProvenanceOf(decision),
      questionIds: [3, 7],
    },
    dir,
  );

  // Assert
  const written = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(written.transport, { mode: 'recorded', source: 'backend' });
  assert.deepEqual(written.provenance, {
    transport: 'recorded',
    label: 'claude-code',
    budget: '0 USD (claude-code, blind)',
  });
  assert.equal(written.guard.spendMode, 'free_recorded');
});
