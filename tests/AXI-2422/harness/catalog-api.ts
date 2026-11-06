import type { APIRequestContext, APIResponse } from '@playwright/test';
import { apiUrl } from '../../../config/env';

/**
 * AXI-2430 (epic AXI-2422 — FR9-FR14, FR40). A thin client for the template CRUD, catalog and
 * publish routes, over an ALREADY-AUTHENTICATED context — an `Actor.api` from the AXI-2267
 * `PrivateProjectsWorld` (it carries `X-Workspace-Id`), so tenancy is always the verified
 * membership and never a body field. API-only: no `page`, no storageState.
 */

export const ROUTE = 'api/v1/analysis-templates';

export interface Reply {
  status: number;
  body: any;
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

export interface CatalogApi {
  list(query?: string, headers?: Record<string, string>): Promise<Reply>;
  get(id: string, headers?: Record<string, string>): Promise<Reply>;
  create(body: unknown): Promise<Reply>;
  update(id: string, body: unknown): Promise<Reply>;
  remove(id: string): Promise<Reply>;
  createVersion(id: string, body: unknown): Promise<Reply>;
  updateVersion(id: string, versionId: string, body: unknown): Promise<Reply>;
  publish(id: string, versionId: string, justification: string): Promise<Reply>;
  archive(id: string, versionId: string): Promise<Reply>;
}

export function catalogApi(ctx: APIRequestContext): CatalogApi {
  const at = (path = '') => apiUrl(`${ROUTE}${path}`);
  return {
    list: async (query = '', headers) => parse(await ctx.get(at(query ? `?${query}` : ''), headers ? { headers } : undefined)),
    get: async (id, headers) => parse(await ctx.get(at(`/${id}`), headers ? { headers } : undefined)),
    create: async (body) => parse(await ctx.post(at(), { data: body as any })),
    update: async (id, body) => parse(await ctx.patch(at(`/${id}`), { data: body as any })),
    remove: async (id) => parse(await ctx.delete(at(`/${id}`))),
    createVersion: async (id, body) => parse(await ctx.post(at(`/${id}/versions`), { data: body as any })),
    updateVersion: async (id, versionId, body) =>
      parse(await ctx.patch(at(`/${id}/versions/${versionId}`), { data: body as any })),
    publish: async (id, versionId, justification) =>
      parse(await ctx.post(at(`/${id}/versions/${versionId}/publish`), { data: { justification } })),
    archive: async (id, versionId) => parse(await ctx.post(at(`/${id}/versions/${versionId}/archive`))),
  };
}

/** Every catalog entry visible to `api`, across every page. */
export async function allVisible(api: CatalogApi, headers?: Record<string, string>): Promise<any[]> {
  const entries: any[] = [];
  for (let page = 1; ; page += 1) {
    const reply = await api.list(`limit=100&page=${page}`, headers);
    if (reply.status !== 200) throw new Error(`catalog page ${page} -> ${reply.status}: ${JSON.stringify(reply.body)}`);
    entries.push(...reply.body.data);
    if (!reply.body.meta.hasNextPage) return entries;
  }
}

/** A business key unique to this run (the key is globally unique across every scope). */
export function uniqueTemplateId(label: string): string {
  return `e2e-axi2430-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
