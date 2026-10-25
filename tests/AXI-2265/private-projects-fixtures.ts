import { APIRequestContext, APIResponse, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-2267 (epic AXI-2265) — self-provisioned world for the Private Projects
 * API specs. Every actor is a throwaway self-registered user, the workspace is
 * created fresh with EXACTLY the members the spec arranges (the platform admin
 * who creates it removes itself), and the one custom workspace role carrying
 * `project:manage_access` is created and deleted by the spec. No seeded account
 * or demo project is ever touched.
 */

export interface Actor {
  userId: string;
  api: APIRequestContext;
}

export type WorkspaceRoleName = 'viewer' | 'editor' | 'approver' | 'admin';

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function json(res: APIResponse, what: string): Promise<any> {
  if (!res.ok()) throw new Error(`AXI-2267 fixture ${what} -> ${res.status()}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export class PrivateProjectsWorld {
  admin!: APIRequestContext;
  adminUserId!: string;
  orgId!: string;
  workspaceId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];

  static async create(): Promise<PrivateProjectsWorld> {
    const world = new PrivateProjectsWorld();
    world.admin = await adminApiContext();
    world.adminUserId = (await json(await world.admin.get(apiUrl('/api/v1/auth/me')), 'me')).id;
    const orgs = await json(await world.admin.get(apiUrl('/api/v1/organizations')), 'orgs');
    world.orgId = orgs?.data?.[0]?.id;
    if (!world.orgId) throw new Error('AXI-2267 fixture: no organization available to the admin');
    const ws = await json(
      await world.admin.post(apiUrl('/api/v1/workspaces'), {
        data: {
          name: unique('E2E AXI-2267 Private Projects'),
          description: 'AXI-2267 private projects E2E fixture',
          type: 'internal',
          ownerOrganizationId: world.orgId,
        },
      }),
      'create workspace',
    );
    world.workspaceId = ws.id;
    return world;
  }

  /** A throwaway WORKSPACE-scoped role carrying exactly `permissions`. */
  async workspaceRole(label: string, permissions: string[]): Promise<string> {
    const role = await json(
      await this.admin.post(apiUrl('/api/v1/roles'), {
        data: { name: unique(`E2E AXI-2267 ${label}`), scope: 'WORKSPACE', permissions },
      }),
      'create role',
    );
    this.roleIds.push(role.id);
    return role.id;
  }

  /** A throwaway self-registered user — NOT yet a workspace member. */
  async actor(label: string): Promise<Actor> {
    const email = `${unique(`axi2267-${label}`)}@axiome.local`;
    const password = 'AXI2267-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await json(
      await bootstrap.post(apiUrl('/api/v1/auth/register'), {
        data: { email, password, firstName: 'AXI2267', lastName: label },
      }),
      'register',
    );
    const tokens = await json(
      await bootstrap.post(apiUrl('/api/v1/auth/login'), { data: { email, password } }),
      'login',
    );
    await bootstrap.dispose();
    const api = await apiRequest.newContext({
      extraHTTPHeaders: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'X-Workspace-Id': this.workspaceId,
      },
    });
    const me = await json(await api.get(apiUrl('/api/v1/auth/me')), 'me');
    const actor = { userId: me.id, api };
    this.actors.push(actor);
    return actor;
  }

  /** Add `actor` to the fixture workspace by legacy role name or by role id. */
  async addMember(actor: Actor, role: WorkspaceRoleName | { roleId: string }): Promise<void> {
    const membership = typeof role === 'string' ? { role } : role;
    await json(
      await this.admin.post(apiUrl(`/api/v1/workspaces/${this.workspaceId}/members`), {
        data: { userId: actor.userId, organizationId: this.orgId, ...membership },
      }),
      'add member',
    );
  }

  /** Leave the workspace so the admin's own membership grants nothing in it. */
  async leaveWorkspace(): Promise<void> {
    await this.admin
      .delete(apiUrl(`/api/v1/workspaces/${this.workspaceId}/members/${this.adminUserId}`))
      .catch(() => undefined);
  }

  async dispose(): Promise<void> {
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) {
      await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    }
    await this.admin.dispose();
  }
}

/** Thin route helpers for the four AXI-2267 access routes. */
export const access = {
  list: (a: Actor, projectId: string) => a.api.get(apiUrl(`/api/v1/projects/${projectId}/access`)),
  visibility: (a: Actor, projectId: string, visibility: string) =>
    a.api.patch(apiUrl(`/api/v1/projects/${projectId}/visibility`), { data: { visibility } }),
  grant: (a: Actor, projectId: string, userId: string, level?: string) =>
    a.api.post(apiUrl(`/api/v1/projects/${projectId}/access/grants`), {
      data: level ? { userId, level } : { userId },
    }),
  revoke: (a: Actor, projectId: string, userId: string) =>
    a.api.delete(apiUrl(`/api/v1/projects/${projectId}/access/grants/${userId}`)),
  auditLogs: (a: Actor, projectId: string) =>
    a.api.get(apiUrl(`/api/v1/projects/${projectId}/audit-logs`)),
};

// ─── AXI-2268 additions (access predicate & ProjectAccessGuard) ───

/** The refusal body minus its per-request fields — what NFR2 parity compares. */
export interface Refusal {
  status: number;
  body: Record<string, unknown>;
}

export async function refusalOf(res: APIResponse): Promise<Refusal> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  const { path: _path, timestamp: _timestamp, ...stable } = body;
  return { status: res.status(), body: stable };
}

/** A project id that was never created — the genuine-miss reference. */
export function neverCreatedProjectId(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const block = (n: number) => Array.from({ length: n }, hex).join('');
  return `${block(8)}-${block(4)}-4${block(3)}-a${block(3)}-${block(12)}`;
}

/**
 * Per-request options that blank the actor's `X-Workspace-Id` (WorkspaceGuard
 * treats an empty header as absent), so a probe reaches a workspace-optional
 * route with no workspace check in front of the ProjectAccessGuard.
 */
export const NO_WORKSPACE_HEADER = { headers: { 'X-Workspace-Id': '' } };

/**
 * A tiny CSV dataset uploaded by `a` into the fixture workspace (initiate →
 * presigned PUT → finalize). Ingestion is not awaited: the dataset row is what
 * AC10 lists.
 */
export async function uploadCsvDataset(world: PrivateProjectsWorld, a: Actor): Promise<string> {
  const base = `/api/v1/workspaces/${world.workspaceId}/datasets`;
  const init = await json(
    await a.api.post(apiUrl(base), {
      data: { organizationId: world.orgId, originalFilename: `${unique('axi2268')}.csv`, contentType: 'text/csv' },
    }),
    'initiate dataset upload',
  );
  const datasetId: string = init?.dataset?.id;
  const put = await fetch(init.presignedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv' },
    body: 'subject_id,value\nS1,1\nS2,2\n',
  });
  if (!put.ok) throw new Error(`AXI-2268 fixture presigned PUT -> ${put.status}`);
  await json(await a.api.patch(apiUrl(`${base}/${datasetId}/finalize`)), 'finalize dataset');
  return datasetId;
}

/** Project ids in a paginated `GET /api/v1/projects` reply. */
export async function listedProjectIds(a: Actor, query = ''): Promise<string[]> {
  const res = await a.api.get(apiUrl(`/api/v1/projects${query}`));
  if (!res.ok()) throw new Error(`AXI-2268 list projects -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  return (body?.data ?? []).map((p: { id: string }) => p.id);
}
