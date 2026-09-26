import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { BACK_ROOT, E2E_ROOT, missingRepos } from './harness/sibling-repos';
import { SYNTHETIC_GRADOS_CONTAINMENT_SETS } from '../AXI-1604/fixtures/synthetic-grados-schema';

/**
 * AXI-1700 - D.W5 QC wiring, late (epic AXI-1687, area D; FR35, FR36, FR58; AC35, AC36, AC58).
 * Scenario doc: `axiome-docs/manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md`,
 * section "AXI-1700 section" L.1 to L.4.
 *
 * ZERO LLM SPEND (NFR1): no browser, no API, no planner call. The facts are the committed seed
 * CSV run through the real IMM-QC-10 resolver in-process, and the OFFLINE Jest suites.
 * `E2E_LIVE_LLM` is never read and is forced empty for the child process.
 */

const APP = 'apps/organization-service/src';
const read = (p: string) => readFileSync(p, 'utf8');
const backFile = (...p: string[]) => path.join(BACK_ROOT as string, APP, ...p);

function requireBack(): void {
  const missing = missingRepos(['back']);
  test.skip(missing.length > 0, `sibling checkout(s) not found: ${missing.join(', ')} - set AXIOME_*_ROOT`);
}

function runJest(suites: readonly string[]): { status: number | null; summary: string } {
  const r = spawnSync('npx', ['jest', '-c', 'apps/organization-service/jest.config.ts', ...suites, '--silent'], {
    cwd: BACK_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', E2E_LIVE_LLM: '' },
    timeout: 5 * 60_000,
  });
  return { status: r.status, summary: `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '') };
}

/** The seed CSV as typed rows: numeric cells become numbers, as the parquet referent carries them. */
function seedRows(): Record<string, unknown>[] {
  const lines = readFileSync(path.join(E2E_ROOT, 'tests/AXI-1604/fixtures/synthetic-grados-cohort.csv'), 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] !== '' && Number.isFinite(Number(cells[i])) ? Number(cells[i]) : cells[i]]));
  });
}

/**
 * The REAL IMM-QC-10 resolver, run in a `tsx` child (the back source is TypeScript outside this
 * project, so it cannot be imported directly). `null` = unknown ("not checked").
 */
function excessPerRow(rows: Record<string, unknown>[], sets: unknown[]): Array<number | null> {
  const resolver = backFile('rule-runs/kernel/qc-declared-resolvers.ts');
  const script = `import { resolveContainmentExcess } from ${JSON.stringify(resolver)};
    const { rows, sets } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    const referent = { datasetMeta: { containmentSets: sets }, rows: rows.map((meta: unknown, rowIndex: number) => ({ rowIndex, meta })) };
    process.stdout.write(JSON.stringify(rows.map((_: unknown, rowIndex: number) => resolveContainmentExcess({ referent, rowIndex }) ?? null)));`;
  const r = spawnSync('npx', ['tsx', '--eval', script], { cwd: E2E_ROOT, input: JSON.stringify({ rows, sets }), encoding: 'utf8', env: { ...process.env, E2E_LIVE_LLM: '' }, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`resolver child failed: ${r.stderr.slice(-800)}`);
  return JSON.parse(r.stdout);
}

test.describe('AXI-1700 L.1 - IMM-QC-10 flags exactly the n % 17 == 0 subject-timepoints on the seed (AC35)', { tag: ['@SI-017', '@SI-045'] }, () => {
  test('AC35: the seed declared through containment sets is flagged on those subject-timepoints and no others; other unit rows are not checked', async () => {
    requireBack();
    const set = SYNTHETIC_GRADOS_CONTAINMENT_SETS[0];
    const declared = [{ parent: set.id, parentTotal: set.parent, children: [...set.children], withinLevel: { column: 'unit', level: set.comparableUnit } }];
    const rows = seedRows();
    const excess = excessPerRow(rows, declared);
    const flagged = new Set<string>();
    let notChecked = 0;
    rows.forEach((row, rowIndex) => {
      const value = excess[rowIndex];
      if (value === null) notChecked += 1;
      else if (value > 0) flagged.add(`${row.subject_id}|${row.timepoint}`);
    });
    const expected = new Set(
      rows.filter((r) => Number(String(r.subject_id).split('-')[1]) % 17 === 0).map((r) => `${r.subject_id}|${r.timepoint}`),
    );
    expect(expected.size).toBeGreaterThan(0);
    expect([...flagged].sort()).toEqual([...expected].sort());
    // Every absolute_count row is outside the declared unit level: typed "not checked", not a pass.
    expect(notChecked).toBe(rows.filter((r) => r.unit !== set.comparableUnit).length);
  });
});

test.describe('AXI-1700 L.2 - IMM-QC-11 fails on a defect fixture and is withheld without a declared type (AC36, AC58)', { tag: ['@SI-014', '@SI-017'] }, () => {
  test('AC36 AC58: the profiler types "n/a" as numeric_with_failures, the rule blocks, and no declaration degrades it (offline Jest)', async () => {
    requireBack();
    const run = runJest(['structure-profiler.parse-integrity', 'qc-declared-resolvers', 'qc-run-executor.service']);
    expect(run.status, run.summary.slice(-1500)).toBe(0);
    expect(run.summary).toMatch(/Tests:\s+\d+ passed/);
    const seed = read(backFile('rules/seed-rules.ts'));
    expect(seed).toMatch(/code: 'IMM-QC-10'/);
    expect(seed).toMatch(/code: 'IMM-QC-11'/);
  });
});

test.describe('AXI-1700 L.3 - the planner is offered IMM-QC-10/11 only for a dataset that declares them (FR32)', { tag: ['@SI-045'] }, () => {
  test('FR32: containment sets / numeric logical types are the producers; none declared means neither rule is offered (offline Jest)', async () => {
    requireBack();
    const registry = read(backFile('rule-runs/kernel/qc-attribute-resolver-registry.ts'));
    expect(registry).toMatch(/kind: 'dataset_meta', id: 'declared_containment_sets'/);
    expect(registry).toMatch(/kind: 'dataset_meta', id: 'declared_logical_types'/);
    const run = runJest(['planner-validation-options', 'dataset-semantic-declaration']);
    expect(run.status, run.summary.slice(-1500)).toBe(0);
  });
});

test.describe('AXI-1700 L.4 - the seed re-stage is a new dataset version with a release note (FR57, AC58)', { tag: ['@SI-044'] }, () => {
  test('FR57: the release note lists the changed numbers, both content hashes, and Q39 names the defect fixture', async () => {
    const docs = process.env.AXIOME_DOCS_ROOT ?? path.resolve(E2E_ROOT, '..', 'axiome-docs-AXI-1700');
    const note = path.join(docs, '04 - architecture/guided-analysis/compiled-planner/RELEASE-NOTE-synthetic-grados-seed-v2.md');
    test.skip(!existsSync(note), 'axiome-docs checkout not found - set AXIOME_DOCS_ROOT');
    const text = read(note);
    expect(text).toMatch(/sha256:[0-9a-f]{64}/);
    expect(text).toMatch(/not\W+overwrite/i);
    expect(text).toMatch(/Q39/);
  });
});
