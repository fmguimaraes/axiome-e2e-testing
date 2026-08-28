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
    scientificQuestion: undefined,
    assumptions: [],
    chartSpecs: [],
    thresholds: [],
    comments: [],
    interpretations: [],
    evidence: [],
    events: [],
  },
};
