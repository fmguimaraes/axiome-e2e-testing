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
 *
 * ═══ AXI-1694 (epic AXI-1687 — FR56/FR57, SI-044): SEED FIDELITY ═══
 * Before this story `absolute_count` was `pct × the subject's ONE total
 * lymphocyte count`, applied flat to every column regardless of nesting —
 * `pd1_tfh_pct`, a subset of the TFH compartment which is itself a subset of
 * CD4, was multiplied straight by the lymphocyte count as if it were a direct
 * lymphocyte subset. The lymphocyte count was one draw per SUBJECT (not per
 * timepoint), same distribution in every disease group. Timepoints were
 * independent draws with no shared subject term. So the two unit readings
 * could never disagree for a fixed subject (`absolute_count` was a monotonic
 * rescaling of `pct_of_parent`), pSS lymphopenia could not exist, and pairing
 * baseline against post-treatment could not show a real subject effect.
 *
 * This story fixes three things, and changes nothing else (bank intents are
 * untouched — FR57):
 *   1. `absolute_count` for a nested measure is now derived through its real
 *      parent chain (`buildAbsoluteBases`/`toRepresentation` below) — see
 *      `SYNTHETIC_GRADOS_VALUE_CHAIN` in `synthetic-grados-schema.ts` for the
 *      declared hierarchy this generator computes against.
 *   2. Total lymphocyte count is drawn once per subject at BASELINE
 *      (`drawBaselineLymphocyteCount`, lower pSS mean — lymphopenia is a real
 *      pSS finding) and `post_treatment` is DERIVED from that same draw
 *      (`derivePostTreatmentLymphocyteCount`), dropping further for
 *      rituximab (deeper depletion) than for steroids alone.
 *   3. Every subject carries a fixed `subjectEffect` (a per-subject random
 *      intercept, §`buildSubjects`) folded into both the lymphocyte draw and
 *      the measure draws at EVERY timepoint, so a treated subject's baseline
 *      and post-treatment readings are correlated (`r(baseline, post) > 0`)
 *      rather than independent draws that only share a group mean.
 * The `n % 17 === 0` subset-overflow injection (Q38) is kept exactly as
 * before, now expressed against the TFH-compartment parent it actually
 * violates rather than against the flat lymphocyte count.
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
  /**
   * AXI-1694. A per-subject random intercept, roughly a z-score in
   * `[-2.4, 2.4]`. Folded into the lymphocyte draw and every measure draw at
   * EVERY timepoint so a subject's own baseline and post-treatment readings
   * are correlated rather than independent draws around a shared group mean
   * — this is what gives `r(baseline, post) > 0` a real subject-level cause.
   */
  subjectEffect: number;
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
        subjectEffect: near(0, 1, -2.4, 2.4),
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
 *
 * AXI-1694: `s.subjectEffect` is folded into every mean as `mean + effect *
 * scale`, the SAME subject term at baseline and post-treatment, so a
 * subject's own two timepoints move together (paired correlation) instead of
 * being independent draws that only share a group mean.
 *
 * PARENT CHAIN (AXI-1694 — see `SYNTHETIC_GRADOS_VALUE_CHAIN`). `cd4_pct`,
 * `cd8_pct`, `nk_pct`, `b_pct` are shares of total lymphocytes. `foxp3_pct`
 * (Treg) is a share of CD4. `tfh1_pct`/`tfh2_pct`/`tfh17_pct`/`pd1_tfh_pct`
 * are shares of a virtual TFH compartment that is itself a share of CD4
 * (`drawTfhFractionOfCd4`); `tfh1+tfh2+tfh17+residual` sum to exactly 100
 * (the compartment), unchanged from before this story. `plasmablast_pct` is a
 * share of B cells. None of this changes what is DRAWN in `pct_of_parent`
 * space — only how `absolute_count` is derived from it (`buildRows` below).
 */
function drawMeasures(s: Subject, postTreatment: boolean): Measures {
  const group = s.group;
  const arm = s.treatmentArm;
  const igg4 = group === 'igg4_rd';
  const pss = group === 'pss';
  const eff = s.subjectEffect;
  // Treatment effect: rituximab depletes harder than steroids alone.
  const shrink = !postTreatment ? 1 : arm === 'rituximab' ? 0.55 : 0.8;
  // A below-LOD subject's cytokine releases sit under `LOD_FLOOR`.
  const cytokine = (mean: number, sd: number, max: number): number =>
    s.belowLod ? near(3, 2, 0, LOD_FLOOR - 0.5) : near(mean + eff * sd * 0.15, sd, 0, max);
  const tfh1Pre = near((igg4 ? 17 : 24) + eff * 2.2, 5, 2, 45) * (postTreatment ? 1.05 : 1);
  const tfh2Pre = near((igg4 ? 21 : 12) + eff * 2.2, 5, 1, 45) * shrink;
  const tfh17Pre = near((igg4 ? 28 : 21) + eff * 2.5, 6, 2, 55) * (postTreatment ? 0.95 : 1);
  // A subset-overflow subject's three TFH shares are scaled so they sum PAST
  // the 100% parent compartment BY A GUARANTEED MARGIN, regardless of how low
  // the pre-scale random draws landed (see `Subject.subsetOverflow`, Q38).
  const [tfh1_pct, tfh2_pct, tfh17_pct] = s.subsetOverflow
    ? scaleAboveCompartmentTotal(tfh1Pre, tfh2Pre, tfh17Pre)
    : [tfh1Pre, tfh2Pre, tfh17Pre];
  return {
    tfh1_pct,
    tfh2_pct,
    tfh17_pct,
    pd1_tfh_pct: near((igg4 ? 14 : 8) + eff * 1.5, 3.5, 0.5, 30) * shrink,
    foxp3_pct: near((igg4 ? 8.5 : 5.5) + eff * 0.9, 2, 0.5, 18),
    plasmablast_pct: near((igg4 ? 3.4 : 0.9) + eff * 0.5, 1.2, 0.05, 9) * shrink,
    cd4_pct: near((pss ? 38 : 45) + eff * 3, 7, 15, 70),
    cd8_pct: near((pss ? 21 : 25) + eff * 2.5, 6, 8, 48),
    nk_pct: near((pss ? 8 : 11) + eff * 1.2, 3, 1, 25),
    b_pct: near((pss ? 6 : 10) + eff * 1.2, 3, 0.5, 24),
    il4: cytokine(igg4 ? 62 : 34, 20, 180),
    il10: cytokine(igg4 ? 88 : 51, 28, 260),
    il17: cytokine(igg4 ? 74 : 46, 24, 220),
    ifng: cytokine(pss ? 130 : 108, 40, 400),
  };
}

/** Below this pg/mL a cytokine reading is reported as below the limit of detection. */
const LOD_FLOOR = 8;

/** How far past 100% a deliberate Q38 overflow row must land, at minimum. */
const OVERFLOW_MARGIN = 8;

/**
 * Scales three TFH-compartment shares up (never down) so their sum is at
 * least `100 + OVERFLOW_MARGIN`. A flat multiplier alone is variance-sensitive
 * — three random draws can land low enough that even ×1.65 stays under 100 —
 * so this scales relative to the ACTUAL pre-scale sum, guaranteeing the
 * containment violation Q38 depends on regardless of how the draw landed.
 */
function scaleAboveCompartmentTotal(a: number, b: number, c: number): [number, number, number] {
  const sum = a + b + c;
  const factor = Math.max(1, (100 + OVERFLOW_MARGIN) / sum);
  return [a * factor, b * factor, c * factor];
}

/**
 * AXI-1694. This subject's own BASELINE total lymphocyte count (cells/µL),
 * with a lower pSS mean (lymphopenia is a real pSS finding). `s.subjectEffect`
 * sets an individual level around that mean.
 */
function drawBaselineLymphocyteCount(s: Subject): number {
  const groupMean = s.group === 'pss' ? 1500 : 1900;
  return Math.round(near(groupMean + s.subjectEffect * 220, 380, 500, 3600));
}

/**
 * AXI-1694. This subject's post-treatment lymphocyte count, derived from
 * their OWN baseline draw (not an independent one) plus a small measurement
 * perturbation — rituximab drops it further than steroids alone. Deriving
 * post directly from baseline, rather than redrawing independently around
 * the same group mean, is what makes `r(baseline, post) > 0` a GUARANTEED
 * property of the generator rather than an accident of one PRNG stream —
 * the two are related by construction, not merely by sharing a subject term.
 */
function derivePostTreatmentLymphocyteCount(baseline: number, s: Subject): number {
  const postFactor = s.treatmentArm === 'rituximab' ? 0.72 : 0.88;
  const perturbation = near(0, 60, -140, 140);
  return Math.round(Math.max(500, baseline * postFactor + perturbation));
}

/**
 * AXI-1694. The TFH compartment's size as a fraction of CD4 (not a CSV
 * column — an internal denominator `buildRows` uses to turn `tfh1_pct` etc.
 * into real cell counts). Re-drawn per timepoint, but `s.subjectEffect` sets
 * its mean, so a subject's baseline and post-treatment fractions are
 * correlated rather than independent of one another.
 */
function drawTfhFractionOfCd4(s: Subject): number {
  return near(20 + s.subjectEffect * 2, 4.5, 8, 34);
}

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
 * AXI-1694. The absolute (cells/µL) base each nested measure's `absolute_count`
 * is derived against — the parent chain, evaluated once per subject-timepoint.
 * `lymphocytes` is the base for `cd4_pct`/`cd8_pct`/`nk_pct`/`b_pct`. `cd4` is
 * the base for `foxp3_pct` (Treg, a CD4 subset). `tfhCompartment` is the base
 * for `tfh1_pct`/`tfh2_pct`/`tfh17_pct`/`pd1_tfh_pct`/`tfh_residual_pct` (all
 * shares of the TFH compartment, itself a share of CD4). `bCells` is the base
 * for `plasmablast_pct` (a B-cell subset). See `SYNTHETIC_GRADOS_VALUE_CHAIN`.
 */
interface AbsoluteBases {
  lymphocytes: number;
  cd4: number;
  tfhCompartment: number;
  bCells: number;
}

function buildAbsoluteBases(lymphocytes: number, m: Measures, tfhFractionOfCd4: number): AbsoluteBases {
  const cd4 = (m.cd4_pct / 100) * lymphocytes;
  const bCells = (m.b_pct / 100) * lymphocytes;
  const tfhCompartment = (tfhFractionOfCd4 / 100) * cd4;
  return { lymphocytes, cd4, tfhCompartment, bCells };
}

/**
 * A measure's value under `unit`, given the ABSOLUTE base of its real parent
 * (not a flat total-lymphocyte multiply). `pct_of_parent` always returns the
 * drawn percentage unchanged — the base only matters for `absolute_count`,
 * which is why the two readings can disagree: the base varies per
 * subject-timepoint independently of the percentage itself.
 */
function toRepresentation(pct: number, unit: 'pct_of_parent' | 'absolute_count', base: number): number {
  return unit === 'pct_of_parent' ? round2(pct) : Math.round((pct / 100) * base);
}

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
    const baselineLymphocytes = drawBaselineLymphocyteCount(s);
    for (const timepoint of timepoints) {
      const postTreatment = timepoint === 'post_treatment';
      const m = drawMeasures(s, postTreatment);
      const belowLod = Math.min(m.il4, m.il10, m.il17, m.ifng) < LOD_FLOOR;
      const lymphocytes = postTreatment
        ? derivePostTreatmentLymphocyteCount(baselineLymphocytes, s)
        : baselineLymphocytes;
      const bases = buildAbsoluteBases(lymphocytes, m, drawTfhFractionOfCd4(s));
      for (const unit of ['pct_of_parent', 'absolute_count'] as const) {
        const ofLymphocytes = (pct: number): number => toRepresentation(pct, unit, bases.lymphocytes);
        const ofCd4 = (pct: number): number => toRepresentation(pct, unit, bases.cd4);
        const ofTfh = (pct: number): number => toRepresentation(pct, unit, bases.tfhCompartment);
        const ofBCells = (pct: number): number => toRepresentation(pct, unit, bases.bCells);
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
          tfh1_pct: ofTfh(m.tfh1_pct),
          tfh2_pct: ofTfh(m.tfh2_pct),
          tfh17_pct: ofTfh(m.tfh17_pct),
          pd1_tfh_pct: ofTfh(m.pd1_tfh_pct),
          foxp3_pct: ofCd4(m.foxp3_pct),
          plasmablast_pct: ofBCells(m.plasmablast_pct),
          cd4_pct: ofLymphocytes(m.cd4_pct),
          cd8_pct: ofLymphocytes(m.cd8_pct),
          nk_pct: ofLymphocytes(m.nk_pct),
          b_pct: ofLymphocytes(m.b_pct),
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
          // into whichever representation this row is in, through the SAME
          // TFH-compartment base as its three siblings. A handful of rows draw
          // a subset sum above 100 and so a NEGATIVE residual — that is
          // deliberate, and it is what makes Q38 ("do any child populations
          // exceed their parent in comparable units?") answerable at all.
          tfh_residual_pct: ofTfh(100 - m.tfh1_pct - m.tfh2_pct - m.tfh17_pct),
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
