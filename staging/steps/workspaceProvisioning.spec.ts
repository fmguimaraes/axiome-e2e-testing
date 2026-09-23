import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorkspaceMatch } from './workspaceProvisioning';

/**
 * UT-STAGE-200/201/202 — AXI-1587 bounce fix. `resolveWorkspaceMatch` is the
 * pure decision at the heart of `ensureWorkspace`'s org-rename-drift fallback:
 * an org-scoped `GET /api/v1/workspaces?...&ownerOrganizationId=<ctx.orgId>`
 * lookup can miss a workspace whose real owning org was renamed out from
 * under `ensure-organization`'s exact-name search (live incident: "Biotech
 * One" -> "Meridian Oncology"), which otherwise leads `ensureWorkspace` to
 * create a DUPLICATE workspace under a freshly (wrongly) created org. See
 * `staging/steps/UT.md`.
 */

const ws = (id: string, ownerOrganizationId: string | null = null) => ({ id, name: 'Public Datasets — IO Benchmarks', ownerOrganizationId });

test('UT-STAGE-200: resolveWorkspaceMatch prefers the org-scoped match and never adopts an org id when the scoped lookup already found it', () => {
  const scoped = ws('scoped-id', 'org-a');
  const result = resolveWorkspaceMatch(scoped, undefined);
  assert.deepEqual(result, { workspace: scoped, adoptOrgId: null });
});

test('UT-STAGE-201: resolveWorkspaceMatch falls back to the any-org match and adopts its real ownerOrganizationId — the org-rename-drift fix', () => {
  const anyOrg = ws('real-workspace-id', 'org-real');
  const result = resolveWorkspaceMatch(undefined, anyOrg);
  assert.deepEqual(result, { workspace: anyOrg, adoptOrgId: 'org-real' });
});

test('UT-STAGE-202: resolveWorkspaceMatch returns undefined (fresh-instance path, AC1) when neither lookup found anything, and tolerates a null ownerOrganizationId on the any-org match', () => {
  assert.equal(resolveWorkspaceMatch(undefined, undefined), undefined);
  const anyOrgNoOwner = ws('id', null);
  assert.deepEqual(resolveWorkspaceMatch(undefined, anyOrgNoOwner), { workspace: anyOrgNoOwner, adoptOrgId: null });
});
