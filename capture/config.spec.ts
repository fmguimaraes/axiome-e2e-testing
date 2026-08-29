import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLOR_SCHEME, DEVICE_SCALE_FACTOR, VIEWPORT, masterPngPath } from './config';

/** UT-CAP-004..007 — FR19/AC14: the fixed capture config itself. These are
 *  the literal numbers the story's acceptance criteria name, pinned so a
 *  future edit that drifts them fails a fast unit test instead of only
 *  being caught by eyeballing a screenshot. */

test('UT-CAP-004 — export width is 2400px (AC14)', () => {
  assert.equal(VIEWPORT.width, 2400);
});

test('UT-CAP-005 — device scale factor is 2x (AC14)', () => {
  assert.equal(DEVICE_SCALE_FACTOR, 2);
});

test('UT-CAP-006 — theme is light (AC14)', () => {
  assert.equal(COLOR_SCHEME, 'light');
});

test('UT-CAP-007 — masterPngPath is stable and keyed only by master id', () => {
  // Arrange / Act
  const a = masterPngPath('M1');
  const b = masterPngPath('M1');
  const c = masterPngPath('M2');
  // Assert
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /masters\/M1\.png$/);
});
