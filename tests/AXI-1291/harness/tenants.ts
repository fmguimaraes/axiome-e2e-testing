import type { Api } from '../../AXI-1435/harness/api';
import { asList } from '../../AXI-1435/harness/api';

/**
 * AXI-1291 — Tenant Registry & Assertions E2E harness (@SI-010/@SI-043).
 *
 * Mirrors `tests/AXI-1603/harness/planner.ts`'s `ensureTenant1603` reuse-or-create
 * pattern for its own dedicated org/workspace (a fresh org per naming this suite
 * owns, so it never collides with another epic's residue tenant), plus two
 * registry-specific helpers:
 *
 *  - a STABLE per-organization tenant id ({@link STABLE_TENANT_ID}) reused across
 *    runs — the assertion-issue route (`tenant-resolution.service.ts`) 403s
 *    "No unambiguous active tenant" the moment an organization has more than one
 *    `active` tenant, so a fresh tenant per run would make every second run of
 *    this suite fail the issuance tests against its own residue;
 *  - a pre-flight sweep ({@link suspendForeignConflicts}) that suspends any OTHER
 *    `e2e-1291-*` tenant this suite left `active` on a previous run, and refuses
 *    to touch (and reports) any `active` tenant this suite did not create.
 */
const NAMES = {
  org: 'AXI-1291 E2E Org',
  workspace: 'AXI-1291 Tenant Registry',
};

export const STABLE_TENANT_ID = 'e2e-1291-admin-org';
const STABLE_TENANT_PREFIX = 'e2e-1291-';
const DEFAULT_RESIDENCY = 'eu-west-3';

export interface OrgWorkspace {
  orgId: string;
  workspaceId: string;
}

async function findByName(api: Api, path: string, name: string): Promise<string | undefined> {
  const res = await api.get(`${path}?limit=100`);
  return asList(res.body).find((x: any) => x.name === name)?.id;
}

/** Reuse-or-create the org+workspace this suite's admin-org tenant belongs to. */
export async function ensureOrgAndWorkspace(api: Api): Promise<OrgWorkspace> {
  const orgId = (await findByName(api, '/api/v1/organizations', NAMES.org))
    ?? (await api.post('/api/v1/organizations', { name: NAMES.org, type: 'biotech' })).body.id;

  let workspaceId = await findByName(api, '/api/v1/workspaces', NAMES.workspace);
  if (!workspaceId) {
    const res = await api.post('/api/v1/workspaces', { name: NAMES.workspace, type: 'internal', ownerOrganizationId: orgId });
    workspaceId = res.body.id;
  }
  return { orgId, workspaceId: workspaceId! };
}

/**
 * Every tenant registry row belonging to `organizationId`. Client-side filter —
 * the admin `GET /tenants` route only supports paginated display-name search,
 * no organization query param (`TenantListQuery` in `tenants.controller.ts`).
 */
async function tenantsForOrg(api: Api, organizationId: string): Promise<any[]> {
  const res = await api.get('/api/v1/tenants?limit=100');
  return asList(res.body).filter((t: any) => t.organizationId === organizationId);
}

/**
 * Suspend any `active` tenant this suite previously created (`e2e-1291-*`,
 * excluding the stable id itself, which is handled by {@link ensureAdminOrgTenant})
 * so the assertion-issue route's "exactly one active tenant" invariant holds
 * before this run issues anything.
 *
 * A foreign `active` tenant (a tenantId not carrying this suite's prefix) is
 * left completely untouched — this helper has no authority to revoke a tenant
 * it did not create. Its id is returned as the reason a caller should
 * `test.skip` the assertion-issuance tests rather than acting on it.
 */
export async function suspendForeignConflicts(api: Api, organizationId: string): Promise<string | undefined> {
  const rows = await tenantsForOrg(api, organizationId);
  let externalActive: string | undefined;
  for (const row of rows) {
    if (row.status !== 'active' || row.tenantId === STABLE_TENANT_ID) continue;
    if (row.tenantId.startsWith(STABLE_TENANT_PREFIX)) {
      await api.patch(`/api/v1/tenants/${row.tenantId}`, { status: 'suspended' });
    } else if (!externalActive) {
      externalActive = row.tenantId;
    }
  }
  return externalActive
    ? `organization ${organizationId} already has an active tenant (${externalActive}) this suite did not create — refusing to touch it or issue against it`
    : undefined;
}

/** Reuse-or-register the stable admin-org tenant, ensuring it ends up `active`. */
export async function ensureAdminOrgTenant(api: Api, organizationId: string): Promise<any> {
  const existing = await api.get(`/api/v1/tenants/${STABLE_TENANT_ID}`);
  let tenant = existing.status === 200 ? existing.body : undefined;
  if (!tenant) {
    const created = await api.post('/api/v1/tenants', {
      tenantId: STABLE_TENANT_ID,
      organizationId,
      displayName: 'AXI-1291 E2E admin-org tenant',
      residency: DEFAULT_RESIDENCY,
    });
    if (created.status >= 300) {
      throw new Error(`could not register the stable admin-org tenant (${created.status}): ${JSON.stringify(created.body)}`);
    }
    tenant = created.body;
  }
  if (tenant.status !== 'active') {
    const activated = await api.patch(`/api/v1/tenants/${STABLE_TENANT_ID}`, { status: 'active' });
    if (activated.status < 300) tenant = activated.body;
  }
  return tenant;
}
