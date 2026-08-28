import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAssumptions } from './assumptionsCount';

/** UT-STAGE-151..153 (SI-044) — Capture Spec §5/AC8, AXI-1380. */

test('UT-STAGE-151 (AC8): evaluateAssumptions passes on exactly 3 active assumptions', () => {
  const assumptions = [{ status: 'active' }, { status: 'active' }, { status: 'active' }];
  assert.equal(evaluateAssumptions(assumptions).pass, true);
});

test('UT-STAGE-152 (FR9): evaluateAssumptions fails if the withheld 4th assumption were staged (4 active)', () => {
  const assumptions = [{ status: 'active' }, { status: 'active' }, { status: 'active' }, { status: 'active' }];
  const result = evaluateAssumptions(assumptions);
  assert.equal(result.pass, false);
  assert.match(result.detail, /4 active/);
});

test('UT-STAGE-153: evaluateAssumptions ignores withdrawn (non-active) assumptions when counting', () => {
  const assumptions = [{ status: 'active' }, { status: 'active' }, { status: 'active' }, { status: 'withdrawn' }];
  assert.equal(evaluateAssumptions(assumptions).pass, true);
});
