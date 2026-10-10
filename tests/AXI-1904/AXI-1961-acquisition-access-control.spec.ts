import { APIRequestContext, expect, request as apiRequest, test } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-1961 (epic AXI-1904 — FR21, FR22, FR23; AC22, AC23, AC24; EC16).
 * API-level only — no UI surface exists yet. Covers the `playwright`-tagged
 * scenarios in `axiome-docs/manual-e2e/AXI-1904-Rule-Acquisition.md` §2.6.
 *
 * AUTHORED, NOT RUN — no stack was started for this story (per the brief: no
 * `wt-up.sh`/`WT_ENV_FORCE`, never touch Postgres :5432 or the shared demo
 * stack). TypeScript compiles clean against the worktree's `tsconfig.json`;
 * execution is deferred to whoever next brings up a throwaway stack for this
 * epic.
 *
 * Self-provisions every actor/role/rule/record per run, mirroring
 * `AXI-1907-acquisition-decision.spec.ts`'s `DecisionWorld` (not imported —
 * a separate file, per story file ownership). `rule:self_approve_acquisition`
 * is granted to NO role by default (AXI-1961's contract) — this suite is what
 * exercises a role that is EXPLICITLY given it.
 *
 * Review bounce #1 fix — actor x call table (every route actually enforces
 * what the previous version of this file assumed a smaller set of
 * permissions could satisfy):
 *
 * | Route | Gateway guard | Org-service check |
 * | --- | --- | --- |
 * | `POST /v1/rules` (create rule) | `AuthGuard` only | workspace membership |
 * | `POST /v1/rules/acquisitions` (create record) | `AuthGuard` + `RuleAcquirePermissionGuard` (`rule:acquire`) | visibility: `rule:read` + membership |
 * | `POST /v1/rules/acquisitions/:id/decisions` | `AuthGuard` + `RulePublishPermissionGuard` (`rule:publish`) | visibility: `rule:read` + membership; then authority (`rule:publish`, uncached); then self-approval (`rule:self_approve_acquisition`, only if approving one's own record) |
 * | `GET /v1/rules/acquisitions/:id`, `GET /v1/rules/:ruleId/acquisitions` | `AuthGuard` only | visibility: `rule:read` + membership |
 * | `GET /v1/rules/acquisitions/capabilities` | `AuthGuard` only | none — caller-level, no visibility |
 *
 * | Actor | Grants (+ membership unless noted) | Calls it makes |
 * | --- | --- | --- |
 * | `acquirer` | `rule:acquire`, `rule:read` | create rule, create OWN records, attempt to decide (missing `rule:publish` — refused at the gateway guard), list-by-rule target, `capabilities` (expect only `canAcquire`) |
 * | `reviewerOnly` | `rule:publish`, `rule:read` | decide on `acquirer`'s records (not self), `readOne`/list on `acquirer`'s records, `capabilities` (expect only `canDecide`) |
 * | `selfAcquirerNoSelfApprove` | `rule:acquire`, `rule:publish`, `rule:read` (NOT the self-approve grant) | create rule + OWN record, decide on OWN record (approve refused, deprecate accepted), `readOne` on OWN record |
 * | `reviewerSelfApprove` | `rule:acquire`, `rule:publish`, `rule:read`, `rule:self_approve_acquisition` | create rule + OWN record, decide `approve` on OWN record (accepted), `readOne` on OWN record, `capabilities` (expect all three true) |
 * | `readOnlyActor` | `rule:read` only | `readOne` on `acquirer`'s record, expecting `allowedDecisions: []` |
 * | `noPermissionActor` | none, not even workspace membership | `capabilities` only (expect all three false — capabilities needs no visibility) |
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

class AccessControlWorld {
  admin!: APIRequestContext;
  adminUserId!: string;
  orgId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];
  private readonly ruleIds: string[] = [];

  static async create(): Promise<AccessControlWorld> {
    const world = new AccessControlWorld();
    world.admin = await adminApiContext();
    world.adminUserId = (await send(world.admin, 'get', '/api/v1/auth/me')).json.id;
    const orgs = await send(world.admin, 'get', '/api/v1/organizations');
    world.orgId =
      orgs.json?.data?.[0]?.id ??
      (
        await send(world.admin, 'post', '/api/v1/organizations', {
          name: unique('AXI-1961 Org'),
          type: 'biotech',
        })
      ).json.id;
    return world;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1961 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1961-${label}`)}@axiome.local`;
    const password = 'AXI1961-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1961',
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
      name: unique(`E2E AXI-1961 ${label}`),
      description: 'AXI-1961 acquisition access control E2E fixture',
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

  async addMember(workspaceId: string, member: Actor): Promise<void> {
    await send(this.admin, 'post', `/api/v1/workspaces/${workspaceId}/members`, {
      userId: member.userId,
      organizationId: this.orgId,
      role: 'admin',
    });
  }

  async rule(owner: Actor, workspaceId: string, code: string): Promise<{ id: string; version: number }> {
    const res = await send(owner.api, 'post', '/api/v1/rules', {
      code,
      title: 'AXI-1961 fixture rule',
      category: 'qc_guard',
      protocolType: 'QC_RULE',
      scope: 'workspace',
      workspaceId,
    });
    expect(res.status, 'creating fixture rule').toBeLessThan(300);
    this.ruleIds.push(res.json.id);
    return { id: res.json.id, version: res.json.version };
  }

  /** Creates one acquisition record, by the acquirer, against `code`. */
  async acquire(acquirer: Actor, code: string, variant = 'a'): Promise<string> {
    const res = await send(acquirer.api, 'post', '/api/v1/rules/acquisitions', {
      ruleCode: code,
      reference: '10.1000/e2e-axi1961',
      referenceType: 'doi',
      excerpt: `the measured threshold is 5 ng/mL for AXI-1961 (variant ${variant})`,
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

  readOne(actor: Actor, acquisitionId: string) {
    return send(actor.api, 'get', `/api/v1/rules/acquisitions/${acquisitionId}`);
  }

  listForRule(actor: Actor, ruleId: string) {
    return send(actor.api, 'get', `/api/v1/rules/${ruleId}/acquisitions`);
  }

  capabilities(actor: Actor) {
    return send(actor.api, 'get', `/api/v1/rules/acquisitions/capabilities`);
  }

  async dispose(): Promise<void> {
    for (const id of this.ruleIds) await this.admin.delete(apiUrl(`/api/v1/rules/${id}`)).catch(() => undefined);
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    await this.admin.dispose();
  }
}

let world: AccessControlWorld;
let acquirer: Actor; // rule:acquire + rule:read
let reviewerOnly: Actor; // rule:publish + rule:read, NOT rule:acquire
let selfAcquirerNoSelfApprove: Actor; // rule:acquire + rule:publish + rule:read, NOT the self-approve grant
let reviewerSelfApprove: Actor; // rule:acquire + rule:publish + rule:read + rule:self_approve_acquisition
let readOnlyActor: Actor; // rule:read only
let noPermissionActor: Actor; // no grants, not even a workspace member
let workspaceId: string;

test.beforeAll(async () => {
  world = await AccessControlWorld.create();

  const acquirerRoleId = await world.role('acquirer', ['rule:acquire', 'rule:read']);
  acquirer = await world.actor('acquirer', acquirerRoleId);
  workspaceId = await world.workspace('ws', acquirer);

  const reviewerOnlyRoleId = await world.role('reviewer-only', ['rule:publish', 'rule:read']);
  reviewerOnly = await world.actor('reviewer-only', reviewerOnlyRoleId);
  await world.addMember(workspaceId, reviewerOnly);

  const selfAcquirerNoSelfApproveRoleId = await world.role('self-acquirer-no-self-approve', [
    'rule:acquire',
    'rule:publish',
    'rule:read',
  ]);
  selfAcquirerNoSelfApprove = await world.actor(
    'self-acquirer-no-self-approve',
    selfAcquirerNoSelfApproveRoleId,
  );
  await world.addMember(workspaceId, selfAcquirerNoSelfApprove);

  const selfApproveRoleId = await world.role('self-approve-reviewer', [
    'rule:acquire',
    'rule:publish',
    'rule:read',
    'rule:self_approve_acquisition',
  ]);
  reviewerSelfApprove = await world.actor('reviewer-self-approve', selfApproveRoleId);
  await world.addMember(workspaceId, reviewerSelfApprove);

  const readOnlyRoleId = await world.role('read-only', ['rule:read']);
  readOnlyActor = await world.actor('read-only', readOnlyRoleId);
  await world.addMember(workspaceId, readOnlyActor);

  // Deliberately NOT added as a workspace member — `capabilities` is
  // caller-level and needs no visibility, so this actor exercises that.
  noPermissionActor = await world.actor('no-permission');
});

test.afterAll(async () => {
  await world.dispose();
});

test.describe('AXI-1961 — rule acquisition access control (self-approval, allowedDecisions, capabilities)', () => {
  // AC24 / EC16
  test('EC16: approve by the record\'s own acquirer is refused 403 SELF_APPROVAL_NOT_PERMITTED without the grant @SI-017 @SI-010', async () => {
    const code = unique('AXI1961EC16A');
    await world.rule(selfAcquirerNoSelfApprove, workspaceId, code);
    const ownRecord = await world.acquire(selfAcquirerNoSelfApprove, code);
    const res = await world.decide(selfAcquirerNoSelfApprove, ownRecord, 'approve');
    expect(res.status).toBe(403);
    expect(res.json?.message ?? JSON.stringify(res.json)).toContain('SELF_APPROVAL_NOT_PERMITTED');
  });

  // AC24
  test('AC24: approve by the acquirer WITH rule:self_approve_acquisition is accepted @SI-017 @SI-010', async () => {
    const code = unique('AXI1961AC24');
    await world.rule(reviewerSelfApprove, workspaceId, code);
    const ownRecord = await world.acquire(reviewerSelfApprove, code);
    const res = await world.decide(reviewerSelfApprove, ownRecord, 'approve');
    expect(res.status).toBeLessThan(300);
    expect(res.json.status).toBe('approved');
  });

  // FR23 — only approve is restricted
  test('FR23: deprecate by the acquirer is accepted WITHOUT the self-approve grant @SI-017 @SI-010', async () => {
    const code = unique('AXI1961FR23');
    await world.rule(selfAcquirerNoSelfApprove, workspaceId, code);
    const ownRecord = await world.acquire(selfAcquirerNoSelfApprove, code);
    const res = await world.decide(selfAcquirerNoSelfApprove, ownRecord, 'deprecate');
    expect(res.status).toBeLessThan(300);
    expect(res.json.status).toBe('deprecated');
  });

  // Refusal order: authority before self-approval
  test('refusal order: missing rule:publish refuses 403 before the self-approval check ever runs @SI-017 @SI-010', async () => {
    const code = unique('AXI1961ORDER');
    await world.rule(acquirer, workspaceId, code);
    const ownRecord = await world.acquire(acquirer, code);
    // `acquirer` holds no rule:publish, approving their own record.
    const res = await world.decide(acquirer, ownRecord, 'approve');
    expect(res.status).toBe(403);
    expect(res.json?.message ?? JSON.stringify(res.json)).not.toContain('SELF_APPROVAL_NOT_PERMITTED');
  });

  // Refusal order: self-approval before the transition graph
  test('refusal order: a self-approval refusal is 403, never masked as a 400 transition refusal @SI-017 @SI-010', async () => {
    const code = unique('AXI1961ORDER2');
    await world.rule(selfAcquirerNoSelfApprove, workspaceId, code);
    const ownRecord = await world.acquire(selfAcquirerNoSelfApprove, code);
    const res = await world.decide(selfAcquirerNoSelfApprove, ownRecord, 'approve');
    expect(res.status).toBe(403);
  });

  // No existence oracle
  test('an unknown acquisition id is still refused 404, even for a self-approval attempt @SI-017 @SI-010', async () => {
    const res = await world.decide(reviewerOnly, unique('NO-SUCH-RECORD'), 'approve');
    expect(res.status).toBe(404);
  });

  // AC22 — allowedDecisions on read-one
  test('AC22: readOne carries allowedDecisions reflecting authority + self-approval for the calling user @SI-017 @SI-010', async () => {
    const code = unique('AXI1961AC22A');
    await world.rule(acquirer, workspaceId, code);
    const acquisitionId = await world.acquire(acquirer, code);

    const asReviewerOnly = await world.readOne(reviewerOnly, acquisitionId);
    expect(asReviewerOnly.status).toBeLessThan(300);
    expect(asReviewerOnly.json.allowedDecisions).toEqual(
      expect.arrayContaining(['approve', 'deprecate']),
    );

    // `readOnlyActor` holds `rule:read` (so the record IS visible to them —
    // 2xx, not 404) but neither `rule:publish` nor `rule:acquire`.
    const asReadOnly = await world.readOne(readOnlyActor, acquisitionId);
    expect(asReadOnly.status).toBeLessThan(300);
    expect(asReadOnly.json.allowedDecisions).toEqual([]);
  });

  // AC22 / EC16 — allowedDecisions for the acquirer themself
  test('AC22/EC16: for the acquirer themself (holding rule:publish, no self-approve grant), allowedDecisions carries deprecate but not approve @SI-017 @SI-010', async () => {
    const code = unique('AXI1961AC22B');
    await world.rule(selfAcquirerNoSelfApprove, workspaceId, code);
    const ownRecord = await world.acquire(selfAcquirerNoSelfApprove, code);
    const res = await world.readOne(selfAcquirerNoSelfApprove, ownRecord);
    expect(res.status).toBeLessThan(300);
    expect(res.json.allowedDecisions).toContain('deprecate');
    expect(res.json.allowedDecisions).not.toContain('approve');
  });

  // AC24 — allowedDecisions for the acquirer with the grant
  test('AC24: for the acquirer WITH the self-approve grant, allowedDecisions carries approve too @SI-017 @SI-010', async () => {
    const code = unique('AXI1961AC24B');
    await world.rule(reviewerSelfApprove, workspaceId, code);
    const ownRecord = await world.acquire(reviewerSelfApprove, code);
    const res = await world.readOne(reviewerSelfApprove, ownRecord);
    expect(res.status).toBeLessThan(300);
    expect(res.json.allowedDecisions).toContain('approve');
  });

  // AC22 — advice/enforcement parity, through the live API
  test('AC22: advice/enforcement parity — a decision absent from allowedDecisions is refused when actually attempted @SI-017 @SI-010', async () => {
    const code = unique('AXI1961PARITY');
    await world.rule(selfAcquirerNoSelfApprove, workspaceId, code);
    const ownRecord = await world.acquire(selfAcquirerNoSelfApprove, code);
    const advice = await world.readOne(selfAcquirerNoSelfApprove, ownRecord);
    expect(advice.json.allowedDecisions).not.toContain('approve');
    const attempt = await world.decide(selfAcquirerNoSelfApprove, ownRecord, 'approve');
    expect(attempt.status).toBe(403);
  });

  // AC22 — list endpoint carries allowedDecisions too
  test('AC22: list-by-rule carries allowedDecisions per item, same policy as read-one @SI-017 @SI-010', async () => {
    const code = unique('AXI1961LIST');
    const rule = await world.rule(acquirer, workspaceId, code);
    await world.acquire(acquirer, code);
    const res = await world.listForRule(reviewerOnly, rule.id);
    expect(res.status).toBeLessThan(300);
    const items: any[] = res.json?.data ?? res.json ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Array.isArray(item.allowedDecisions)).toBe(true);
    }
  });

  // AC23 — capabilities endpoint
  test('AC23: capabilities reflects the three grants independently, caller-level @SI-017 @SI-010', async () => {
    // `noPermissionActor` holds no grants at all and is not even a
    // workspace member — capabilities needs neither, so this still 2xxs.
    const none = await world.capabilities(noPermissionActor);
    expect(none.status).toBeLessThan(300);
    expect(none.json).toEqual({ canAcquire: false, canDecide: false, canSelfApprove: false });

    const onlyAcquire = await world.capabilities(acquirer);
    expect(onlyAcquire.status).toBeLessThan(300);
    expect(onlyAcquire.json).toEqual({ canAcquire: true, canDecide: false, canSelfApprove: false });

    const decideOnly = await world.capabilities(reviewerOnly);
    expect(decideOnly.status).toBeLessThan(300);
    expect(decideOnly.json).toEqual({ canAcquire: false, canDecide: true, canSelfApprove: false });

    const all = await world.capabilities(reviewerSelfApprove);
    expect(all.status).toBeLessThan(300);
    expect(all.json).toEqual({ canAcquire: true, canDecide: true, canSelfApprove: true });
  });

  // Route order — capabilities is never captured by the :id route
  test('route order: GET /rules/acquisitions/capabilities resolves to the capabilities shape, never a 400/404 from the :id route @SI-017 @SI-010', async () => {
    const res = await world.capabilities(reviewerSelfApprove);
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty('canAcquire');
    expect(res.json).toHaveProperty('canDecide');
    expect(res.json).toHaveProperty('canSelfApprove');
  });
});
