import { test, expect } from '@playwright/test';
import { compareFixture } from './harness/comparator';
import {
  adminApi,
  ensureRoundTripTenant,
  ensureRoundTripAnalysis,
  ingestRoundTripFixture,
  loadRoundTripFixtures,
  submitRoundTrip,
  fetchRoundTripResult,
  type RoundTripFixture,
} from './harness/round-trip';

/**
 * AXI-1921 (epic AXI-1911 — FR5, AC5, D8; SI-042). Release round-trip runner:
 * one fixture per method, submitted as a REAL governed run against a running
 * stack through the public API, polled to a terminal status, its stored
 * result compared against the fixture's expected values under MSR-style
 * tolerance (the ported AXI-1919 comparator, `harness/comparator.ts`).
 *
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1911-Method-Validation-
 * Foundation.md` §AXI-1921, Scenario 7. Contract (composition) tests for the
 * SAME parity boundary live in `axiome-back` (SI-017); this file is the ONLY
 * ONE OF THE TWO that exercises bio-compute itself and the full storage
 * round trip, which is why it needs a running stack and is gated.
 *
 * RELEASE-GATE ONLY, NEVER PER MERGE. Every test below is a no-op unless
 * `AXI1921_ROUND_TRIP=1` is set — this is read directly in this file rather
 * than threaded through `config/env.ts` (this story's ownership boundary is
 * `tests/AXI-1911/**` + its own helpers; it does not edit the shared env
 * facade other stories read). Without the flag, every test reports SKIPPED
 * loudly (never silently absent) and the suite exits 0.
 *
 * HONESTY NOTE (AXI-1921 story report): this spec is AUTHORED but has NOT
 * been run against a live stack in this story — no isolated stack was stood
 * up in this session. Its own fixture-comparison LOGIC is exercised with no
 * network by `harness-unit/AXI-1911/comparator.spec.ts` (24/24 passing,
 * verified). Treat this file's own `n/n` as unobserved until a future
 * release run actually executes it; never report `e2e-pass` for it until
 * then.
 *
 * Today's fixture coverage (`harness/fixtures/*.json`): `stats.fisher_exact`
 * only, embedded from axiome-bio-compute's own self-test corpus (see the
 * fixture file's own `_README`). The other 33 D1 methods have no round-trip
 * fixture yet (AXI-1912's job, same gap the `axiome-back` contract suite
 * reports) — loudly skipped below by name, never silently absent.
 */

const ROUND_TRIP_ENABLED = /^(1|true)$/i.test(process.env.AXI1921_ROUND_TRIP ?? '');
const SKIP_REASON = 'release round-trip is opt-in — set AXI1921_ROUND_TRIP=1 to run against a live stack (not run per merge)';

test.describe('AXI-1921 — release round-trip runner (@SI-042)', { tag: ['@SI-042', '@AXI-1921'] }, () => {
  test.skip(!ROUND_TRIP_ENABLED, SKIP_REASON);

  let fixtures: RoundTripFixture[];

  test.beforeAll(() => {
    fixtures = loadRoundTripFixtures();
  });

  test('AC5/D8 — every method with a round-trip fixture is named, and the others are named as "no fixture yet"', async () => {
    // This assertion is cheap and always meaningful even if nothing below
    // runs: it is the completeness-visibility half of AC5, mirrored from the
    // axiome-back contract suite's own UT-RULES-1915.
    expect(fixtures.map((f) => f.method_id)).toEqual(['stats.fisher_exact']);
    // eslint-disable-next-line no-console
    console.log(
      `[AXI-1921 round-trip runner] ${fixtures.length} method(s) have a round-trip fixture today: ` +
        `${fixtures.map((f) => f.method_id).join(', ')}. Every other D1 method: no fixture yet (AXI-1912).`,
    );
  });

  for (const methodId of ['stats.fisher_exact']) {
    test(`AC5/D8 — a governed run of ${methodId} matches its fixture's expected values under tolerance`, async () => {
      const fixture = fixtures.find((f) => f.method_id === methodId);
      expect(fixture, `no round-trip fixture for ${methodId} — see "no fixture yet" above`).toBeTruthy();
      if (!fixture) return;

      const api = await adminApi();
      try {
        const tenant = await ensureRoundTripTenant(api);
        const datasetId = await ingestRoundTripFixture(api, tenant, fixture);
        const analysis = await ensureRoundTripAnalysis(api, tenant, `${fixture.method_id} round trip`, datasetId);
        const run = await submitRoundTrip(api, tenant, analysis, datasetId, fixture);
        expect(run.status, `run did not succeed: ${JSON.stringify(run)}`).toBe('SUCCEEDED');

        const result = await fetchRoundTripResult(api, tenant, run.id);
        if (fixture.case_kind === 'refusal') {
          if (!fixture.expected_refusal) throw new Error(`fixture ${methodId} declares case_kind 'refusal' with no expected_refusal`);
        } else if (!fixture.expected) {
          throw new Error(`fixture ${methodId} declares case_kind '${fixture.case_kind}' with no expected field list`);
        }
        const verdict =
          fixture.case_kind === 'refusal'
            ? compareFixture(result, { caseKind: 'refusal', expectedRefusal: fixture.expected_refusal! })
            : compareFixture(result, { caseKind: fixture.case_kind, expected: fixture.expected! });
        if (verdict.status !== 'pass') {
          const failing = verdict.fieldVerdicts.filter((v) => v.status === 'fail');
          throw new Error(
            `${methodId} round-trip mismatch — ${failing.map((f) => `${f.path}: ${f.message}`).join('; ')}`,
          );
        }
        expect(verdict.status).toBe('pass');
      } finally {
        await api.ctx.dispose();
      }
    });
  }
});
