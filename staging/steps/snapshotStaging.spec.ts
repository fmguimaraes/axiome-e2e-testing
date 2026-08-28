import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSnapshotByName, resolveDatasetIdForSnapshot, snapshotIsStale } from './snapshotStaging';
import { checkSnapshotDatasetRolesDeclared, checkSnapshotNamesUnique } from '../fixtures/validateFixture';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import type { SnapshotSummary } from './snapshotStaging';

/**
 * UT-STAGE-060..070 (SI-044) — FR11/AC10 (Capture Spec §4), the OQ6
 * follow-up's name-keyed snapshot reconciliation `snapshotStaging.ts` uses
 * to bind v2 to the real per-arm stratified dataset (and supersede a stale
 * prior v2 bound to the wrong one). See `staging/steps/UT.md`.
 */

function summary(id: string, version: number, name: string | null, datasetId = 'root-dataset'): SnapshotSummary {
  return { id, version, name, datasetId };
}

test('UT-STAGE-060 (FR11): resolveDatasetIdForSnapshot returns the root dataset for a snapshot with no datasetRole', () => {
  const id = resolveDatasetIdForSnapshot({ name: 'Snapshot v1' }, {}, 'root-dataset');
  assert.equal(id, 'root-dataset');
});

test('UT-STAGE-061 (OQ6): resolveDatasetIdForSnapshot resolves a declared datasetRole to its live dataset id', () => {
  const id = resolveDatasetIdForSnapshot(
    { name: 'Snapshot v2', datasetRole: 'stratified_de_table' },
    { stratified_de_table: 'strat-dataset-id' },
    'root-dataset',
  );
  assert.equal(id, 'strat-dataset-id');
});

test('UT-STAGE-062 (OQ6): resolveDatasetIdForSnapshot throws loudly when the declared role has no live dataset yet', () => {
  assert.throws(
    () => resolveDatasetIdForSnapshot({ name: 'Snapshot v2', datasetRole: 'stratified_de_table' }, {}, 'root-dataset'),
    /datasetRole "stratified_de_table"/,
  );
});

test('UT-STAGE-063 (NFR1): findSnapshotByName matches on name, not position', () => {
  const current = [summary('s2', 2, 'Snapshot v2'), summary('s1', 1, 'Snapshot v1')];
  assert.equal(findSnapshotByName(current, 'Snapshot v1')?.id, 's1');
  assert.equal(findSnapshotByName(current, 'Snapshot v2')?.id, 's2');
});

test('UT-STAGE-064 (NFR1): findSnapshotByName is undefined when no declared name has a live match yet', () => {
  const current = [summary('s1', 1, 'Snapshot v1')];
  assert.equal(findSnapshotByName(current, 'Snapshot v2'), undefined);
});

test('UT-STAGE-065 (OQ6): snapshotIsStale is false once the live datasetId already matches the declared target', () => {
  const existing = summary('s2', 2, 'Snapshot v2', 'strat-dataset-id');
  assert.equal(snapshotIsStale(existing, 'strat-dataset-id'), false);
});

test('UT-STAGE-066 (OQ6): snapshotIsStale is true for a v2 row still bound to the old (pooled) root dataset', () => {
  const existing = summary('s2', 2, 'Snapshot v2', 'root-dataset');
  assert.equal(snapshotIsStale(existing, 'strat-dataset-id'), true);
});

test('UT-STAGE-067 (AC10): checkSnapshotNamesUnique passes on the live TENANT_FIXTURE (v1/v2 distinct names)', () => {
  assert.deepEqual(checkSnapshotNamesUnique(TENANT_FIXTURE), []);
});

test('UT-STAGE-068 (AC10): checkSnapshotNamesUnique flags a duplicated snapshot name', () => {
  const fixture = {
    ...TENANT_FIXTURE,
    content: { ...TENANT_FIXTURE.content, snapshots: [{ name: 'Snapshot v1' }, { name: 'Snapshot v1' }] },
  };
  const violations = checkSnapshotNamesUnique(fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'AC10');
});

test('UT-STAGE-069 (FR11, Capture Spec §4): TENANT_FIXTURE declares v1 (pooled, no datasetRole) then v2 (real stratified, datasetRole set) in order', () => {
  const declared = TENANT_FIXTURE.content.snapshots;
  assert.equal(declared.length, 2);
  assert.equal(declared[0].name, 'Snapshot v1');
  assert.equal(declared[0].datasetRole, undefined);
  assert.match(declared[1].name, /ipilimumab/);
  assert.equal(declared[1].datasetRole, 'stratified_de_table');
});

test('UT-STAGE-070 (OQ6): checkSnapshotDatasetRolesDeclared passes on the live TENANT_FIXTURE', () => {
  assert.deepEqual(checkSnapshotDatasetRolesDeclared(TENANT_FIXTURE), []);
});

test('UT-STAGE-071 (OQ6): checkSnapshotDatasetRolesDeclared flags a snapshot pointing at an undeclared dataset role', () => {
  const fixture = {
    ...TENANT_FIXTURE,
    content: {
      ...TENANT_FIXTURE.content,
      // stratified_de_table IS declared by TENANT_FIXTURE — drop it so v2's
      // datasetRole reference genuinely dangles.
      datasets: TENANT_FIXTURE.content.datasets.filter((d) => d.role !== 'stratified_de_table'),
    },
  };
  const violations = checkSnapshotDatasetRolesDeclared(fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'FR6');
});
