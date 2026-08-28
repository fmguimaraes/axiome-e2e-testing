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

/** FR7 — `content.dataset`, when declared, must bind to a workspace/project
 *  this same fixture actually provisions; a typo'd name would otherwise only
 *  surface as a confusing 404 deep inside the dataset-ingestion step. */
export function checkDatasetBindsToDeclaredProject(fixture: TenantFixture): FixtureViolation[] {
  const dataset = fixture.content.dataset;
  if (!dataset) return [];
  const workspace = fixture.workspaces.find((w) => w.name === dataset.workspaceName);
  if (!workspace) {
    return [{ rule: 'FR7', detail: `content.dataset.workspaceName "${dataset.workspaceName}" is not a declared workspace` }];
  }
  if (!workspace.projects.some((p) => p.name === dataset.projectName)) {
    return [{ rule: 'FR7', detail: `content.dataset.projectName "${dataset.projectName}" is not a declared project in workspace "${workspace.name}"` }];
  }
  return [];
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
    ...checkChartTitlesUnique(fixture),
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
