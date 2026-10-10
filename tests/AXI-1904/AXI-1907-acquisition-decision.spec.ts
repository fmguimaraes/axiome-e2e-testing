import { APIRequestContext, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-1907 (epic AXI-1904 — FR5, FR7, FR8, FR9, FR14, FR15, NFR1, NFR3;
 * AC7, AC8, AC9, AC14; EC9, EC10). API-level only — no UI surface yet. Covers
 * the `playwright`-tagged scenarios in
 * `axiome-docs/manual-e2e/AXI-1904-Rule-Acquisition.md` §2.3.
 *
 * Self-provisioned per run, same shape as
 * `tests/AXI-1904/AXI-1906-acquisition-create.spec.ts`'s `AcquisitionWorld`
 * (not imported from it — that file is a test, not a shared module; a
 * throwaway `rule:acquire` role creates the records under test and a
 * throwaway `rule:publish` role decides on them).
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

class DecisionWorld {
  admin!: APIRequestContext;
  adminUserId!: string;
  orgId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];
  private readonly ruleIds: string[] = [];

  static async create(): Promise<DecisionWorld> {
    const world = new DecisionWorld();
    world.admin = await adminApiContext();
    world.adminUserId = (await send(world.admin, 'get', '/api/v1/auth/me')).json.id;
    const orgs = await send(world.admin, 'get', '/api/v1/organizations');
    world.orgId =
      orgs.json?.data?.[0]?.id ??
      (
        await send(world.admin, 'post', '/api/v1/organizations', {
          name: unique('AXI-1907 Org'),
          type: 'biotech',
        })
      ).json.id;
    return world;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1907 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1907-${label}`)}@axiome.local`;
    const password = 'AXI1907-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1907',
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
      name: unique(`E2E AXI-1907 ${label}`),
      description: 'AXI-1907 acquisition decision E2E fixture',
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

  async rule(owner: Actor, workspaceId: string, code: string): Promise<{ id: string; version: number }> {
    const res = await send(owner.api, 'post', '/api/v1/rules', {
      code,
      title: 'AXI-1907 fixture rule',
      category: 'qc_guard',
      protocolType: 'QC_RULE',
      scope: 'workspace',
      workspaceId,
    });
    expect(res.status, 'creating fixture rule').toBeLessThan(300);
    this.ruleIds.push(res.json.id);
    return { id: res.json.id, version: res.json.version };
  }

  /**
   * Creates one acquisition record, by the acquirer, against `code`.
   *
   * `variant` MUST differ between two calls that need to produce two
   * DISTINCT records for the same rule code (e.g. a supersede original +
   * replacement): the content hash (NFR6) covers `excerpt` and every other
   * client content field but never `acquiredAt`, so two calls with an
   * identical body are idempotent and the second returns the SAME id as
   * the first, not a new one.
   */
  async acquire(acquirer: Actor, code: string, variant = 'a'): Promise<string> {
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', {
      ruleCode: code,
      reference: '10.1000/e2e-axi1907',
      referenceType: 'doi',
      excerpt: `the measured threshold is 5 ng/mL for AXI-1907 (variant ${variant})`,
      acquisitionMethod: 'manual',
      acquiredAt: new Date().toISOString(),
    });
    expect(res.status, 'creating fixture acquisition record').toBeLessThan(300);
    return res.json.id;
  }

  decide(
    actor: Actor,
    acquisitionId: string,
    decision: 'approve' | 'deprecate' | 'supersede',
    supersededBy?: string,
  ) {
    return send(actor.api, 'post', `/api/v1/rules/acquisitions/${acquisitionId}/decisions`, {
      decision,
      ...(supersededBy ? { supersededBy } : {}),
    });
  }

  async dispose(): Promise<void> {
    for (const id of this.ruleIds) await this.admin.delete(apiUrl(`/api/v1/rules/${id}`)).catch(() => undefined);
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    await this.admin.dispose();
  }
}

let world: DecisionWorld;
let acquirer: Actor; // holds rule:acquire + rule:read, member of workspaceId
let reviewer: Actor; // holds rule:publish + rule:read, member of workspaceId
let noPermissionActor: Actor; // holds neither rule:acquire nor rule:publish
let workspaceId: string;

test.beforeAll(async () => {
  world = await DecisionWorld.create();
  const acquirerRoleId = await world.role('acquirer', ['rule:acquire', 'rule:read']);
  acquirer = await world.actor('acquirer', acquirerRoleId);
  workspaceId = await world.workspace('ws', acquirer);
  // `decide()` resolves the record's rule through the full visibility decision
  // (`isRuleVisible` AND `isRuleActionPermitted('view')`), same as create and
  // read-one — `rule:publish` alone grants no visibility, so the reviewer
  // ALSO needs `rule:read` (membership in the rule's workspace is granted
  // below) or every decision 404s before the authority check is even reached.
  const reviewerRoleId = await world.role('reviewer', ['rule:publish', 'rule:read']);
  reviewer = await world.actor('reviewer', reviewerRoleId);
  await send(world.admin, 'post', `/api/v1/workspaces/${workspaceId}/members`, {
    userId: reviewer.userId,
    organizationId: world.orgId,
    role: 'admin',
  });
  noPermissionActor = await world.actor('no-permission');
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1907 — rule acquisition decision API', () => {
  // AT-1907-1 / AC7
  test('AC7: draft -> approve succeeds, the response carries the new derived status @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907AC7A');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    const res = await world.decide(reviewer, acquisitionId, 'approve');
    expect(res.status).toBeLessThan(300);
    expect(res.json.status).toBe('approved');
    expect(res.json.decision.decision).toBe('approve');
  });

  // AT-1907-2 / AC7, EC9
  test('AC7/EC9: re-approving an already-approved record is refused 400 @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907AC7B');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    await world.decide(reviewer, acquisitionId, 'approve');
    const res = await world.decide(reviewer, acquisitionId, 'approve');
    expect(res.status).toBe(400);
  });

  // AT-1907-3 / AC7
  test('AC7: draft -> deprecate succeeds @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907AC7C');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    const res = await world.decide(reviewer, acquisitionId, 'deprecate');
    expect(res.status).toBeLessThan(300);
    expect(res.json.status).toBe('deprecated');
  });

  // AT-1907-4 / AC7, EC9
  test('AC7/EC9: deprecated is terminal — approve after deprecate is refused 400 @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907EC9');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    await world.decide(reviewer, acquisitionId, 'deprecate');
    const res = await world.decide(reviewer, acquisitionId, 'approve');
    expect(res.status).toBe(400);
  });

  // AT-1907-5 / AC7
  test('AC7: approved -> deprecate succeeds @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907AC7D');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    await world.decide(reviewer, acquisitionId, 'approve');
    const res = await world.decide(reviewer, acquisitionId, 'deprecate');
    expect(res.status).toBeLessThan(300);
    expect(res.json.status).toBe('deprecated');
  });

  // AT-1907-6 / AC8
  test('AC8: approved -> supersede with a valid supersededBy of the SAME rule succeeds @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907AC8OK');
    await world.rule(acquirer, workspaceId, code);
    const original = await world.acquire(acquirer, code, 'original');
    await world.decide(reviewer, original, 'approve');
    // The reviewer holds no rule:acquire — creation is always done by
    // `acquirer`. `variant` MUST differ from `original`'s or the content
    // hash (NFR6) dedupes this to the SAME record.
    const replacement = await world.acquire(acquirer, code, 'replacement');
    await world.decide(reviewer, replacement, 'approve');
    const res = await world.decide(reviewer, original, 'supersede', replacement);
    expect(res.status).toBeLessThan(300);
    expect(res.json.status).toBe('superseded');
    expect(res.json.decision.supersededBy).toBe(replacement);
  });

  // AT-1907-7 / AC8, EC10
  test('AC8/EC10: a supersede decision missing supersededBy is refused 400 @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907EC10A');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    await world.decide(reviewer, acquisitionId, 'approve');
    const res = await world.decide(reviewer, acquisitionId, 'supersede');
    expect(res.status).toBe(400);
  });

  // AT-1907-8 / AC8, EC10
  test('AC8/EC10: supersededBy referencing a record of a DIFFERENT rule is refused 400 @SI-017 @SI-010 @SI-002', async () => {
    const codeA = unique('AXI1907EC10B-A');
    const codeB = unique('AXI1907EC10B-B');
    await world.rule(acquirer, workspaceId, codeA);
    await world.rule(acquirer, workspaceId, codeB);
    const acquisitionA = await world.acquire(acquirer, codeA);
    const acquisitionB = await world.acquire(acquirer, codeB);
    await world.decide(reviewer, acquisitionA, 'approve');
    await world.decide(reviewer, acquisitionB, 'approve');
    const res = await world.decide(reviewer, acquisitionA, 'supersede', acquisitionB);
    expect(res.status).toBe(400);
  });

  // AT-1907-9 / AC8, EC10
  test('AC8/EC10: supersededBy pointing at itself is refused 400 @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907EC10C');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    await world.decide(reviewer, acquisitionId, 'approve');
    const res = await world.decide(reviewer, acquisitionId, 'supersede', acquisitionId);
    expect(res.status).toBe(400);
  });

  // AT-1907-10 / AC8, EC10
  test('AC8/EC10: supersededBy referencing a NON-approved record of the same rule is refused 400 @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907EC10D');
    await world.rule(acquirer, workspaceId, code);
    const original = await world.acquire(acquirer, code, 'original');
    // The reviewer holds no rule:acquire — creation is always done by
    // `acquirer`. `variant` MUST differ from `original`'s or the content
    // hash (NFR6) dedupes this to the SAME record.
    const stillDraft = await world.acquire(acquirer, code, 'still-draft');
    await world.decide(reviewer, original, 'approve');
    const res = await world.decide(reviewer, original, 'supersede', stillDraft);
    expect(res.status).toBe(400);
  });

  // AT-1907-11 / AC9, NFR3
  test('AC9: reviewer identity and timestamp are recorded and visible in the rule audit log @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907AC9');
    const rule = await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    const decideRes = await world.decide(reviewer, acquisitionId, 'approve');
    expect(decideRes.status).toBeLessThan(300);
    expect(decideRes.json.decision.actorId).toBe(reviewer.userId);
    expect(typeof decideRes.json.decision.createdAt).toBe('string');

    const audit = await send(reviewer.api, 'get', `/api/v1/rules/${rule.id}/audit`);
    expect(audit.status).toBeLessThan(300);
    const entries: any[] = audit.json?.data ?? audit.json ?? [];
    const recorded = entries.find((e) => e.action === 'acquisition_decision_recorded');
    expect(recorded).toBeTruthy();
    expect(recorded.performedBy).toBe(reviewer.userId);
  });

  // AT-1907-12 / AC14
  test('AC14: a decision is refused 403 without rule:publish @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907AC14');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    const res = await world.decide(noPermissionActor, acquisitionId, 'approve');
    expect(res.status).toBe(403);
  });

  // AT-1907-13 / FR9, EC13-analog
  test('FR9: a body-supplied actorId is rejected by the API (400), never silently honored @SI-017 @SI-010 @SI-002', async () => {
    const code = unique('AXI1907FR9');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);
    const res = await send(
      reviewer.api,
      'post',
      `/api/v1/rules/acquisitions/${acquisitionId}/decisions`,
      { decision: 'approve', actorId: 'FORGED' },
    );
    expect(res.status).toBe(400);
  });

  // AT-1907-14 / EC2-analog (no existence oracle)
  test('An unknown acquisition record id is refused 404 @SI-017 @SI-010 @SI-002', async () => {
    const res = await world.decide(reviewer, unique('NO-SUCH-RECORD'), 'approve');
    expect(res.status).toBe(404);
  });
});
