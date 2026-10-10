import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ABS_FLOOR, compareField, compareFixture, LOG_P_EPS } from '../../tests/AXI-1911/harness/comparator';
import { decodeValue, encodeValue } from '../../tests/AXI-1911/harness/encoding';

/**
 * UT-RTT-1 through UT-RTT-29 (epic AXI-1911 — AXI-1921, SI-042; review
 * bounce #1 rework). Pure unit coverage for the TypeScript comparator +
 * encoding port used by the release round-trip runner. Mirrors
 * axiome-bio-compute's own `test_comparator.py`/`test_encoding.py`
 * (AXI-1919) test classes one-for-one, over the SAME edge cases, READ
 * directly from `origin/main` for this rework (not from memory) — this file
 * is the evidence that the port is verified against equivalent inputs/
 * outputs, not merely "the same idea" (the AXI-1921 story's own
 * requirement). No network, no browser — see `UT.md` in this directory.
 * Run via `npm run harness:unit`.
 *
 * NOTE on `compareField`'s signature here vs `comparator.py`'s
 * `compare_field`: this port takes the already-decoded value directly
 * (`actual`, `expectedValue`) — the Python test helper `_expected(value)`
 * builds an `ExpectedOutput` wrapping the SAME already-decoded value; the
 * envelope decode itself is tested separately below against `encoding.ts`,
 * matching `test_encoding.py` exactly, not re-tested per comparator case.
 */

test('UT-RTT-1: relative tolerance near zero is floored, never collapsing to zero (ABS_FLOOR)', () => {
  const v = compareField(9e-13, 'x', 1e-15, false, false, 'relative', 0.01);
  assert.equal(v.status, 'pass');
  assert.equal(ABS_FLOOR, 1e-12);
});

test('UT-RTT-2: relative boundary exactly at tolerance is inclusive (passes)', () => {
  const v = compareField(101, 'x', 100, false, false, 'relative', 0.01);
  assert.equal(v.status, 'pass');
  assert.equal(v.deviation, 1);
});

test('UT-RTT-3: relative boundary just outside tolerance fails', () => {
  const v = compareField(101.01, 'x', 100, false, false, 'relative', 0.01);
  assert.equal(v.status, 'fail');
});

test('UT-RTT-4: log_p domain check runs BEFORE any clamp — actual=2.0 vs expected=1.0 fails, never passes via clamping', () => {
  const v = compareField(2.0, 'x', 1.0, false, false, 'log_p', 0.1);
  assert.equal(v.status, 'fail');
  assert.match(v.message, /domain/);
});

test('UT-RTT-5: log_p in-domain values underflow-floored to LOG_P_EPS and compared by log difference', () => {
  const v = compareField(1e-320, 'x', 1e-320, false, false, 'log_p', 0.1);
  assert.equal(v.status, 'pass');
  assert.equal(LOG_P_EPS, 1e-300);
});

test('UT-RTT-6: log_p an infinite value is out of domain (fails), never a clamp target', () => {
  const v = compareField(Infinity, 'x', 0.5, false, false, 'log_p', 0.1);
  assert.equal(v.status, 'fail');
});

test('UT-RTT-7: NaN vs NaN passes (declared equal by convention) for relative/absolute/monte_carlo/log_p/exact', () => {
  for (const kind of ['relative', 'absolute', 'monte_carlo', 'log_p', 'exact'] as const) {
    const v = compareField(NaN, 'x', NaN, false, false, kind, 0.01);
    assert.equal(v.status, 'pass', `kind=${kind}`);
  }
});

test('UT-RTT-8: NaN vs a number fails for every numeric kind', () => {
  for (const kind of ['relative', 'absolute', 'monte_carlo', 'log_p'] as const) {
    const v = compareField(NaN, 'x', 1.0, false, false, kind, 0.01);
    assert.equal(v.status, 'fail', `kind=${kind}`);
  }
});

test('UT-RTT-9: +Infinity vs +Infinity passes; -Infinity vs -Infinity passes', () => {
  assert.equal(compareField(Infinity, 'x', Infinity, false, false, 'absolute', 0.01).status, 'pass');
  assert.equal(compareField(-Infinity, 'x', -Infinity, false, false, 'absolute', 0.01).status, 'pass');
});

test('UT-RTT-10: +Infinity vs -Infinity fails', () => {
  assert.equal(compareField(Infinity, 'x', -Infinity, false, false, 'absolute', 0.01).status, 'fail');
});

test('UT-RTT-11: signed zero (0 vs -0) passes under absolute/relative (IEEE equality, no special case)', () => {
  assert.equal(compareField(0, 'x', -0, false, false, 'absolute', 0.01).status, 'pass');
});

test('UT-RTT-12: exact — bool is a distinct type; true vs 1 fails in both directions', () => {
  assert.equal(compareField(true, 'x', 1, false, false, 'exact', 0).status, 'fail');
  assert.equal(compareField(1, 'x', true, false, false, 'exact', 0).status, 'fail');
});

test('UT-RTT-13: exact — bool vs bool, equal values pass', () => {
  assert.equal(compareField(true, 'x', true, false, false, 'exact', 0).status, 'pass');
});

test('UT-RTT-14: exact — int/float are one numeric class: 20 vs 20.0 passes', () => {
  assert.equal(compareField(20, 'x', 20.0, false, false, 'exact', 0).status, 'pass');
});

test('UT-RTT-15: exact — a different number fails', () => {
  assert.equal(compareField(20, 'x', 21, false, false, 'exact', 0).status, 'fail');
});

test('UT-RTT-16: exact — type AND value must match for non-numeric, non-bool values ("0.05" vs 0.05 fails)', () => {
  assert.equal(compareField('0.05', 'x', 0.05, false, false, 'exact', 0).status, 'fail');
});

test('UT-RTT-17: monte_carlo is an absolute band around expected', () => {
  assert.equal(compareField(0.52, 'x', 0.5, false, false, 'monte_carlo', 0.05).status, 'pass');
  assert.equal(compareField(0.6, 'x', 0.5, false, false, 'monte_carlo', 0.05).status, 'fail');
});

test('UT-RTT-18: a field missing from actual fails, distinct from "actual is null"', () => {
  const v = compareField(undefined, 'p', 0.5, false, true, 'relative', 0.01);
  assert.equal(v.status, 'fail');
  assert.match(v.message, /missing/);
});

test('UT-RTT-19: expected null (NA) + actual null on a NULLABLE field passes', () => {
  const v = compareField(null, 'ciHigh', null, true, true, 'relative', 0.01);
  assert.equal(v.status, 'pass');
});

test('UT-RTT-20: expected null (NA) + actual null on a NON-nullable field fails', () => {
  const v = compareField(null, 'pValue', null, true, false, 'relative', 0.01);
  assert.equal(v.status, 'fail');
});

test('UT-RTT-21: expected a value, actual is null fails distinctly from "missing"', () => {
  const v = compareField(null, 'pValue', 0.5, false, true, 'relative', 0.01);
  assert.equal(v.status, 'fail');
  assert.match(v.message, /observed null/);
});

// --- UT-RTT-22 rewritten (review bounce #1): the real `__float__` envelope,
// ported from `test_encoding.py` read directly at origin/main, replacing the
// invented bare-string scheme the first draft of this port used. ---

test('UT-RTT-22a: NaN round-trips through the envelope exactly as `{"__float__": "nan"}` (TestNonFiniteRoundTrip.test_nan_round_trips_through_the_envelope)', () => {
  const encoded = encodeValue(NaN);
  assert.deepEqual(encoded, { __float__: 'nan' });
  const decoded = decodeValue(encoded);
  assert.ok(Number.isNaN(decoded as number));
});

test('UT-RTT-22b: +Infinity round-trips (TestNonFiniteRoundTrip.test_positive_infinity_round_trips)', () => {
  assert.equal(decodeValue(encodeValue(Infinity)), Infinity);
});

test('UT-RTT-22c: -Infinity round-trips', () => {
  assert.equal(decodeValue(encodeValue(-Infinity)), -Infinity);
});

test('UT-RTT-22d: recurses into nested lists and dicts (TestNonFiniteRoundTrip.test_recurses_into_nested_lists_and_dicts)', () => {
  const payload = { a: [1.0, NaN], b: { c: Infinity } };
  const decoded = decodeValue(encodeValue(payload)) as { a: number[]; b: { c: number } };
  assert.ok(Number.isNaN(decoded.a[1]));
  assert.equal(decoded.b.c, Infinity);
});

test('UT-RTT-22e: an envelope with an extra sibling key is rejected (TestStrictEnvelope.test_extra_key_alongside_float_is_rejected)', () => {
  assert.throws(() => decodeValue({ __float__: 'nan', unit: 'p' }), /malformed non-finite envelope/);
});

test('UT-RTT-22f: an unrecognised token is rejected (TestStrictEnvelope.test_unrecognised_token_is_rejected)', () => {
  assert.throws(() => decodeValue({ __float__: 'not-a-number' }), /unknown non-finite token/);
});

test('UT-RTT-23: compareFixture passes only when every field passes, and fails naming the first failing field', () => {
  const expected = [
    { field: 'n', value: 8, toleranceKind: 'exact' as const, toleranceValue: 0, nullable: false },
    { field: 'oddsRatio', value: 9.0, toleranceKind: 'relative' as const, toleranceValue: 1e-9, nullable: false },
  ];
  const good = compareFixture({ n: 8, oddsRatio: 9.0 }, { caseKind: 'nominal', expected });
  assert.equal(good.status, 'pass');
  const bad = compareFixture({ n: 8, oddsRatio: 9.5 }, { caseKind: 'nominal', expected });
  assert.equal(bad.status, 'fail');
  const failing = bad.fieldVerdicts.find((v) => v.status === 'fail');
  assert.equal(failing?.path, 'oddsRatio');
});

test('UT-RTT-24: a mutated expected value makes compareFixture fail, naming the field (mutation check, AC5)', () => {
  const expected = [{ field: 'pValue', value: 0.48571428571428565, toleranceKind: 'relative' as const, toleranceValue: 1e-9, nullable: false }];
  const mutated = [{ ...expected[0], value: 0.1 }];
  const v = compareFixture({ pValue: 0.48571428571428565 }, { caseKind: 'nominal', expected: mutated });
  assert.equal(v.status, 'fail');
  assert.equal(v.fieldVerdicts[0].path, 'pValue');
});

// --- New in this rework (review bounce #1): array/record recursion, ported
// from `TestArrayComparison`/`TestNestedRecordComparison` in
// `test_comparator.py`, read directly at origin/main. ---

test('UT-RTT-25: matching arrays pass (TestArrayComparison.test_matching_arrays_pass)', () => {
  const v = compareField([1, 2, 3], 'x', [1, 2, 3], false, false, 'exact', 0);
  assert.equal(v.status, 'pass');
});

test('UT-RTT-26: an array element mismatch names the failing index (TestArrayComparison.test_element_mismatch_names_the_failing_index)', () => {
  const v = compareField([1, 2, 9], 'x', [1, 2, 3], false, false, 'exact', 0);
  assert.equal(v.status, 'fail');
  assert.equal(v.path, 'x[2]');
});

test('UT-RTT-27: array length mismatch fails naming both lengths (TestArrayComparison.test_array_length_mismatch_fails_naming_both_lengths)', () => {
  const v = compareField([1, 2], 'x', [1, 2, 3], false, false, 'exact', 0);
  assert.equal(v.status, 'fail');
  assert.match(v.message, /length mismatch/);
});

test('UT-RTT-28: matching nested records pass (TestNestedRecordComparison.test_matching_nested_records_pass)', () => {
  const v = compareField({ a: 1, b: 2 }, 'x', { a: 1, b: 2 }, false, false, 'exact', 0);
  assert.equal(v.status, 'pass');
});

test('UT-RTT-29: a record missing a key fails naming it (TestNestedRecordComparison.test_record_missing_key_fails)', () => {
  const v = compareField({ a: 1 }, 'x', { a: 1, b: 2 }, false, false, 'exact', 0);
  assert.equal(v.status, 'fail');
  assert.match(v.message, /missing key/);
});

// --- New in this rework (review bounce #1): refusal-fixture comparison,
// ported from `TestCompareFixtureRefusal` in `test_comparator.py`, read
// directly at origin/main. ---

test('UT-RTT-30: a matching refusal passes (TestCompareFixtureRefusal.test_matching_refusal_passes)', () => {
  const v = compareFixture(
    { code: 'STAT-FISHER-PRE-01', severity: 'hard', message: 'refused: empty margin detected' },
    { caseKind: 'refusal', expectedRefusal: { code: 'STAT-FISHER-PRE-01', severity: 'hard', messageContains: 'empty margin' } },
  );
  assert.equal(v.status, 'pass');
});

test('UT-RTT-31: a wrong refusal code fails (TestCompareFixtureRefusal.test_wrong_refusal_code_fails)', () => {
  const v = compareFixture(
    { code: 'STAT-FISHER-PRE-02', severity: 'hard', message: 'wrong reason' },
    { caseKind: 'refusal', expectedRefusal: { code: 'STAT-FISHER-PRE-01', severity: 'hard', messageContains: 'empty margin' } },
  );
  assert.equal(v.status, 'fail');
});

test('UT-RTT-33: a refusal fixture missing the mandatory message_contains (AXI-1957, FR16) throws rather than silently skipping the message check', () => {
  assert.throws(
    () =>
      compareFixture(
        { code: 'STAT-FISHER-PRE-01', severity: 'hard', message: 'refused: empty margin detected' },
        { caseKind: 'refusal', expectedRefusal: { code: 'STAT-FISHER-PRE-01', severity: 'hard', messageContains: '' } },
      ),
    /unsupported fixture shape/,
  );
});

test('UT-RTT-34: a refusal with the right code/severity but a non-matching message substring fails (message_contains is mandatory and checked, AXI-1957)', () => {
  const v = compareFixture(
    { code: 'STAT-FISHER-PRE-01', severity: 'hard', message: 'refused: unrelated reason' },
    { caseKind: 'refusal', expectedRefusal: { code: 'STAT-FISHER-PRE-01', severity: 'hard', messageContains: 'empty margin' } },
  );
  assert.equal(v.status, 'fail');
});

// --- New in this rework (review bounce #1): an unrecognised fixture shape
// (an unported case_kind, or AXI-1957's `expected_rows`) must error loudly,
// never pass or silently skip — this story's own requirement, since
// `comparator.py` itself has no such union-exhaustiveness guard to port
// (Python's dynamic dispatch has no equivalent "unknown variant" state). ---

test('UT-RTT-32: compareFixture throws "unsupported fixture shape" for an unrecognised case_kind, never a silent pass', () => {
  assert.throws(
    () => compareFixture({}, { caseKind: 'mystery' as never, expected: [] } as never),
    /unsupported fixture shape/,
  );
});
