import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoDoNotShipContent, findDoNotShipViolations } from './doNotShip';

test('UT-CAP-037 — clean page text has no violations', () => {
  assert.deepEqual(findDoNotShipViolations('Volcano — pre-therapy responders vs non-responders'), []);
});

test('UT-CAP-038 — a dashed placeholder marker is flagged', () => {
  assert.ok(findDoNotShipViolations('Product screenshot · 3').length > 0);
});

test('UT-CAP-039 — a Safe Compare marker is flagged (case-insensitive)', () => {
  assert.ok(findDoNotShipViolations('safe compare results').length > 0);
});

test('UT-CAP-040 — assertNoDoNotShipContent throws, naming the master id', () => {
  assert.throws(() => assertNoDoNotShipContent('M3', 'rule catalog'), /M3: AC15 violation/);
});

test('UT-CAP-041 — assertNoDoNotShipContent does not throw on clean text', () => {
  assert.doesNotThrow(() => assertNoDoNotShipContent('M3', 'a normal chart title'));
});
