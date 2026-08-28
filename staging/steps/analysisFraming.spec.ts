import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alreadyStaged, isStageable, THRESHOLD_DECLARED_BEFORE_CONTRAST, toBackendType } from './analysisFraming';
import { TENANT_FIXTURE } from '../fixtures/tenantFixture';
import type { AssumptionFixture } from '../fixtures/types';

/**
 * UT-STAGE-020..028 (SI-044) — FR9's truth guard (AXI-1373's crux: three
 * assumptions always stage, the fourth only if its claim is true of this
 * run) and the idempotency check the re-stage loop relies on (NFR1).
 * See `staging/steps/UT.md`.
 */

function assumption(category: AssumptionFixture['category'], text = 'irrelevant for this check'): AssumptionFixture {
  return { category, text, authorHandle: 'cast-biologist' };
}

test('UT-STAGE-020: cohort_definition is always stageable', () => {
  assert.equal(isStageable(assumption('cohort_definition')), true);
});

test('UT-STAGE-021: data_filter is always stageable', () => {
  assert.equal(isStageable(assumption('data_filter')), true);
});

test('UT-STAGE-022: methodological_choice is always stageable', () => {
  assert.equal(isStageable(assumption('methodological_choice')), true);
});

test('UT-STAGE-023: threshold_provenance is withheld while the truth guard is closed (default false)', () => {
  assert.equal(THRESHOLD_DECLARED_BEFORE_CONTRAST, false);
  assert.equal(isStageable(assumption('threshold_provenance')), false);
});

test('UT-STAGE-024: AC8 at fixture level — TENANT_FIXTURE declares 4 assumption bodies (words), but exactly 3 pass the FR9 guard', () => {
  const declared = TENANT_FIXTURE.content.assumptions;
  assert.equal(declared.length, 4, 'the fixture holds all 4 assumption bodies (FR6: words, not a truth decision)');
  const stageable = declared.filter(isStageable);
  assert.equal(stageable.length, 3, 'AC8: the chip must read 3, not 4, while the threshold-provenance claim is untrue of this run');
  assert.deepEqual(
    stageable.map((a) => a.category).sort(),
    ['cohort_definition', 'data_filter', 'methodological_choice'].sort(),
  );
});

test('UT-STAGE-025: toBackendType maps the three FR9-staged categories verbatim (no translation needed)', () => {
  assert.equal(toBackendType('cohort_definition'), 'cohort_definition');
  assert.equal(toBackendType('data_filter'), 'data_filter');
  assert.equal(toBackendType('methodological_choice'), 'methodological_choice');
});

test('UT-STAGE-026: toBackendType maps threshold_provenance to domain_assumption (no direct backend enum match)', () => {
  assert.equal(toBackendType('threshold_provenance'), 'domain_assumption');
});

test('UT-STAGE-027 (NFR1): alreadyStaged is true for a matching active assumption — re-run does not duplicate', () => {
  const a = assumption('cohort_definition', 'Responders = RECIST CR/PR.');
  const existing = [{ type: 'cohort_definition', text: 'Responders = RECIST CR/PR.', status: 'active' }];
  assert.equal(alreadyStaged(existing, a), true);
});

test('UT-STAGE-028 (NFR1): alreadyStaged is false when the text differs — an edited fixture body re-stages', () => {
  const a = assumption('cohort_definition', 'New wording.');
  const existing = [{ type: 'cohort_definition', text: 'Old wording.', status: 'active' }];
  assert.equal(alreadyStaged(existing, a), false);
});

test('UT-STAGE-029 (NFR1): alreadyStaged is false when the matching prior entry was withdrawn — a withdrawn assumption is re-staged, not treated as still present', () => {
  const a = assumption('data_filter', 'Same text.');
  const existing = [{ type: 'data_filter', text: 'Same text.', status: 'withdrawn' }];
  assert.equal(alreadyStaged(existing, a), false);
});
