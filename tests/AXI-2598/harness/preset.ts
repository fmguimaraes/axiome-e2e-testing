/**
 * AXI-2601 (epic AXI-2598 — FR10, FR12, EC6, EC7) — the handover preset definition and its
 * pre-provisioning checks. PURE: no I/O, no Playwright, so `harness-unit/AXI-2601` covers it.
 *
 * The preset file (`fixtures/handover/mag4-preset.json`) is the ONE source of every preset value
 * (FR10): protocol, study population, data specification, questions with pinned template versions.
 * The suite provisions from it and nothing else.
 */
import { createHash } from 'node:crypto';

export type SemanticRole = 'continuous' | 'grouping_two_levels' | 'grouping_three_plus_levels';
export type QuestionRole = 'primary' | 'key_secondary' | 'secondary' | 'exploratory';

export interface PresetField {
  name: string;
  label: string;
  semanticRole: SemanticRole;
  levels?: string[];
  controlLevels?: string[];
  unit?: string;
  required: boolean;
  description?: string;
}

export interface PresetBinding {
  slot: string;
  /** A preset field NAME (resolved to the server fieldId at provisioning). */
  field: string;
}

export interface PresetQuestion {
  key: string;
  text: string;
  role: QuestionRole;
  template: { templateId: 'T1' | 'T2' | 'T3' | 'T4' | 'T5'; templateVersion: string };
  estimand: {
    population: string;
    variable: string;
    intercurrentEvents: string;
    populationSummary: string;
    treatmentComparison: string;
  };
  bindings: PresetBinding[];
  parameters: { alpha: number; sidedness: 'two_sided' | 'greater' | 'less'; [k: string]: unknown };
  decisionCriterion: { kind: 'p_at_or_below_alpha'; direction?: 'positive' | 'negative' };
  /** The chart kind the result page is expected to default to (FR20 — recorded, not asserted here). */
  expectedChart: string;
}

export interface Preset {
  presetId: string;
  presetVersion: string;
  dataFile: { path: string; sha256: string; rows: number; columns: number };
  protocol: { title: string; objective: string; studyPopulation: string; text: string };
  plan: { title: string; studyPopulation: string };
  dataSpecification: { fields: PresetField[] };
  questions: PresetQuestion[];
}

export interface CsvFacts {
  header: string[];
  rows: number;
  /** Distinct non-blank values per column, in first-seen order. */
  values: Record<string, string[]>;
  /** Blank cells per column. */
  blanks: Record<string, number>;
}

/**
 * Template pins refused for ANY role until AXI-2526 ships (EC6): the whole-matrix main result of
 * T3/T5 `0.4` is never run, so pre-flight refuses `template_main_result_not_run`.
 */
export const REFUSED_PINS: ReadonlyArray<{ templateId: string; templateVersion: string; reason: string }> = [
  { templateId: 'T3', templateVersion: '0.4', reason: 'pre-flight refuses template_main_result_not_run (AXI-2526 not shipped)' },
  { templateId: 'T5', templateVersion: '0.4', reason: 'pre-flight refuses template_main_result_not_run (AXI-2526 not shipped)' },
];

/** Correlation templates whose `0.3` with more than one cell must be exploratory (CC9, EC7). */
const CORRELATION_TEMPLATES = new Set(['T3', 'T5']);

/** RFC-4180-enough CSV split: quoted cells, doubled quotes, CR/LF line ends. */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function csvFacts(text: string): CsvFacts {
  const [header = [], ...data] = splitCsv(text.replace(/^﻿/, ''));
  const values: Record<string, string[]> = {};
  const blanks: Record<string, number> = {};
  header.forEach((col, i) => {
    const seen: string[] = [];
    let blank = 0;
    for (const r of data) {
      const v = (r[i] ?? '').trim();
      if (v === '') blank++;
      else if (!seen.includes(v)) seen.push(v);
    }
    values[col] = seen;
    blanks[col] = blank;
  });
  return { header, rows: data.length, values, blanks };
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * FR12 / EC6 / EC7 — every problem that makes this preset unfit for this data file, at once.
 * Empty ⇒ the preset may be provisioned. Never "fixes" anything: a mismatch is refused.
 */
export function presetProblems(preset: Preset, csv: CsvFacts, fileSha256?: string): string[] {
  const problems: string[] = [];
  if (fileSha256 !== undefined && fileSha256 !== preset.dataFile.sha256) {
    problems.push(`data file sha256 ${fileSha256} ≠ preset.dataFile.sha256 ${preset.dataFile.sha256}`);
  }
  if (csv.rows !== preset.dataFile.rows) problems.push(`data file has ${csv.rows} rows, preset declares ${preset.dataFile.rows}`);
  if (csv.header.length !== preset.dataFile.columns) {
    problems.push(`data file has ${csv.header.length} columns, preset declares ${preset.dataFile.columns}`);
  }
  const names = preset.dataSpecification.fields.map((f) => f.name);
  names
    .filter((n, i) => names.indexOf(n) !== i)
    .forEach((n) => problems.push(`field "${n}" is declared twice`));
  for (const f of preset.dataSpecification.fields) {
    // Character for character — a case or spelling difference is a refusal, never a guess (EC2).
    if (!csv.header.includes(f.name)) {
      const near = csv.header.find((h) => h.toLowerCase() === f.name.toLowerCase());
      problems.push(`field "${f.name}" is not a column of the data file${near ? ` (the file has "${near}")` : ''}`);
      continue;
    }
    const grouping = f.semanticRole !== 'continuous';
    if (grouping) {
      const fileLevels = csv.values[f.name] ?? [];
      if (!f.levels || !sameSet(f.levels, fileLevels)) {
        problems.push(`field "${f.name}" declares levels [${(f.levels ?? []).join(', ')}], the file holds [${fileLevels.join(', ')}]`);
      }
      const want = f.semanticRole === 'grouping_two_levels' ? 2 : 3;
      const n = f.levels?.length ?? 0;
      if (f.semanticRole === 'grouping_two_levels' ? n !== 2 : n < want) {
        problems.push(`field "${f.name}" is ${f.semanticRole} but declares ${n} level(s)`);
      }
      for (const c of f.controlLevels ?? []) {
        if (!f.levels?.includes(c)) problems.push(`field "${f.name}" control level "${c}" is not one of its levels`);
      }
    } else {
      if (f.levels !== undefined) problems.push(`field "${f.name}" is continuous but declares levels`);
      const nonNumeric = (csv.values[f.name] ?? []).filter((v) => !Number.isFinite(Number(v)));
      if (nonNumeric.length > 0) problems.push(`field "${f.name}" is continuous but the file holds non-numeric [${nonNumeric.slice(0, 3).join(', ')}]`);
    }
  }
  const keys = preset.questions.map((q) => q.key);
  keys.filter((k, i) => keys.indexOf(k) !== i).forEach((k) => problems.push(`question key "${k}" is used twice`));
  for (const q of preset.questions) {
    for (const b of q.bindings) {
      if (!names.includes(b.field)) problems.push(`question ${q.key} binds slot ${b.slot} to undeclared field "${b.field}"`);
    }
    const refused = REFUSED_PINS.find((p) => p.templateId === q.template.templateId && p.templateVersion === q.template.templateVersion);
    if (refused) problems.push(`question ${q.key} pins ${q.template.templateId}@${q.template.templateVersion}: ${refused.reason} (EC6)`);
    if (CORRELATION_TEMPLATES.has(q.template.templateId) && q.template.templateVersion === '0.3' && q.role !== 'exploratory') {
      const cells = cellCount(q);
      if (cells > 1) problems.push(`question ${q.key} is a ${cells}-cell correlation at 0.3 and must be exploratory, not ${q.role} (CC9, EC7)`);
    }
    if (!/^\d+\.\d+(\.\d+)?$/.test(q.template.templateVersion)) {
      problems.push(`question ${q.key} pins a non-concrete template version "${q.template.templateVersion}"`);
    }
  }
  return problems;
}

/** Cells of a correlation question: |first many-slot| × |second many-slot| (bindings grouped by slot). */
export function cellCount(q: PresetQuestion): number {
  const bySlot = new Map<string, number>();
  for (const b of q.bindings) bySlot.set(b.slot, (bySlot.get(b.slot) ?? 0) + 1);
  return [...bySlot.values()].reduce((a, n) => a * n, 1);
}

/** The v2 draft `dataSpecification` body for this preset (fieldIds are assigned by the server). */
export function specificationBody(preset: Preset): { fields: PresetField[] } {
  return {
    fields: preset.dataSpecification.fields.map((f) => ({
      name: f.name,
      label: f.label,
      semanticRole: f.semanticRole,
      ...(f.levels ? { levels: [...f.levels] } : {}),
      ...(f.controlLevels ? { controlLevels: [...f.controlLevels] } : {}),
      ...(f.unit ? { unit: f.unit } : {}),
      required: f.required,
      ...(f.description ? { description: f.description } : {}),
    })),
  };
}

/** A v2 question body: bindings by server fieldId (FR5). Throws on an unknown field name. */
export function questionBody(q: PresetQuestion, fieldIdByName: ReadonlyMap<string, string>) {
  return {
    text: q.text,
    role: q.role,
    estimand: { ...q.estimand },
    template: { ...q.template },
    bindings: q.bindings.map((b) => {
      const field = fieldIdByName.get(b.field);
      if (!field) throw new Error(`question ${q.key}: no server fieldId for "${b.field}"`);
      return { slot: b.slot, field };
    }),
    parameters: { ...q.parameters },
    decisionCriterion: { ...q.decisionCriterion },
    sensitivityAnalyses: [],
  };
}

/** FR12 for the mapping step: the identity mapping spec field name → same-named column. */
export function expectedMapping(preset: Preset, fieldIdByName: ReadonlyMap<string, string>): Array<{ fieldId: string; column: string }> {
  return preset.dataSpecification.fields.map((f) => ({ fieldId: fieldIdByName.get(f.name) as string, column: f.name }));
}
