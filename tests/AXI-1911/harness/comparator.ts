/**
 * AXI-1921 (epic AXI-1911 — FR5, D8, SI-042; review bounce #1 rework). A
 * TypeScript PORT, not a reinvention, of axiome-bio-compute's decided
 * tolerance comparator (`tests/validation/fixtures/comparator.py`,
 * AXI-1919, origin/main) — reused by the release round-trip runner so a
 * governed run's stored result is judged by the SAME numerical rules the
 * Python parity harness already uses.
 *
 * ARCHITECTURE NOTE (bounce #1's main finding): this module never decodes a
 * non-finite JSON envelope itself — exactly like `comparator.py`, which
 * receives already-decoded native floats because `loader.py#parse_fixture`
 * calls `encoding.py#decode_value` ONCE, recursively, before a fixture is
 * ever compared. The equivalent TS decode step is `encoding.ts#decodeValue`,
 * applied once at fixture-LOAD time (`round-trip.ts#loadRoundTripFixtures`),
 * never per-leaf here. The ACTUAL side's own encoding (what a real governed
 * run's stored result returns) is a SEPARATE, back-end-specific concern,
 * decoded by `round-trip.ts#decodeActualTableValue` before a value ever
 * reaches `compareField` below — this module receives two already-decoded
 * native values on both sides, like its Python counterpart.
 *
 * Ported semantics (each covered by `harness-unit/AXI-1911/comparator.spec.ts`,
 * written by reading `test_comparator.py` top to bottom, same edge cases):
 *   - `relative`: tolerance is `max(tol * |expected|, ABS_FLOOR)` (floor
 *     `1e-12`).
 *   - boundary exactly at tolerance PASSES (inclusive).
 *   - `log_p`: domain check `[0, 1]` BEFORE any clamp; in-domain values
 *     floored to `LOG_P_EPS` (`1e-300`), compared as `|log(a)-log(e)| <= tol`.
 *   - `NaN` vs `NaN` PASSES; `NaN` vs a number FAILS.
 *   - `+Inf`/`+Inf` and `-Inf`/`-Inf` PASS; `+Inf`/`-Inf` FAILS.
 *   - `exact`: `bool` is a distinct type; int/float are one numeric class;
 *     everything else needs type AND value equality.
 *   - `monte_carlo` is an absolute band around `expected`.
 *   - a value missing from `actual` FAILS, distinct from "actual is null".
 *   - `expected.null === true`: PASS iff `actual` is also null on a
 *     NULLABLE field; always FAIL on a non-nullable one.
 *   - arrays: element-wise, first failing index named, length mismatch
 *     named with both lengths (`_compare_array`).
 *   - records: element-wise by key, a missing key named (`_compare_record`).
 *   - refusal fixtures (`case_kind: 'refusal'`): `code`/`severity` exact
 *     match, `message_contains` substring check (`_compare_refusal_fields`).
 *     `message_contains` is MANDATORY on `ExpectedRefusal` as of AXI-1957
 *     (bio-compute origin/main `cd0aa85`, FR16) — never optional; this port
 *     throws rather than silently skipping the message check on a fixture
 *     that omits it.
 *
 * NOT ported (AXI-1957, merged on bio-compute origin/main `cd0aa85`, but
 * out of this story's scope — porting it is a separate story's job):
 * `expected_rows` (a multi-row result keyed by `row_key`, with `subset`
 * controlling whether every actual row must be named). `loadRoundTripFixtures`
 * (`round-trip.ts`) THROWS "unsupported fixture shape" the moment it sees an
 * `expected_rows` key on disk, before a fixture of that shape ever reaches
 * this comparator — never a silent pass or skip. See the ported/not-ported
 * table in this story's report and `contract/README.md`.
 */

export type ToleranceKind = 'exact' | 'relative' | 'absolute' | 'log_p' | 'monte_carlo';

export interface FieldVerdict {
  readonly path: string;
  readonly status: 'pass' | 'fail';
  readonly toleranceKind: ToleranceKind | 'exact';
  readonly observed: unknown;
  readonly expected: unknown;
  readonly deviation: number | null;
  readonly message: string;
}

export const ABS_FLOOR = 1e-12;
export const LOG_P_EPS = 1e-300;

const MISSING = Symbol('missing');

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isNaNValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isNaN(value);
}

function pass(path: string, kind: ToleranceKind, observed: unknown, expected: unknown): FieldVerdict {
  return { path, status: 'pass', toleranceKind: kind, observed, expected, deviation: null, message: 'pass' };
}

function fail(
  path: string,
  kind: ToleranceKind,
  observed: unknown,
  expected: unknown,
  message: string,
  deviation: number | null = null,
): FieldVerdict {
  return { path, status: 'fail', toleranceKind: kind, observed, expected, deviation, message };
}

function compareExact(actual: unknown, expected: unknown, path: string): FieldVerdict {
  if (isNaNValue(actual) && isNaNValue(expected)) return pass(path, 'exact', actual, expected);
  const actualIsBool = typeof actual === 'boolean';
  const expectedIsBool = typeof expected === 'boolean';
  if (actualIsBool || expectedIsBool) {
    if (!actualIsBool || !expectedIsBool) {
      return fail(path, 'exact', actual, expected, "bool is a distinct type under 'exact': both sides must be bool");
    }
    return actual === expected ? pass(path, 'exact', actual, expected) : fail(path, 'exact', actual, expected, 'values differ');
  }
  if (isNumber(actual) && isNumber(expected)) {
    return actual === expected ? pass(path, 'exact', actual, expected) : fail(path, 'exact', actual, expected, 'values differ');
  }
  if (typeof actual !== typeof expected) {
    return fail(path, 'exact', actual, expected, `type mismatch: expected ${typeof expected}, observed ${typeof actual}`);
  }
  return actual === expected ? pass(path, 'exact', actual, expected) : fail(path, 'exact', actual, expected, 'values differ');
}

function nanOrTypeGuard(actual: unknown, expected: unknown, kind: ToleranceKind, path: string): FieldVerdict | undefined {
  if (isNaNValue(actual) && isNaNValue(expected)) return pass(path, kind, actual, expected);
  if (isNaNValue(actual) || isNaNValue(expected)) {
    return fail(path, kind, actual, expected, 'NaN mismatch: one side is NaN, the other is not');
  }
  if (!isNumber(actual) || !isNumber(expected)) {
    return fail(path, kind, actual, expected, `type mismatch: expected a number, observed ${typeof actual}`);
  }
  return undefined;
}

function compareInfinite(actual: number, expected: number, kind: ToleranceKind, path: string): FieldVerdict {
  const bothInfinite = !Number.isFinite(actual) && !Number.isFinite(expected);
  const sameSign = actual > 0 === expected > 0;
  if (bothInfinite && sameSign) return pass(path, kind, actual, expected);
  return fail(path, kind, actual, expected, 'infinite value mismatch (sign or finiteness differs)');
}

function compareScaled(
  actual: unknown,
  expected: unknown,
  toleranceValue: number,
  path: string,
  kind: ToleranceKind,
  relative: boolean,
): FieldVerdict {
  const guard = nanOrTypeGuard(actual, expected, kind, path);
  if (guard) return guard;
  const a = actual as number;
  const e = expected as number;
  if (!Number.isFinite(a) || !Number.isFinite(e)) return compareInfinite(a, e, kind, path);
  const deviation = Math.abs(a - e);
  const tol = relative ? Math.max(toleranceValue * Math.abs(e), ABS_FLOOR) : toleranceValue;
  const status = deviation <= tol ? 'pass' : 'fail';
  return { path, status, toleranceKind: kind, observed: a, expected: e, deviation, message: `deviation ${deviation} vs tolerance ${tol}` };
}

function checkPDomain(actual: number, expected: number, path: string): FieldVerdict | undefined {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    return fail(path, 'log_p', actual, expected, 'p-value out of domain [0, 1]: infinite');
  }
  if (!(actual >= 0 && actual <= 1)) return fail(path, 'log_p', actual, expected, `actual p-value ${actual} is outside the valid domain [0, 1]`);
  if (!(expected >= 0 && expected <= 1)) return fail(path, 'log_p', actual, expected, `expected p-value ${expected} is outside the valid domain [0, 1]`);
  return undefined;
}

function compareLogP(actual: unknown, expected: unknown, toleranceValue: number, path: string): FieldVerdict {
  const guard = nanOrTypeGuard(actual, expected, 'log_p', path);
  if (guard) return guard;
  const a = actual as number;
  const e = expected as number;
  const domainFailure = checkPDomain(a, e, path);
  if (domainFailure) return domainFailure;
  const clampedA = Math.max(a, LOG_P_EPS);
  const clampedE = Math.max(e, LOG_P_EPS);
  const deviation = Math.abs(Math.log(clampedA) - Math.log(clampedE));
  const status = deviation <= toleranceValue ? 'pass' : 'fail';
  return { path, status, toleranceKind: 'log_p', observed: a, expected: e, deviation, message: `|log diff| ${deviation} vs tolerance ${toleranceValue}` };
}

/** One leaf comparison — dispatches on `kind` (mirrors `_compare_leaf`). */
function compareLeaf(actual: unknown, expected: unknown, kind: ToleranceKind, toleranceValue: number, path: string): FieldVerdict {
  if (kind === 'exact') return compareExact(actual, expected, path);
  if (kind === 'relative') return compareScaled(actual, expected, toleranceValue, path, kind, true);
  if (kind === 'absolute') return compareScaled(actual, expected, toleranceValue, path, kind, false);
  if (kind === 'monte_carlo') return compareScaled(actual, expected, toleranceValue, path, kind, false);
  if (kind === 'log_p') return compareLogP(actual, expected, toleranceValue, path);
  throw new Error(`unknown tolerance kind '${kind as string}'`); // exhaustive; unreachable is a programmer error
}

/** Dispatches a leaf vs array vs record comparison, like `_compare_recursive`. */
function compareRecursive(actual: unknown, expected: unknown, kind: ToleranceKind, toleranceValue: number, path: string): FieldVerdict {
  if (Array.isArray(expected)) return compareArray(actual, expected, kind, toleranceValue, path);
  if (expected !== null && typeof expected === 'object') return compareRecord(actual, expected as Record<string, unknown>, kind, toleranceValue, path);
  return compareLeaf(actual, expected, kind, toleranceValue, path);
}

function compareArray(actual: unknown, expected: readonly unknown[], kind: ToleranceKind, toleranceValue: number, path: string): FieldVerdict {
  if (!Array.isArray(actual)) return fail(path, kind, actual, expected, `type mismatch: expected array, observed ${typeof actual}`);
  if (actual.length !== expected.length) {
    return fail(path, kind, actual, expected, `array length mismatch: expected ${expected.length}, observed ${actual.length}`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    const leaf = compareRecursive(actual[i], expected[i], kind, toleranceValue, `${path}[${i}]`);
    if (leaf.status === 'fail') return leaf;
  }
  return pass(path, kind, actual, expected);
}

function compareRecord(
  actual: unknown,
  expected: Record<string, unknown>,
  kind: ToleranceKind,
  toleranceValue: number,
  path: string,
): FieldVerdict {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    return fail(path, kind, actual, expected, `type mismatch: expected record, observed ${typeof actual}`);
  }
  const actualRecord = actual as Record<string, unknown>;
  const missing = Object.keys(expected).filter((key) => !(key in actualRecord));
  if (missing.length > 0) return fail(path, kind, actual, expected, `record missing key(s): ${JSON.stringify(missing)}`);
  for (const key of Object.keys(expected)) {
    const leaf = compareRecursive(actualRecord[key], expected[key], kind, toleranceValue, `${path}.${key}`);
    if (leaf.status === 'fail') return leaf;
  }
  return pass(path, kind, actual, expected);
}

/**
 * One `ExpectedOutput` entry vs the corresponding field already read (and
 * already decoded — see the module header) off a real governed run's
 * stored result.
 */
export function compareField(
  actualRaw: unknown,
  path: string,
  expectedValue: unknown,
  expectedIsNull: boolean,
  nullable: boolean,
  kind: ToleranceKind,
  toleranceValue: number,
): FieldVerdict {
  const actual = actualRaw === undefined ? MISSING : actualRaw;
  if (actual === MISSING) return fail(path, kind, '<missing>', expectedValue, 'actual output is missing this field');
  if (expectedIsNull) {
    if (!nullable) return fail(path, kind, actual, null, 'field is declared non-nullable but the fixture expects null');
    if (actual === null || actual === undefined) return pass(path, kind, actual, null);
    return fail(path, kind, actual, null, 'expected null (NA), observed a non-null value');
  }
  if (actual === null || actual === undefined) return fail(path, kind, null, expectedValue, 'expected a value, observed null (NA)');
  return compareRecursive(actual, expectedValue, kind, toleranceValue, path);
}

export interface ExpectedOutput {
  readonly field: string;
  readonly value: unknown;
  readonly null?: boolean;
  readonly toleranceKind: ToleranceKind;
  readonly toleranceValue: number;
  readonly nullable: boolean;
}

/**
 * Mirrors `schema.py#ExpectedRefusal` as of AXI-1957 (bio-compute
 * origin/main `cd0aa85`): `messageContains` is MANDATORY, never optional —
 * `code` alone is not a positive tie to the observed reason (a single- or
 * zero-precondition method's refusal code is assigned by precondition
 * COUNT, not by which precondition actually fired; see `schema.py`'s own
 * `ExpectedRefusal` docstring). A fixture omitting it is a fixture-authoring
 * bug this port must not silently tolerate.
 */
export interface ExpectedRefusal {
  readonly code: string;
  readonly severity: 'hard' | 'soft';
  readonly messageContains: string;
}

export interface FixtureVerdict {
  readonly status: 'pass' | 'fail';
  readonly fieldVerdicts: readonly FieldVerdict[];
}

/**
 * Mirrors `_compare_refusal_fields`: code/severity exact, message a
 * substring check. `messageContains` is mandatory on `ExpectedRefusal`
 * (AXI-1957) — this function requires a non-empty string, matching the
 * schema-level `NonEmptyStr` constraint, rather than treating a missing
 * value as "skip the message check" the way a pre-AXI-1957 fixture might.
 */
function compareRefusalFields(actual: Record<string, unknown>, expected: ExpectedRefusal): FieldVerdict {
  if (typeof expected.messageContains !== 'string' || expected.messageContains.length === 0) {
    throw new Error("unsupported fixture shape: refusal fixture is missing the mandatory 'message_contains' (AXI-1957, FR16)");
  }
  const codeOk = actual.code === expected.code;
  const severityOk = actual.severity === expected.severity;
  const messageOk = String(actual.message ?? '').includes(expected.messageContains);
  const status = codeOk && severityOk && messageOk ? 'pass' : 'fail';
  const message = status === 'pass' ? 'refusal matches' : `refusal mismatch: observed ${JSON.stringify(actual)}`;
  return { path: 'refusal', status, toleranceKind: 'exact', observed: actual, expected: expected.code, deviation: null, message };
}

export type RoundTripFixtureCase =
  | { readonly caseKind: 'nominal' | 'boundary' | 'degenerate'; readonly expected: readonly ExpectedOutput[] }
  | { readonly caseKind: 'refusal'; readonly expectedRefusal: ExpectedRefusal };

/**
 * Compare a real result object against a fixture case. THROWS (never
 * silently passes or skips) on a fixture shape this port does not
 * recognise — this is what keeps an unported case (e.g. AXI-1957's
 * not-yet-merged multi-row `expected_rows` shape) loud rather than a false
 * pass. See the module header's ported/not-ported list.
 */
export function compareFixture(actual: Record<string, unknown>, fixture: RoundTripFixtureCase): FixtureVerdict {
  if (fixture.caseKind === 'refusal') {
    const verdict = compareRefusalFields(actual, fixture.expectedRefusal);
    return { status: verdict.status, fieldVerdicts: [verdict] };
  }
  if (fixture.caseKind === 'nominal' || fixture.caseKind === 'boundary' || fixture.caseKind === 'degenerate') {
    const fieldVerdicts = fixture.expected.map((e) =>
      compareField(actual[e.field], e.field, e.value, e.null === true, e.nullable, e.toleranceKind, e.toleranceValue),
    );
    const status = fieldVerdicts.every((v) => v.status === 'pass') ? 'pass' : 'fail';
    return { status, fieldVerdicts };
  }
  // Exhaustive over the ported case_kind union — an unrecognised shape
  // (including AXI-1957's unmerged `expected_rows`) must error here, never
  // fall through to a silent pass.
  throw new Error(`unsupported fixture shape: case_kind '${(fixture as { caseKind: string }).caseKind}' is not ported by this comparator`);
}
