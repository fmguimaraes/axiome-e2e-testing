/**
 * AC4 — "The staged tenant contains no name, filename or label from Capture
 * Spec §2.1's replace column, and no entity named for a Jira key or for E2E
 * testing." (AXI-1371)
 *
 * A live check over the entities the provisioning step actually produced —
 * not a fixture-authoring check (that's `fixtures/validateFixture.ts`) and
 * not a guess at what a rename *should* have done. It exists to catch a
 * rename that silently failed or a legacy name the fixture never declared.
 */

export interface NamedEntity {
  kind: string;
  name: string;
}

/** Exact names Capture Spec §2.1's "Replace with" column forbids outright,
 *  regardless of the Jira-key/E2E patterns below (e.g. the misspelled cast
 *  placeholder carries neither marker). */
const FORBIDDEN_EXACT = [
  'axi50-e2e-race.csv',
  'AXI-1179 - Longitudinal Data Linking and Merging',
  'Adminstrator CRO One',
] as const;

const JIRA_KEY_RE = /AXI-\d+/;
const E2E_OR_TEST_RE = /\be2e\b|\btest(ing)?\b/i;

export interface ForbiddenNameHit {
  entity: NamedEntity;
  reason: string;
}

/** Pure — no REST calls. Callers pass in whatever entities the provisioning
 *  step reports it touched or reused, so this stays testable without a live
 *  stack (AC4 is checked over that report; `verify`-time re-fetch is out of
 *  this story's scope). */
export function findForbiddenNames(entities: NamedEntity[]): ForbiddenNameHit[] {
  return entities.flatMap((entity) => forbiddenReasonsFor(entity).map((reason) => ({ entity, reason })));
}

function forbiddenReasonsFor(entity: NamedEntity): string[] {
  const reasons: string[] = [];
  if ((FORBIDDEN_EXACT as readonly string[]).includes(entity.name)) reasons.push('Capture Spec §2.1 replace-column name');
  if (JIRA_KEY_RE.test(entity.name)) reasons.push('named for a Jira key');
  if (E2E_OR_TEST_RE.test(entity.name)) reasons.push('named for E2E testing');
  return reasons;
}

/** Throws with every hit listed — the entry point for "must be clean or
 *  stop", matching `fixtures/validateFixture.ts`'s `assert*` convention. */
export function assertNoForbiddenNames(entities: NamedEntity[]): void {
  const hits = findForbiddenNames(entities);
  if (hits.length === 0) return;
  const lines = hits.map((h) => `  ${h.entity.kind} "${h.entity.name}" — ${h.reason}`).join('\n');
  throw new Error(`AC4 FAILED — ${hits.length} forbidden name(s) in the staged tenant:\n${lines}`);
}
