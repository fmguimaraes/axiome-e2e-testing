/**
 * AXI-1565 (epic AXI-1555 — FR35) — what each descriptive Riaz question
 * (Q12–Q21) must produce, as data.
 *
 * Every number here was derived INDEPENDENTLY of the platform, from the source
 * CSVs in `/home/felipe/dev/axiome/riaz_de/` with pandas — never from a run's own
 * output — and each expectation carries the one-line derivation that produced it
 * (`derivation`), which `stage:riaz-questions` copies into the trace so a reader
 * can re-run it. `scripts/derive-riaz-describe-expectations.py` is that script.
 *
 * Two deviations from `axiome-docs/demo/riaz-2017/Riaz-Guided-Questions.md`, both
 * deliberate and both recorded in the report:
 *  - **Q20 standard deviations are POPULATION SD** (`ddof=0`), because bio-compute's
 *    `std` aggregation is population SD (AXI-1557, pre-existing). The doc quotes the
 *    sample SD (CXCL9 2.81); the ranking is identical, the values differ in the second
 *    decimal (CXCL9 2.76), and asserting the doc's number would fail a CORRECT platform.
 *  - **Q15 asserts `nGroups: 1`**, because `describe.top_n` groups nothing — bio-compute
 *    reports `n_groups: 1` for the whole selection (`top_n.py`) and `SUM-TOPN-01` does not
 *    declare the metric at all. The real invariant, ten rows, is asserted as `rowCount`.
 *  - **Q16 counts significant genes per direction as `n_groups` of two `describe.count`
 *    branches** grouped by `gene`, because the pooled DE table carries no direction
 *    column and `describe` derives none (P11: the registry is the compute boundary —
 *    a describe node may not mint a column). "25 up / 33 down" is therefore read as
 *    the two branches' group counts, not as a two-row table.
 */

/** A value assertion with the ±0.01 tolerance FR35 mandates. */
export const VALUE_TOLERANCE = 0.01;

/** One row of a describe result, addressed by its group label. */
export interface ExpectedCell {
  /** group column value(s), joined by `|` in the bound `groupColumns` order */
  label: string;
  /** the aggregate (`mean_log2_cpm`, `n`, …); omitted when only `n` is asserted */
  value?: number;
  /** the `n` column of that row */
  n?: number;
}

/** A row addressed by its ordinal position in the returned (ranked) row order. */
export interface ExpectedRank {
  rank: number;
  label: string;
  value?: number;
}

/** The parameters the connector must have bound on the run. */
export interface ExpectedParameters {
  groupColumns?: string[];
  valueColumn?: string;
  aggregation?: string;
  direction?: string;
  distinctKey?: string;
  sortColumn?: string;
  n?: number;
}

/**
 * One describe result of a question. A question with two describe branches
 * (Q16) carries two, discriminated by `cohort`: a fragment that must appear in
 * the referent snapshot's effective filters (`log2FoldChange gt 0`). An empty
 * `cohort` matches the question's single describe result.
 */
export interface ExpectedDescribeResult {
  cohort: string;
  connector: string;
  operationId: string;
  nGroups: number;
  parameters: ExpectedParameters;
  /** physical first row of the returned order (direction desc ⇒ the highest) */
  top?: ExpectedCell;
  /** physical last row */
  bottom?: ExpectedCell;
  /** exact ordinal positions, 1-based, in the returned row order */
  ranks?: ExpectedRank[];
  /** rows addressed by label — the cross-tab / count shape, whose order is by label */
  cells?: ExpectedCell[];
  /** total rows in the result table when it is not `nGroups` (top_n) */
  rowCount?: number;
  /** `describe.top_n` only — the column carrying the row's identity, named rather than guessed positionally */
  labelColumn?: string;
  /** the rendered sentence, byte-for-byte (AC2 — Q12 only) */
  sentence?: string;
  /** substrings the rendered sentence must contain (EC6: Q14 says "patients") */
  sentenceIncludes?: string[];
  /** substrings the rendered sentence must NOT contain (EC6: Q14 never says "rows") */
  sentenceExcludes?: string[];
}

export interface DescribeExpectation {
  /** how the expected numbers were computed, independently of the platform */
  derivation: string;
  results: ExpectedDescribeResult[];
}

const PAIRED = 'riaz2017_immune_paired_log2cpm_long.csv';
const DE = 'riaz_pre_therapy_responders_vs_nonresponders.csv (ingested as riaz2017_de_pre_R_vs_NR.csv)';
/** AXI-1587 — Q25/Q30 additional source files. */
const DE_STRATA = 'riaz_stratified_pre_R_vs_NR_by_prior_ipi.csv (ingested as riaz2017_stratified_de_by_prior_ipi.csv)';
const WIDE_V2 = 'riaz2017_expression_by_response_timepoint_v2.csv';

/** AC2's golden EN sentence for Q12, byte-for-byte. */
export const Q12_SENTENCE =
  'HLA-DRA has the highest mean log2 CPM at Pre (9.76, n=27); IFNG the lowest (1.14). 24 genes ranked.';

export const DESCRIBE_EXPECTED: Record<string, DescribeExpectation> = {
  Q12: {
    derivation: `pandas: ${PAIRED} → df[df.timepoint=='Pre'].groupby('gene').log2_cpm.agg(['mean','count']).sort_values('mean', ascending=False)`,
    results: [
      {
        cohort: '',
        connector: 'SUM-RANK-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 24,
        parameters: { groupColumns: ['gene'], valueColumn: 'log2_cpm', aggregation: 'mean', direction: 'desc' },
        top: { label: 'HLA-DRA', value: 9.7626, n: 27 },
        bottom: { label: 'IFNG', value: 1.1382, n: 27 },
        ranks: [
          { rank: 1, label: 'HLA-DRA', value: 9.7626 },
          { rank: 2, label: 'STAT1', value: 8.5016 },
          { rank: 3, label: 'CXCL9', value: 6.0093 },
          { rank: 24, label: 'IFNG', value: 1.1382 },
        ],
        sentence: Q12_SENTENCE,
      },
    ],
  },
  Q13: {
    derivation: `pandas: ${PAIRED} → df.groupby(['gene','timepoint']).log2_cpm.agg(['mean','count'])`,
    results: [
      {
        cohort: '',
        connector: 'SUM-CROSS-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 48,
        parameters: { groupColumns: ['gene', 'timepoint'], valueColumn: 'log2_cpm', aggregation: 'mean' },
        cells: [
          { label: 'CXCL9|Pre', value: 6.0093, n: 27 },
          { label: 'CXCL9|On', value: 6.731, n: 27 },
          { label: 'PRF1|Pre', value: 2.8553, n: 27 },
          { label: 'PRF1|On', value: 3.5, n: 27 },
          { label: 'HLA-DRA|Pre', value: 9.7626, n: 27 },
        ],
      },
    ],
  },
  Q14: {
    derivation: `pandas: ${PAIRED} → df[(df.gene=='CD8A')&(df.timepoint=='Pre')].groupby(['response','prior_ipi']).patient_id.nunique()`,
    results: [
      {
        cohort: '',
        connector: 'SUM-CROSS-COUNT-01',
        operationId: 'describe.count',
        nGroups: 4,
        parameters: { groupColumns: ['response', 'prior_ipi'], distinctKey: 'patient_id' },
        cells: [
          { label: 'NR|ipi_naive', value: 9 },
          { label: 'NR|ipi_progressed', value: 9 },
          { label: 'R|ipi_naive', value: 5 },
          { label: 'R|ipi_progressed', value: 4 },
        ],
        sentenceIncludes: ['patients'],
        sentenceExcludes: ['rows'],
      },
    ],
  },
  Q15: {
    derivation: `pandas: ${DE} → df[df.padj<0.05].sort_values('log2FoldChange', ascending=False).head(10)`,
    results: [
      {
        cohort: 'padj lt 0.05',
        connector: 'SUM-TOPN-01',
        operationId: 'describe.top_n',
        // `describe.top_n` groups NOTHING — bio-compute reports the whole
        // selection as one group (`top_n.py`: `metrics.n_groups = 1`) and
        // `SUM-TOPN-01`'s seed omits `n_groups` from its outputFields. The ten
        // rows are the invariant, and they are asserted as `rowCount`.
        nGroups: 1,
        rowCount: 10,
        labelColumn: 'gene',
        parameters: { sortColumn: 'log2FoldChange', direction: 'desc', n: 10 },
        ranks: [
          { rank: 1, label: 'C20orf166-AS1', value: 13.9224 },
          { rank: 2, label: 'LINC00890', value: 9.2489 },
          { rank: 3, label: 'FCAMR', value: 5.6966 },
          { rank: 4, label: 'VGF', value: 5.2405 },
          { rank: 10, label: 'PRG4', value: 3.2953 },
        ],
      },
    ],
  },
  Q16: {
    derivation: `pandas: ${DE} → sig=df[df.padj<0.05]; (sig.log2FoldChange>0).sum() == 25 up, (sig.log2FoldChange<0).sum() == 33 down (of 58 significant)`,
    results: [
      {
        cohort: 'log2FoldChange gt 0',
        connector: 'SUM-COUNT-01',
        operationId: 'describe.count',
        nGroups: 25,
        parameters: { groupColumns: ['gene'] },
      },
      {
        cohort: 'log2FoldChange lt 0',
        connector: 'SUM-COUNT-01',
        operationId: 'describe.count',
        nGroups: 33,
        parameters: { groupColumns: ['gene'] },
      },
    ],
  },
  Q17: {
    derivation: `pandas: ${PAIRED} → df[df.response=='R'].groupby(['gene','timepoint']).log2_cpm.agg(['mean','count'])`,
    results: [
      {
        cohort: 'response eq R',
        connector: 'SUM-CROSS-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 48,
        parameters: { groupColumns: ['gene', 'timepoint'], valueColumn: 'log2_cpm', aggregation: 'mean' },
        cells: [
          { label: 'PDCD1|Pre', value: 2.0016, n: 9 },
          { label: 'PDCD1|On', value: 3.3846, n: 9 },
          { label: 'PRF1|Pre', value: 3.5298, n: 9 },
          { label: 'PRF1|On', value: 4.9077, n: 9 },
          { label: 'CXCL11|On', value: 3.4112, n: 9 },
        ],
      },
    ],
  },
  Q18: {
    derivation: `pandas: ${PAIRED} → df[df.gene=='CXCL9'].groupby(['response','timepoint']).log2_cpm.agg(['mean','count'])`,
    results: [
      {
        cohort: 'gene eq CXCL9',
        connector: 'SUM-CROSS-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 4,
        parameters: { groupColumns: ['response', 'timepoint'], valueColumn: 'log2_cpm', aggregation: 'mean' },
        cells: [
          { label: 'R|Pre', value: 7.2381, n: 9 },
          { label: 'R|On', value: 7.727, n: 9 },
          { label: 'NR|Pre', value: 5.3948, n: 18 },
          { label: 'NR|On', value: 6.2331, n: 18 },
        ],
      },
    ],
  },
  Q19: {
    derivation: `pandas: ${PAIRED} → df[df.timepoint=='On'].groupby(['gene','response']).log2_cpm.agg(['mean','count'])`,
    results: [
      {
        cohort: 'timepoint eq On',
        connector: 'SUM-CROSS-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 48,
        parameters: { groupColumns: ['gene', 'response'], valueColumn: 'log2_cpm', aggregation: 'mean' },
        cells: [
          { label: 'CD8A|R', value: 6.097, n: 9 },
          { label: 'CD8A|NR', value: 3.5487, n: 18 },
          { label: 'LCK|R', value: 5.2066, n: 9 },
          { label: 'CD3E|R', value: 5.6342, n: 9 },
          { label: 'CD3E|NR', value: 3.1827, n: 18 },
        ],
      },
    ],
  },
  // Q20 retired — identical to Q33 (AXI-1575 amendments); ids are not renumbered.
  Q21: {
    derivation: `pandas: ${DE} → df[df.gene.isin(panel24)].sort_values('log2FoldChange', ascending=False); min(padj)=0.2095 at IDO1`,
    results: [
      {
        cohort: 'gene in',
        connector: 'SUM-RANK-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 24,
        // Ranking by the MEAN of `log2FoldChange` per gene, which for a
        // one-row-per-gene DE table is the value itself. The derivation script
        // ranks by |log2FoldChange| and lands on the same order ONLY because
        // all 24 panel genes have a positive fold change here (verified); a
        // future panel with a negative mover would diverge — rank by the raw
        // value in both places if that ever changes.
        parameters: { groupColumns: ['gene'], valueColumn: 'log2FoldChange', aggregation: 'mean', direction: 'desc' },
        top: { label: 'IDO1', value: 2.2149, n: 1 },
        bottom: { label: 'HAVCR2', value: 0.0666, n: 1 },
        ranks: [
          { rank: 1, label: 'IDO1', value: 2.2149 },
          { rank: 2, label: 'LCK', value: 1.9680 },
          { rank: 3, label: 'CXCL11', value: 1.8431 },
          { rank: 24, label: 'HAVCR2', value: 0.0666 },
        ],
      },
    ],
  },
  // ── AXI-1587: Q22–Q31 (Chart-Enrichment-Brief §5) ──────────────────────────
  Q22: {
    derivation: `pandas: ${PAIRED} → df[df.gene.isin(CYTO)].groupby(['patient_id','timepoint']).log2_cpm.agg(['mean','count'])`,
    results: [
      {
        cohort: '',
        connector: 'SUM-CROSS-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 54,
        parameters: { groupColumns: ['patient_id', 'timepoint'], valueColumn: 'log2_cpm', aggregation: 'mean' },
        cells: [
          { label: 'Pt1|On', value: 2.4613, n: 6 },
          { label: 'Pt1|Pre', value: 3.9935, n: 6 },
          { label: 'Pt101|On', value: 4.8915, n: 6 },
          { label: 'Pt103|Pre', value: 3.7511, n: 6 },
          { label: 'Pt94|On', value: 3.0123, n: 6 },
        ],
      },
    ],
  },
  Q23: {
    derivation: `pandas: ${WIDE_V2} → df[df.gene=='CD8A'].sort_values('delta', ascending=False)`,
    results: [
      {
        cohort: 'gene eq CD8A',
        connector: 'SUM-TOPN-01',
        operationId: 'describe.top_n',
        nGroups: 1,
        rowCount: 27,
        labelColumn: 'patient_id',
        parameters: { sortColumn: 'delta', direction: 'desc', n: 27 },
        ranks: [
          { rank: 1, label: 'Pt30', value: 4.4608 },
          { rank: 2, label: 'Pt78', value: 3.326 },
          { rank: 3, label: 'Pt28', value: 2.7263 },
          { rank: 27, label: 'Pt103', value: -3.1238 },
        ],
      },
    ],
  },
  Q24: {
    derivation: `pandas: ${PAIRED} → df[df.timepoint=='On'].groupby(['gene','prior_ipi']).log2_cpm.agg(['mean','count'])`,
    results: [
      {
        cohort: 'timepoint eq On',
        connector: 'SUM-CROSS-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 48,
        parameters: { groupColumns: ['gene', 'prior_ipi'], valueColumn: 'log2_cpm', aggregation: 'mean' },
        cells: [
          { label: 'CD8A|ipi_naive', value: 4.8035, n: 14 },
          { label: 'CD8A|ipi_progressed', value: 3.9616, n: 13 },
          { label: 'HLA-DRA|ipi_naive', value: 10.201, n: 14 },
          { label: 'PDCD1|ipi_naive', value: 2.1859, n: 14 },
          { label: 'PDCD1|ipi_progressed', value: 1.7544, n: 13 },
        ],
      },
    ],
  },
  Q25: {
    derivation: `pandas: ${DE} → sig-band counts by padj: (df.padj<0.01).sum()==22 genes, (0.01<=df.padj<0.05).sum()==36 genes, (0.05<=df.padj<0.10).sum()==91 genes (each a describe.count group count)`,
    results: [
      { cohort: 'padj lt 0.01', connector: 'SUM-COUNT-01', operationId: 'describe.count', nGroups: 22, parameters: { groupColumns: ['gene'] } },
      { cohort: 'padj gte 0.01', connector: 'SUM-COUNT-01', operationId: 'describe.count', nGroups: 36, parameters: { groupColumns: ['gene'] } },
      { cohort: 'padj gte 0.05', connector: 'SUM-COUNT-01', operationId: 'describe.count', nGroups: 91, parameters: { groupColumns: ['gene'] } },
    ],
  },
  Q26: {
    derivation: `pandas: ${PAIRED} → df[df.timepoint=='Pre'].groupby(['gene','response']).log2_cpm.agg(['median','count'])`,
    results: [
      {
        cohort: 'timepoint eq Pre',
        connector: 'SUM-CROSS-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 48,
        parameters: { groupColumns: ['gene', 'response'], valueColumn: 'log2_cpm', aggregation: 'median' },
        cells: [
          { label: 'CD8A|NR', value: 3.799, n: 18 },
          { label: 'CD8A|R', value: 5.7715, n: 9 },
          { label: 'HLA-DRA|NR', value: 9.6252, n: 18 },
          { label: 'HLA-DRA|R', value: 10.8617, n: 9 },
          { label: 'PDCD1|R', value: 2.1544, n: 9 },
        ],
      },
    ],
  },
  Q27: {
    derivation: `pandas: ${DE} → df[df.padj<0.05].sort_values('log2FoldChange', ascending=True).head(10)`,
    results: [
      {
        cohort: 'padj lt 0.05',
        connector: 'SUM-TOPN-01',
        operationId: 'describe.top_n',
        nGroups: 1,
        rowCount: 10,
        labelColumn: 'gene',
        parameters: { sortColumn: 'log2FoldChange', direction: 'asc', n: 10 },
        ranks: [
          { rank: 1, label: 'MYL1', value: -43.2809 },
          { rank: 2, label: 'KRT14', value: -7.7627 },
          { rank: 3, label: 'CASP14', value: -7.2487 },
          { rank: 10, label: 'KRTDAP', value: -5.6561 },
        ],
      },
    ],
  },
  Q28: {
    derivation: `pandas: ${PAIRED} → df[df.gene.isin(['CXCL9','CXCL10','CXCL11']) & (df.response=='R')].groupby(['gene','timepoint']).log2_cpm.agg(['mean','count'])`,
    results: [
      {
        cohort: '',
        connector: 'SUM-CROSS-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 6,
        parameters: { groupColumns: ['gene', 'timepoint'], valueColumn: 'log2_cpm', aggregation: 'mean' },
        cells: [
          { label: 'CXCL10|On', value: 5.8779, n: 9 },
          { label: 'CXCL10|Pre', value: 5.8671, n: 9 },
          { label: 'CXCL11|On', value: 3.4112, n: 9 },
          { label: 'CXCL11|Pre', value: 3.8484, n: 9 },
          { label: 'CXCL9|On', value: 7.727, n: 9 },
          { label: 'CXCL9|Pre', value: 7.2381, n: 9 },
        ],
      },
    ],
  },
  Q29: {
    derivation: `pandas: ${PAIRED} → df[(df.gene=='HLA-DRA')&(df.timepoint=='Pre')].sort_values('log2_cpm', ascending=False).head(10)`,
    results: [
      {
        cohort: '',
        connector: 'SUM-TOPN-01',
        operationId: 'describe.top_n',
        nGroups: 1,
        rowCount: 10,
        labelColumn: 'patient_id',
        parameters: { sortColumn: 'log2_cpm', direction: 'desc', n: 10 },
        ranks: [
          { rank: 1, label: 'Pt34', value: 13.4693 },
          { rank: 2, label: 'Pt103', value: 12.5465 },
          { rank: 3, label: 'Pt46', value: 12.3897 },
          { rank: 10, label: 'Pt31', value: 10.4751 },
        ],
      },
    ],
  },
  Q30: {
    derivation: `pandas: ${DE_STRATA} → df[df.padj<0.05].groupby('stratum').log2FoldChange.agg(['mean','count'])`,
    results: [
      {
        cohort: '',
        connector: 'SUM-RANK-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 2,
        parameters: { groupColumns: ['stratum'], valueColumn: 'log2FoldChange', aggregation: 'mean', direction: 'desc' },
        top: { label: 'ipi_progressed', value: 1.7887, n: 50 },
        bottom: { label: 'ipi_naive', value: -0.4618, n: 33 },
      },
    ],
  },
  Q31: {
    derivation: `pandas: ${PAIRED} → df[(df.timepoint=='On')&(df.gene.isin(CYTO))].groupby('patient_id').log2_cpm.mean() desc`,
    results: [
      {
        cohort: '',
        connector: 'SUM-RANK-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 27,
        parameters: { groupColumns: ['patient_id'], valueColumn: 'log2_cpm', aggregation: 'mean', direction: 'desc' },
        top: { label: 'Pt49', value: 6.5885, n: 6 },
        bottom: { label: 'Pt84', value: 0.1548, n: 6 },
        ranks: [
          { rank: 1, label: 'Pt49', value: 6.5885 },
          { rank: 2, label: 'Pt30', value: 5.7634 },
          { rank: 3, label: 'Pt18', value: 5.0655 },
          { rank: 27, label: 'Pt84', value: 0.1548 },
        ],
      },
    ],
  },
  // ── AXI-1581: the four Phase-1 shape connectors (epic AXI-1575) — derived with pandas from the source CSV ──
  Q32: {
    derivation: `pandas: ${PAIRED} → df[df.timepoint=='Pre'].groupby('gene').log2_cpm.median().sort_values(ascending=False)`,
    results: [
      {
        cohort: '',
        connector: 'SUM-RANK-MEDIAN-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 24,
        parameters: { groupColumns: ['gene'], valueColumn: 'log2_cpm', aggregation: 'median', direction: 'desc' },
        top: { label: 'HLA-DRA', value: 9.757, n: 27 },
        bottom: { label: 'IFNG', value: 0.9225, n: 27 },
        ranks: [
          { rank: 1, label: 'HLA-DRA', value: 9.757 },
          { rank: 2, label: 'STAT1', value: 8.2792 },
          { rank: 3, label: 'CXCL9', value: 6.5856 },
          { rank: 24, label: 'IFNG', value: 0.9225 },
        ],
      },
    ],
  },
  Q33: {
    derivation: `pandas: ${PAIRED} → df[df.timepoint=='Pre'].groupby('gene').log2_cpm.std(ddof=0).sort_values(ascending=False)  # population SD — bio-compute std is ddof=0`,
    results: [
      {
        cohort: '',
        connector: 'SUM-SPREAD-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 24,
        parameters: { groupColumns: ['gene'], valueColumn: 'log2_cpm', aggregation: 'std', direction: 'desc' },
        top: { label: 'CXCL9', value: 2.7591, n: 27 },
        bottom: { label: 'IFNG', value: 0.9621, n: 27 },
        ranks: [
          { rank: 1, label: 'CXCL9', value: 2.7591 },
          { rank: 2, label: 'CXCL10', value: 2.1331 },
          { rank: 3, label: 'IDO1', value: 2.0833 },
        ],
      },
    ],
  },
  Q34: {
    derivation: `pandas: ${PAIRED} → df[df.timepoint=='Pre'].groupby('gene').log2_cpm.max().sort_values(ascending=False)`,
    results: [
      {
        cohort: '',
        connector: 'SUM-EXTREMES-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 24,
        parameters: { groupColumns: ['gene'], valueColumn: 'log2_cpm', aggregation: 'max', direction: 'desc' },
        top: { label: 'HLA-DRA', value: 13.4693, n: 27 },
        bottom: { label: 'IFNG', value: 2.842, n: 27 },
        ranks: [
          { rank: 1, label: 'HLA-DRA', value: 13.4693 },
          { rank: 2, label: 'STAT1', value: 10.2178 },
          { rank: 3, label: 'CXCL9', value: 9.9296 },
          { rank: 24, label: 'IFNG', value: 2.842 },
        ],
      },
    ],
  },
  Q35: {
    derivation: `pandas: ${PAIRED} → df[df.gene=='CD8A'].groupby(['response','timepoint']).patient_id.nunique()`,
    results: [
      {
        cohort: '',
        connector: 'SUM-CROSS-COUNT-01',
        operationId: 'describe.count',
        nGroups: 4,
        parameters: { groupColumns: ['response', 'timepoint'], distinctKey: 'patient_id' },
        cells: [
          { label: 'NR|On', value: 18 },
          { label: 'NR|Pre', value: 18 },
          { label: 'R|On', value: 9 },
          { label: 'R|Pre', value: 9 },
        ],
        sentenceIncludes: ['patients'],
        sentenceExcludes: ['rows'],
      },
    ],
  },
  // ── AXI-1582: filtered top-N + domain connector — derived with pandas from the source CSV ──
  // NOTE Q37 binds `match` only after the semantic contract repair has been RUN against the project
  // (POST /v1/semantic-profiles/projects/:id/normalize maps log2_cpm -> expression_value); before it, the
  // connector is `indeterminate` naming log2_cpm and the question fails by design (FR21 / AC9).
  Q36: {
    derivation: `pandas: ${PAIRED} → df[(df.gene=='HLA-DRA')&(df.timepoint=='Pre')&(df.response=='R')].sort_values('log2_cpm', ascending=False).head(5)`,
    results: [
      {
        cohort: '',
        connector: 'SUM-TOPN-FILTERED-01',
        operationId: 'describe.top_n',
        nGroups: 1,
        rowCount: 5,
        labelColumn: 'patient_id',
        parameters: { sortColumn: 'log2_cpm', direction: 'desc', n: 5 },
        ranks: [
          { rank: 1, label: 'Pt34', value: 13.4693 },
          { rank: 2, label: 'Pt101', value: 12.0683 },
          { rank: 3, label: 'Pt49', value: 11.3636 },
          { rank: 5, label: 'Pt18', value: 10.8617 },
        ],
      },
    ],
  },
  Q37: {
    derivation: `pandas: ${PAIRED} → df[df.timepoint=='Pre'].groupby('gene').log2_cpm.agg(['mean','count']).sort_values('mean', ascending=False)`,
    results: [
      {
        cohort: '',
        connector: 'SUM-EXPR-RANK-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 24,
        parameters: { groupColumns: ['gene'], valueColumn: 'log2_cpm', aggregation: 'mean', direction: 'desc' },
        top: { label: 'HLA-DRA', value: 9.7626, n: 27 },
        bottom: { label: 'IFNG', value: 1.1382, n: 27 },
        ranks: [
          { rank: 1, label: 'HLA-DRA', value: 9.7626 },
          { rank: 2, label: 'STAT1', value: 8.5016 },
          { rank: 3, label: 'CXCL9', value: 6.0093 },
          { rank: 24, label: 'IFNG', value: 1.1382 },
        ],
      },
    ],
  },
};

/** The descriptive question ids, in order. */
export const DESCRIBE_QUESTION_IDS: readonly string[] = Object.freeze(Object.keys(DESCRIBE_EXPECTED));

export const isDescribeQuestion = (id: string): boolean => id in DESCRIBE_EXPECTED;
