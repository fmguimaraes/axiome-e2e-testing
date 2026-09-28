import { APIRequestContext, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { ensureAuthTokens } from '../../config/auth';
import { ROLES } from '../../config/roles';

/**
 * Shared auth/read primitives for the AXI-1236 Safe Compare E2E specs.
 *
 * Safe Compare is reachable end-to-end today over two API surfaces: the seeded
 * IMM-CMP rule family in the rule catalog (`GET /api/v1/rules`, AXI-1322) and the
 * two-referent comparability gate (`POST /api/v1/rule-runs/comparability`,
 * AXI-1323). Both are exercised with an authenticated admin request context; the
 * catalog is not workspace-scoped and the gate reads no tenant data, so no
 * workspace is stood up. Kept self-contained (not shared with other epics'
 * fixtures) so parallel spec authoring never collides on it.
 */

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

// Log in at most ONCE per role per worker process, mirroring the AXI-1244
// fixture: a whole run stays inside a token's lifetime and well under the
// login rate limit (100/60s). A rejected login is never memoized.
let adminTokens: Promise<Tokens> | undefined;

function cachedAdminTokens(): Promise<Tokens> {
  if (!adminTokens) {
    adminTokens = (async () => {
      const bootstrap = await apiRequest.newContext();
      const role = ROLES.find((r) => r.name === 'admin');
      if (!role) throw new Error('admin role missing from ROLES registry');
      const tokens = await ensureAuthTokens(bootstrap, role);
      await bootstrap.dispose();
      return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    })().catch((err) => {
      adminTokens = undefined;
      throw err;
    });
  }
  return adminTokens;
}

/** An API request context carrying the admin bearer token on every call. The
 *  caller disposes the returned context. */
export async function adminApiContext(): Promise<APIRequestContext> {
  const tokens = await cachedAdminTokens();
  return apiRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
  });
}

/** Fetch the full SYSTEM rule catalog: every page, `scope === 'system'` only.
 *  AXI-1809 (the AXI-1822 finding): one unscoped page let other specs' fixture
 *  rules in (e.g. AXI-1149's project-scope `IMM-QC-01-clone`, one per run) and,
 *  as they accumulate, push seeds off the page. The seeded catalog is what these
 *  specs assert on. (Paging is inlined rather than imported from
 *  `tests/AXI-1762/seeded-rule-approval.ts`, which imports this file.) Fails
 *  loudly so a provisioning fault is never mistaken for a product defect. */
export async function fetchRuleCatalog(api: APIRequestContext): Promise<CatalogRule[]> {
  const rows: CatalogRule[] = [];
  for (let page = 1; ; page++) {
    const res = await api.get(apiUrl(`/api/v1/rules?scope=system&limit=200&page=${page}`));
    if (!res.ok()) throw new Error(`GET /rules → ${res.status()}: ${await res.text()}`);
    const body = await res.json();
    if (!Array.isArray(body?.data)) throw new Error('rule catalog response missing data[]');
    rows.push(...(body.data as CatalogRule[]));
    if (!body.meta?.hasNextPage || body.data.length === 0) break;
  }
  return rows.filter((r) => r.scope === 'system');
}

/** The subset of a catalog rule the Safe Compare specs assert on. */
export interface CatalogRule {
  id: string;
  code: string;
  scope: string;
  status: string;
  category: string;
  isMandatory: boolean;
  ruoOnly: boolean;
  tags: string[] | null;
  safetyFlags: string[] | null;
  guardOutput: { blockDecision?: boolean } | null;
  outputFields: Array<{ key: string; type: string; description?: string }> | null;
}
