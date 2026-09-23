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
        connector: 'SUM-COUNT-01',
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
        nGroups: 10,
        rowCount: 10,
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
  Q20: {
    derivation: `pandas: ${PAIRED} → df[df.timepoint=='Pre'].groupby('gene').log2_cpm.std(ddof=0) (POPULATION sd, as bio-compute computes it) sorted descending`,
    results: [
      {
        cohort: 'timepoint eq Pre',
        connector: 'SUM-RANK-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 24,
        parameters: { groupColumns: ['gene'], valueColumn: 'log2_cpm', aggregation: 'std', direction: 'desc' },
        top: { label: 'CXCL9', value: 2.7591, n: 27 },
        bottom: { label: 'IFNG', value: 0.9621, n: 27 },
        ranks: [
          { rank: 1, label: 'CXCL9', value: 2.7591 },
          { rank: 2, label: 'CXCL10', value: 2.1331 },
          { rank: 24, label: 'IFNG', value: 0.9621 },
        ],
      },
    ],
  },
  Q21: {
    derivation: `pandas: ${DE} → df[df.gene.isin(panel24)].sort_values('log2FoldChange', ascending=False); min(padj)=0.2095 at IDO1`,
    results: [
      {
        cohort: 'gene in',
        connector: 'SUM-RANK-01',
        operationId: 'describe.grouped_aggregate',
        nGroups: 24,
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
};

/** The ten descriptive question ids, in order. */
export const DESCRIBE_QUESTION_IDS: readonly string[] = Object.freeze(Object.keys(DESCRIBE_EXPECTED));

export const isDescribeQuestion = (id: string): boolean => id in DESCRIBE_EXPECTED;
