/**
 * AXI-1677 (epic AXI-1604 — FR28/FR30, @SI-042). Generator for
 * `synthetic-grados-cohort.csv`.
 *
 * ═══ PROVENANCE — READ THIS BEFORE CITING ANY NUMBER OUT OF THE CSV ═══
 * EVERY VALUE IN THE GENERATED FILE IS SYNTHETIC. It is drawn from a fixed-seed
 * PRNG in this file. It is NOT the Grados 2017 IgG4-RD cohort, it is not derived
 * from it, and it is not evidence about IgG4-RD, about TFH biology, or about any
 * patient. Grados et al. published SUMMARY TABLES ONLY; no cohort-level
 * row-wise Grados dataset exists in any environment reachable from this repo,
 * and none is reconstructible from the paper.
 *
 * WHY IT EXISTS ANYWAY. The FR30 gate's condition (a) — "zero `unsupported` on
 * the bank, or each remaining one explicitly accepted in §18.2" — is a
 * measurement of the PLANNER, and a planner can only be measured on an envelope
 * that carries columns its questions can bind to. The 2026-09-25 shadow run
 * (`axiome-docs/reports/2026-09-25-compiled-planner-shadow-run.md`) was voided
 * because the envelope carried `columns: []`; AXI-1661/AXI-1662 made that
 * failure loud, but a loud failure is still not a measurement. The only real
 * dataset in the tenant (Riaz 2017 melanoma) shares no column with the Grados
 * bank's clinical/immunology vocabulary, so a run against it would measure a
 * domain mismatch rather than the planner.
 *
 * THE SCHEMA IS NOT INVENTED HERE. The column set, the types and every
 * categorical domain are copied verbatim from `GRADOS_DATASET` in
 * `axiome-back/apps/organization-service/src/guided-analysis/plan/compile/
 * __fixtures__/grados-golden-intents.ts` — the schema FR29 already declared and
 * hand-authored all 46 golden intents against. This file supplies ROWS for a
 * schema that was already decided; it does not get a vote on the schema.
 * `synthetic-grados-schema.ts` holds the copy this generator and the tests read,
 * and a unit test pins it against the declared fixture.
 *
 * Regenerate with:
 *   npx tsx tests/AXI-1604/fixtures/generate-synthetic-grados-cohort.ts
 * The output is byte-stable: the PRNG is seeded and the row order is fixed, so
 * re-running never produces a diff. If the CSV changes, the generator changed.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SYNTHETIC_GRADOS_COLUMNS,
  SYNTHETIC_GRADOS_CSV_FILENAME,
  type SyntheticGradosColumn,
} from './synthetic-grados-schema';

/** Fixed seed — the file must regenerate byte-identically. */
const SEED = 0x1677_2604;

/** mulberry32: small, deterministic, dependency-free. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = prng(SEED);

/** A value near `mean`, spread `sd`, clamped to `[min, max]`, 2 dp. */
function near(mean: number, sd: number, min: number, max: number): number {
  // Irwin-Hall(4) → roughly normal, bounded, no Math.random, no dependency.
  const u = rand() + rand() + rand() + rand() - 2;
  const v = mean + u * sd;
  return Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)];
}

const DISEASE_GROUPS = ['igg4_rd', 'healthy_control', 'pss'] as const;
type DiseaseGroup = (typeof DISEASE_GROUPS)[number];

/** Cohort sizes — 60 / 30 / 30, the shape of a mid-size single-centre cohort. */
const COHORT_SIZES: Record<DiseaseGroup, number> = {
  igg4_rd: 60,
  healthy_control: 30,
  pss: 30,
};

/** Of the 60 IgG4-RD subjects, these many are treated and have TWO timepoints. */
const TREATED_IGG4RD = 40;

/** Serum IgG4 cut-point the bank's Q28 names, in g/L. */
const IGG4_CUTPOINT = 1.35;

interface Subject {
  subjectId: string;
  group: DiseaseGroup;
  age: number;
  treated: boolean;
  treatmentArm: string | null;
  site: string;
  batch: string;
  flareStatus: string | null;
  organCount: number | null;
  storiformFibrosis: string | null;
  denominatorType: string | null;
  histologyRatio: number | null;
  igg4Serum: number;
  responderIndex: number | null;
  /** Absolute lymphocyte count (cells/µL) — the denominator the
   *  `absolute_count` representation is derived with. */
  lymphocyteCount: number;
  /**
   * DELIBERATE DATA-QUALITY INJECTION, subject-level so it is stable across a
   * subject's timepoints and representations. The bank contains `data_quality`
   * questions that are only ANSWERABLE if the condition they ask about actually
   * occurs somewhere in the file: Q37 ("how many cytokine values fall below the
   * limit of detection") needs some, and Q38 ("do any child populations exceed
   * their parent in comparable units?") needs some. Injected on a fixed subject
   * index so the count is exact and reproducible, never drawn from the tail of a
   * distribution and hoped for.
   */
  belowLod: boolean;
  subsetOverflow: boolean;
}

function buildSubjects(): Subject[] {
  const subjects: Subject[] = [];
  let n = 0;
  for (const group of DISEASE_GROUPS) {
    for (let i = 0; i < COHORT_SIZES[group]; i++) {
      n += 1;
      const isIgg4 = group === 'igg4_rd';
      const treated = isIgg4 && i < TREATED_IGG4RD;
      const organCount = isIgg4 ? 1 + Math.floor(rand() * 5) : null;
      const igg4Serum =
        group === 'igg4_rd' ? near(3.1, 1.6, 0.4, 9.5)
        : group === 'pss' ? near(0.9, 0.4, 0.15, 2.4)
        : near(0.6, 0.25, 0.1, 1.6);
      subjects.push({
        subjectId: `SUBJ-${String(n).padStart(3, '0')}`,
        group,
        age:
          group === 'igg4_rd' ? Math.round(near(62, 10, 40, 85))
          : group === 'pss' ? Math.round(near(54, 11, 30, 80))
          : Math.round(near(50, 12, 25, 75)),
        treated,
        treatmentArm: treated ? (i % 2 === 0 ? 'rituximab' : 'steroids_alone') : null,
        site: pick(['site_a', 'site_b', 'site_c']),
        batch: pick(['batch_1', 'batch_2']),
        flareStatus: isIgg4 ? pick(['first_flare', 'relapse']) : null,
        organCount,
        storiformFibrosis: isIgg4 ? pick(['present', 'absent']) : null,
        denominatorType: isIgg4 ? pick(['total_igg', 'igg_positive_cells']) : null,
        histologyRatio: isIgg4 ? near(0.48, 0.18, 0.05, 0.95) : null,
        igg4Serum,
        responderIndex: isIgg4 ? Math.round(near(9, 4, 0, 24)) : null,
        lymphocyteCount: Math.round(near(1900, 450, 700, 3400)),
        belowLod: n % 12 === 0,
        subsetOverflow: n % 17 === 0,
      });
    }
  }
  return subjects;
}

/** The immunological measures, in `pct_of_parent` units, for one subject-timepoint. */
interface Measures {
  tfh1_pct: number;
  tfh2_pct: number;
  tfh17_pct: number;
  pd1_tfh_pct: number;
  foxp3_pct: number;
  plasmablast_pct: number;
  cd4_pct: number;
  cd8_pct: number;
  nk_pct: number;
  b_pct: number;
  il4: number;
  il10: number;
  il17: number;
  ifng: number;
}

/**
 * Draws one subject-timepoint's measures. The group offsets are *plausible
 * ranges chosen to make the bank's questions answerable in both directions* —
 * they are NOT the paper's effect sizes and must never be read as such.
 */
function drawMeasures(s: Subject, postTreatment: boolean): Measures {
  const group = s.group;
  const arm = s.treatmentArm;
  const igg4 = group === 'igg4_rd';
  const pss = group === 'pss';
  // Treatment effect: rituximab depletes harder than steroids alone.
  const shrink = !postTreatment ? 1 : arm === 'rituximab' ? 0.55 : 0.8;
  // A subset-overflow subject's three TFH shares are inflated so they sum past
  // the 100 % parent compartment (see `Subject.subsetOverflow`).
  const overflow = s.subsetOverflow ? 1.65 : 1;
  // A below-LOD subject's cytokine releases sit under `LOD_FLOOR`.
  const cytokine = (mean: number, sd: number, max: number): number =>
    s.belowLod ? near(3, 2, 0, LOD_FLOOR - 0.5) : near(mean, sd, 0, max);
  return {
    tfh1_pct: near(igg4 ? 17 : 24, 5, 2, 45) * (postTreatment ? 1.05 : 1) * overflow,
    tfh2_pct: near(igg4 ? 21 : 12, 5, 1, 45) * shrink * overflow,
    tfh17_pct: near(igg4 ? 28 : 21, 6, 2, 55) * (postTreatment ? 0.95 : 1) * overflow,
    pd1_tfh_pct: near(igg4 ? 14 : 8, 3.5, 0.5, 30) * shrink,
    foxp3_pct: near(igg4 ? 8.5 : 5.5, 2, 0.5, 18),
    plasmablast_pct: near(igg4 ? 3.4 : 0.9, 1.2, 0.05, 9) * shrink,
    cd4_pct: near(pss ? 38 : 45, 7, 15, 70),
    cd8_pct: near(pss ? 21 : 25, 6, 8, 48),
    nk_pct: near(pss ? 8 : 11, 3, 1, 25),
    b_pct: near(pss ? 6 : 10, 3, 0.5, 24),
    il4: cytokine(igg4 ? 62 : 34, 20, 180),
    il10: cytokine(igg4 ? 88 : 51, 28, 260),
    il17: cytokine(igg4 ? 74 : 46, 24, 220),
    ifng: cytokine(pss ? 130 : 108, 40, 400),
  };
}

/** Below this pg/mL a cytokine reading is reported as below the limit of detection. */
const LOD_FLOOR = 8;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type Row = Record<SyntheticGradosColumn, string | number | null>;

/**
 * One CSV row per subject × timepoint × representation level. The representation
 * duplication is what makes the `dual_representation` shape (bank Q7–Q10, Q12)
 * answerable at all: the SAME measure under `pct_of_parent` and under
 * `absolute_count`, flagged `comparableAcrossLevels: false` by the declared
 * schema's `representation` role.
 */
function buildRows(subjects: readonly Subject[]): Row[] {
  const rows: Row[] = [];
  for (const s of subjects) {
    const timepoints = s.treated ? (['baseline', 'post_treatment'] as const) : (['baseline'] as const);
    for (const timepoint of timepoints) {
      const m = drawMeasures(s, timepoint === 'post_treatment');
      const belowLod = Math.min(m.il4, m.il10, m.il17, m.ifng) < LOD_FLOOR;
      for (const unit of ['pct_of_parent', 'absolute_count'] as const) {
        // `absolute_count` = the percentage applied to this subject's absolute
        // lymphocyte count — the same measurement in a different representation,
        // which is exactly why the two levels are not poolable.
        const asUnit = (pct: number): number =>
          unit === 'pct_of_parent' ? round2(pct) : Math.round((pct / 100) * s.lymphocyteCount);
        // Cytokine release (pg/mL) has no percentage/absolute duality; it is the
        // same value under both levels rather than a fabricated second reading.
        rows.push({
          subject_id: s.subjectId,
          age: s.age,
          disease_group: s.group,
          treatment_arm: s.treatmentArm,
          treated_flag: s.treated ? 'treated' : 'untreated',
          timepoint,
          site: s.site,
          batch: s.batch,
          flare_status: s.flareStatus,
          organ_involvement_group:
            s.organCount === null ? null : s.organCount >= 2 ? 'multi_organ' : 'single_organ',
          igg4_threshold_group: s.igg4Serum > IGG4_CUTPOINT ? 'above_1_35' : 'below_1_35',
          storiform_fibrosis: s.storiformFibrosis,
          denominator_type: s.denominatorType,
          lod_flag: belowLod ? 'below_lod' : 'above_lod',
          unit,
          tfh1_pct: asUnit(m.tfh1_pct),
          tfh2_pct: asUnit(m.tfh2_pct),
          tfh17_pct: asUnit(m.tfh17_pct),
          pd1_tfh_pct: asUnit(m.pd1_tfh_pct),
          foxp3_pct: asUnit(m.foxp3_pct),
          plasmablast_pct: asUnit(m.plasmablast_pct),
          cd4_pct: asUnit(m.cd4_pct),
          cd8_pct: asUnit(m.cd8_pct),
          nk_pct: asUnit(m.nk_pct),
          b_pct: asUnit(m.b_pct),
          il4: round2(m.il4),
          il10: round2(m.il10),
          il17: round2(m.il17),
          ifng: round2(m.ifng),
          igg4_serum: round2(s.igg4Serum),
          histology_ratio: s.histologyRatio,
          organ_count: s.organCount,
          responder_index: s.responderIndex,
          // The residual the bank's Q34 asks about: the share of the full TFH
          // compartment the three named subsets do NOT account for. Computed in
          // percentage space (where "the compartment" is 100) and then carried
          // into whichever representation this row is in. A handful of rows draw
          // a subset sum above 100 and so a NEGATIVE residual — that is
          // deliberate, and it is what makes Q38 ("do any child populations
          // exceed their parent in comparable units?") answerable at all.
          tfh_residual_pct: asUnit(100 - m.tfh1_pct - m.tfh2_pct - m.tfh17_pct),
        });
      }
    }
  }
  return rows;
}

/** The CSV text — header line plus one line per row, `\n`-terminated. */
export function renderSyntheticGradosCsv(): string {
  const rows = buildRows(buildSubjects());
  const lines = [SYNTHETIC_GRADOS_COLUMNS.map((c) => c.name).join(',')];
  for (const row of rows) {
    lines.push(SYNTHETIC_GRADOS_COLUMNS.map((c) => csvCell(row[c.name])).join(','));
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && process.argv[1].endsWith('generate-synthetic-grados-cohort.ts')) {
  const out = join(process.cwd(), 'tests', 'AXI-1604', 'fixtures', SYNTHETIC_GRADOS_CSV_FILENAME);
  writeFileSync(out, renderSyntheticGradosCsv(), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`wrote ${out}`);
}
