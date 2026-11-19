import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { csvFacts, splitCsv, type NewModelPreset } from '../../tests/AXI-2630/harness/new-model-preset';

/**
 * UT-PRESET-2667-001 .. UT-PRESET-2667-006 (epic AXI-2630, AXI-2667, FR77, AC58). The preset's
 * chart declarations name levels the data files really hold, so a declared order or label can
 * never silently match nothing. No network. Run via `npm run harness:unit`. See `UT.md`.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, 'fixtures/handover', file), 'utf8');
const PRESET = JSON.parse(read('mag4-new-model-preset.json')) as NewModelPreset;
const LONG = read('final_tableau1_long_synthetic.csv');
const WIDE = csvFacts(read('final_tableau2_synthetic.csv'));

const question = (key: string) => PRESET.questions.find((q) => q.key === key)!;
const displayOf = (key: string) => question(key).parameters.chartDisplay!;

/** The image-1 values the figure draws: its three groups, its three panels. */
function imageOneValues(): number[] {
  const [header, ...rows] = splitCsv(LONG.replace(/^﻿/, ''));
  const column = (name: string) => header.indexOf(name);
  const { groups, stratifyBy } = question('image-1').parameters;
  return rows
    .filter((r) => groups!.includes(r[column('group')]) && stratifyBy!.strata!.includes(r[column('reference')]))
    .map((r) => Number(r[column('pct')]))
    .filter(Number.isFinite);
}

test('UT-PRESET-2667-001 image 1 declares median bars, no box and brackets against IgG4-RD only', () => {
  const display = displayOf('image-1');
  assert.equal(display.show_box, false);
  assert.equal(display.show_median, true);
  assert.deepEqual(display.pairwise, { reference_group: 'IgG4-RD' });
});

test('UT-PRESET-2667-002 image 1 orders exactly the groups and the panels the question compares', () => {
  const display = displayOf('image-1');
  const { groups, stratifyBy } = question('image-1').parameters;
  assert.deepEqual([...display.group_order!].sort(), [...groups!].sort());
  assert.deepEqual(display.facet_order, stratifyBy!.strata);
  assert.deepEqual(Object.keys(display.facet_labels!).sort(), [...stratifyBy!.strata!].sort());
});

test('UT-PRESET-2667-003 image 1 axis limits contain every drawn value', () => {
  const [low, high] = displayOf('image-1').y_range!;
  const values = imageOneValues();
  assert.ok(values.length > 0);
  assert.ok(Math.min(...values) >= low, `lowest value ${Math.min(...values)} is below ${low}`);
  assert.ok(Math.max(...values) <= high, `highest value ${Math.max(...values)} is above ${high}`);
});

test('UT-PRESET-2667-004 image 2 declares a log axis and labels every cluster of the file, in order', () => {
  const display = displayOf('image-2');
  assert.equal(display.log_y, true);
  assert.deepEqual([...display.group_order!].sort(), [...WIDE.values.cluster_selon_acr_eular_2019].sort());
  assert.deepEqual(display.group_order!.map((g) => display.group_labels![g]), ['Cluster 1', 'Cluster 2', 'Cluster 3', 'Cluster 4']);
});

test('UT-PRESET-2667-005 image 3 declares a log axis and labels the raw levels 0 and 1', () => {
  const display = displayOf('image-3');
  assert.equal(display.log_y, true);
  assert.deepEqual([...display.group_order!].sort(), [...WIDE.values.atteinte_pancreatique].sort());
  assert.deepEqual(display.group_labels, { '0': 'Absent', '1': 'Present' });
});

test('UT-PRESET-2667-006 image 4 declares no chart display', () => {
  assert.equal(question('image-4').parameters.chartDisplay, undefined);
});
