import { ADMIN_HANDLE } from '../staging/steps/context';
import type { RestClient } from '../staging/client/RestClient';

/**
 * FR19 precondition, discovered live: the `service` identity's role
 * (`staging-service-account`) is created with `permissions: []`
 * (AXI-1370's own documented gap — "later stories hitting capability/
 * workspace guards must PATCH /api/v1/roles/:id once the required
 * permission strings surface from those guards"). `ProjectViewAnalysisDetail`
 * and `ProjectViewAnalysisProvenance` (`axiome-front/src/pages/*.tsx`) gate
 * their ENTIRE render on `hasPermission(roleId, 'view-analysis:view')` —
 * with an empty permission set, `service` sees "Access denied" on every
 * analysis/provenance page regardless of workspace membership, which is
 * what capture's first two live runs hit before this was diagnosed.
 *
 * `PATCH /api/v1/roles/:id` is System-Admin-gated
 * (`roles.controller.ts`: `req.user?.role !== 'ADMIN'` throws) and REPLACES
 * the whole `permissions` array (not a merge) — so this reads the role's
 * CURRENT permissions first and PATCHes the union, never dropping a
 * permission some other story already granted (NFR1: idempotent, safe to
 * re-run).
 *
 * The full set below was found by grepping `hasPermission(roleId, '...')`
 * across every page/component a master navigates (`ProjectViewAnalysisDetail`,
 * `ProjectViewAnalysisProvenance`, `DatasetDetail`, `DatasetVisualizations`,
 * `EvidenceListing`, `SnapshotDiscussionPanel`, the sponsor-review/export
 * pages) plus the Subject-registry read capability (`subject:read`, M10's
 * own precondition check needs a REAL 200/empty, not a 403 misread as
 * "no subjects") — granted together rather than one at a time, because each
 * missed string costs a full live capture run to discover.
 */
export const REQUIRED_PERMISSIONS: readonly string[] = [
  'view-analysis:view',
  'view-analysis:edit',
  'view-analysis:manage_evidence',
  'view-analysis:publish',
  'view-analysis:create_visualization',
  'framing:edit_question',
  'framing:add_assumption',
  'framing:withdraw_own_assumption',
  'framing:force_withdraw_assumption',
  'dataset:read',
  'dataset:update',
  'dataset:manage',
  'dataset:link',
  'cross_dataset:materialize',
  'workflow:read',
  'workflow:run',
  'comment:moderate',
  'export:create',
  'styling-preset:read',
  'experiment-compute:exclude_points',
  'experiment-compute:recompute',
  'experiment-compute:save_derived',
  'subject:read',
];

interface RoleResponse {
  id: string;
  permissions: string[];
}

export async function ensureCapturePermissions(client: RestClient, roleId: string): Promise<void> {
  const current = await fetchRolePermissions(client, roleId);
  const union = mergePermissions(current, REQUIRED_PERMISSIONS);
  if (union.length === current.length) return; // already has everything needed (NFR1)
  await patchRolePermissions(client, roleId, union);
}

/** Pure — exported for unit testing. Union, not replace — a PATCH here must
 *  never remove a permission another story or an operator granted. */
export function mergePermissions(current: readonly string[], required: readonly string[]): string[] {
  return [...new Set([...current, ...required])];
}

async function fetchRolePermissions(client: RestClient, roleId: string): Promise<string[]> {
  const res = await client.as<RoleResponse>(ADMIN_HANDLE, 'GET', `/api/v1/roles/${roleId}`);
  if (!res.ok || !res.body) throw new Error(`ensureCapturePermissions: could not read role ${roleId} (status ${res.status})`);
  return res.body.permissions ?? [];
}

async function patchRolePermissions(client: RestClient, roleId: string, permissions: string[]): Promise<void> {
  const res = await client.as(ADMIN_HANDLE, 'PATCH', `/api/v1/roles/${roleId}`, { permissions });
  if (!res.ok) throw new Error(`ensureCapturePermissions: PATCH /api/v1/roles/${roleId} failed (status ${res.status})`);
}
