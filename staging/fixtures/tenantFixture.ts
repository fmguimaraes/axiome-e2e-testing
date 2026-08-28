import type { TenantFixture } from './types';

/**
 * The demo tenant's words (AXI-1371, FR6). Source: Capture Spec
 * (Confluence 274857986, v1) §2.1 (tenant naming/hygiene), §3 (cast).
 *
 * This is the ONLY file a wording change touches — `staging/steps/**` reads
 * it and never hard-codes a name. `org`/`workspaces`/`projects` are FR5's
 * provisioning target; `retiredProjects` are EC1's cleanup target;
 * `content` slots are populated by AXI-1372 onward.
 *
 * `legacyNames` are exact names Capture Spec §2.1 found already staged by
 * hand before this toolkit existed — the provisioning step renames onto
 * `name` from any of them and is a no-op once `name` is already in place
 * (NFR1). Names are otherwise unrelated across workspaces/orgs; a legacy
 * name here MUST be the literal string §2.1 lists, not a paraphrase.
 */
export const TENANT_FIXTURE: TenantFixture = {
  fixtureVersion: 1,
  publicCohort: 'riaz-2017',

  org: {
    name: 'Biotech One',
    type: 'laboratory',
  },

  workspaces: [
    {
      name: 'Translational Immuno-Oncology',
      legacyNames: ['E2E Testing'],
      type: 'internal',
      projects: [
        {
          name: 'Melanoma IO cohort, paired timepoints',
          legacyNames: ['AXI-1179 - Longitudinal Data Linking and Merging'],
        },
      ],
      retiredProjects: [],
    },
    {
      // Capture Spec §2.1 lists this workspace as "Keep" under the spelling
      // "Public Datasets, IO Benchmarks"; the live tenant already carries it
      // as "Public Datasets — IO Benchmarks" (em dash). Kept content is
      // reused as-is (no rename), so the fixture's `name` matches what is
      // actually live rather than re-litigating punctuation on a "keep".
      name: 'Public Datasets — IO Benchmarks',
      legacyNames: [],
      type: 'internal',
      projects: [
        {
          // Same live-vs-spec punctuation note as the workspace above —
          // Capture Spec §2.1 lists "Riaz 2017, Nivolumab Melanoma" as
          // "Keep"; the live project is "Riaz 2017 — Nivolumab Melanoma".
          name: 'Riaz 2017 — Nivolumab Melanoma',
          legacyNames: [],
        },
      ],
      retiredProjects: [
        // Capture Spec §2.1: Project "E2E Testing" -> Delete.
        { legacyName: 'E2E Testing', retiredName: 'Retired duplicate (do not use for capture)' },
      ],
    },
  ],

  // Capture Spec §3. Handles must match staging/identities/registry.ts —
  // AXI-1370's role-based placeholders (cast-biologist/-bioinformatician/
  // -clinician) don't line up one-for-one with §3's role labels
  // (bioinformatician/biostatistician/study-lead-immunologist); the mapping
  // below is by best-fit, not by name — see the AXI-1371 report for the
  // caveat. What matters for capture is the *display* name applied here.
  cast: [
    { handle: 'cast-bioinformatician', displayFirstName: 'Léa', displayLastName: 'Fontaine', initials: 'LF', role: 'Bioinformatician' },
    { handle: 'cast-biologist', displayFirstName: 'Marc', displayLastName: 'Ottavi', initials: 'MO', role: 'Biostatistician' },
    { handle: 'cast-clinician', displayFirstName: 'Claire', displayLastName: 'Ngo', initials: 'CN', role: 'Study lead, immunologist' },
    { handle: 'external-stakeholder', displayFirstName: 'Daniel', displayLastName: 'Reiss', initials: 'DR', role: 'Sponsor scientist, external' },
  ],

  content: {
    // AXI-1373 (FR9, Capture Spec §4): "the scientific spine" — one question
    // carried consistently across every capture. Verbatim from the spec's
    // "Workspace title" line. Doubles as the view-analysis's `name` (its
    // header/title) — see the `scientificQuestion` doc in `types.ts`.
    scientificQuestion: 'Does the pre-therapy transcriptional profile separate nivolumab responders from non-responders?',
    // AXI-1372 (FR7/AC5, Capture Spec §2.1/§2.2): the leaked build filename
    // `axi50-e2e-race.csv` replaced with the real name, real gene symbols,
    // bound to the ANALYSIS project — confirmed against Capture Spec §4 ("the
    // scientific spine" question lives on this workspace/project) — not the
    // separate "Riaz 2017 — Nivolumab Melanoma" benchmark-catalog project,
    // which Capture Spec §2.1 marks "Keep" as-is and this epic does not touch.
    //
    // AXI-1374 widens this to TWO dataset versions, one corpus (AC5 amended
    // 2026-08-28, founder-approved): the DE table (one row per gene) backs
    // charts 1-4; a second, per-sample count-matrix dataset backs charts 5-6
    // (Capture Spec §6.2 #5/#6 need per-sample expression the DE table
    // collapses away). Both bind to the SAME workspace/project —
    // `checkDatasetsShareCorpus` (validateFixture.ts) enforces that.
    //
    // The count-matrix file is NOT the raw `CountData.BMS038.txt` wide
    // matrix — investigation (AXI-1374) confirmed the platform's chart
    // engine binds strictly to literal columns in the ingested CSV; there is
    // no wide->long reshape or external sample-metadata join at ingestion or
    // query time (`datasets.service.ts:queryData` runs DuckDB directly over
    // the raw parquet's own columns; `CellStorageService`'s wide->long melt
    // is a DIFFERENT feature, AXI-1179's cell-merge, never read by
    // candidates/chart code). So the join happens BEFORE upload, offline,
    // the same way `riaz_de/run_de.py` produced the DE table before AXI-1372
    // ever uploaded it: `riaz_de/build_count_matrix_dataset.py` melts
    // `CountData.BMS038.txt` + `SampleTableCorrected.9.19.16.csv` into one
    // row per (gene, patient) — columns `gene,patient_id,response,
    // pre_expression,on_expression` — restricted to the top 20
    // lowest-padj genes from the DE table and the 27 patients who have BOTH
    // a Pre and an On-treatment sample AND a clean RECIST R/NR call
    // (PRCR/PD; SD/NE/NA excluded, same rule as the staged cohort_definition
    // assumption). See the AXI-1374 design-note Jira comment for the full
    // writeup.
    datasets: [
      {
        role: 'de_table',
        originalFilename: 'riaz2017_de_pre_R_vs_NR.csv',
        contentType: 'text/csv',
        workspaceName: 'Translational Immuno-Oncology',
        projectName: 'Melanoma IO cohort, paired timepoints',
        localPathEnv: 'STAGING_RIAZ_DE_CSV_PATH',
        defaultLocalPath: '/home/felipe/dev/axiome/riaz_de/riaz_pre_therapy_responders_vs_nonresponders.csv',
      },
      {
        role: 'count_matrix',
        originalFilename: 'riaz2017_expression_by_response_timepoint.csv',
        contentType: 'text/csv',
        workspaceName: 'Translational Immuno-Oncology',
        projectName: 'Melanoma IO cohort, paired timepoints',
        localPathEnv: 'STAGING_RIAZ_COUNT_MATRIX_CSV_PATH',
        defaultLocalPath: '/home/felipe/dev/axiome/riaz_de/riaz2017_counts_by_response_timepoint.csv',
      },
    ],
    // AXI-1373 (FR9, Capture Spec §5). All four assumption BODIES are
    // declared here (words); whether the fourth is actually staged is a
    // toolkit-level TRUTH guard, not a fixture switch — see
    // `staging/steps/analysisFraming.ts`'s `THRESHOLD_DECLARED_BEFORE_CONTRAST`.
    // `authorHandle: 'cast-biologist'` is Marc Ottavi/MO (Capture Spec §3
    // owns assumptions/thresholds/contrast choices) — same best-fit mapping
    // note as the `cast` array above, not a name match.
    assumptions: [
      {
        category: 'cohort_definition',
        text: 'Responders = RECIST CR/PR; non-responders = RECIST PD. Pre-therapy timepoint only.',
        authorHandle: 'cast-biologist',
      },
      {
        category: 'data_filter',
        text: 'Genes with low counts excluded by DESeq2 independent filtering; padj reported as NULL for filtered genes (expected).',
        authorHandle: 'cast-biologist',
      },
      {
        category: 'methodological_choice',
        text: 'Differential expression run with DESeq2 (pydeseq2 0.5.2) rather than edgeR or limma-voom.',
        authorHandle: 'cast-biologist',
      },
      {
        category: 'threshold_provenance',
        text: '|log2FC| ≥ 1 taken from the published cutoff, not fitted on this cohort. Declared before the contrast was run.',
        authorHandle: 'cast-biologist',
      },
    ],
    // AXI-1374 (FR8/FR23, Capture Spec §6.2): the six user-created charts.
    // Charts 1-4 bind `dataRequirement: 'de_table'` — satisfied by the DE
    // table dataset (`94b0bd10`). Charts 5-6 declare `'count_matrix'`,
    // satisfied by the second dataset above (AC5 amended) — `chartStaging.ts`
    // checks LIVE platform state (which dataset roles are actually ingested)
    // before staging any `count_matrix` chart, same shape as FR9's truth
    // guard: a chart whose requirement isn't ACTUALLY met is withheld, never
    // fabricated. Titles are human-authored, no duplicates, no `TEST` card
    // (Capture Spec §6.2's own wording).
    chartSpecs: [
      {
        title: 'Volcano — pre-therapy responders vs non-responders (baseMean ≥ 10)',
        templateId: 'volcano_v1',
        templateVersion: '1.0.0',
        dataRequirement: 'de_table',
        bindings: { x: 'log2FoldChange', y: 'pvalue' },
        // FR23 — the saved, persisted fix: -log10(p) y-axis + colour by
        // significance category. `pval_threshold` is in the TRANSFORMED
        // (-log10) scale — -log10(0.05) ≈ 1.301 — overriding the backend
        // template's own seeded default of 0.05 (`specialized.templates.ts`),
        // which is calibrated for a raw p-value axis and is itself the
        // upstream source of the "unshippable" volcano bug this story fixes.
        params: { yAxisTransform: 'neg_log10', colorBy: 'significance', fc_threshold: 1, pval_threshold: 1.301 },
        filters: [{ column: 'baseMean', operator: 'gte', value: 10 }],
      },
      {
        title: 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1',
        templateId: 'table_preview_v1',
        templateVersion: '1.0.0',
        dataRequirement: 'de_table',
        bindings: {},
        filters: [
          { column: 'padj', operator: 'lt', value: 0.05 },
          { column: 'log2FoldChange', operator: 'gte', value: 1 },
          { column: 'log2FoldChange', operator: 'lte', value: -1 },
        ],
        combinator: 'AND',
        // The two log2FoldChange conditions OR together (|x| >= 1); padj < 0.05
        // ANDs against that pair — same AXI-1136 combinator/columnCombinators
        // shape the data table's own filter UI uses.
        columnCombinators: { log2FoldChange: 'OR' },
      },
      {
        title: 'P-value distribution — tested universe',
        templateId: 'histogram_v1',
        templateVersion: '1.0.0',
        dataRequirement: 'de_table',
        bindings: { x: 'pvalue' },
        params: { bin_count: 30 },
      },
      {
        title: 'Independent-filtering exclusions — padj not reported',
        templateId: 'table_preview_v1',
        templateVersion: '1.0.0',
        dataRequirement: 'de_table',
        bindings: {},
        filters: [{ column: 'padj', operator: 'is_null' }],
      },
      {
        // Capture Spec §6.2 #5: box/violin by response group, over the top
        // 20 lowest-padj genes' pre-therapy expression — `pre_expression`
        // is the count-matrix dataset's own literal column (see the
        // `content.datasets` doc above for how it was built).
        title: 'Expression by response group — top discriminating genes',
        templateId: 'boxplot_v1',
        templateVersion: '1.0.0',
        dataRequirement: 'count_matrix',
        bindings: { y: 'pre_expression', group: 'response' },
      },
      {
        // Capture Spec §6.2 #6: paired pre/on-treatment delta — restricted,
        // at melt time, to the 27 patients with BOTH samples, so every row
        // already has a real `on_expression` (no null-filter dependency).
        title: 'Paired timepoint delta — pre vs on-treatment',
        templateId: 'paired_timepoint_scatter_v1',
        templateVersion: '1.0.0',
        dataRequirement: 'count_matrix',
        bindings: { x: 'pre_expression', y: 'on_expression', group: 'response' },
      },
    ],
    // AXI-1376 (FR11, Capture Spec §8): both thresholds target the chart
    // that is literally about these two cutoffs ("Significant differential
    // expression — FDR < 0.05, |log2FC| ≥ 1"), authored by Marc Ottavi/MO
    // (Capture Spec §3 owns thresholds). `provenance` and `rationale` are
    // folded into the threshold's `label` and a threshold-targeted
    // Annotation respectively — see `types.ts`'s `ThresholdFixture` doc for
    // why (no structured provenance field exists on the backend entity).
    thresholds: [
      {
        chartTitle: 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1',
        field: 'log2FoldChange',
        operator: '>=',
        value: 1,
        label: '|log2FC| ≥ 1 — published cutoff (external)',
        provenance: 'external',
        rationale: '|log2FC| ≥ 1 is the published cutoff, taken from prior literature rather than fitted on this cohort — keeping it external means these p-values are not inflated by having chosen the threshold from the same data.',
        authorHandle: 'cast-biologist',
      },
      {
        chartTitle: 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1',
        field: 'padj',
        operator: '<',
        value: 0.05,
        label: 'FDR < 0.05 — prespecified',
        provenance: 'prespecified',
        rationale: 'FDR < 0.05 was declared before the contrast was run, not chosen after seeing which genes cleared it.',
        authorHandle: 'cast-biologist',
      },
    ],
    // AXI-1376 (FR11/AC10, Capture Spec §4). Array order is version order —
    // see `types.ts`'s `ContentSlots.snapshots` doc. v2's name carries the
    // "stratified" wording verbatim from the spec; `snapshotStaging.ts`
    // documents why the underlying data slice is honestly identical to v1
    // (no per-patient ipilimumab-exposure column exists in either ingested
    // dataset — a real stratified contrast would require a new offline DE
    // re-run per arm, out of this REST-only story's scope).
    snapshots: [
      { name: 'Snapshot v1' },
      { name: 'Snapshot v2 — stratified by prior ipilimumab exposure (naive vs progressed)' },
    ],
    // AXI-1375 (FR10, Capture Spec §7). Handle -> cast mapping (see `cast`
    // above): cast-biologist = Marc Ottavi/MO, cast-bioinformatician = Léa
    // Fontaine/LF, cast-clinician = Claire Ngo/CN, external-stakeholder =
    // Daniel Reiss/DR.
    comments: {
      // §7.1 — internal thread, analysis level (AC9: >= 3 distinct authors,
      // >= 1 reply, >= 1 resolved). Staged on `/api/v1/snapshot-comments`
      // (anchorType: 'view_analysis') — see `commentStaging.ts`'s module doc
      // for why that surface, not `/api/v1/comments`, backs this thread.
      internalThread: [
        {
          type: 'assumption',
          authorHandle: 'cast-biologist',
          text: 'Contrast direction assumed positive log2FC = higher in responders. Not yet confirmed against the design matrix; flag before any direction-dependent claim.',
        },
        {
          type: 'assumption',
          authorHandle: 'cast-biologist',
          text: 'baseMean ≥ 10 prefilter declared before the contrast was run, not chosen after looking at the result. Recorded so the p-values are not read as optimistic.',
        },
        {
          type: 'qc_concern',
          authorHandle: 'cast-bioinformatician',
          text: 'NULL padj genes are DESeq2 independent-filtering drops at low baseMean, not an upstream join failure. The quarantine snapshot makes this unambiguous.',
        },
        {
          type: 'qc_concern',
          authorHandle: 'cast-bioinformatician',
          text: 'Volcano y-axis was raw p-value in the first draft, so the significant cloud sat at the bottom and read inverted. Now −log10(p), colour by significance category.',
          resolved: true,
          replies: [{ authorHandle: 'cast-biologist', text: 'Confirmed on v1. Threshold lines redrawn.' }],
        },
        {
          type: 'question',
          authorHandle: 'cast-clinician',
          text: 'Should the contrast run within the ipilimumab-naive and ipilimumab-progressed strata before pooling? The pooled result may be averaging two different biologies.',
          replies: [
            {
              authorHandle: 'cast-biologist',
              text: 'Ran both. Stratified contrasts are in snapshot v2; direction holds in the naive arm, N is too small in the progressed arm to say anything.',
            },
          ],
        },
        {
          type: 'interpretation_note',
          authorHandle: 'cast-clinician',
          text: 'Negative-at-baseline is consistent with the on-treatment signal being the discriminating one. Worth stating explicitly so a reviewer does not read the small significant set as a failed analysis.',
        },
      ],
      // §7.2 — chart-anchored comments (AC9: 4 exist). `chartTitle` matches a
      // `chartSpecs[].title` above verbatim; staged on `/api/v1/comments`
      // (chart-comments), anchored to that chart's `dashboardVisualizationId`.
      chartAnchored: [
        {
          chartTitle: 'Significant differential expression — FDR < 0.05, |log2FC| ≥ 1',
          authorHandle: 'cast-biologist',
          text: '|log2FC| ≥ 1 is the published cutoff, not fitted on this cohort. Keeping it external means the p-values here are not inflated by having chosen the threshold from the same data.',
        },
        {
          chartTitle: 'P-value distribution — tested universe',
          authorHandle: 'cast-bioinformatician',
          text: 'Uniform with a spike near zero is what we want. A U-shape would say the model is misspecified and nothing downstream is safe.',
        },
        {
          chartTitle: 'Independent-filtering exclusions — padj not reported',
          authorHandle: 'cast-bioinformatician',
          text: 'These are the low-baseMean genes dropped by independent filtering. They are excluded, not lost.',
        },
        {
          chartTitle: 'Volcano — pre-therapy responders vs non-responders (baseMean ≥ 10)',
          authorHandle: 'cast-clinician',
          text: 'Pre-therapy separation is weak here, and that is the finding, not a failure. Do not let this figure travel without that sentence attached.',
        },
      ],
      // §7.3 — external thread. DR asks and follows up (`authorType: 'client'`);
      // CN's reply is `authorType: 'internal'` on the SAME artifact thread —
      // AC9's "authored solely by the external stakeholder" scopes to the
      // EXTERNAL side of the boundary, not to every message in the thread
      // (see `commentStaging.ts`'s module doc).
      externalThread: [
        {
          authorHandle: 'external-stakeholder',
          authorType: 'client',
          text: 'Can we see this contrast restricted to the ipilimumab-naive arm before it goes to our team?',
        },
        {
          authorHandle: 'cast-clinician',
          authorType: 'internal',
          text: 'Snapshot v2 has it. Direction holds in the naive arm; the progressed arm is underpowered and we have said so on the record rather than reporting it.',
        },
        {
          authorHandle: 'external-stakeholder',
          authorType: 'client',
          text: 'Good. The point my group will press on is whether the fold-change cutoff was fitted here. Useful that it is written down as the published one.',
        },
      ],
    },
    interpretations: [],
    evidence: [],
    events: [],
  },
};
