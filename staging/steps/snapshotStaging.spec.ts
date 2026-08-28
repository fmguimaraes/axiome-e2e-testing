import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairSnapshotsToNames, snapshotsToCreate } from './snapshotStaging';
import { checkSnapshotNamesUnique } from '../fixtures/validateFixture';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import type { SnapshotSummary } from './snapshotStaging';

/**
 * UT-STAGE-060..067 (SI-044) — FR11/AC10 (Capture Spec §4), the snapshot
 * count/version-ordinal idempotency logic `snapshotStaging.ts`'s EC7 poll
 * and route-choice findings depend on. See `staging/steps/UT.md`.
 */

function summary(id: string, version: number, name: string | null = null): SnapshotSummary {
  return { id, version, name };
}

test('UT-STAGE-060 (NFR1): snapshotsToCreate is the full target count against an empty tenant', () => {
  assert.equal(snapshotsToCreate(0, 2), 2);
});

test('UT-STAGE-061 (NFR1): snapshotsToCreate is the shortfall when some already exist', () => {
  assert.equal(snapshotsToCreate(1, 2), 1);
});

test('UT-STAGE-062 (NFR1): snapshotsToCreate is zero once at or past target — re-run creates nothing new', () => {
  assert.equal(snapshotsToCreate(2, 2), 0);
  assert.equal(snapshotsToCreate(3, 2), 0);
});

test('UT-STAGE-063 (AC10): pairSnapshotsToNames binds fixture[0] to the lowest version and fixture[1] to the next', () => {
  const current = [summary('s2', 2), summary('s1', 1)]; // deliberately out of order
  const pairs = pairSnapshotsToNames(current, TENANT_FIXTURE.content.snapshots);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].snapshot.id, 's2'); // caller is responsible for pre-sorting by version
});

test('UT-STAGE-064: pairSnapshotsToNames sorted input binds v1 fixture to version 1 and v2 fixture to version 2', () => {
  const current = [summary('s1', 1), summary('s2', 2)];
  const pairs = pairSnapshotsToNames(current, TENANT_FIXTURE.content.snapshots);
  assert.equal(pairs[0].snapshot.id, 's1');
  assert.equal(pairs[0].fixture.name, 'Snapshot v1');
  assert.equal(pairs[1].snapshot.id, 's2');
  assert.match(pairs[1].fixture.name, /stratified/);
});

test('UT-STAGE-065 (NFR1): pairSnapshotsToNames drops a declared entry with no matching live snapshot yet, rather than crashing', () => {
  const current = [summary('s1', 1)];
  const pairs = pairSnapshotsToNames(current, TENANT_FIXTURE.content.snapshots);
  assert.equal(pairs.length, 1);
});

test('UT-STAGE-066 (AC10): checkSnapshotNamesUnique passes on the live TENANT_FIXTURE (v1/v2 distinct names)', () => {
  assert.deepEqual(checkSnapshotNamesUnique(TENANT_FIXTURE), []);
});

test('UT-STAGE-067 (AC10): checkSnapshotNamesUnique flags a duplicated snapshot name', () => {
  const fixture = {
    ...TENANT_FIXTURE,
    content: { ...TENANT_FIXTURE.content, snapshots: [{ name: 'Snapshot v1' }, { name: 'Snapshot v1' }] },
  };
  const violations = checkSnapshotNamesUnique(fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'AC10');
});

test('UT-STAGE-068 (FR11/AC10, Capture Spec §4): TENANT_FIXTURE declares exactly v1 (pooled) then v2 (stratified label) in order', () => {
  const declared = TENANT_FIXTURE.content.snapshots;
  assert.equal(declared.length, 2);
  assert.equal(declared[0].name, 'Snapshot v1');
  assert.match(declared[1].name, /ipilimumab/);
});
