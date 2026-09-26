import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { SYNTHETIC_GRADOS_CSV_FILENAME } from '../../tests/AXI-1604/fixtures/synthetic-grados-schema';

/**
 * UT-GRADOS-1694-1..6 (epic AXI-1687 — FR56/FR57, SI-044). The seed-fidelity
 * fix to the synthetic Grados-shaped fixture: `generate-synthetic-grados-
 * cohort.ts` no longer derives `absolute_count` as a flat `pct × total
 * lymphocyte count` for nested subsets, lymphocyte count now varies by
 * disease group and by timepoint, and a per-subject random effect makes
 * baseline and post-treatment readings genuinely paired.
 *
 * These are GENERATOR INVARIANTS, read off the committed CSV — not a live
 * dataset, not a planner call, no `E2E_LIVE_LLM`. Regenerate via
 * `npx tsx tests/AXI-1604/fixtures/generate-synthetic-grados-cohort.ts` if the
 * generator changes; run this file via `npm run harness:unit`.
 *
 * WHAT THIS FILE DOES NOT COVER (recorded, not hidden — FR58). "Pairing
 * changes a paired result" (AC57) is a property of the STATISTIC that
 * consumes paired rows (a paired vs. unpaired test), not of the seed; it is
 * asserted where that statistic runs, not here. This file proves the seed
 * now CARRIES the subject effect (`r(baseline, post) > 0`, UT-GRADOS-1694-5)
 * that a paired statistic needs in order to differ from its unpaired twin.
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

function readCsv(): Row[] {
  const lines = readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])) as Row;
  });
}

/** `SUBJ-017` -> `17`. The generator's `n % 17 === 0` overflow index. */
function subjectIndex(subjectId: string): number {
  return Number(subjectId.split('-')[1]);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Pearson correlation coefficient. */
function pearsonR(xs: readonly number[], ys: readonly number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = Math.sqrt(mean(xs.map((x) => (x - mx) ** 2)));
  const sy = Math.sqrt(mean(ys.map((y) => (y - my) ** 2)));
  return cov / (sx * sy);
}

test('UT-GRADOS-1694-1: the TFH-compartment triad stays within its declared 100% total except on the declared overflow rows', () => {
  const rows = readCsv().filter((r) => r.unit === 'pct_of_parent');
  for (const r of rows) {
    const sum = Number(r.tfh1_pct) + Number(r.tfh2_pct) + Number(r.tfh17_pct);
    const residual = Number(r.tfh_residual_pct);
    if (subjectIndex(r.subject_id) % 17 === 0) {
      assert.ok(sum > 100 && residual < 0, `${r.subject_id}@${r.timepoint}: declared overflow row must exceed 100%`);
    } else {
      assert.ok(sum <= 100 && residual >= 0, `${r.subject_id}@${r.timepoint}: non-overflow row must stay within 100%`);
    }
  }
});

test('UT-GRADOS-1694-2: every nested absolute_count child is at most its real parent, not the flat lymphocyte count', () => {
  // foxp3_pct is a CD4 subset (base = cd4_pct's own absolute value, this row);
  // plasmablast_pct is a B-cell subset (base = b_pct's own absolute value).
  // Both are clamped to <= 100% of their parent at the pct_of_parent draw, so
  // the absolute_count reading must respect the SAME containment.
  const rows = readCsv().filter((r) => r.unit === 'absolute_count');
  assert.ok(rows.length > 0, 'absolute_count rows exist');
  for (const r of rows) {
    assert.ok(Number(r.foxp3_pct) <= Number(r.cd4_pct), `${r.subject_id}@${r.timepoint}: foxp3 abs <= CD4 abs`);
    assert.ok(
      Number(r.plasmablast_pct) <= Number(r.b_pct),
      `${r.subject_id}@${r.timepoint}: plasmablast abs <= B-cell abs`,
    );
  }
});

/** Lymphocyte count implied by a row's b_pct pair (b_pct is a direct lymphocyte share). */
function impliedLymphocytes(pctRow: Row, absRow: Row): number {
  return Number(absRow.b_pct) / (Number(pctRow.b_pct) / 100);
}

function baselineRowsByGroup(rows: readonly Row[]): Map<string, number[]> {
  const byKey = new Map<string, { pct?: Row; abs?: Row }>();
  for (const r of rows) {
    if (r.timepoint !== 'baseline') continue;
    const key = r.subject_id;
    const entry = byKey.get(key) ?? {};
    if (r.unit === 'pct_of_parent') entry.pct = r;
    else entry.abs = r;
    byKey.set(key, entry);
  }
  const out = new Map<string, number[]>();
  for (const { pct, abs } of byKey.values()) {
    if (!pct || !abs) continue;
    const list = out.get(pct.disease_group) ?? [];
    list.push(impliedLymphocytes(pct, abs));
    out.set(pct.disease_group, list);
  }
  return out;
}

test('UT-GRADOS-1694-3: baseline total lymphocyte count is lower for pSS than for the other two groups (pSS lymphopenia)', () => {
  const rows = readCsv();
  const byGroup = baselineRowsByGroup(rows);
  const pss = mean(byGroup.get('pss') ?? []);
  const igg4 = mean(byGroup.get('igg4_rd') ?? []);
  const healthy = mean(byGroup.get('healthy_control') ?? []);
  assert.ok(pss < igg4, `pSS mean (${pss}) below IgG4-RD mean (${igg4})`);
  assert.ok(pss < healthy, `pSS mean (${pss}) below healthy-control mean (${healthy})`);
});

/** Baseline vs. post-treatment implied lymphocyte counts, per treated subject. */
function pairedLymphocytes(rows: readonly Row[]): { subjectId: string; arm: string; baseline: number; post: number }[] {
  const bySubject = new Map<string, { baselinePct?: Row; baselineAbs?: Row; postPct?: Row; postAbs?: Row }>();
  for (const r of rows) {
    const entry = bySubject.get(r.subject_id) ?? {};
    if (r.timepoint === 'baseline' && r.unit === 'pct_of_parent') entry.baselinePct = r;
    if (r.timepoint === 'baseline' && r.unit === 'absolute_count') entry.baselineAbs = r;
    if (r.timepoint === 'post_treatment' && r.unit === 'pct_of_parent') entry.postPct = r;
    if (r.timepoint === 'post_treatment' && r.unit === 'absolute_count') entry.postAbs = r;
    bySubject.set(r.subject_id, entry);
  }
  const out: { subjectId: string; arm: string; baseline: number; post: number }[] = [];
  for (const [subjectId, e] of bySubject) {
    if (!e.baselinePct || !e.baselineAbs || !e.postPct || !e.postAbs) continue;
    out.push({
      subjectId,
      arm: e.baselinePct.treatment_arm,
      baseline: impliedLymphocytes(e.baselinePct, e.baselineAbs),
      post: impliedLymphocytes(e.postPct, e.postAbs),
    });
  }
  return out;
}

test('UT-GRADOS-1694-4: post-rituximab lymphocyte count is lower than the same subjects\' own baseline', () => {
  const paired = pairedLymphocytes(readCsv());
  const rituximab = paired.filter((p) => p.arm === 'rituximab');
  assert.ok(rituximab.length > 0, 'at least one rituximab-treated subject has both timepoints');
  assert.ok(
    mean(rituximab.map((p) => p.post)) < mean(rituximab.map((p) => p.baseline)),
    'mean post-rituximab lymphocyte count is below mean baseline for the same subjects',
  );
});

test('UT-GRADOS-1694-5: baseline and post-treatment lymphocyte counts are positively correlated within a subject (the subject effect is real)', () => {
  const paired = pairedLymphocytes(readCsv());
  const r = pearsonR(paired.map((p) => p.baseline), paired.map((p) => p.post));
  assert.ok(r > 0, `r(baseline, post) = ${r}, expected > 0`);
});

test('UT-GRADOS-1694-6: the two unit readings of a nested measure can disagree — a subject can rank differently under pct_of_parent than under absolute_count', () => {
  // Because absolute_count now goes through a real parent chain rather than a
  // flat lymphocyte multiply, two subjects' PERCENTAGE order for a nested
  // measure need not match their ABSOLUTE order — the parent varies
  // independently of the child's percentage. foxp3_pct (CD4 subset) is the
  // measure; find at least one disagreeing pair among baseline igg4_rd rows.
  const rows = readCsv().filter((r) => r.timepoint === 'baseline' && r.disease_group === 'igg4_rd');
  const pctBySubject = new Map(rows.filter((r) => r.unit === 'pct_of_parent').map((r) => [r.subject_id, Number(r.foxp3_pct)]));
  const absBySubject = new Map(rows.filter((r) => r.unit === 'absolute_count').map((r) => [r.subject_id, Number(r.foxp3_pct)]));
  const subjects = [...pctBySubject.keys()];
  let disagreement = false;
  for (const a of subjects) {
    for (const b of subjects) {
      if (a === b) continue;
      const pctOrder = pctBySubject.get(a)! > pctBySubject.get(b)!;
      const absOrder = absBySubject.get(a)! > absBySubject.get(b)!;
      if (pctOrder !== absOrder) {
        disagreement = true;
        break;
      }
    }
    if (disagreement) break;
  }
  assert.ok(disagreement, 'at least one subject pair ranks differently under pct_of_parent than under absolute_count');
});
