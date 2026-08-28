import { PUBLIC_COHORT_ALLOWLIST } from './types';
import type { TenantFixture, WorkspaceFixture } from './types';

/**
 * Fixture-schema validator (AXI-1371, FR6/NFR8).
 *
 * Runs over a `TenantFixture` value regardless of how it was produced — the
 * TS literal in `tenantFixture.ts` today, or JSON/YAML loaded at runtime
 * later (FR6 only requires "a single versioned fixture file", not that it
 * stay a `.ts` literal forever). NFR8 must hold either way, so this check is
 * a runtime function, not just the `PublicCohortId` type.
 */
export interface FixtureViolation {
  rule: string;
  detail: string;
}

/** NFR8 — the fixture MUST NOT be able to represent a non-public cohort. */
export function checkPublicCohort(fixture: TenantFixture): FixtureViolation[] {
  const cohort = fixture.publicCohort as string;
  if (PUBLIC_COHORT_ALLOWLIST.includes(cohort as (typeof PUBLIC_COHORT_ALLOWLIST)[number])) return [];
  return [{ rule: 'NFR8', detail: `publicCohort "${cohort}" is not on the public-cohort allow-list [${PUBLIC_COHORT_ALLOWLIST.join(', ')}]` }];
}

/** Every name the fixture declares must be non-empty — an empty name can
 *  never be a deliberate staged word. */
export function checkNoEmptyNames(fixture: TenantFixture): FixtureViolation[] {
  const names = collectDeclaredNames(fixture);
  return names.filter((n) => n.trim().length === 0).map(() => ({ rule: 'schema', detail: 'a declared name is empty' }));
}

/** FR6 — cast handles must be unique and non-empty; a duplicate handle would
 *  make "who said this" ambiguous when the fixture is applied. */
export function checkCastHandlesUnique(fixture: TenantFixture): FixtureViolation[] {
  const seen = new Set<string>();
  const violations: FixtureViolation[] = [];
  for (const member of fixture.cast) {
    if (seen.has(member.handle)) violations.push({ rule: 'FR6', detail: `duplicate cast handle "${member.handle}"` });
    seen.add(member.handle);
  }
  return violations;
}

/** FR7 — every `content.datasets[]` entry must bind to a workspace/project
 *  this same fixture actually provisions; a typo'd name would otherwise only
 *  surface as a confusing 404 deep inside the dataset-ingestion step. */
export function checkDatasetBindsToDeclaredProject(fixture: TenantFixture): FixtureViolation[] {
  return fixture.content.datasets.flatMap((dataset) => checkOneDatasetBinding(fixture, dataset));
}

function checkOneDatasetBinding(fixture: TenantFixture, dataset: TenantFixture['content']['datasets'][number]): FixtureViolation[] {
  const workspace = fixture.workspaces.find((w) => w.name === dataset.workspaceName);
  if (!workspace) {
    return [{ rule: 'FR7', detail: `content.datasets[role=${dataset.role}].workspaceName "${dataset.workspaceName}" is not a declared workspace` }];
  }
  if (!workspace.projects.some((p) => p.name === dataset.projectName)) {
    return [{ rule: 'FR7', detail: `content.datasets[role=${dataset.role}].projectName "${dataset.projectName}" is not a declared project in workspace "${workspace.name}"` }];
  }
  return [];
}

/**
 * AC5 (amended, AXI-1374) — "one corpus, one-or-more dataset versions": every
 * declared dataset must bind to the SAME (workspace, project) pair. A second
 * dataset for a genuinely different corpus is a real product decision, not
 * something the fixture format should be able to represent by accident —
 * this is the structural guard that keeps that decision deliberate.
 */
export function checkDatasetsShareCorpus(fixture: TenantFixture): FixtureViolation[] {
  const datasets = fixture.content.datasets;
  if (datasets.length <= 1) return [];
  const [first, ...rest] = datasets;
  const mismatch = rest.find((d) => d.workspaceName !== first.workspaceName || d.projectName !== first.projectName);
  if (!mismatch) return [];
  return [{
    rule: 'AC5',
    detail: `content.datasets[role=${mismatch.role}] binds to "${mismatch.workspaceName}/${mismatch.projectName}", ` +
      `not the corpus's "${first.workspaceName}/${first.projectName}" — every dataset in one tenant must share one corpus`,
  }];
}

/** FR7/AC5 — a dataset `role` must be unique so "the de_table dataset" and
 *  "the count_matrix dataset" are well-defined lookups, never an ambiguous
 *  pick-the-first among duplicates. */
export function checkDatasetRolesUnique(fixture: TenantFixture): FixtureViolation[] {
  const seen = new Set<string>();
  const violations: FixtureViolation[] = [];
  for (const dataset of fixture.content.datasets) {
    if (seen.has(dataset.role)) violations.push({ rule: 'FR7', detail: `duplicate dataset role "${dataset.role}"` });
    seen.add(dataset.role);
  }
  return violations;
}

/** FR8 (Capture Spec §6.2: "no duplicates") — chart titles must be unique;
 *  a duplicate would silently collapse two distinct charts under the same
 *  re-run idempotency key (`alreadyStagedChart` keys on title). */
export function checkChartTitlesUnique(fixture: TenantFixture): FixtureViolation[] {
  const seen = new Set<string>();
  const violations: FixtureViolation[] = [];
  for (const spec of fixture.content.chartSpecs) {
    if (seen.has(spec.title)) violations.push({ rule: 'FR8', detail: `duplicate chart title "${spec.title}"` });
    seen.add(spec.title);
  }
  return violations;
}

/** AXI-1376 — a threshold's `chartTitle` must match a declared chart, or
 *  `thresholdStaging.ts` fails deep inside a live call instead of here. */
export function checkThresholdChartsDeclared(fixture: TenantFixture): FixtureViolation[] {
  const titles = new Set(fixture.content.chartSpecs.map((c) => c.title));
  return fixture.content.thresholds
    .filter((t) => !titles.has(t.chartTitle))
    .map((t) => ({ rule: 'FR6', detail: `threshold "${t.label}" targets chartTitle "${t.chartTitle}", which is not a declared chartSpec` }));
}

/** AXI-1376 (AC10) — snapshot `name`s must be distinct, so
 *  `snapshotStaging.ts`'s name-keyed lookup never treats two declared
 *  versions as the same live row. */
export function checkSnapshotNamesUnique(fixture: TenantFixture): FixtureViolation[] {
  const seen = new Set<string>();
  const violations: FixtureViolation[] = [];
  for (const snapshot of fixture.content.snapshots) {
    if (seen.has(snapshot.name)) violations.push({ rule: 'AC10', detail: `duplicate snapshot name "${snapshot.name}"` });
    seen.add(snapshot.name);
  }
  return violations;
}

/** AXI-1376 OQ6 follow-up — a snapshot's `datasetRole` (when declared) must
 *  match a declared `content.datasets[]` role, or `snapshotStaging.ts` fails
 *  deep inside a live run instead of here (same shape as
 *  `checkThresholdChartsDeclared`). */
export function checkSnapshotDatasetRolesDeclared(fixture: TenantFixture): FixtureViolation[] {
  const roles = new Set(fixture.content.datasets.map((d) => d.role));
  return fixture.content.snapshots
    .filter((s) => s.datasetRole !== undefined && !roles.has(s.datasetRole))
    .map((s) => ({ rule: 'FR6', detail: `snapshot "${s.name}" declares datasetRole "${s.datasetRole}", which is not a declared dataset role` }));
}

/** AXI-1377 — evidence titles are this fixture's idempotent identity marker
 *  (mirrors `checkChartTitlesUnique`/`checkSnapshotNamesUnique`); a duplicate
 *  would collapse two distinct evidence records under one lookup. */
export function checkEvidenceTitlesUnique(fixture: TenantFixture): FixtureViolation[] {
  const seen = new Set<string>();
  const violations: FixtureViolation[] = [];
  for (const evidence of fixture.content.evidence) {
    if (seen.has(evidence.title)) violations.push({ rule: 'FR6', detail: `duplicate evidence title "${evidence.title}"` });
    seen.add(evidence.title);
  }
  return violations;
}

/** AXI-1377 — a `chart-derived`/`computed` evidence's `chartTitle`/
 *  `snapshotName` must match a declared chart/snapshot, or the staging step
 *  fails deep inside a live call instead of here (same shape as
 *  `checkThresholdChartsDeclared`). */
export function checkEvidenceReferencesDeclared(fixture: TenantFixture): FixtureViolation[] {
  const chartTitles = new Set(fixture.content.chartSpecs.map((c) => c.title));
  const snapshotNames = new Set(fixture.content.snapshots.map((s) => s.name));
  const violations: FixtureViolation[] = [];
  for (const evidence of fixture.content.evidence) {
    if (evidence.kind === 'statistical') continue;
    if (!chartTitles.has(evidence.chartTitle)) {
      violations.push({ rule: 'FR6', detail: `evidence "${evidence.title}" targets chartTitle "${evidence.chartTitle}", which is not a declared chartSpec` });
    }
    if (!snapshotNames.has(evidence.snapshotName)) {
      violations.push({ rule: 'FR6', detail: `evidence "${evidence.title}" targets snapshotName "${evidence.snapshotName}", which is not a declared snapshot` });
    }
  }
  return violations;
}

/** AXI-1377 — a `computed` evidence's `parentEvidenceTitle` must name
 *  another evidence entry declared EARLIER in the same array (its live id
 *  must already exist by the time the computed entry is staged — see
 *  `types.ts`'s `ContentSlots.evidence` doc). */
export function checkComputedEvidenceParentDeclaredEarlier(fixture: TenantFixture): FixtureViolation[] {
  const violations: FixtureViolation[] = [];
  const seenTitles = new Set<string>();
  for (const evidence of fixture.content.evidence) {
    if (evidence.kind === 'computed' && !seenTitles.has(evidence.parentEvidenceTitle)) {
      violations.push({
        rule: 'FR6',
        detail: `computed evidence "${evidence.title}" declares parentEvidenceTitle "${evidence.parentEvidenceTitle}", which is not an earlier-declared evidence entry`,
      });
    }
    seenTitles.add(evidence.title);
  }
  return violations;
}

/** AXI-1377 — an interpretation's citation must name a declared snapshot or
 *  evidence entry, same shape as `checkEvidenceReferencesDeclared`. */
export function checkInterpretationCitationsDeclared(fixture: TenantFixture): FixtureViolation[] {
  const snapshotNames = new Set(fixture.content.snapshots.map((s) => s.name));
  const evidenceTitles = new Set(fixture.content.evidence.map((e) => e.title));
  const violations: FixtureViolation[] = [];
  for (const interpretation of fixture.content.interpretations) {
    for (const citation of interpretation.citations) {
      if (citation.snapshotName && !snapshotNames.has(citation.snapshotName)) {
        violations.push({ rule: 'FR6', detail: `interpretation "${interpretation.label}" cites snapshotName "${citation.snapshotName}", which is not a declared snapshot` });
      }
      if (citation.evidenceTitle && !evidenceTitles.has(citation.evidenceTitle)) {
        violations.push({ rule: 'FR6', detail: `interpretation "${interpretation.label}" cites evidenceTitle "${citation.evidenceTitle}", which is not a declared evidence entry` });
      }
    }
  }
  return violations;
}

/** AC11 (Capture Spec §9) — fixture-level shape check: exactly 3
 *  interpretations, at least one authored by Claire Ngo (`cast-clinician`),
 *  at least one citing evidence explicitly (an `evidenceTitle` citation, not
 *  just a `snapshotName` one). */
export function checkInterpretationsShape(fixture: TenantFixture): FixtureViolation[] {
  const violations: FixtureViolation[] = [];
  const declared = fixture.content.interpretations;
  if (declared.length !== 3) {
    violations.push({ rule: 'AC11', detail: `expected exactly 3 declared interpretations, found ${declared.length}` });
  }
  if (!declared.some((i) => i.authorHandle === 'cast-clinician')) {
    violations.push({ rule: 'AC11', detail: 'no declared interpretation is authored by "cast-clinician" (Claire Ngo)' });
  }
  if (!declared.some((i) => i.citations.some((c) => c.evidenceTitle))) {
    violations.push({ rule: 'AC11', detail: 'no declared interpretation cites evidence explicitly (an evidenceTitle citation)' });
  }
  return violations;
}

/** AC11 (Capture Spec §9) — fixture-level shape check: exactly 6 evidence
 *  entries, all three kinds represented ("mixed kinds"). */
export function checkEvidenceShape(fixture: TenantFixture): FixtureViolation[] {
  const declared = fixture.content.evidence;
  const violations: FixtureViolation[] = [];
  if (declared.length !== 6) {
    violations.push({ rule: 'AC11', detail: `expected exactly 6 declared evidence entries, found ${declared.length}` });
  }
  const kinds = new Set(declared.map((e) => e.kind));
  for (const kind of ['chart-derived', 'statistical', 'computed'] as const) {
    if (!kinds.has(kind)) violations.push({ rule: 'AC11', detail: `no declared evidence entry has kind "${kind}" — evidence is not "mixed kinds"` });
  }
  return violations;
}

function collectDeclaredNames(fixture: TenantFixture): string[] {
  const workspaceNames = fixture.workspaces.flatMap(collectWorkspaceNames);
  return [fixture.org.name, ...workspaceNames];
}

function collectWorkspaceNames(ws: WorkspaceFixture): string[] {
  const projectNames = ws.projects.map((p) => p.name);
  const retiredNames = ws.retiredProjects.map((p) => p.legacyName);
  return [ws.name, ...projectNames, ...retiredNames];
}

/** Runs every fixture-format check; empty result = the fixture is valid. */
export function validateFixture(fixture: TenantFixture): FixtureViolation[] {
  return [
    ...checkPublicCohort(fixture),
    ...checkNoEmptyNames(fixture),
    ...checkCastHandlesUnique(fixture),
    ...checkDatasetBindsToDeclaredProject(fixture),
    ...checkDatasetsShareCorpus(fixture),
    ...checkDatasetRolesUnique(fixture),
    ...checkChartTitlesUnique(fixture),
    ...checkThresholdChartsDeclared(fixture),
    ...checkSnapshotNamesUnique(fixture),
    ...checkSnapshotDatasetRolesDeclared(fixture),
    ...checkEvidenceTitlesUnique(fixture),
    ...checkEvidenceReferencesDeclared(fixture),
    ...checkComputedEvidenceParentDeclaredEarlier(fixture),
    ...checkInterpretationCitationsDeclared(fixture),
    ...checkInterpretationsShape(fixture),
    ...checkEvidenceShape(fixture),
  ];
}

/** Throws with every violation listed — the entry point for a caller that
 *  wants "valid or stop", rather than the raw list. */
export function assertFixtureValid(fixture: TenantFixture): void {
  const violations = validateFixture(fixture);
  if (violations.length === 0) return;
  const lines = violations.map((v) => `  [${v.rule}] ${v.detail}`).join('\n');
  throw new Error(`fixture failed validation (${violations.length} violation(s)):\n${lines}`);
}
