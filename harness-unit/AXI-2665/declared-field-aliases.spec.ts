import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  declarationWithFieldAliases,
  declaredFieldAliases,
} from '../../tests/AXI-2630/harness/declared-field-aliases';
import { csvFacts, type NewModelPreset } from '../../tests/AXI-2630/harness/new-model-preset';

/**
 * UT-PRESET-2665-001 .. UT-PRESET-2665-006 (epic AXI-2630, AXI-2665, FR76, AC57; SI-042). The
 * declaration the reproduction sends for the plan's extension fields, checked against the
 * committed preset and the committed reference file. No network.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const PRESET: NewModelPreset = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/handover/mag4-new-model-preset.json'), 'utf8'));
const WIDE_FILE = csvFacts(readFileSync(path.join(ROOT, 'fixtures/handover/final_tableau2_synthetic.csv'), 'utf8'));
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ALIASES = declaredFieldAliases(PRESET, PROJECT_ID, 'T2');

test('UT-PRESET-2665-001 the wide file declares one alias for each of the nine extension fields', () => {
  assert.equal(ALIASES.length, 9);
  assert.equal(new Set(ALIASES.map((a) => a.term)).size, 9);
});

test('UT-PRESET-2665-002 every declared column is a column of the reference file, spelled exactly', () => {
  for (const alias of ALIASES) assert.ok(WIDE_FILE.header.includes(alias.column), alias.column);
});

test('UT-PRESET-2665-003 every term is the namespaced field the plan binds', () => {
  const expected = PRESET.dataSpecification.fields
    .filter((f) => f.canonicalFieldSource === 'extension')
    .map((f) => `project.${PROJECT_ID}.${f.canonicalField}`);
  assert.deepEqual(ALIASES.map((a) => a.term), expected);
});

test('UT-PRESET-2665-004 the long file carries no extension field, so it declares nothing', () => {
  assert.deepEqual(declaredFieldAliases(PRESET, PROJECT_ID, 'T1_LONG'), []);
});

test('UT-PRESET-2665-005 a dataset with no declaration gets a minimal admissible body', () => {
  assert.deepEqual(declarationWithFieldAliases(null, ALIASES), { scopeRoles: [], aliases: ALIASES });
});

test('UT-PRESET-2665-006 an existing declaration keeps its members and another project\'s aliases', () => {
  const other = { term: 'project.22222222-2222-4222-8222-222222222222.x', column: 'eosinophils' };
  const bindings = [{ column: 'age', role: 'covariate' }];
  const current = { scopeRoles: [], templateColumnBindings: bindings, aliases: [other, ALIASES[0]] };
  const body = declarationWithFieldAliases(current, ALIASES);
  assert.deepEqual(body.templateColumnBindings, bindings);
  assert.deepEqual(body.aliases, [other, ...ALIASES]);
});
