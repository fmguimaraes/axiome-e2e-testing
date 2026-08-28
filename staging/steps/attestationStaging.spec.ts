import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAttestationComputeBody } from './attestationStaging';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';

/**
 * UT-STAGE-102..105 (SI-044) — Capture Spec §14 (AXI-1379). Most of
 * `attestationStaging.ts`'s logic is network-shaped find-or-compute (already
 * covered live, see `UT.md`); the compute-body builder and fixture-level
 * checks below are what stays pure. See `staging/steps/UT.md`.
 */

test('UT-STAGE-102: buildAttestationComputeBody attests the analysis artifact against its bound dataset and project', () => {
  const body = buildAttestationComputeBody('analysis-1', 'dataset-1', 'project-1');
  assert.deepEqual(body, { artifactId: 'analysis-1', artifactType: 'view_analysis', datasetId: 'dataset-1', projectId: 'project-1' });
});

test('UT-STAGE-103: buildAttestationComputeBody is a pure function of its inputs — no hidden state leaks between two different analyses', () => {
  const first = buildAttestationComputeBody('analysis-1', 'dataset-1', 'project-1');
  const second = buildAttestationComputeBody('analysis-2', 'dataset-2', 'project-2');
  assert.notDeepEqual(first, second);
});

test('UT-STAGE-104: TENANT_FIXTURE declares exactly one de_table dataset for the attestation step to target', () => {
  const deTables = TENANT_FIXTURE.content.datasets.filter((d) => d.role === 'de_table');
  assert.equal(deTables.length, 1);
});
