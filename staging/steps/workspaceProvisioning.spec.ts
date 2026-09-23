import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorkspaceMatch, WorkspaceNameAmbiguousError } from './workspaceProvisioning';

/**
 * UT-STAGE-200..204 — AXI-1587 bounce fix + review-gate bounce fix.
 * `resolveWorkspaceMatch` is the pure decision at the heart of
 * `ensureWorkspace`'s org-rename-drift fallback: an org-scoped
 * `GET /api/v1/workspaces?...&ownerOrganizationId=<ctx.orgId>` lookup can
 * miss a workspace whose real owning org was renamed out from under
 * `ensure-organization`'s exact-name search (live incident: "Biotech One"
 * -> "Meridian Oncology"), which otherwise leads `ensureWorkspace` to create
 * a DUPLICATE workspace under a freshly (wrongly) created org.
 *
 * Review-gate bounce (same story): the any-org fallback must never just pick
 * the FIRST same-named match — a foreign, totally unrelated workspace can
 * coincidentally share the exact fixture name in a different org (confirmed
 * live: `18005b73-…`, org `5ac1262c-…`, an unrelated "Statistical Surface
 * Validation" project). If more than one distinct `ownerOrganizationId` is
 * represented among the any-org matches, `resolveWorkspaceMatch` REFUSES
 * (throws `WorkspaceNameAmbiguousError`) rather than guessing. See
 * `staging/steps/UT.md`.
 */

const ws = (id: string, ownerOrganizationId: string | null = null) => ({ id, name: 'Public Datasets — IO Benchmarks', ownerOrganizationId });

test('UT-STAGE-200: resolveWorkspaceMatch prefers the org-scoped match and never adopts an org id when the scoped lookup already found it', () => {
  const scoped = ws('scoped-id', 'org-a');
  const result = resolveWorkspaceMatch(scoped, []);
  assert.deepEqual(result, { workspace: scoped, adoptOrgId: null });
});

test('UT-STAGE-201: resolveWorkspaceMatch falls back to the sole any-org match and adopts its real ownerOrganizationId — the org-rename-drift fix', () => {
  const anyOrg = ws('real-workspace-id', 'org-real');
  const result = resolveWorkspaceMatch(undefined, [anyOrg]);
  assert.deepEqual(result, { workspace: anyOrg, adoptOrgId: 'org-real' });
});

test('UT-STAGE-202: resolveWorkspaceMatch returns undefined (fresh-instance path, AC1) when neither lookup found anything, and tolerates a null ownerOrganizationId on the sole any-org match', () => {
  assert.equal(resolveWorkspaceMatch(undefined, []), undefined);
  const anyOrgNoOwner = ws('id', null);
  assert.deepEqual(resolveWorkspaceMatch(undefined, [anyOrgNoOwner]), { workspace: anyOrgNoOwner, adoptOrgId: null });
});

test('UT-STAGE-203: resolveWorkspaceMatch REFUSES (throws WorkspaceNameAmbiguousError) when the any-org fallback finds the same name in two different orgs — never picks the first', () => {
  const real = ws('real-workspace-id', 'org-real');
  const foreign = ws('foreign-workspace-id', 'org-foreign');
  assert.throws(() => resolveWorkspaceMatch(undefined, [foreign, real]), WorkspaceNameAmbiguousError);
  // order must not matter — refusing regardless of which the listing API returned first
  assert.throws(() => resolveWorkspaceMatch(undefined, [real, foreign]), WorkspaceNameAmbiguousError);
});

test('UT-STAGE-204: WorkspaceNameAmbiguousError message names every candidate workspace id and org id, for a human to disambiguate', () => {
  const real = ws('real-workspace-id', 'org-real');
  const foreign = ws('foreign-workspace-id', 'org-foreign');
  try {
    resolveWorkspaceMatch(undefined, [foreign, real]);
    assert.fail('expected resolveWorkspaceMatch to throw');
  } catch (err) {
    assert.ok(err instanceof WorkspaceNameAmbiguousError);
    assert.match(err.message, /foreign-workspace-id/);
    assert.match(err.message, /org-foreign/);
    assert.match(err.message, /real-workspace-id/);
    assert.match(err.message, /org-real/);
  }
});
