import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCharts } from './chartCountOrigin';
import type { ExistingSpec } from '../../steps/chartStaging';

/** UT-STAGE-134..137 (SI-044) — Capture Spec §6.1/§6.2/AC6, AXI-1380. */

function spec(title: string, origin: 'auto' | 'user'): ExistingSpec {
  return { id: title, title, origin };
}

test('UT-STAGE-134: evaluateCharts passes when every declared title exists with origin:"user"', () => {
  const specs = [spec('Volcano', 'user'), spec('Histogram', 'user')];
  assert.equal(evaluateCharts(specs, ['Volcano', 'Histogram']).pass, true);
});

test('UT-STAGE-135: evaluateCharts fails closed when a declared chart is missing live', () => {
  const specs = [spec('Volcano', 'user')];
  const result = evaluateCharts(specs, ['Volcano', 'Histogram']);
  assert.equal(result.pass, false);
  assert.match(result.detail, /Histogram/);
});

test('UT-STAGE-136 (AC6): evaluateCharts ignores an auto-origin spec sharing a declared title — origin, not title, decides', () => {
  const specs = [spec('Volcano', 'auto')];
  const result = evaluateCharts(specs, ['Volcano']);
  assert.equal(result.pass, false);
  assert.match(result.detail, /missing user-origin chart/);
});

test('UT-STAGE-137: evaluateCharts reports (does not fail on) a co-existing auto-origin spec once all user charts are present', () => {
  const specs = [spec('Volcano', 'user'), spec('Pvalue vs Basemean', 'auto')];
  const result = evaluateCharts(specs, ['Volcano']);
  assert.equal(result.pass, true);
  assert.match(result.detail, /1 origin:'auto' spec/);
});
