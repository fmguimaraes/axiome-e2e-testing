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
 * The single Riaz 2017 dataset version (AXI-1372, FR7/AC5). Names WHERE it
 * binds (workspace/project, by the same fixture names `staging/steps/**`
 * already provisions) and WHAT it is declared as (filename/content type) —
 * everything a reader would call "words", not code. Deliberately has no
 * `cohort` field of its own: there is exactly one cohort per tenant today
 * (`TenantFixture.publicCohort`, already NFR8-checked), so duplicating it
 * here would just be a second place the same fact could drift.
 *
 * No local filesystem path here on purpose — a machine-specific file
 * location is not staged "content" any more than the admin bootstrap
 * credential is (FR4's env-sourcing precedent); see
 * `staging/steps/datasetIngestion.ts`'s `STAGING_RIAZ_DE_CSV_PATH`.
 */
export interface DatasetFixture {
  originalFilename: string;
  contentType: string;
  workspaceName: string;
  projectName: string;
}

/**
 * Slots for content later stories fill (FR6's fuller list: the scientific
 * question, assumption bodies, chart titles/specs, threshold values, comment
 * bodies, interpretation statements, evidence records, event-feed entries).
 * Declared now, empty by design, so AXI-1372+ extend data here rather than
 * widen the fixture's shape.
 */
export interface ContentSlots {
  scientificQuestion?: string;
  dataset?: DatasetFixture;
  assumptions: unknown[];
  chartSpecs: unknown[];
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
