/**
 * The content fixture format (AXI-1371, FR6).
 *
 * FR6: "All staged content ... MUST be declared in a single versioned fixture
 * file in the repository, and the toolkit MUST read it rather than
 * hard-coding content. Editing the demo's words MUST NOT require editing
 * code." Code (the `staging/steps/**` provisioning logic) holds the tenant's
 * *shape* — an org has workspaces, a workspace has projects, a project is
 * either kept or retired. This file holds only *types*; `tenantFixture.ts`
 * holds the actual words, and is the only file a wording change touches.
 *
 * NFR8 ("the fixture format MUST NOT be able to represent a non-public
 * cohort") is enforced at the type level by {@link PublicCohortId} — a closed
 * union, not a free `string` — plus a runtime check in `validateFixture.ts`
 * for the case where the fixture is loaded from untyped JSON/YAML rather than
 * authored as this literal TS object.
 */

/**
 * Closed allow-list of cohorts the fixture format can name (NFR8). Capture
 * Spec §1: "Public dataset only ... No MAG4, no AP-HM, no MIPP, not even
 * de-identified." Widening this to a second cohort is a real product change —
 * add the literal here, deliberately, never accept an arbitrary string.
 */
export type PublicCohortId = 'riaz-2017';

export const PUBLIC_COHORT_ALLOWLIST: readonly PublicCohortId[] = ['riaz-2017'];

/** A cast member's real display name (Capture Spec §3), keyed onto an
 *  AXI-1370 identity handle. The handle is who can authenticate; this is what
 *  their frames show. */
export interface CastMemberFixture {
  handle: string;
  displayFirstName: string;
  displayLastName: string;
  initials: string;
  role: string;
}

/** A project the tenant must contain, converging under `name` regardless of
 *  which legacy name (Capture Spec §2.1) it may currently carry. */
export interface ProjectFixture {
  name: string;
  legacyNames: string[];
}

/** A project the tenant must NOT contain at all — Capture Spec §2.1's
 *  "Delete" instructions. Distinct from {@link ProjectFixture} because there
 *  is no name to converge onto: the only correct end state is "gone".
 *  `retiredName` is a fallback word (FR6: still content, not code) applied
 *  if the live DELETE route rejects an otherwise-archived project — see
 *  `staging/steps/projectRetirement.ts` for why deletion can fail. */
export interface RetiredProjectFixture {
  legacyName: string;
  retiredName: string;
}

export interface WorkspaceFixture {
  name: string;
  legacyNames: string[];
  type: 'internal' | 'client' | 'consortium';
  projects: ProjectFixture[];
  retiredProjects: RetiredProjectFixture[];
}

export interface OrganizationFixture {
  name: string;
  type: string;
}

/**
 * What a chart (or a dataset backing one) needs to exist: the Riaz DE table
 * (one row per gene, AXI-1372's `94b0bd10`) or the per-sample count matrix
 * (AXI-1374 charts 5-6). Shared between {@link DatasetFixture.role} and
 * {@link ChartSpecFixture.dataRequirement} so a chart's requirement and a
 * dataset's role are checked against the same closed vocabulary — no string
 * that means "de_table" in one field and "deTable" in the other.
 *
 * `stratified_de_table` (AXI-1376 OQ6 follow-up) names the real per-arm
 * (ipilimumab-naive vs -progressed) DESeq2 re-run of the pre-therapy
 * responder-vs-non-responder contrast, produced offline by
 * `riaz_de/run_de_stratified.py` — the same class of artifact as the
 * `de_table` role, computed per stratum instead of pooled. No chart declares
 * this as a `dataRequirement`; it exists to be the dataset a snapshot
 * {@link SnapshotFixture.datasetRole} links to.
 */
export type DataRequirement = 'de_table' | 'count_matrix' | 'stratified_de_table';

/**
 * One dataset version the tenant carries (AXI-1372 FR7/AC5, widened by
 * AXI-1374 to "one corpus, two dataset versions" — Capture Spec §6.2 charts
 * 5-6 need per-sample expression the DE table doesn't have). Names WHERE it
 * binds (workspace/project, by the same fixture names `staging/steps/**`
 * already provisions) and WHAT it is declared as (filename/content type/
 * `role`) — everything a reader would call "words", not code. Every dataset
 * in `ContentSlots.datasets` MUST bind to the SAME workspace/project (one
 * corpus) — `checkDatasetsShareCorpus` (NFR8-adjacent) enforces this; a
 * dataset for a genuinely different corpus is a product decision, not
 * something this fixture shape can represent by accident.
 *
 * `localPathEnv`/`defaultLocalPath` replace what AXI-1372 hard-coded as a
 * module constant in `datasetIngestion.ts` — every dataset entry carries its
 * OWN operator-machine file location (FR4's env-sourcing precedent: a real,
 * usable default, never a credential), so the ingestion step reads from the
 * fixture entry instead of a single hard-coded path.
 */
export interface DatasetFixture {
  role: DataRequirement;
  originalFilename: string;
  contentType: string;
  workspaceName: string;
  projectName: string;
  localPathEnv: string;
  defaultLocalPath: string;
}

/**
 * Assumption categories, named after the Capture Spec §5 popover section
 * labels (AXI-1373, FR9). Three of these (`cohort_definition`,
 * `data_filter`, `methodological_choice`) are byte-identical to the
 * backend's `AssumptionType` enum (`libs/contracts/src/framing/
 * framing.patterns.ts`) on purpose — no translation needed for the ones
 * this story actually stages. `threshold_provenance` has no backend
 * counterpart (the closest is `domain_assumption`); see
 * `staging/steps/analysisFraming.ts` for the mapping and why it is never
 * exercised while the FR9 guard stays closed.
 */
export type AssumptionCategory = 'cohort_definition' | 'data_filter' | 'methodological_choice' | 'threshold_provenance';

/**
 * One assumption the demo tenant should carry (Capture Spec §5). `text` is
 * the exact popover body; `authorHandle` is the AXI-1370 identity that must
 * author it (Capture Spec §3: Marc Ottavi/MO owns assumptions, thresholds,
 * contrast choices — mapped onto the `cast-biologist` handle, see the note
 * in `tenantFixture.ts`'s `cast` array).
 *
 * Declaring all four here (words) is correct even though FR9 forbids
 * staging the fourth unconditionally — the TRUTH judgment that withholds it
 * is a toolkit-level guard (`analysisFraming.ts`), not a fixture flag,
 * because whether the claim is true of this run is a verified fact about
 * how the DE table was built, not a matter of demo wording.
 */
export interface AssumptionFixture {
  category: AssumptionCategory;
  text: string;
  authorHandle: string;
}

/**
 * A chart the tenant must carry (AXI-1374, FR8/FR23, Capture Spec §6.2).
 * `templateId`/`templateVersion` match the backend's seeded template
 * registry verbatim (`apps/organization-service/src/templates/
 * seed-templates/*.templates.ts`) — the create route 404s on a mismatch.
 * `bindings` are plain source-column names (the Riaz DE table's own header
 * row: gene/baseMean/log2FoldChange/lfcSE/pvalue/padj), which is what the
 * frontend's `resolveBinding` accepts directly (see
 * `axiome-front/src/lib/charts/builders/shared.ts`).
 *
 * `dataRequirement` is content (a fact about what the chart needs), but
 * whether that requirement is actually SATISFIED is a toolkit-level TRUTH
 * judgment checked against the LIVE platform state (which `DatasetFixture`
 * roles are actually ingested and available), same shape as FR9's threshold
 * guard — see `isChartStageable` in `chartStaging.ts`. A chart whose
 * requirement isn't met is withheld, never fabricated.
 */
export interface ChartSpecFixture {
  title: string;
  templateId: string;
  templateVersion: string;
  dataRequirement: DataRequirement;
  bindings: Record<string, string>;
  params?: Record<string, unknown>;
  filters?: { column: string; operator: string; value?: unknown }[];
  combinator?: 'AND' | 'OR';
  columnCombinators?: Record<string, 'AND' | 'OR'>;
}

/**
 * Type badge on an internal-thread comment (AXI-1375, FR10, Capture Spec
 * §7.1). Byte-identical to the backend's `SnapshotCommentType` enum
 * (`libs/contracts/src/snapshot-comment/snapshot-comment.patterns.ts`) —
 * `commentStaging.ts` stages this thread on `/api/v1/snapshot-comments`
 * (`anchorType: 'view_analysis'`), the type that actually backs the
 * Discussion tab's type badges — confirmed against
 * `SnapshotDiscussionPanel.tsx` (axiome-front), NOT `/api/v1/comments`
 * (chart-comments), despite the AXI-1369 audit catalog labeling the latter
 * "analysis-level" (a mislabel corrected in `staging/audit/actionCatalog.ts`
 * by this same story).
 */
export type InternalCommentType = 'question' | 'interpretation_note' | 'qc_concern' | 'assumption' | 'action_item';

/** One reply nested under an {@link InternalCommentFixture} or an
 *  {@link ExternalThreadMessageFixture} (Capture Spec §7.1's "↳ MO reply:",
 *  §7.3's "CN · reply"). */
export interface CommentReplyFixture {
  authorHandle: string;
  text: string;
}

/**
 * One comment in the internal analysis-level thread (Capture Spec §7.1,
 * AC9: "≥ 3 distinct authors, ≥ 1 reply, ≥ 1 resolved"). `resolved: true`
 * marks the one entry `commentStaging.ts` resolves live via
 * `PATCH /api/v1/snapshot-comments/:id/resolve` after staging it — the
 * LF "Volcano y-axis" QC concern, per spec.
 */
export interface InternalCommentFixture {
  type: InternalCommentType;
  authorHandle: string;
  text: string;
  resolved?: boolean;
  replies?: CommentReplyFixture[];
}

/**
 * One chart-anchored comment (Capture Spec §7.2, AC9: "four chart-anchored
 * comments exist"). `chartTitle` matches a {@link ChartSpecFixture.title}
 * verbatim — `commentStaging.ts` resolves it to that chart's
 * `dashboardVisualizationId` (via a dashboard link, see that file's module
 * doc) rather than carrying an id here, so this fixture stays pure content
 * (FR6) with no dependency on staging-run-specific ids.
 */
export interface ChartAnchoredCommentFixture {
  chartTitle: string;
  authorHandle: string;
  text: string;
}

/**
 * One message in the external stakeholder thread (Capture Spec §7.3, AC9:
 * "non-zero count, authored solely by the external stakeholder" — on the
 * EXTERNAL side; an internal reply within the same thread does not violate
 * this, see `commentStaging.ts`'s module doc). `authorType` is the
 * `ClientExplorationComment` field the backend actually keys visibility on
 * (`client` vs `internal`) — declared per-message here rather than derived
 * from `authorHandle`, since the fixture is content and the mapping from
 * "which handle" to "which side of the boundary" is exactly the fact this
 * thread is staged to demonstrate.
 */
export interface ExternalThreadMessageFixture {
  authorHandle: string;
  authorType: 'client' | 'internal';
  text: string;
}

/** The full §7 comment set (AXI-1375, FR10). */
export interface CommentsFixture {
  internalThread: InternalCommentFixture[];
  chartAnchored: ChartAnchoredCommentFixture[];
  externalThread: ExternalThreadMessageFixture[];
}

/**
 * How a threshold's cutoff was arrived at (AXI-1376, Capture Spec §8). The
 * backend `Threshold` entity (`apps/organization-service/src/thresholds/`)
 * has NO structured provenance/rationale field at all — only
 * `field`/`operator`/`value`/`label`/`consumers`/`status`/`createdBy`
 * (confirmed against `libs/contracts/src/threshold/threshold.patterns.ts`
 * and the Prisma model). `provenance` here is fixture-level content that
 * `thresholdStaging.ts` folds into the threshold's `label` (a short marker)
 * and into a threshold-targeted `Annotation`'s `text` (the one-line
 * rationale Capture Spec §8 requires) — the closest real, honest mapping
 * this schema supports. See `thresholdStaging.ts`'s module doc for the full
 * investigation.
 */
export type ThresholdProvenance = 'external' | 'prespecified';

/**
 * One threshold the tenant must carry (Capture Spec §8: "author, value,
 * rationale and cutoff provenance visible"). `operator` is restricted to the
 * backend's `ThresholdOperator` scalar comparisons (`>=`/`<=`/`>`/`<`) —
 * `between` is excluded here because neither of this story's two thresholds
 * needs a range. `chartTitle` matches a {@link ChartSpecFixture.title}
 * verbatim, same binding convention as {@link ChartAnchoredCommentFixture}.
 */
export interface ThresholdFixture {
  chartTitle: string;
  field: string;
  operator: '>=' | '<=' | '>' | '<';
  value: number;
  label: string;
  provenance: ThresholdProvenance;
  rationale: string;
  authorHandle: string;
}

/**
 * One versioned snapshot of the analysis (AXI-1376, FR11/AC10, Capture Spec
 * §4; `datasetRole` added by the OQ6 follow-up). `name` is set post-creation
 * via `PATCH .../snapshots/:id` and doubles as this fixture's idempotent
 * identity marker — `snapshotStaging.ts` looks up "the snapshot named this"
 * rather than relying on array position, because a stale prior version bound
 * to the wrong dataset must be superseded (renamed out of the way), not
 * silently treated as done.
 *
 * `datasetRole` (optional) is the {@link DataRequirement} this snapshot
 * version resolves against, by declared dataset role rather than a live id
 * (FR6: content is words). Omitted means "the analysis's own root dataset"
 * (a plain filter-origin snapshot — what every snapshot was before this
 * field existed). When set, `snapshotStaging.ts` creates the snapshot with
 * `origin: 'linked'` and an explicit `datasetId` resolved from the matching
 * `content.datasets[]` entry — the backend's `linked` origin exists
 * precisely for "a snapshot pointing at an append-only-attached dataset
 * unrelated to the analysis root" (`view-analyses.service.ts
 * assertOriginInvariant`), which is exactly what a real per-arm stratified
 * DE result is relative to the pooled root dataset.
 */
export interface SnapshotFixture {
  name: string;
  datasetRole?: DataRequirement;
}

/**
 * Evidence "kind" (AXI-1377, Capture Spec §9: "6, mixed kinds — chart-derived,
 * statistical, computed"). INVESTIGATION FINDING: no literal `kind` enum
 * exists on the backend `Evidence`/`EvidenceVersion` entity at all (confirmed
 * against `libs/contracts/src/view-analysis/**`, the Prisma schema, and
 * `citation-context.types.ts` — the only real discriminator is
 * `citationContext.kind: 'de' | 'flow' | 'table'`, a DIFFERENT axis: whether
 * a tabular row/population is cited, not "what kind of evidence this is").
 * This type is fixture-level bookkeeping ONLY — it drives which REST shape
 * `interpretationsEvidenceStaging.ts` builds, never a field sent to the
 * backend (`CreateEvidenceDto` would 400 on an unknown property).
 *
 * The three values map onto three genuinely distinct, real backend code
 * paths, honestly representing "mixed kinds" without fabricating a field:
 * - `chart-derived`: `chartEntries` only (cites a chart + snapshot directly).
 * - `statistical`: `citationContext.kind: 'de'` only (cites specific DE rows
 *   with p-values/log2FC — a numeric/statistical claim), no chart entries.
 * - `computed`: `chartEntries` + `parentEvidenceId` set — a roll-up derived
 *   FROM another Evidence (AXI-995/FR8's derived-evidence lineage,
 *   materializes a `DERIVED_FROM` edge distinct from a raw chart citation).
 */
export type EvidenceKind = 'chart-derived' | 'statistical' | 'computed';

interface EvidenceFixtureBase {
  title: string;
  text: string;
}

/** Cites a chart directly (`POST /view-analyses/evidences` `chartEntries`).
 *  `chartTitle`/`snapshotName` resolve to live ids the same way
 *  {@link ThresholdFixture.chartTitle} and {@link SnapshotFixture.name} do. */
export interface ChartDerivedEvidenceFixture extends EvidenceFixtureBase {
  kind: 'chart-derived';
  chartTitle: string;
  snapshotName: string;
}

/**
 * Cites specific rows of a DE dataset via `citationContext: {kind: 'de', ...}`.
 * `citedGeneCount` (not a literal gene list) is deliberate: which genes are
 * "top" by padj is LIVE query-time truth, not a fixture word (same
 * live-state-over-fixture-constant precedent as `isChartStageable`'s dataset-
 * role availability check) — the step queries the real dataset (lowest padj
 * first, optionally filtered) rather than hard-coding gene symbols that could
 * drift from a re-ingested dataset.
 */
export interface StatisticalEvidenceFixture extends EvidenceFixtureBase {
  kind: 'statistical';
  datasetRole: DataRequirement;
  citedGeneCount: number;
  strataFilter?: { column: string; value: string };
}

/** A computed roll-up derived from an earlier-declared evidence entry
 *  (`parentEvidenceTitle` must match another {@link EvidenceFixture.title}
 *  declared earlier in the array — `validateFixture.ts` enforces both the
 *  existence and the ordering, since a forward reference would need the not-
 *  yet-created evidence's live id). */
export interface ComputedEvidenceFixture extends EvidenceFixtureBase {
  kind: 'computed';
  chartTitle: string;
  snapshotName: string;
  parentEvidenceTitle: string;
}

export type EvidenceFixture = ChartDerivedEvidenceFixture | StatisticalEvidenceFixture | ComputedEvidenceFixture;

/** Byte-identical to the backend `DecisionDraftType` enum
 *  (`libs/contracts/src/decision-draft/decision-draft.patterns.ts`). */
export type InterpretationType =
  | 'phenotype_classification'
  | 'qc_assessment'
  | 'cohort_stratification'
  | 'biomarker_threshold'
  | 'assay_qualification';

/** Byte-identical to the backend `DecisionDraftConfidence` enum. */
export type InterpretationConfidence = 'low' | 'medium' | 'high';

/**
 * One citation on an interpretation's `evidenceLinks[]` (AXI-1377). Exactly
 * one of `snapshotName`/`evidenceTitle` is set — a decision counts toward an
 * analysis's Interpretations tab if EITHER matches one of that analysis's own
 * snapshots or evidence (`decision-drafts.service.ts findAllByViewAnalysis`,
 * confirmed live) — but only an `evidenceTitle` citation counts as "citing
 * evidence explicitly" (Capture Spec §9 / FR12).
 */
export interface InterpretationCitation {
  snapshotName?: string;
  evidenceTitle?: string;
}

/**
 * One interpretation (= DecisionDraft, see the dev-epic-context's naming
 * note) the tenant must carry (AXI-1377, FR12/AC11, Capture Spec §9).
 * `targetStatus` is the transition target after create — 'draft' is never
 * valid here because §9 requires "a validated interpretation"; the step
 * transitions every declared interpretation at least to 'reviewed'.
 */
export interface InterpretationFixture {
  label: string;
  type: InterpretationType;
  confidence: InterpretationConfidence;
  authorHandle: string;
  citations: InterpretationCitation[];
  targetStatus: 'reviewed' | 'approved';
}

/**
 * Slots for content later stories fill (FR6's fuller list: the scientific
 * question, assumption bodies, chart titles/specs, threshold values, comment
 * bodies, interpretation statements, evidence records, event-feed entries).
 * Declared now, empty by design, so AXI-1372+ extend data here rather than
 * widen the fixture's shape.
 */
export interface ContentSlots {
  /**
   * AXI-1373 (FR9, Capture Spec §4): "This sentence ... appears in frame on
   * most captures and becomes alt text" — the analysis header/title AND the
   * framed Review Question are the SAME string, verbatim (per the story's
   * own acceptance criterion: "the title is the scientific question
   * verbatim"). One field, not two, so there is nowhere for title and
   * question to drift apart.
   */
  scientificQuestion?: string;
  /**
   * AXI-1372 FR7/AC5, widened AXI-1374: one corpus, one-or-more dataset
   * versions. `checkDatasetsShareCorpus` (`validateFixture.ts`) enforces the
   * "one corpus" half; `role` uniqueness within the list is what makes
   * "the de_table dataset" / "the count_matrix dataset" well-defined lookups
   * for `staging/steps/**`.
   */
  datasets: DatasetFixture[];
  assumptions: AssumptionFixture[];
  chartSpecs: ChartSpecFixture[];
  thresholds: ThresholdFixture[];
  comments: CommentsFixture;
  /** AXI-1376 (FR11/AC10, Capture Spec §4): declared in fixture ORDER —
   *  index 0 is v1 (pooled), index 1 is v2 (stratified label). Version
   *  numbers are assigned by the backend on creation (`version = count + 1`),
   *  so array order is the source of truth for "which is v1 / which is v2". */
  snapshots: SnapshotFixture[];
  /** AXI-1377 (FR12/AC11, Capture Spec §9). Declared AFTER `evidence` in the
   *  object literal is not required by TS, but every interpretation's
   *  `citations[].evidenceTitle` must reference a `evidence[]` entry —
   *  `checkInterpretationCitationsDeclared` enforces this at fixture level. */
  interpretations: InterpretationFixture[];
  /** AXI-1377 (FR12/AC11, Capture Spec §9). Array order matters for
   *  `kind: 'computed'` entries — `parentEvidenceTitle` must name an entry
   *  declared EARLIER in this same array (its live id must already exist by
   *  the time the computed entry is staged). */
  evidence: EvidenceFixture[];
  events: unknown[];
}

export interface TenantFixture {
  fixtureVersion: number;
  publicCohort: PublicCohortId;
  org: OrganizationFixture;
  workspaces: WorkspaceFixture[];
  cast: CastMemberFixture[];
  content: ContentSlots;
}
