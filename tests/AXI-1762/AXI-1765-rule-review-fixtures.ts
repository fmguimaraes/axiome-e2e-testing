import { APIRequestContext, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../config/env';
import { adminApiContext } from '../AXI-1236/rules-fixtures';

/**
 * AXI-1765 (epic AXI-1762 — FR11–FR13) — self-provisioned review actors.
 *
 * Rule review is gated on `rule:publish` read from a user's ASSIGNED roles (the
 * table the Roles admin page writes), so every actor here is a throwaway
 * self-registered user given a throwaway role through the same admin API the
 * UI uses (`POST /roles`, `POST /users/:id/roles`) — never a seeded account
 * whose grants depend on the environment. Every workspace is created fresh, so
 * "who else in this workspace holds rule:publish" (the self-approval rule) is
 * exactly what the test arranged.
 *
 * Shared by the AXI-1765 spec and by AXI-1764's fork scenario (whose publish
 * step now has to go through review).
 */

export interface Actor {
  userId: string;
  email: string;
  api: APIRequestContext;
}

export interface RuleResponse {
  id: string;
  code: string;
  status: string;
  version: number;
  title?: string;
  review?: {
    contentHash: string;
    canApprove: boolean;
    canRequestChanges: boolean;
    approveBlockedCode: string | null;
    approveBlockedReason: string | null;
    requestChangesBlockedCode: string | null;
    wouldSelfApprove: boolean;
  };
  approvalHistory?: Array<{
    id: string;
    ruleVersionId: string | null;
    ruleVersion: number;
    decision: 'approve' | 'request_changes';
    actorId: string;
    selfApproved: boolean;
    note: string;
    contentHash: string;
  }>;
  servedVersion?: { id: string; version: number; contentHash: string } | null;
  [key: string]: unknown;
}

export async function send(
  api: APIRequestContext,
  method: 'post' | 'patch' | 'delete' | 'get',
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await api[method](apiUrl(path), { data: body as any });
  if (!res.ok()) {
    throw new Error(`AXI-1765 fixture ${method.toUpperCase()} ${path} -> ${res.status()}: ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export class ReviewWorld {
  admin!: APIRequestContext;
  adminUserId!: string;
  orgId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];

  static async create(): Promise<ReviewWorld> {
    const world = new ReviewWorld();
    world.admin = await adminApiContext();
    world.adminUserId = (await send(world.admin, 'get', '/api/v1/auth/me')).id;
    const orgs = await send(world.admin, 'get', '/api/v1/organizations');
    world.orgId =
      orgs?.data?.[0]?.id ??
      (
        await send(world.admin, 'post', '/api/v1/organizations', {
          name: unique('AXI-1765 Review Org'),
          type: 'biotech',
        })
      ).id;
    return world;
  }

  /** A throwaway assigned role carrying exactly `permissions`. */
  async role(label: string, permissions: string[]): Promise<string> {
    const role = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-1765 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    this.roleIds.push(role.id);
    return role.id;
  }

  /** A throwaway self-registered user, optionally assigned `roleId`. */
  async actor(label: string, roleId?: string): Promise<Actor> {
    const email = `${unique(`axi1765-${label}`)}@axiome.local`;
    const password = 'AXI1765-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI1765',
      lastName: label,
    });
    const tokens = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
    await bootstrap.dispose();
    const api = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const me = await send(api, 'get', '/api/v1/auth/me');
    if (roleId) await this.grant(me.id, roleId);
    const actor = { userId: me.id, email, api };
    this.actors.push(actor);
    return actor;
  }

  async grant(userId: string, roleId: string): Promise<void> {
    await send(this.admin, 'post', `/api/v1/users/${userId}/roles`, { roleId });
  }

  async revoke(userId: string, roleId: string): Promise<void> {
    await send(this.admin, 'delete', `/api/v1/users/${userId}/roles/${roleId}`);
  }

  /**
   * A fresh workspace whose members are EXACTLY `members` — the admin who
   * creates it is removed again, so it cannot count as an approver.
   */
  async workspace(label: string, members: Actor[]): Promise<string> {
    const ws = await send(this.admin, 'post', '/api/v1/workspaces', {
      name: unique(`E2E AXI-1765 ${label}`),
      description: 'AXI-1765 rule review E2E fixture',
      type: 'internal',
      ownerOrganizationId: this.orgId,
    });
    for (const member of members) {
      await send(this.admin, 'post', `/api/v1/workspaces/${ws.id}/members`, {
        userId: member.userId,
        organizationId: this.orgId,
        role: 'admin',
      });
    }
    await this.admin
      .delete(apiUrl(`/api/v1/workspaces/${ws.id}/members/${this.adminUserId}`))
      .catch(() => undefined);
    return ws.id;
  }

  async dispose(): Promise<void> {
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) {
      await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`)).catch(() => undefined);
    }
    await this.admin.dispose();
  }
}

export const COMPLETE_GUIDANCE = {
  whatItDoes: 'Counts rows per group.',
  whenToUse: 'Use when you need a per-group tally.',
  whenNotToUse: 'Do not use for continuous outcomes.',
  example: 'Ten rows per site.',
  youWillGet: 'A bar chart of counts.',
};

export const COMPLETE_OUTPUT_FIELDS = [
  { key: 'feature_name', type: 'string', description: 'Name of the computed feature.' },
  { key: 'value', type: 'number', description: 'The computed feature value.' },
];

/**
 * AXI-1809 (the AXI-1822 finding): fixture rules used to be left behind on every
 * run. Several of them are SYSTEM scope, so after a few runs they pushed boot seeds
 * such as `IMM-QC-01` off the first catalogue page, and a later spec's lookup failed.
 * Every rule a fixture creates is recorded here. The spec that created it deletes
 * it in `afterAll` with {@link deleteFixtureRules} (soft delete, as the platform
 * admin: system scope needs that).
 */
const fixtureRuleIds = new Set<string>();

/** Record a rule a spec created outside {@link inReviewRule}, so {@link deleteFixtureRules} removes it too. */
export function trackFixtureRule(id: string): void {
  fixtureRuleIds.add(id);
}

/** Soft-delete every fixture rule recorded in this worker so far (best effort; each id once). */
export async function deleteFixtureRules(admin: APIRequestContext): Promise<void> {
  const ids = [...fixtureRuleIds];
  fixtureRuleIds.clear();
  for (const id of ids) {
    await admin.delete(apiUrl(`/api/v1/rules/${id}`)).catch(() => undefined);
  }
}

/**
 * Create a complete FEATURE_RULE as `author` and walk it to `in_review`
 * (draft → checked by the FR9 gate → submitted by the author).
 */
export async function inReviewRule(
  author: APIRequestContext,
  scope: { scope: 'workspace'; workspaceId: string } | { scope: 'system' },
  overrides: Record<string, unknown> = {},
): Promise<RuleResponse> {
  const created = (await send(author, 'post', '/api/v1/rules', {
    code: unique('AXI-1765'),
    title: 'AXI-1765 review fixture',
    category: 'phenotype_detection',
    protocolType: 'FEATURE_RULE',
    signals: ['marker:cd4_count'],
    ...scope,
    ...overrides,
  })) as RuleResponse;
  trackFixtureRule(created.id);
  const completed = (await send(author, 'patch', `/api/v1/rules/${created.id}`, {
    outputFields: COMPLETE_OUTPUT_FIELDS,
    guidance: COMPLETE_GUIDANCE,
  })) as RuleResponse;
  expect(completed.status, 'fixture rule must pass the FR9 gate').toBe('checked');
  const submitted = (await send(author, 'post', `/api/v1/rules/${created.id}/submit-for-review`)) as RuleResponse;
  expect(submitted.status).toBe('in_review');
  return submitted;
}
