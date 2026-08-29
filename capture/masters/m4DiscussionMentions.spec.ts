import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrecondition } from './m4DiscussionMentions';

test('UT-CAP-021 — M4 precondition throws with fewer than 3 live author names', () => {
  assert.throws(() => assertPrecondition(['Cast Bioinformatician', 'Cast Biologist']), /need >= 3/);
});

test('UT-CAP-046 — M4 precondition does not throw with 3 distinct live author names', () => {
  assert.doesNotThrow(() => assertPrecondition(['Cast Bioinformatician', 'Cast Biologist', 'Cast Clinician']));
});

test('UT-CAP-047 — M4 precondition does not throw with more than 3 (still satisfies "need >= 3")', () => {
  assert.doesNotThrow(() => assertPrecondition(['Léa Fontaine', 'Marc Ottavi', 'Claire Ngo', 'Staging Service']));
});
