import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrecondition, findVolcanoSpec } from './m3VolcanoPublication';
import type { ExistingSpec } from '../../staging/steps/chartStaging';

const VOLCANO_TITLE = 'Volcano — pre-therapy responders vs non-responders (baseMean ≥ 10)';

test('UT-CAP-017 — findVolcanoSpec finds the user-origin volcano by exact title', () => {
  const charts: ExistingSpec[] = [
    { id: 'a', title: 'Other chart', origin: 'user' },
    { id: 'b', title: VOLCANO_TITLE, origin: 'user' },
  ];
  const found = findVolcanoSpec(charts);
  assert.equal(found?.id, 'b');
});

test('UT-CAP-018 — findVolcanoSpec ignores an auto-origin spec with the same title', () => {
  const charts: ExistingSpec[] = [{ id: 'a', title: VOLCANO_TITLE, origin: 'auto' }];
  assert.equal(findVolcanoSpec(charts), undefined);
});

test('UT-CAP-019 — M3 precondition throws when no volcano spec is found', () => {
  assert.throws(() => assertPrecondition(undefined), /precondition failed/);
});

test('UT-CAP-020 — M3 precondition does not throw when found', () => {
  assert.doesNotThrow(() => assertPrecondition({ id: 'b', title: VOLCANO_TITLE, origin: 'user' }));
});
