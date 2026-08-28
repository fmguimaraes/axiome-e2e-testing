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
 */
export type DataRequirement = 'de_table' | 'count_matrix';

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
  thresholds: unknown[];
  comments: unknown[];
  interpretations: unknown[];
  evidence: unknown[];
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
