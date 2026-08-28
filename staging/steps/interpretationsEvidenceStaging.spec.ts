import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDeCitationContext, resolveEvidenceLinks } from './interpretationsEvidenceStaging';
import {
  checkComputedEvidenceParentDeclaredEarlier,
  checkEvidenceReferencesDeclared,
  checkEvidenceShape,
  checkEvidenceTitlesUnique,
  checkInterpretationCitationsDeclared,
  checkInterpretationsShape,
} from '../fixtures/validateFixture';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import type { SnapshotSummary } from './snapshotStaging';

/**
 * UT-STAGE-072..089 (SI-044) — FR12/AC11 (Capture Spec §9): evidence-kind
 * mapping (`buildDeCitationContext`), interpretation citation resolution
 * (`resolveEvidenceLinks` — the mechanism that produces the AC11 provenance
 * fork), and the fixture-level shape/reference checks each staging loop
 * depends on (NFR1). See `staging/steps/UT.md`.
 */

test('UT-STAGE-072: buildDeCitationContext cites each row with the dataset id/version as the opaque evidence_id/evidence_version reference', () => {
  const ctx = buildDeCitationContext('ds-1', '2', [{ gene: 'TP53' }, { gene: 'BRCA1' }], undefined);
  assert.equal(ctx.kind, 'de');
  assert.equal(ctx.evidence_id, 'ds-1');
  assert.deepEqual(ctx.cited_rows, [
    { evidence_id: 'ds-1', evidence_version: '2', row_id: 'TP53', gene_identifier: 'TP53' },
    { evidence_id: 'ds-1', evidence_version: '2', row_id: 'BRCA1', gene_identifier: 'BRCA1' },
  ]);
});

test('UT-STAGE-073: buildDeCitationContext defaults the view_state filter to padj<0.05 when no strata filter is given', () => {
  const ctx = buildDeCitationContext('ds-1', '1', [{ gene: 'TP53' }], undefined) as { view_state: { filters: unknown[] } };
  assert.deepEqual(ctx.view_state.filters, [{ column_id: 'padj', operator: '<', value: 0.05 }]);
});

test('UT-STAGE-074: buildDeCitationContext uses the declared strata filter in view_state when given', () => {
  const ctx = buildDeCitationContext('ds-1', '1', [{ gene: 'TP53' }], { column: 'stratum', value: 'ipi_naive' }) as { view_state: { filters: unknown[] } };
  assert.deepEqual(ctx.view_state.filters, [{ column_id: 'stratum', operator: '=', value: 'ipi_naive' }]);
});

test('UT-STAGE-075: buildDeCitationContext truncate_n tracks the actual cited row count', () => {
  const ctx = buildDeCitationContext('ds-1', '1', [{ gene: 'A' }, { gene: 'B' }, { gene: 'C' }], undefined) as { view_state: { ordering: { truncate_n: number } } };
  assert.equal(ctx.view_state.ordering.truncate_n, 3);
});

function snapshots(): SnapshotSummary[] {
  return [
    { id: 'snap-v1', version: 1, name: 'Snapshot v1', datasetId: 'ds-pooled' },
    { id: 'snap-v2', version: 3, name: 'Snapshot v2 — stratified', datasetId: 'ds-strat' },
  ];
}

test('UT-STAGE-076: resolveEvidenceLinks resolves an evidenceTitle citation to {evidenceId} — the AC11 fork mechanism', () => {
  const map = new Map([['Top genes', { id: 'ev-1' }]]);
  const links = resolveEvidenceLinks([{ evidenceTitle: 'Top genes' }], map, snapshots());
  assert.deepEqual(links, [{ evidenceId: 'ev-1' }]);
});

test('UT-STAGE-077: resolveEvidenceLinks resolves a snapshotName citation to {snapshotId} by NAME, not a hard-coded id', () => {
  const links = resolveEvidenceLinks([{ snapshotName: 'Snapshot v2 — stratified' }], new Map(), snapshots());
  assert.deepEqual(links, [{ snapshotId: 'snap-v2' }]);
});

test('UT-STAGE-078: resolveEvidenceLinks throws loudly on a citation naming an undeclared/unstaged evidence title', () => {
  assert.throws(() => resolveEvidenceLinks([{ evidenceTitle: 'Nope' }], new Map(), snapshots()), /undeclared\/unstaged evidence/);
});

test('UT-STAGE-079: resolveEvidenceLinks throws loudly on a citation naming an undeclared/unstaged snapshot name', () => {
  assert.throws(() => resolveEvidenceLinks([{ snapshotName: 'Nope' }], new Map(), snapshots()), /undeclared\/unstaged snapshot/);
});

test('UT-STAGE-080: resolveEvidenceLinks resolves multiple citations on one interpretation in order (the fork on the shared evidence)', () => {
  const map = new Map([
    ['A', { id: 'ev-a' }],
    ['B', { id: 'ev-b' }],
  ]);
  const links = resolveEvidenceLinks([{ evidenceTitle: 'A' }, { evidenceTitle: 'B' }], map, snapshots());
  assert.deepEqual(links, [{ evidenceId: 'ev-a' }, { evidenceId: 'ev-b' }]);
});

test('UT-STAGE-081 (AC11): checkEvidenceTitlesUnique passes on the live TENANT_FIXTURE', () => {
  assert.deepEqual(checkEvidenceTitlesUnique(TENANT_FIXTURE), []);
});

test('UT-STAGE-082 (AC11): checkEvidenceReferencesDeclared passes on the live TENANT_FIXTURE (every chart-derived/computed entry targets a real chart+snapshot)', () => {
  assert.deepEqual(checkEvidenceReferencesDeclared(TENANT_FIXTURE), []);
});

test('UT-STAGE-083: checkComputedEvidenceParentDeclaredEarlier passes on the live TENANT_FIXTURE (the computed entry is declared after its parent)', () => {
  assert.deepEqual(checkComputedEvidenceParentDeclaredEarlier(TENANT_FIXTURE), []);
});

test('UT-STAGE-084: checkComputedEvidenceParentDeclaredEarlier flags a computed entry whose parent is declared later (or not at all)', () => {
  const fixture = {
    ...TENANT_FIXTURE,
    content: {
      ...TENANT_FIXTURE.content,
      evidence: [
        { kind: 'computed' as const, title: 'C', text: 't', chartTitle: TENANT_FIXTURE.content.chartSpecs[0].title, snapshotName: 'Snapshot v1', parentEvidenceTitle: 'Not declared' },
      ],
    },
  };
  const violations = checkComputedEvidenceParentDeclaredEarlier(fixture);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'FR6');
});

test('UT-STAGE-085 (AC11): checkInterpretationCitationsDeclared passes on the live TENANT_FIXTURE', () => {
  assert.deepEqual(checkInterpretationCitationsDeclared(TENANT_FIXTURE), []);
});

test('UT-STAGE-086 (AC11): checkInterpretationsShape passes on the live TENANT_FIXTURE — 3 interpretations, >=1 by CN, >=1 citing evidence explicitly', () => {
  assert.deepEqual(checkInterpretationsShape(TENANT_FIXTURE), []);
});

test('UT-STAGE-087 (AC11): checkInterpretationsShape flags a fixture with no cast-clinician (CN) author', () => {
  const fixture = {
    ...TENANT_FIXTURE,
    content: { ...TENANT_FIXTURE.content, interpretations: TENANT_FIXTURE.content.interpretations.map((i) => ({ ...i, authorHandle: 'cast-biologist' })) },
  };
  const violations = checkInterpretationsShape(fixture);
  assert.ok(violations.some((v) => v.detail.includes('cast-clinician')));
});

test('UT-STAGE-088 (AC11): checkEvidenceShape passes on the live TENANT_FIXTURE — 6 evidence, all 3 kinds represented', () => {
  assert.deepEqual(checkEvidenceShape(TENANT_FIXTURE), []);
});

test('UT-STAGE-089 (AC11): checkEvidenceShape flags a fixture missing one of the 3 kinds ("mixed kinds" violated)', () => {
  const fixture = {
    ...TENANT_FIXTURE,
    content: { ...TENANT_FIXTURE.content, evidence: TENANT_FIXTURE.content.evidence.filter((e) => e.kind !== 'computed') },
  };
  const violations = checkEvidenceShape(fixture);
  assert.ok(violations.some((v) => v.detail.includes('"computed"')));
});
