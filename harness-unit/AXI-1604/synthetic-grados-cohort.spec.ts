import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { renderSyntheticGradosCsv } from '../../tests/AXI-1604/fixtures/generate-synthetic-grados-cohort';
import {
  declaredCategories,
  SYNTHETIC_GRADOS_COLUMNS,
  SYNTHETIC_GRADOS_CSV_FILENAME,
} from '../../tests/AXI-1604/fixtures/synthetic-grados-schema';

/**
 * UT-GRADOS-1677-1..5 (epic AXI-1604 — FR28/FR29/FR30, SI-042). The synthetic
 * Grados-shaped fixture: that it matches the schema FR29 DECLARED, that it seats
 * the bank's question structure, and that it regenerates byte-identically.
 *
 * ═══ THE FILE IS SYNTHETIC ═══ No cohort-level Grados dataset exists anywhere;
 * the paper published summary tables only. The COLUMN SCHEMA is transcribed from
 * `GRADOS_DATASET` (the `PlannerDatasetSchema` all 46 golden `AnalysisIntent`s
 * were hand-authored against); the VALUES are fixed-seed PRNG output. It exists
 * so the compiled planner can be measured on questions that have a matching
 * column, and it is NOT evidence about IgG4-RD.
 *
 * WHY A DRIFT GUARD (UT-GRADOS-1677-5). `synthetic-grados-schema.ts` is a COPY
 * of a declaration that lives in another repo — the two share no package, so the
 * copy is unavoidable. What is avoidable is the copy drifting: a column renamed
 * or a category domain changed on the `axiome-back` side would leave the seeded
 * dataset quietly seating the OLD schema, and the next gate measurement would be
 * against a dataset the golden intents no longer describe. The guard reads the
 * declaring fixture from the sibling checkout and fails on any disagreement.
 *
 * Run via `npm run harness:unit`. See `UT.md` in `harness-unit/`.
 */

const CSV_PATH = path.join(
  process.cwd(),
  'tests',
  'AXI-1604',
  'fixtures',
  SYNTHETIC_GRADOS_CSV_FILENAME,
);

interface Row {
  [column: string]: string;
}

function readCsv(): { header: string[]; rows: Row[] } {
  const lines = readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])) as Row;
  });
  return { header, rows };
}

test('UT-GRADOS-1677-1: the CSV header is exactly the declared GRADOS_DATASET columns, in declaration order', () => {
  const { header } = readCsv();
  assert.deepEqual(header, SYNTHETIC_GRADOS_COLUMNS.map((c) => c.name));
});

test('UT-GRADOS-1677-2: every categorical column observes its declared domain exactly — no stray level, no missing level', () => {
  // The profiler reports the OBSERVED domain. If the file carries a level the
  // schema does not declare, the live envelope contradicts the golden intents;
  // if it omits one, a bank question that filters on it has nothing to bind to.
  const { rows } = readCsv();
  for (const [name, declared] of declaredCategories()) {
    const observed = new Set(rows.map((r) => r[name]).filter((v) => v.length > 0));
    assert.deepEqual(
      [...observed].sort(),
      [...declared].sort(),
      `${name}: observed levels match the declared domain`,
    );
  }
});

test('UT-GRADOS-1677-3: the cohort and longitudinal structure the bank asks about is present', () => {
  const { rows } = readCsv();
  const subjects = new Map<string, Row[]>();
  for (const r of rows) {
    const list = subjects.get(r.subject_id) ?? [];
    list.push(r);
    subjects.set(r.subject_id, list);
  }

  // Three disease groups (Q1-Q6 are three-group comparisons).
  const groups = new Set(rows.map((r) => r.disease_group));
  assert.deepEqual([...groups].sort(), ['healthy_control', 'igg4_rd', 'pss']);

  // Treated subjects carry TWO timepoints, untreated ONE — Q13-Q16 are
  // baseline-to-post-treatment, and Q17 asks about the subjects who have no
  // post-treatment timepoint, which only exists if some genuinely do not.
  let treatedWithTwo = 0;
  let untreatedWithOne = 0;
  for (const [subjectId, subjectRows] of subjects) {
    const timepoints = new Set(subjectRows.map((r) => r.timepoint));
    if (subjectRows[0].treated_flag === 'treated') {
      assert.equal(timepoints.size, 2, `${subjectId}: a treated subject has both timepoints`);
      treatedWithTwo += 1;
    } else {
      assert.equal(timepoints.size, 1, `${subjectId}: an untreated subject has one timepoint`);
      untreatedWithOne += 1;
    }
    // Every subject-timepoint exists under BOTH representation levels — what
    // makes the `dual_representation` shape (Q7-Q10, Q12) answerable at all.
    const units = new Set(subjectRows.map((r) => r.unit));
    assert.deepEqual([...units].sort(), ['absolute_count', 'pct_of_parent'], `${subjectId}: both units`);
  }
  assert.ok(treatedWithTwo > 0 && untreatedWithOne > 0, 'both treated and untreated subjects exist');
});

test('UT-GRADOS-1677-4: the committed CSV regenerates byte-identically from its generator', () => {
  // A fixed seed and a fixed row order, so a diff in the CSV can only mean the
  // generator changed. Without this the file is an unreviewable blob.
  assert.equal(renderSyntheticGradosCsv(), readFileSync(CSV_PATH, 'utf8'));
});

test('UT-GRADOS-1677-5: the copied schema still matches GRADOS_DATASET in axiome-back', (t) => {
  const declaring = locateGradosFixture();
  if (!declaring) {
    // Not a silent pass: the sibling checkout is simply not present in this
    // environment, and the guard says so rather than pretending it ran.
    t.skip('axiome-back checkout not found beside this repo — drift guard not evaluated');
    return;
  }
  const source = readFileSync(declaring, 'utf8');
  const declared = parseDeclaredColumns(source);
  assert.ok(declared.length > 0, `no columns parsed out of ${declaring}`);
  assert.deepEqual(
    declared,
    SYNTHETIC_GRADOS_COLUMNS.map((c) => ({
      name: c.name,
      type: c.type,
      categories: 'categories' in c && c.categories ? [...c.categories] : undefined,
    })),
    'synthetic-grados-schema.ts has drifted from GRADOS_DATASET',
  );
});

/** The declaring fixture, in either the primary-checkout or worktree layout. */
function locateGradosFixture(): string | undefined {
  const rel =
    'axiome-back/apps/organization-service/src/guided-analysis/plan/compile/__fixtures__/grados-golden-intents.ts';
  const candidates = [
    path.resolve(process.cwd(), '..', rel), // axiome-global/axiome-e2e-testing
    path.resolve(process.cwd(), '..', '..', rel), // axiome-global/_worktrees/<wt>
  ];
  return candidates.find((c) => existsSync(c));
}

interface DeclaredColumn {
  name: string;
  type: string;
  categories?: string[];
}

/**
 * Pulls `GRADOS_DATASET`'s `columns` out of the declaring TypeScript source.
 *
 * Read as TEXT rather than imported: the two repos share no package and
 * `grados-golden-intents.ts` imports `@libs/contracts`, which does not resolve
 * from here. A regex over a hand-maintained literal is enough — and the
 * assertion it feeds is exact, so a parse that misses something fails loudly
 * rather than weakening the guard.
 */
function parseDeclaredColumns(source: string): DeclaredColumn[] {
  const block = source.slice(source.indexOf('export const GRADOS_DATASET'));
  const columns = block.slice(block.indexOf('columns: ['), block.indexOf('\n  representation:'));
  const out: DeclaredColumn[] = [];
  for (const entry of columns.matchAll(/\{([^{}]*?)\}/gs)) {
    const text = entry[1];
    const name = /name:\s*'([^']+)'/.exec(text)?.[1];
    const type = /type:\s*'([^']+)'/.exec(text)?.[1];
    if (!name || !type) continue;
    const categories = /categories:\s*\[([^\]]*)\]/.exec(text)?.[1];
    out.push({
      name,
      type,
      categories: categories
        ? [...categories.matchAll(/'([^']+)'/g)].map((m) => m[1])
        : undefined,
    });
  }
  return out;
}
