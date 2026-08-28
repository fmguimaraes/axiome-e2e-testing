import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allPass } from './verify';
import type { RuleResult } from './types';

/**
 * UT-STAGE-157..159 (SI-044) — FR18's own gate: `verify` MUST exit non-zero
 * on ANY violation. `main()` calls `process.exit(1)` when `!allPass(...)`,
 * so this is the pure boundary that decision is made at — see the story
 * report for the LIVE proof this fires (a mocked violation, since the
 * staged tenant currently holds no real one to induce).
 */

function ok(rule: string): RuleResult {
  return { rule, pass: true, detail: 'fine' };
}

function violated(rule: string): RuleResult {
  return { rule, pass: false, detail: 'broken' };
}

test('UT-STAGE-157: allPass is true when every rule passed', () => {
  assert.equal(allPass([ok('a'), ok('b'), ok('c')]), true);
});

test('UT-STAGE-158 (FR18): allPass is false when ANY single rule failed — the fail-closed gate', () => {
  assert.equal(allPass([ok('a'), violated('b'), ok('c')]), false);
});

test('UT-STAGE-159: allPass is false when every rule failed', () => {
  assert.equal(allPass([violated('a'), violated('b')]), false);
});
