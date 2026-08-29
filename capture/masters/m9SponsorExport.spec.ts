import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublishedVersionExists } from './m9SponsorExport';

test('UT-CAP-034 — M9 precondition throws with no published version', () => {
  assert.throws(() => assertPublishedVersionExists(undefined), /no published version/);
});

test('UT-CAP-035 — M9 precondition does not throw with a published version id', () => {
  assert.doesNotThrow(() => assertPublishedVersionExists('229924ad-90c2-44c2-a088-1bf286d0e13b'));
});
