import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SYNTHETIC_GRADOS_CSV_FILENAME } from '../AXI-1604/fixtures/synthetic-grados-schema';

/**
 * AXI-1694 (epic AXI-1687 — FR56/FR57, SI-044). G·W5 — Seed fidelity.
 *
 * Scenarios §1 of `axiome-docs/manual-e2e/AXI-1687-Compiled-Planner-Answer-As-Asked.md`.
 *
 * FILE-LEVEL, API-FREE, NO PLANNER CALL. This story owns the synthetic Grados
 * seed GENERATOR and its committed fixture CSV, not a running backend — the
 * dataset semantic declaration that reads this fixture (AXI-1693) has not
 * merged yet, and this story's own acceptance (AC56/AC57) is about the CSV's
 * numeric properties, not about anything a live envelope resolves. No
 * `E2E_LIVE_LLM`, no Anthropic call, no tenant seed.
 *
 * ═══ THE DATA IS STILL SYNTHETIC ═══ See the generator's header
 * (`tests/AXI-1604/fixtures/generate-synthetic-grados-cohort.ts`) for the full
 * provenance statement. This story does not change that: it fixes HOW the
 * values are derived (parent chain, group/timepoint lymphocyte variance, a
 * real subject effect), not what they claim to be evidence of.
 *
 * Run headless: `npx playwright test tests/AXI-1687/AXI-1694-seed-fidelity`
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

function subjectIndex(subjectId: string): number {
  return Number(subjectId.split('-')[1]);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function pearsonR(xs: readonly number[], ys: readonly number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = Math.sqrt(mean(xs.map((x) => (x - mx) ** 2)));
  const sy = Math.sqrt(mean(ys.map((y) => (y - my) ** 2)));
  return cov / (sx * sy);
}

/** Lymphocyte count implied by a row's b_pct pair (b_pct is a direct lymphocyte share). */
function impliedLymphocytes(pctRow: Row, absRow: Row): number {
  return Number(absRow.b_pct) / (Number(pctRow.b_pct) / 100);
}

function pairedLymphocytes(rows: readonly Row[]) {
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

test(
  'AC56 — absolute counts recomputed from the parent chain match the declared containment set, and lymphocyte count is lower for pSS and for post-rituximab',
  { tag: ['@SI-044'] },
  async () => {
    const rows = readCsv();

    // Recomputed from the parent chain: every absolute_count nested child
    // (foxp3_pct of CD4, plasmablast_pct of B cells) is at most its real
    // parent's absolute value in the SAME row — not the flat lymphocyte count.
    const absRows = rows.filter((r) => r.unit === 'absolute_count');
    for (const r of absRows) {
      expect(Number(r.foxp3_pct), `${r.subject_id}@${r.timepoint}: foxp3 abs <= CD4 abs`).toBeLessThanOrEqual(
        Number(r.cd4_pct),
      );
      expect(
        Number(r.plasmablast_pct),
        `${r.subject_id}@${r.timepoint}: plasmablast abs <= B-cell abs`,
      ).toBeLessThanOrEqual(Number(r.b_pct));
    }

    // Grouped by disease and timepoint: pSS is lower than the other two groups
    // at baseline (lymphopenia), and post-rituximab is lower than the same
    // subjects' own baseline.
    const byGroup = new Map<string, number[]>();
    for (const r of rows) {
      if (r.timepoint !== 'baseline' || r.unit !== 'pct_of_parent') continue;
      const abs = rows.find((a) => a.subject_id === r.subject_id && a.timepoint === 'baseline' && a.unit === 'absolute_count');
      if (!abs) continue;
      const list = byGroup.get(r.disease_group) ?? [];
      list.push(impliedLymphocytes(r, abs));
      byGroup.set(r.disease_group, list);
    }
    const pss = mean(byGroup.get('pss') ?? []);
    expect(pss, 'pSS baseline lymphocyte mean below IgG4-RD').toBeLessThan(mean(byGroup.get('igg4_rd') ?? []));
    expect(pss, 'pSS baseline lymphocyte mean below healthy control').toBeLessThan(
      mean(byGroup.get('healthy_control') ?? []),
    );

    const paired = pairedLymphocytes(rows).filter((p) => p.arm === 'rituximab');
    expect(paired.length, 'at least one rituximab-treated subject has both timepoints').toBeGreaterThan(0);
    expect(mean(paired.map((p) => p.post)), 'post-rituximab lymphocyte mean below baseline').toBeLessThan(
      mean(paired.map((p) => p.baseline)),
    );
  },
);

test(
  'AC57 — the two readings of a measure disagree on at least one contrast, and r(baseline, post) > 0',
  { tag: ['@SI-044'] },
  async () => {
    const rows = readCsv();

    // r(baseline, post) > 0 — the subject effect is a real, testable property
    // of the seed, not an artefact this story is merely claiming.
    const paired = pairedLymphocytes(rows);
    const r = pearsonR(paired.map((p) => p.baseline), paired.map((p) => p.post));
    expect(r, `r(baseline, post) = ${r}`).toBeGreaterThan(0);

    // The two unit readings can disagree: among baseline igg4_rd subjects, at
    // least one pair ranks differently for foxp3_pct under pct_of_parent than
    // under absolute_count, because absolute_count now goes through the real
    // CD4 parent rather than a flat lymphocyte multiply.
    const igg4Baseline = rows.filter((r2) => r2.timepoint === 'baseline' && r2.disease_group === 'igg4_rd');
    const pctBySubject = new Map(
      igg4Baseline.filter((r2) => r2.unit === 'pct_of_parent').map((r2) => [r2.subject_id, Number(r2.foxp3_pct)]),
    );
    const absBySubject = new Map(
      igg4Baseline.filter((r2) => r2.unit === 'absolute_count').map((r2) => [r2.subject_id, Number(r2.foxp3_pct)]),
    );
    const subjects = [...pctBySubject.keys()];
    let disagreement = false;
    outer: for (const a of subjects) {
      for (const b of subjects) {
        if (a === b) continue;
        const pctOrder = pctBySubject.get(a)! > pctBySubject.get(b)!;
        const absOrder = absBySubject.get(a)! > absBySubject.get(b)!;
        if (pctOrder !== absOrder) {
          disagreement = true;
          break outer;
        }
      }
    }
    expect(disagreement, 'at least one subject pair ranks differently under the two representations').toBe(true);

    // The n % 17 === 0 overflow rows still violate the declared TFH-compartment
    // containment set, non-overflow rows still respect it — the deliberate
    // defect Q38 depends on is unchanged by this story (FR56).
    for (const r2 of rows.filter((row) => row.unit === 'pct_of_parent')) {
      const sum = Number(r2.tfh1_pct) + Number(r2.tfh2_pct) + Number(r2.tfh17_pct);
      const isOverflow = subjectIndex(r2.subject_id) % 17 === 0;
      expect(sum > 100).toBe(isOverflow);
    }
  },
);
