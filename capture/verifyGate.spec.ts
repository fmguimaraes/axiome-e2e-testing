import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGatePasses } from './verifyGate';
import type { RuleResult } from '../staging/verify/types';

/**
 * UT-CAP-001..002 — FR18 gate, unit-tested as a pure function (AAA, no
 * network): `runVerifyGate` itself needs a live server, but the fail-closed
 * decision it makes is `assertGatePasses`, extracted specifically so this
 * gate's most important property — "capture cannot proceed on a single
 * failed rule" — is provable without one.
 */

function passing(rule: string): RuleResult {
  return { rule, pass: true, detail: 'ok' };
}

function failing(rule: string, detail: string): RuleResult {
  return { rule, pass: false, detail };
}

test('UT-CAP-001 — all rules passing does not throw', () => {
  // Arrange
  const results = [passing('r1'), passing('r2')];
  // Act / Assert
  assert.doesNotThrow(() => assertGatePasses(results));
});

test('UT-CAP-002 — one failing rule throws, naming the rule and detail', () => {
  // Arrange
  const results = [passing('r1'), failing('Capture Spec §18 — corpus', 'two datasets present')];
  // Act / Assert
  assert.throws(() => assertGatePasses(results), /Capture Spec §18 — corpus: two datasets present/);
});

test('UT-CAP-003 — empty result set does not throw (vacuously all pass)', () => {
  // Arrange
  const results: RuleResult[] = [];
  // Act / Assert
  assert.doesNotThrow(() => assertGatePasses(results));
});
