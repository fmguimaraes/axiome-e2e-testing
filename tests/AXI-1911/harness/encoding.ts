/**
 * AXI-1921 (epic AXI-1911 — FR5, D8, SI-042; review bounce #1). A
 * TypeScript PORT of axiome-bio-compute's own non-finite JSON envelope
 * (`tests/validation/fixtures/encoding.py`, origin/main) — this is the
 * FIXTURE-file side encoding only (the `expected[].value` a round-trip
 * fixture declares), decoded ONCE, recursively, when a fixture is loaded —
 * exactly where `loader.py#parse_fixture` calls `decode_value`, never
 * inline per comparison leaf (`comparator.py` itself never touches the
 * envelope — this was bounce #1's main finding against the first draft of
 * this port).
 *
 * Plain JSON has no token for `NaN`/`Infinity`/`-Infinity`. The ONLY
 * accepted encoding, mirrored exactly, is the one-key envelope
 * `{"__float__": "nan" | "inf" | "-inf"}`. An object carrying `__float__`
 * plus any other key, or an unrecognised token, THROWS — never silently
 * passed through unstripped (the Python side's own bounce #1 finding,
 * `test_encoding.py::TestStrictEnvelope`).
 *
 * This module has NOTHING to do with how a real governed run's STORED
 * RESULT encodes a non-finite value over the public API — that is a
 * different, back-end-specific encoding, established separately in
 * `round-trip.ts#decodeActualTableValue` by reading `axiome-back`'s own
 * write/read path, not this fixture-file convention.
 */

export const NONFINITE_KEY = '__float__';

const DECODE: Record<string, number> = { nan: NaN, inf: Infinity, '-inf': -Infinity };

function nonFiniteToken(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  return value > 0 ? 'inf' : '-inf';
}

/** Recursively replace a non-finite number with its envelope (mirrors `encode_value`). */
export function encodeValue(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { [NONFINITE_KEY]: nonFiniteToken(value) };
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encodeValue(v);
    return out;
  }
  return value;
}

/**
 * Recursively replace a non-finite envelope with its number (mirrors
 * `decode_value`). Throws on a malformed envelope — see module doc.
 */
export function decodeValue(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && NONFINITE_KEY in (value as object)) {
    return decodeEnvelope(value as Record<string, unknown>);
  }
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = decodeValue(v);
    return out;
  }
  return value;
}

function decodeEnvelope(value: Record<string, unknown>): number {
  const keys = Object.keys(value).sort();
  if (keys.length !== 1 || keys[0] !== NONFINITE_KEY) {
    throw new Error(`malformed non-finite envelope: expected only the '${NONFINITE_KEY}' key, got ${JSON.stringify(keys)}`);
  }
  const token = value[NONFINITE_KEY];
  if (typeof token !== 'string' || !(token in DECODE)) {
    throw new Error(`unknown non-finite token '${String(token)}' for key '${NONFINITE_KEY}'`);
  }
  return DECODE[token];
}
