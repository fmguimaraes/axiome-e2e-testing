import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  csvFacts,
  extensionFieldsOf,
  image1Question,
  isSingleStratifiedDunnRun,
  planShapeProblems,
  presetProblems,
  provisioningPlan,
  questionBody,
  sha256Hex,
  specificationBody,
  type CsvFacts,
  type FileKey,
  type NewModelPreset,
} from '../../tests/AXI-2630/harness/new-model-preset';

/**
 * UT-PRESET-2648-001 .. UT-PRESET-2648-015 and UT-PRESET-2648-026 .. UT-PRESET-2648-037
 * (epic AXI-2630 — AXI-2648, SI-042). Pure coverage of the new-model handover preset's plan
 * shape (ONE study, TWO files, FOUR questions — FR58), the image-1 single stratified Dunn run
 * over exactly 3 strata (FR59, L11, AC37), the preset-to-data-file match (FR12-equivalent),
 * and — review round 2 — the three defects that made the plan statically unlaunchable on the
 * live `question-data.resolver.ts` / CC18 path: the live-only `profilePin` gate, the per-file
 * canonical-field duplicate gate (mirrors `outcomeOf`'s `matched_twice`), and the required-field
 * cross-file cohesion gate (mirrors `neededFieldsOf`). IDs 016-025 are reserved by the sibling
 * `section-20.spec.ts` in this same directory — do not reuse them here. No network, no live
 * endpoint call. Run via `npm run harness:unit`. See `UT.md`.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const PRESET = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/handover/mag4-new-model-preset.json'), 'utf8')) as NewModelPreset;
const CSV_BY_FILE: Record<FileKey, CsvFacts> = {
  T1_LONG: csvFacts(readFileSync(path.join(ROOT, 'fixtures/handover/final_tableau1_long_synthetic.csv'), 'utf8')),
  T2: csvFacts(readFileSync(path.join(ROOT, 'fixtures/handover/final_tableau2_synthetic.csv'), 'utf8')),
};
const clone = (): NewModelPreset => JSON.parse(JSON.stringify(PRESET));
const LIVE_CONFIG_VERSION = 'immune_mediated_microbiota@1.0.0+sha256:0123456789abcdef';
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

// ── plan shape (FR58) ──────────────────────────────────────────────────────

test('UT-PRESET-2648-001 the committed preset is one study, two files and four questions', () => {
  assert.deepEqual(planShapeProblems(PRESET), []);
});

test('UT-PRESET-2648-002 a third file is refused as not matching FR58 (exactly two)', () => {
  const p = clone();
  p.files.push({ ...p.files[0], key: 'T2' as never });
  assert.ok(planShapeProblems(p).some((x) => x.includes('FR58 requires exactly 2')));
});

test('UT-PRESET-2648-003 a missing T1_LONG file is named explicitly', () => {
  const p = clone();
  p.files = p.files.filter((f) => f.key !== 'T1_LONG');
  assert.ok(planShapeProblems(p).some((x) => x === 'preset has no T1_LONG file'));
});

test('UT-PRESET-2648-004 a fifth question is refused as not matching FR58 (exactly four)', () => {
  const p = clone();
  p.questions.push({ ...p.questions[0], key: 'image-1-dup' });
  assert.ok(planShapeProblems(p).some((x) => x.includes('FR58 requires exactly 4')));
});

test('UT-PRESET-2648-005 the four questions cover images 1 to 4 exactly once', () => {
  const p = clone();
  p.questions[1].image = 1;
  assert.ok(planShapeProblems(p).some((x) => x.startsWith('preset questions carry images')));
});

// ── image 1 = ONE stratified Dunn run over exactly 3 strata (FR59, L11, AC37) ────────────────

test('UT-PRESET-2648-006 the image-1 question is a single stratified Dunn run over exactly 3 strata on T1_LONG', () => {
  const q = image1Question(PRESET)!;
  assert.equal(isSingleStratifiedDunnRun(q), true);
  assert.equal(q.dataFile, 'T1_LONG');
  assert.equal(q.template.templateId, 'T2');
  assert.deepEqual(q.parameters.stratifyBy, { column: 'reference', strata: ['ENT 059', 'CER 229', 'CER 215 et 234'] });
});

test('UT-PRESET-2648-007 the image-1 strata spell the §20 reference names byte for byte against the T1_LONG CSV', () => {
  const q = image1Question(PRESET)!;
  for (const stratum of q.parameters.stratifyBy!.strata!) {
    assert.ok((CSV_BY_FILE.T1_LONG.values.reference ?? []).includes(stratum), `"${stratum}" is not a reference value in the CSV`);
  }
});

test('UT-PRESET-2648-008 a stratifyBy with no explicit strata subset fails the gate (would draw 7 panels, §20 wants 3)', () => {
  const p = clone();
  const q = image1Question(p)!;
  delete q.parameters.stratifyBy!.strata;
  assert.equal(isSingleStratifiedDunnRun(q), false);
  assert.ok(presetProblems(p, CSV_BY_FILE).some((x) => x.includes('not a single stratified Dunn run')));
});

test('UT-PRESET-2648-009 dropping stratifyBy entirely turns image 1 into a plain (non-stratified) run', () => {
  const p = clone();
  const q = image1Question(p)!;
  delete q.parameters.stratifyBy;
  assert.equal(isSingleStratifiedDunnRun(q), false);
  assert.ok(presetProblems(p, CSV_BY_FILE).some((x) => x.includes('not a single stratified Dunn run')));
});

test('UT-PRESET-2648-010 image 1 restricts the comparison to exactly HD, IgG4-RD, SD', () => {
  const q = image1Question(PRESET)!;
  assert.deepEqual([...q.parameters.groups!].sort(), ['HD', 'IgG4-RD', 'SD'].sort());
});

test('UT-PRESET-2648-011 narrowing image-1 groups to two levels is no longer the HD/IgG4-RD/SD restriction', () => {
  const p = clone();
  const q = image1Question(p)!;
  q.parameters.groups = ['HD', 'IgG4-RD'];
  assert.equal(isSingleStratifiedDunnRun(q), false);
});

// ── preset vs committed data files ──────────────────────────────────────────

test('UT-PRESET-2648-012 the committed preset matches both committed data files with no problem', () => {
  assert.deepEqual(presetProblems(PRESET, CSV_BY_FILE), []);
});

test('UT-PRESET-2648-013 a field whose levels differ from the file values is refused', () => {
  const p = clone();
  const g = p.dataSpecification.fields.find((f) => f.name === 'cluster_selon_acr_eular_2019')!;
  g.levels = ['C1', 'C2', 'C3', 'c4'];
  assert.ok(presetProblems(p, CSV_BY_FILE).some((x) => x.includes('declares levels [C1, C2, C3, c4]')));
});

test('UT-PRESET-2648-014 a field declared against the wrong file is refused as not a column of it', () => {
  const p = clone();
  const f = p.dataSpecification.fields.find((f) => f.name === 'pct')!;
  f.file = 'T2';
  assert.ok(presetProblems(p, CSV_BY_FILE).some((x) => x.startsWith('field "pct" is not a column of file')));
});

test('UT-PRESET-2648-015 a question binding an undeclared field is refused', () => {
  const p = clone();
  p.questions[1].bindings[0].field = 'nope';
  assert.ok(presetProblems(p, CSV_BY_FILE).some((x) => x.includes('undeclared field "nope"')));
});

// ── review round 2: CC19/CC18 and the live launch path ─────────────────────

test('UT-PRESET-2648-026 a field with no canonicalField is refused, mirroring CC19', () => {
  const p = clone();
  const f = p.dataSpecification.fields.find((f) => f.name === 'igg4_g_l')!;
  (f as { canonicalField?: string }).canonicalField = '';
  assert.ok(presetProblems(p, CSV_BY_FILE).some((x) => x.includes('names no canonical field') && x.includes('CC19')));
});

test('UT-PRESET-2648-027 a platform field naming an unknown canonical field is refused, mirroring CC18', () => {
  const p = clone();
  const f = p.dataSpecification.fields.find((f) => f.name === 'igg4_g_l')!;
  f.canonicalField = 'not_a_real_canonical_field';
  assert.ok(presetProblems(p, CSV_BY_FILE).some((x) => x.includes('not one of the profile\'s known platform fields') && x.includes('CC18')));
});

test('UT-PRESET-2648-028 two fields in the SAME file sharing one canonical field are refused, mirroring outcomeOf matched_twice', () => {
  const p = clone();
  const a = p.dataSpecification.fields.find((f) => f.name === 'igg4_g_l')!;
  const b = p.dataSpecification.fields.find((f) => f.name === 'igg4_rd_ri')!;
  b.canonicalField = a.canonicalField;
  assert.ok(presetProblems(p, CSV_BY_FILE).some((x) => x.includes('matched_twice')));
});

test('UT-PRESET-2648-029 the SAME platform canonical field repeated across DIFFERENT files is not a duplicate', () => {
  const p = clone();
  const t1 = p.dataSpecification.fields.find((f) => f.name === 'pct')!;
  const t2 = p.dataSpecification.fields.find((f) => f.name === 'igg4_g_l')!;
  t2.canonicalField = t1.canonicalField;
  t2.canonicalFieldSource = 'platform';
  assert.ok(!presetProblems(p, CSV_BY_FILE).some((x) => x.includes('matched_twice')));
});

test('UT-PRESET-2648-030 the committed preset declares a distinct canonical field per field within each file', () => {
  for (const file of PRESET.files) {
    const keys = PRESET.dataSpecification.fields.filter((f) => f.file === file.key).map((f) => f.canonicalField);
    assert.deepEqual(keys.length, new Set(keys).size, `file ${file.key} has a repeated canonicalField`);
  }
});

test('UT-PRESET-2648-031 marking a field required across two files is refused, mirroring neededFieldsOf', () => {
  const p = clone();
  const f = p.dataSpecification.fields.find((f) => f.name === 'pct')!;
  f.required = true;
  assert.ok(presetProblems(p, CSV_BY_FILE).some((x) => x.includes('neededFieldsOf would make it unresolvable')));
});

test('UT-PRESET-2648-032 no field in the committed preset is required (every question would otherwise span two files)', () => {
  assert.ok(PRESET.dataSpecification.fields.every((f) => f.required === false));
});

test('UT-PRESET-2648-033 extensionFieldsOf lists exactly the 9 T2 columns that share a platform canonical field with a sibling', () => {
  const extensions = extensionFieldsOf(PRESET);
  assert.equal(extensions.length, 9);
  assert.ok(extensions.every((e) => e.file === 'T2'));
  assert.deepEqual(new Set(extensions.map((e) => e.key)).size, 9);
});

test('UT-PRESET-2648-034 provisioningPlan reads the live configVersion AFTER adding the extension (L3)', () => {
  const steps = provisioningPlan(PRESET).map((s) => s.kind);
  const addIndex = steps.indexOf('add_extension');
  const readIndex = steps.indexOf('read_live_config_version');
  assert.ok(addIndex !== -1 && readIndex !== -1 && addIndex < readIndex);
});

test('UT-PRESET-2648-035 specificationBody refuses a configVersion with no +sha256 suffix, and namespaces extension fields when it is well-formed', () => {
  assert.throws(() => specificationBody(PRESET, PROJECT_ID, 'immune_mediated_microbiota@1.0.0'), /\+sha256:/);
  const spec = specificationBody(PRESET, PROJECT_ID, LIVE_CONFIG_VERSION);
  assert.ok(spec.fields.every((f) => f.profilePin === LIVE_CONFIG_VERSION));
  assert.ok(spec.fields.every((f) => !('file' in f) && !('canonicalFieldSource' in f)));
  const ent059 = spec.fields.find((f) => f.name === 'microbiote_igg4_ent_059')!;
  assert.equal(ent059.canonicalField, `project.${PROJECT_ID}.igg4_coating_ent_059`);
  const group = spec.fields.find((f) => f.name === 'group')!;
  assert.equal(group.canonicalField, 'disease_group');
});

test('UT-PRESET-2648-036 questionBody resolves field names to server ids and throws on an unknown one', () => {
  const fieldIdByName = new Map(PRESET.dataSpecification.fields.map((f, i) => [f.name, `field-${i}`]));
  const body = questionBody(image1Question(PRESET)!, fieldIdByName);
  assert.deepEqual(
    body.bindings.map((b) => b.slot),
    ['groupingColumn', 'outcome'],
  );
  assert.ok(body.bindings.every((b) => b.field.startsWith('field-')));
  assert.throws(() => questionBody(image1Question(PRESET)!, new Map()), /no server fieldId/);
});

test('UT-PRESET-2648-037 csvFacts/sha256Hex are reused, not re-implemented, from the AXI-2598 harness', () => {
  assert.equal(
    sha256Hex(readFileSync(path.join(ROOT, 'fixtures/handover/final_tableau2_synthetic.csv'))),
    PRESET.files.find((f) => f.key === 'T2')!.sha256,
  );
});
