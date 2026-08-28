import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMissingLiveDatasets, findPlaceholderGene } from './corpusConsistency';

/** UT-STAGE-118..120 (SI-044) — Capture Spec §2.2/AC5, AXI-1380. */

test('UT-STAGE-118: findMissingLiveDatasets is empty when every declared role resolves live', () => {
  const datasets = [{ role: 'de_table' }, { role: 'count_matrix' }] as { role: string }[];
  const byRole = new Map([['de_table', 'id-1'], ['count_matrix', 'id-2']]);
  assert.deepEqual(findMissingLiveDatasets(datasets as never, byRole), []);
});

test('UT-STAGE-119: findMissingLiveDatasets flags a declared role with no live match', () => {
  const datasets = [{ role: 'de_table' }, { role: 'stratified_de_table' }] as { role: string }[];
  const byRole = new Map([['de_table', 'id-1']]);
  assert.deepEqual(findMissingLiveDatasets(datasets as never, byRole), ['stratified_de_table']);
});

test('UT-STAGE-120a: findPlaceholderGene is undefined for real gene symbols', () => {
  assert.equal(findPlaceholderGene([{ gene: 'TP53' }, { gene: 'BRCA1' }]), undefined);
});

test('UT-STAGE-120b: findPlaceholderGene returns the first GENE00001-style placeholder found', () => {
  assert.equal(findPlaceholderGene([{ gene: 'TP53' }, { gene: 'GENE00042' }]), 'GENE00042');
});
