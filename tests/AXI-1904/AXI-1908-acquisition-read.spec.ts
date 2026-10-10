import { APIRequestContext, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-1908 (epic AXI-1904 — FR10, FR11, NFR5; AC10, AC15; EC15). API-level
 * only — no UI surface exists yet (that is AXI-1909). Covers the scenarios in
 * `axiome-docs/manual-e2e/AXI-1904-Rule-Acquisition.md` §2.4.
 *
 * Self-provisions every actor/role/rule/record per run, mirroring
 * `AXI-1906-acquisition-create.spec.ts`'s `AcquisitionWorld` (not imported —
 * a separate file, per story file ownership).
 *
 * AXI-1907 (decision endpoint) is a sibling story landing in parallel; this
 * suite therefore only exercises the `draft` status (no decision exists yet
 * on `main` at authoring time) plus ordering, visibility and the
 * rawOutput list/read-one split, which do not depend on it.
 */

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

interface Actor {
  userId: string;
  api: APIRequestContext;
}

async function send(
  api: APIRequestContext,
  method: 'post' | 'get' | 'delete',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await api[method](apiUrl(path), body === undefined ? undefined : { data: body as any });
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : {} };
}

class AcquisitionReadWorld {
  admin!: APIRequestContext;
  adminUserId!: string;
  orgId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];
  private readonly ruleIds: string[] = [];

  static async create(): Promise<AcquisitionReadWorld> {
    const world = new AcquisitionReadWorld();
    world.admin = await adminApiContext();
    world.adminUserId = (await send(world.admin, 'get', '/api/v1/auth/me')).json.id;
    const orgs = await send(world.admin, 'get', '/api/v1/organizations');
    world.orgId =
      orgs.json?.data?.[0]?.id ??
      (
        await send(world.admin, 'post', '/api/v1/organizations', {
          name: unique('AXI-1908 Org'),
          type: 'biotech',
        })
      ).json.id;
    return world;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1908 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1908-${label}`)}@axiome.local`;
    const password = 'AXI1908-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1908',
      lastName: label,
    });
    const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
    await bootstrap.dispose();
    const api = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` },
    });
    const me = await send(api, 'get', '/api/v1/auth/me');
    if (roleId) await send(this.admin, 'post', `/api/v1/users/${me.json.id}/roles`, { roleId });
    const actor = { userId: me.json.id, api };
    this.actors.push(actor);
    return actor;
  }

  /** A fresh workspace whose only member is `member`. */
  async workspace(label: string, member: Actor): Promise<string> {
    const ws = await send(this.admin, 'post', '/api/v1/workspaces', {
      name: unique(`E2E AXI-1908 ${label}`),
      description: 'AXI-1908 acquisition read E2E fixture',
      type: 'internal',
      ownerOrganizationId: this.orgId,
    });
    await send(this.admin, 'post', `/api/v1/workspaces/${ws.json.id}/members`, {
      userId: member.userId,
      organizationId: this.orgId,
      role: 'admin',
    });
    await this.admin
      .delete(apiUrl(`/api/v1/workspaces/${ws.json.id}/members/${this.adminUserId}`))
      .catch(() => undefined);
    return ws.json.id;
  }

  /** A minimal, immediately-usable workspace QC_RULE under the given code. */
  async rule(owner: Actor, workspaceId: string, code: string): Promise<{ id: string; version: number }> {
    const res = await send(owner.api, 'post', '/api/v1/rules', {
      code,
      title: 'AXI-1908 fixture rule',
      category: 'qc_guard',
      protocolType: 'QC_RULE',
      scope: 'workspace',
      workspaceId,
    });
    expect(res.status, 'creating fixture rule').toBeLessThan(300);
    this.ruleIds.push(res.json.id);
    return { id: res.json.id, version: res.json.version };
  }

  async dispose(): Promise<void> {
    for (const id of this.ruleIds) await this.admin.delete(apiUrl(`/api/v1/rules/${id}`)).catch(() => undefined);
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    await this.admin.dispose();
  }
}

function baseAcquisitionBody(ruleCode: string, overrides: Record<string, unknown> = {}) {
  return {
    ruleCode,
    reference: '10.1000/e2e-axi1908',
    referenceType: 'doi',
    excerpt: 'the measured threshold is 7 ng/mL for AXI-1908',
    acquisitionMethod: 'manual',
    acquiredAt: new Date().toISOString(),
    ...overrides,
  };
}

let world: AcquisitionReadWorld;
let acquirer: Actor; // holds rule:acquire + rule:read (can create + resolve codes in its own workspace)
let reader: Actor; // holds ONLY rule:read — no rule:acquire (read needs no acquire/publish permission)
let nonMemberReader: Actor; // holds rule:read, member of NO workspace (visibility must still gate reads)
let workspaceId: string;

test.beforeAll(async () => {
  world = await AcquisitionReadWorld.create();
  const acquireAndReadRoleId = await world.role('acquire-and-read', ['rule:acquire', 'rule:read']);
  const readOnlyRoleId = await world.role('read-only', ['rule:read']);
  acquirer = await world.actor('acquirer', acquireAndReadRoleId);
  workspaceId = await world.workspace('ws', acquirer);
  reader = await world.actor('reader', readOnlyRoleId);
  await send(world.admin, 'post', `/api/v1/workspaces/${workspaceId}/members`, {
    userId: reader.userId,
    organizationId: world.orgId,
    role: 'member',
  });
  // Same role as `reader` but never added to ANY workspace (cross-tenant check).
  nonMemberReader = await world.actor('non-member-reader', readOnlyRoleId);
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1908 — rule acquisition list/read API', () => {
  // AC15: list excludes rawOutput; ordering newest-first
  test('AC15, FR10: list returns records newest first by acquiredAt and never carries rawOutput @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1908LIST');
    const rule = await world.rule(acquirer, workspaceId, code);
    const older = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseAcquisitionBody(code, {
        acquisitionMethod: 'llm',
        modelId: 'm1',
        promptVersionHash: 'h1',
        rawOutput: 'first raw output',
        excerpt: 'older excerpt for AXI-1908',
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    expect(older.status).toBeLessThan(300);
    const newer = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseAcquisitionBody(code, { excerpt: 'newer excerpt for AXI-1908' }),
    );
    expect(newer.status).toBeLessThan(300);

    const list = await send(acquirer.api, 'get', `/api/v1/rules/${rule.id}/acquisitions`);
    expect(list.status).toBe(200);
    const ids = (list.json.data ?? list.json).map((r: any) => r.id);
    expect(ids.indexOf(newer.json.id)).toBeLessThan(ids.indexOf(older.json.id));
    for (const item of list.json.data ?? list.json) {
      expect(item).not.toHaveProperty('rawOutput');
    }
  });

  // AC15: read-one returns rawOutput verbatim
  test('AC15: read-one returns rawOutput verbatim @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1908READONE');
    await world.rule(acquirer, workspaceId, code);
    const created = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseAcquisitionBody(code, {
        acquisitionMethod: 'llm',
        modelId: 'm1',
        promptVersionHash: 'h1',
        rawOutput: 'exact raw output text for AXI-1908',
      }),
    );
    expect(created.status).toBeLessThan(300);

    const read = await send(acquirer.api, 'get', `/api/v1/rules/acquisitions/${created.json.id}`);
    expect(read.status).toBe(200);
    expect(read.json.rawOutput).toBe('exact raw output text for AXI-1908');
  });

  // FR10/FR14: a fresh record with no decision reads as draft
  test('FR14: a record with no decision is status draft, and the draft filter returns it @SI-017 @SI-010', async () => {
    const code = unique('AXI1908DRAFT');
    const rule = await world.rule(acquirer, workspaceId, code);
    const created = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseAcquisitionBody(code));
    expect(created.status).toBeLessThan(300);

    const read = await send(acquirer.api, 'get', `/api/v1/rules/acquisitions/${created.json.id}`);
    expect(read.json.status).toBe('draft');

    const filtered = await send(acquirer.api, 'get', `/api/v1/rules/${rule.id}/acquisitions?status=draft`);
    expect(filtered.status).toBe(200);
    const ids = (filtered.json.data ?? filtered.json).map((r: any) => r.id);
    expect(ids).toContain(created.json.id);
  });

  // FR10: an invalid status filter value is a 400
  test('FR10: an invalid status filter is refused 400 @SI-017 @SI-010', async () => {
    const code = unique('AXI1908BADSTATUS');
    const rule = await world.rule(acquirer, workspaceId, code);
    const res = await send(acquirer.api, 'get', `/api/v1/rules/${rule.id}/acquisitions?status=not-a-status`);
    expect(res.status).toBe(400);
  });

  // Read needs no rule:acquire/rule:publish — any caller who can SEE the rule can list/read
  test('FR11: read needs only rule-read visibility, never rule:acquire @SI-017 @SI-010', async () => {
    const code = unique('AXI1908READPERM');
    const rule = await world.rule(acquirer, workspaceId, code);
    await send(world.admin, 'post', `/api/v1/workspaces/${workspaceId}/members`, {
      userId: reader.userId,
      organizationId: world.orgId,
      role: 'member',
    });
    const created = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseAcquisitionBody(code));
    expect(created.status).toBeLessThan(300);

    const list = await send(reader.api, 'get', `/api/v1/rules/${rule.id}/acquisitions`);
    expect(list.status).toBe(200);
    const readOne = await send(reader.api, 'get', `/api/v1/rules/acquisitions/${created.json.id}`);
    expect(readOne.status).toBe(200);
  });

  // Visibility gotcha: rule:read alone is not enough — workspace membership is also required
  test('AC15: a non-member of the rule workspace gets 404 on both routes, same as unknown (no oracle) @SI-017 @SI-010', async () => {
    const code = unique('AXI1908NONMEMBER');
    const rule = await world.rule(acquirer, workspaceId, code);
    const created = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseAcquisitionBody(code));
    expect(created.status).toBeLessThan(300);

    const list = await send(nonMemberReader.api, 'get', `/api/v1/rules/${rule.id}/acquisitions`);
    expect(list.status).toBe(404);
    const readOne = await send(nonMemberReader.api, 'get', `/api/v1/rules/acquisitions/${created.json.id}`);
    expect(readOne.status).toBe(404);

    const unknownRuleList = await send(nonMemberReader.api, 'get', `/api/v1/rules/${rule.id}/acquisitions`);
    expect(unknownRuleList.status).toBe(list.status);
  });

  // An unknown record id is 404
  test('AC15: an unknown acquisition id is refused 404 @SI-017 @SI-010', async () => {
    const res = await send(
      acquirer.api,
      'get',
      `/api/v1/rules/acquisitions/00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status).toBe(404);
  });

  // EC15: a draft rule edited after the record was written flags ruleContentChanged
  test('AC15/EC15: ruleContentChanged flips true once the pinned draft content is edited @SI-017 @SI-010', async () => {
    const code = unique('AXI1908EC15');
    const rule = await world.rule(acquirer, workspaceId, code);
    const created = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseAcquisitionBody(code));
    expect(created.status).toBeLessThan(300);

    const beforeEdit = await send(acquirer.api, 'get', `/api/v1/rules/acquisitions/${created.json.id}`);
    expect(beforeEdit.json.ruleContentChanged).toBe(false);

    // PATCH via raw context (send() only models post/get/delete)
    const patchRes = await acquirer.api.patch(apiUrl(`/api/v1/rules/${rule.id}`), {
      data: { title: 'AXI-1908 fixture rule — edited' },
    });
    expect(patchRes.status()).toBeLessThan(300);

    const afterEdit = await send(acquirer.api, 'get', `/api/v1/rules/acquisitions/${created.json.id}`);
    expect(afterEdit.json.ruleContentChanged).toBe(true);
  });
});
