import { ApiClient, okBody } from './api-client';
import { ProdSuiteAbort } from './abort';

/**
 * AXI-2318 — prod-suite isolation (FR28, NFR5, EC9).
 *
 * The suite runs ONLY inside the dedicated test org. "Only" is proven, not
 * assumed, from three facts the server states about the test identity:
 *  1. the identity can see EXACTLY one organization, and it is the configured
 *     one — an identity that can resolve any other org (a platform admin, a
 *     member of a real client org) is refused, because then nothing structural
 *     stops a spec from reaching that org's data;
 *  2. that organization is not a forbidden one — by name/slug (Paul's
 *     CeRAINOM-IgG4) or by id (`PROD_E2E_FORBIDDEN_ORG_IDS`, where the
 *     operator puts the prod id of Paul's org);
 *  3. the configured workspace is owned by that organization.
 * Any failure is a {@link ProdSuiteAbort} — a hard failure of the run, never a
 * fallback to another org (EC9).
 */

/** Organization names/slugs the suite may never run in, compared normalized. */
export const FORBIDDEN_ORG_NAMES: readonly string[] = ['CeRAINOM-IgG4', 'aphm-cerainom-igg4'];

export interface OrgFacts {
  id: string;
  name: string | null;
  slug: string | null;
}

export interface IsolationVerdict {
  organizationId: string;
  workspaceId: string;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** True when `org` matches a forbidden name, slug or id. */
export function isForbiddenOrg(org: OrgFacts, forbiddenIds: readonly string[]): boolean {
  const names = FORBIDDEN_ORG_NAMES.map(normalize);
  const labels = [org.name, org.slug].filter((v): v is string => Boolean(v)).map(normalize);
  const byName = labels.some((label) => names.some((n) => label.includes(n)));
  return byName || forbiddenIds.some((id) => id.toLowerCase() === org.id.toLowerCase());
}

/** Pure decision over the visible org list (fact 1 + 2). Throws a {@link ProdSuiteAbort}. */
export function assertConfined(visible: OrgFacts[], configuredOrgId: string, forbiddenIds: readonly string[]): void {
  const forbidden = visible.filter((org) => isForbiddenOrg(org, forbiddenIds));
  if (forbidden.length > 0) {
    throw new ProdSuiteAbort('isolation', 'FORBIDDEN_ORG_VISIBLE',
      `the test identity can resolve ${forbidden.length} forbidden organization(s) (EC9) — refusing to run`);
  }
  if (visible.length !== 1) {
    throw new ProdSuiteAbort('isolation', 'IDENTITY_NOT_CONFINED',
      `the test identity can see ${visible.length} organizations; it must see exactly the dedicated test org`);
  }
  if (visible[0].id !== configuredOrgId) {
    throw new ProdSuiteAbort('isolation', 'ORG_MISMATCH',
      'the only organization the test identity can see is not PROD_E2E_ORG_ID');
  }
}

function toOrgFacts(row: any): OrgFacts {
  return { id: String(row?.id ?? ''), name: row?.name ?? null, slug: row?.slug ?? null };
}

/** Every organization the identity can see, across all pages. */
export async function listVisibleOrgs(client: ApiClient): Promise<OrgFacts[]> {
  const orgs: OrgFacts[] = [];
  for (let page = 1; page <= 50; page++) {
    const body = okBody(await client.get(`/api/v1/organizations?page=${page}&limit=100`), 'list organizations');
    const rows: any[] = Array.isArray(body?.data) ? body.data : [];
    orgs.push(...rows.map(toOrgFacts));
    if (!body?.meta?.hasNextPage || rows.length === 0) return orgs;
  }
  throw new ProdSuiteAbort('isolation', 'ORG_LIST_UNBOUNDED', 'organization listing did not terminate in 50 pages');
}

/** Fact 3: the configured workspace is owned by the configured org. */
export async function assertWorkspaceInOrg(client: ApiClient, workspaceId: string, orgId: string): Promise<void> {
  const res = await client.get(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  if (res.status !== 200) {
    throw new ProdSuiteAbort('isolation', 'WORKSPACE_UNREADABLE', `PROD_E2E_WORKSPACE_ID is not readable (HTTP ${res.status})`);
  }
  if (res.body?.ownerOrganizationId !== orgId) {
    throw new ProdSuiteAbort('isolation', 'WORKSPACE_OUTSIDE_TEST_ORG', 'PROD_E2E_WORKSPACE_ID is not owned by the test org');
  }
}

/** The full guard (facts 1–3). Resolves only when the run is confined to the test org. */
export async function verifyIsolation(
  client: ApiClient,
  cfg: { organizationId: string; workspaceId: string; forbiddenOrgIds: readonly string[] },
): Promise<IsolationVerdict> {
  if (isForbiddenOrg({ id: cfg.organizationId, name: null, slug: null }, cfg.forbiddenOrgIds)) {
    throw new ProdSuiteAbort('isolation', 'CONFIGURED_ORG_FORBIDDEN', 'PROD_E2E_ORG_ID is a forbidden organization (EC9)');
  }
  assertConfined(await listVisibleOrgs(client), cfg.organizationId, cfg.forbiddenOrgIds);
  await assertWorkspaceInOrg(client, cfg.workspaceId, cfg.organizationId);
  return { organizationId: cfg.organizationId, workspaceId: cfg.workspaceId };
}
