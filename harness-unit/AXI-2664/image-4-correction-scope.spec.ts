import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { NewModelPreset } from '../../tests/AXI-2630/harness/new-model-preset';

/**
 * UT-PRESET-2664-001 .. UT-PRESET-2664-003 (epic AXI-2630, AXI-2664, FR75, AC56; SI-042). The MAG4
 * image-4 question declares Benjamini-Hochberg within each reference, and only that question does.
 * No network, no live endpoint call. Run via `npm run harness:unit`. See `UT.md`.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const PRESET = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures/handover/mag4-new-model-preset.json'), 'utf8'),
) as NewModelPreset;
const imageFour = () => {
  const question = PRESET.questions.find((q) => q.key === 'image-4');
  assert.ok(question, 'the preset has an image-4 question');
  return question;
};

test('UT-PRESET-2664-001 the image-4 question declares the per-reference family', () => {
  assert.equal(imageFour().parameters.familyScope, 'per_reference');
});

test('UT-PRESET-2664-002 the image-4 estimand states the same family as its parameter', () => {
  assert.match(imageFour().estimand.populationSummary, /within each reference/);
  assert.doesNotMatch(imageFour().estimand.populationSummary, /across all cells/);
});

test('UT-PRESET-2664-003 no other question declares a correction family', () => {
  const others = PRESET.questions.filter((q) => q.key !== 'image-4');
  assert.deepEqual(others.filter((q) => 'familyScope' in q.parameters).map((q) => q.key), []);
});
