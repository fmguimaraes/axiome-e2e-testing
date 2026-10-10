import { APIRequestContext, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-1906 (epic AXI-1904 — FR1..FR4, FR12, FR13, FR15, FR16, NFR3, NFR6;
 * AC2..AC4, AC11..AC14; EC1..EC4, EC6..EC8, EC12..EC14). API-level only — no
 * UI surface exists yet. Covers the scenarios in
 * `axiome-docs/manual-e2e/AXI-1904-Rule-Acquisition.md` §2.2.
 *
 * Every actor, role and rule is self-provisioned per run, mirroring
 * `tests/AXI-1762/AXI-1765-rule-review-fixtures.ts`'s `ReviewWorld`: a
 * throwaway SYSTEM role carrying exactly `rule:acquire` (optionally plus
 * `rule:read`), granted to a throwaway self-registered user via the same
 * admin API the Roles UI calls.
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

class AcquisitionWorld {
  admin!: APIRequestContext;
  adminUserId!: string;
  orgId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];
  private readonly ruleIds: string[] = [];

  static async create(): Promise<AcquisitionWorld> {
    const world = new AcquisitionWorld();
    world.admin = await adminApiContext();
    world.adminUserId = (await send(world.admin, 'get', '/api/v1/auth/me')).json.id;
    const orgs = await send(world.admin, 'get', '/api/v1/organizations');
    world.orgId =
      orgs.json?.data?.[0]?.id ??
      (
        await send(world.admin, 'post', '/api/v1/organizations', {
          name: unique('AXI-1906 Org'),
          type: 'biotech',
        })
      ).json.id;
    return world;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1906 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1906-${label}`)}@axiome.local`;
    const password = 'AXI1906-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1906',
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
      name: unique(`E2E AXI-1906 ${label}`),
      description: 'AXI-1906 acquisition create E2E fixture',
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
      title: 'AXI-1906 fixture rule',
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

function baseBody(ruleCode: string, overrides: Record<string, unknown> = {}) {
  return {
    ruleCode,
    reference: '10.1000/e2e-axi1906',
    referenceType: 'doi',
    excerpt: 'the measured threshold is 5 ng/mL for AXI-1906',
    acquisitionMethod: 'manual',
    acquiredAt: new Date().toISOString(),
    ...overrides,
  };
}

let world: AcquisitionWorld;
let acquirerRoleId: string;
let acquirerWithReadRoleId: string;
let acquirer: Actor; // holds rule:acquire + rule:read (can resolve codes in its own workspace)
let acquireOnlyActor: Actor; // holds ONLY rule:acquire (FR16)
let noPermissionActor: Actor; // holds neither (AC14)
let nonMemberAcquirer: Actor; // holds rule:acquire + rule:read, member of NO workspace (review fix)
let workspaceId: string;

test.beforeAll(async () => {
  world = await AcquisitionWorld.create();
  acquirerWithReadRoleId = await world.role('acquire-and-read', ['rule:acquire', 'rule:read']);
  acquirerRoleId = await world.role('acquire-only', ['rule:acquire']);
  acquirer = await world.actor('acquirer', acquirerWithReadRoleId);
  workspaceId = await world.workspace('ws', acquirer);
  acquireOnlyActor = await world.actor('acquire-only', acquirerRoleId);
  noPermissionActor = await world.actor('no-permission');
  // Same role as `acquirer` (rule:acquire + rule:read) but never added to ANY
  // workspace, so they are not a member of the fixture rule's workspace.
  nonMemberAcquirer = await world.actor('non-member-acquirer', acquirerWithReadRoleId);
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1906 — rule acquisition create API', () => {
  // AT-1906-1 / AC2
  test('AC2: a record missing a required field (excerpt) is refused 400, nothing created @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906AC2');
    await world.rule(acquirer, workspaceId, code);
    const body = baseBody(code, { excerpt: undefined });
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', body);
    expect(res.status).toBe(400);
  });

  // AT-1906-2 / AC3
  test('AC3: an llm record missing model/prompt/raw-output is refused 400 @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906AC3');
    await world.rule(acquirer, workspaceId, code);
    const body = baseBody(code, { acquisitionMethod: 'llm' });
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', body);
    expect(res.status).toBe(400);
  });

  // AT-1906-3 / AC4, NFR6, EC1
  test('AC4: resending an identical record returns the SAME id, not a second row @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906AC4');
    await world.rule(acquirer, workspaceId, code);
    const body = baseBody(code);
    const first = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', body);
    expect(first.status).toBeLessThan(300);
    const second = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', body);
    expect(second.status).toBeLessThan(300);
    expect(second.json.id).toBe(first.json.id);
  });

  // AT-1906-4 / AC11, EC2
  test('AC11/EC2: an unknown rule code is refused 404 @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseBody(unique('NO-SUCH-RULE')));
    expect(res.status).toBe(404);
  });

  // AT-1906-5 / AC11, EC3
  test('AC11/EC3: a code matching two rules visible to the caller is an explicit ambiguity error, never a pick @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906AC11AMBIG');
    const ws2 = await world.workspace('ws2', acquirer);
    await world.rule(acquirer, workspaceId, code);
    await world.rule(acquirer, ws2, code);
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseBody(code));
    expect(res.status).toBe(409);
  });

  // AT-1906-6 / AC12, EC4
  test('AC12/EC4: a ruleVersion that is neither current nor published is refused 400 @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906AC12');
    await world.rule(acquirer, workspaceId, code);
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseBody(code, { ruleVersion: 999 }));
    expect(res.status).toBe(400);
  });

  // AT-1906-7 / AC12 happy path
  test("AC12: a record pins the rule's current version and a stored content hash @SI-017 @SI-010 @SI-001 @SI-002", async () => {
    const code = unique('AXI1906AC12OK');
    const rule = await world.rule(acquirer, workspaceId, code);
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseBody(code));
    expect(res.status).toBeLessThan(300);
    expect(res.json.ruleVersion).toBe(rule.version);
    expect(typeof res.json.ruleContentHash).toBe('string');
    expect(res.json.ruleContentHash.length).toBeGreaterThan(0);
  });

  // AT-1906-8 / AC13, EC13
  test('AC13: acquiredBy is the authenticated caller even when the body names another identity @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906AC13');
    await world.rule(acquirer, workspaceId, code);
    const res = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseBody(code, { acquiredBy: 'someone-else' }),
    );
    expect(res.status).toBeLessThan(300);
    expect(res.json.acquiredBy).toBe(acquirer.userId);
  });

  // AT-1906-9 / AC14
  test('AC14: create is refused 403 without rule:acquire @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906AC14');
    await world.rule(acquirer, workspaceId, code);
    const res = await send(noPermissionActor.api, 'post', '/api/v1/rules/acquisitions', baseBody(code));
    expect(res.status).toBe(403);
  });

  // AT-1906-10 / FR16
  test('FR16: rule:acquire alone grants no visibility — resolves to the SAME 404 as an unknown code @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906FR16');
    await world.rule(acquirer, workspaceId, code);
    const res = await send(acquireOnlyActor.api, 'post', '/api/v1/rules/acquisitions', baseBody(code));
    expect(res.status).toBe(404);
  });

  // AT-1906-10b / AC11/EC2 — review fix: cross-tenant rule addressing
  test('AC11/EC2: rule:acquire + rule:read is not enough — a non-member of the rule\'s workspace gets the SAME 404 as an unknown code @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906NONMEMBER');
    await world.rule(acquirer, workspaceId, code);
    const res = await send(nonMemberAcquirer.api, 'post', '/api/v1/rules/acquisitions', baseBody(code));
    expect(res.status).toBe(404);
  });

  // AT-1906-11 / EC6
  test('AC2/EC6: a doi reference with no "10." prefix is refused 400 @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906EC6');
    await world.rule(acquirer, workspaceId, code);
    const res = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseBody(code, { reference: 'not-a-doi' }),
    );
    expect(res.status).toBe(400);
  });

  // AT-1906-12 / EC7
  test('AC2/EC7: a whitespace-only excerpt is refused 400 @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906EC7');
    await world.rule(acquirer, workspaceId, code);
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseBody(code, { excerpt: '   ' }));
    expect(res.status).toBe(400);
  });

  // AT-1906-13 / EC8
  test('AC2/EC8: raw_output over 1 MB is refused outright, never truncated @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906EC8');
    await world.rule(acquirer, workspaceId, code);
    const res = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseBody(code, {
        acquisitionMethod: 'llm',
        modelId: 'test-model',
        promptVersionHash: 'hash',
        rawOutput: 'a'.repeat(1_048_577),
      }),
    );
    expect(res.status).toBe(400);
  });

  // AT-1906-14 / EC12
  test('AC2/EC12: a manual record carrying LLM fields anyway is accepted and stored @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906EC12');
    await world.rule(acquirer, workspaceId, code);
    const res = await send(
      acquirer.api,
      'post',
      '/api/v1/rules/acquisitions',
      baseBody(code, { modelId: 'test-model', promptVersionHash: 'hash', rawOutput: 'small output' }),
    );
    expect(res.status).toBeLessThan(300);
    expect(res.json.modelId).toBe('test-model');
  });

  // AT-1906-15 / EC14
  test('AC2/EC14: acquired_at more than 5 minutes in the future is refused 400 @SI-017 @SI-010 @SI-001 @SI-002', async () => {
    const code = unique('AXI1906EC14');
    await world.rule(acquirer, workspaceId, code);
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', baseBody(code, { acquiredAt: future }));
    expect(res.status).toBe(400);
  });
});
