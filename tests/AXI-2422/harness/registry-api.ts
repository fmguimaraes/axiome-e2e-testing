import { request as apiRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { ensureAuthTokens } from '../../../config/auth';
import { ROLES, type Role } from '../../../config/roles';

/**
 * AXI-2424 (epic AXI-2422 — Analysis Template Library, Registry v0). A thin API client for the
 * registry routes, one per role. API-only: no `page`, no storageState — each role logs in over
 * the API (`ensureAuthTokens`; the non-admin `user` self-registers when absent).
 */

export const ROUTE = 'api/v1/analysis-templates';

export interface Reply {
  status: number;
  body: any;
}

export interface RegistryApi {
  list(): Promise<Reply>;
  resolve(templateId: string, templateVersion: string): Promise<Reply>;
  create(body: unknown): Promise<Reply>;
  dispose(): Promise<void>;
}

async function parse(res: APIResponse): Promise<Reply> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text.length ? JSON.parse(text) : undefined;
  } catch {
    body = { _raw: text };
  }
  return { status: res.status(), body };
}

function client(ctx: APIRequestContext): RegistryApi {
  return {
    // AXI-2430: `GET /analysis-templates` is now the paged, scoped catalog `{data, meta}` and the
    // variant write moved to `POST /analysis-templates/recipe-variants`. `list()` keeps the AXI-2423/
    // 2424 view these specs assert — `{templateId, label, versions: <published versionKeys>}` — over
    // EVERY page (a stack accumulates e2e variants past one page of 100).
    list: async () => {
      const entries: any[] = [];
      for (let page = 1; ; page += 1) {
        const reply = await parse(await ctx.get(apiUrl(`${ROUTE}?limit=100&page=${page}`)));
        if (reply.status !== 200 || !Array.isArray(reply.body?.data)) return reply;
        entries.push(...reply.body.data);
        if (!reply.body.meta?.hasNextPage) break;
      }
      return {
        status: 200,
        body: entries.map((entry: any) => ({
          templateId: entry.templateId,
          label: entry.label,
          versions: entry.versions
            .filter((v: any) => v.status === 'published')
            .map((v: any) => v.templateVersion)
            .sort(), // the legacy list ordered version keys ascending; the catalog orders by creation
        })),
      };
    },
    resolve: async (id, version) =>
      parse(await ctx.get(apiUrl(`${ROUTE}/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`))),
    create: async (body) => parse(await ctx.post(apiUrl(`${ROUTE}/recipe-variants`), { data: body as any })),
    dispose: () => ctx.dispose(),
  };
}

async function tokenFor(name: Role['name']): Promise<string> {
  const role = ROLES.find((r) => r.name === name);
  if (!role) throw new Error(`role '${name}' missing from ROLES`);
  const bootstrap = await apiRequest.newContext();
  try {
    return (await ensureAuthTokens(bootstrap, role)).accessToken;
  } finally {
    await bootstrap.dispose();
  }
}

/** An authenticated registry client for a role (`admin` = platform admin, `user` = not). */
export async function registryApiAs(name: Role['name']): Promise<RegistryApi> {
  const token = await tokenFor(name);
  return client(await apiRequest.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } }));
}

/** A registry client with NO token. */
export async function anonymousRegistryApi(): Promise<RegistryApi> {
  return client(await apiRequest.newContext());
}
