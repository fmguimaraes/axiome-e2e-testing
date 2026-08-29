import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_PERMISSIONS, mergePermissions } from './ensureCapturePermissions';

test('UT-CAP-042 — mergePermissions unions without dropping existing entries', () => {
  const current = ['some:other-permission'];
  const merged = mergePermissions(current, ['view-analysis:view']);
  assert.ok(merged.includes('some:other-permission'));
  assert.ok(merged.includes('view-analysis:view'));
  assert.equal(merged.length, 2);
});

test('UT-CAP-043 — mergePermissions de-duplicates an already-present permission', () => {
  const current = ['view-analysis:view'];
  const merged = mergePermissions(current, ['view-analysis:view']);
  assert.deepEqual(merged, ['view-analysis:view']);
});

test('UT-CAP-044 — mergePermissions on an empty current list returns exactly the required set', () => {
  const merged = mergePermissions([], REQUIRED_PERMISSIONS);
  assert.deepEqual(new Set(merged), new Set(REQUIRED_PERMISSIONS));
});

test('UT-CAP-045 — REQUIRED_PERMISSIONS includes the view-analysis page gate', () => {
  assert.ok(REQUIRED_PERMISSIONS.includes('view-analysis:view'));
});
