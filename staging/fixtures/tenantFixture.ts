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
    dataset: {
      originalFilename: 'riaz2017_de_pre_R_vs_NR.csv',
      contentType: 'text/csv',
      workspaceName: 'Translational Immuno-Oncology',
      projectName: 'Melanoma IO cohort, paired timepoints',
    },
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
    chartSpecs: [],
    thresholds: [],
    comments: [],
    interpretations: [],
    evidence: [],
    events: [],
  },
};
