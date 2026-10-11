import { APIRequestContext, expect, request as apiRequest } from '@playwright/test';
import { apiUrl } from '../../../config/env';
import { adminApiContext } from '../../AXI-1236/rules-fixtures';

/**
 * AXI-2005 (epic AXI-1991 — AC7, AC10, AC11, AC14, AC18, AC19).
 *
 * Shared, self-contained fixture world for the Rule Families E2E specs.
 * Mirrors `AXI-1961-acquisition-access-control.spec.ts`'s `AccessControlWorld`
 * (actor/role/workspace provisioning) rather than importing it — a separate
 * file per story's file-ownership boundary — but reuses `adminApiContext`
 * from AXI-1236 (an established cross-story-dir convention in this suite,
 * e.g. AXI-1907 imports the same helper).
 *
 * AUTHORED, NOT RUN — no stack was started for this story. Every call here is
 * exercised for the first time on whichever stack next runs these specs.
 *
 * **Served rules (bounce #1, B1; bounce #2 reworks this to drop self-
 * approval).** `GET /rule-runs/offered-rules` offers only a SERVED rule
 * (`served-rule.ts`: live `status === 'published'`, or a fork with a
 * published `RuleVersion`) that is also RUNNABLE (`isRuleRunnable`,
 * `rule-runnability.ts`). A bare `world.rule()` leaves a rule `draft`/
 * `checked` — absent from both `offered[]` and `notAvailable[]` — so any test
 * asserting presence/absence there must use {@link RuleFamilyWorld.servedQcRule}
 * instead, which walks a QC_RULE through `draft → checked` (FR9's own-save
 * gate; a QC_RULE is always runnable via the shared `qc.rule_gate` operation,
 * `isRuleRunnable`'s `qc_rule` branch) → `in_review` → `published`.
 *
 * Bounce #1's first version had the throwaway OWNER self-approve, reasoning
 * "sole `rule:publish` holder in a private workspace ⇒ no other approver
 * exists". Bounce #2 found that premise false on a real stack: every
 * workspace's CREATOR is auto-enrolled as an `admin` member
 * (`apps/organization-service/src/workspaces/workspaces.service.ts:58-67`,
 * "Add creator as admin member"), and `servedQcRule` creates the workspace as
 * `this.admin` — the suite's shared bootstrap PLATFORM ADMIN context
 * (`adminApiContext()`, `tests/AXI-1236/rules-fixtures.ts`). That admin holds
 * `rule:publish` through the boot-seeded "Rule Approver" system role
 * (migration `20260928180000_grant_rule_publish_to_platform_admins`,
 * `admin-bootstrap.service.ts`), so `RuleApprovalService.otherApprovers`
 * (`apps/organization-service/src/rules/approval/rule-approval.service.ts`,
 * the `otherApprovers()` method) always finds it as a member of the rule's
 * workspace holding `rule:publish`, and self-approval is refused
 * `SELF_APPROVAL_OTHER_APPROVER_EXISTS` on every real stack. The premise was
 * "fragile on any real stack" exactly as flagged — dropped rather than
 * repaired (e.g. by creating the workspace as the owner instead): the
 * product's designed path is two-person review, and this fixture should
 * exercise that path, not route around it.
 *
 * **Fix: ordinary two-person review.** The owner (author) creates the rule
 * and submits it for review; `this.admin` — a DIFFERENT actor, never the
 * author — approves it:
 *   - `decideRuleReview` (`rule-review-policy.ts`): when the approving actor
 *     is not in the rule's `authorIds`, the function returns
 *     `{ allowed: true, selfApproved: false }` immediately (the
 *     `if (!facts.authorIds.has(facts.actorId))` branch, near the function's
 *     end) — none of the self-approval sub-rules (4a-4d) are even reached.
 *   - `RuleApprovalService.evaluate()` (`rule-approval.service.ts`): gathers
 *     `authorIds` via `authorsOf(rule)` (creator + anyone who
 *     created/updated/submitted it); `this.admin`'s id is in neither, so
 *     `if (!authorIds.has(actorId)) return decideRuleReview({...facts,
 *     authorIds})` is the exact branch taken — `otherApprovers()` (the method
 *     that made self-approval fragile) is never even called for a
 *     non-author approver.
 *   - Visibility: `RulesService.approve` → `loadForReview` →
 *     `this.ruleVisibility.assertRuleVisible(existing, caller, ...)`
 *     (`rules.service.ts`, `loadForReview`). `RuleVisibilityService`'s own
 *     class doc comment states platform admin "bypasses scoping, per the
 *     AXI-1129 precedent" (`rule-visibility.service.ts`, the
 *     `callerIsPlatformAdmin` field's doc comment) — so `this.admin`'s
 *     platform-admin fact alone satisfies visibility, independent of its
 *     also being a workspace member (which it is, per the auto-enrollment
 *     above — belt and suspenders, neither is load-bearing alone).
 *   - Gate: `RulePublishPermissionGuard` (`apps/gateway/src/proxy/rule-publish-permission.guard.ts`)
 *     resolves the SAME assigned-role permission table
 *     (`RuleAccessResolverService.resolvePermissions`) for whichever actor
 *     calls `POST /rules/:id/approve` — nothing in the guard or the service
 *     path above refuses an approver who also happens to be the workspace's
 *     creator; the only two facts that matter are "holds `rule:publish`" and
 *     "is not an author of this rule's content".
 *   - Request/response shape (`apps/gateway/src/proxy/rules.controller.ts`,
 *     `@Post(':id/approve')`): body is `{ note?: string;
 *     expectedContentHash?: string }`; a successful call transitions the live
 *     row to `status: 'published'` and creates a `RuleVersion` row at
 *     `status: 'published'` (`RulesService.approve`'s own doc comment, step 6
 *     — "the published `RuleVersion`... then the approval record").
 *
 * This never bypasses the review gate and never uses a seeded/shared system
 * rule (`tests/AXI-1762/seeded-rule-approval.ts`'s mechanism, which serves
 * only BOOT-SEEDED system rules and is for a different fixture shape).
 *
 * **AXI-2022 (moving part, in development at authoring time):** membership
 * routes will require workspace membership to manage/read a WORKSPACE-scope
 * family, and `GET /rule-family-membership/rules/:ruleId` will return only
 * families the caller may read. None of this suite's families are
 * workspace-scope (every `createFamily` call here passes `'organization'` or
 * `'system'`), and the one actor that reads
 * `/rule-family-membership/rules/:ruleId` (`AXI-2005-rbac-tenancy.spec.ts`'s
 * `assign` test) is already a member of the rule's workspace. Nothing here is
 * expected to need a change when AXI-2022 lands; if a future addition creates
 * a workspace-scope family, its managing/reading actor must be added via
 * {@link RuleFamilyWorld.addWorkspaceMember} first.
 */

export function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export interface Actor {
  userId: string;
  api: APIRequestContext;
}

export async function send(
  api: APIRequestContext,
  method: 'post' | 'get' | 'delete' | 'patch',
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const opts: Record<string, unknown> = {};
  if (body !== undefined) opts.data = body;
  if (headers) opts.headers = headers;
  const res = await (api as any)[method](apiUrl(path), opts);
  const text = await res.text();
  return { status: res.status(), json: text ? JSON.parse(text) : {} };
}

/** `X-Organization-Id` header required by every `rule-families*` route (FR39). */
export function orgHeader(organizationId: string): Record<string, string> {
  return { 'X-Organization-Id': organizationId };
}

/** The five `rule_family:*` capability strings (FR38), restated here because
 *  `libs/common` is not on this suite's build path (no shared package). */
export const RULE_FAMILY_CAPABILITY = {
  READ: 'rule_family:read',
  MANAGE: 'rule_family:manage',
  ASSIGN: 'rule_family:assign',
  CONFIGURE_DEFAULTS: 'rule_family:configure_defaults',
  PROJECT_SELECT: 'rule_family:project_select',
} as const;

export class RuleFamilyWorld {
  admin!: APIRequestContext;
  adminUserId!: string;
  private readonly roleIds: string[] = [];
  private readonly actors: Actor[] = [];
  /** `{id, organizationId}` — the org header `dispose()` needs to delete each one (A3). */
  private readonly families: Array<{ id: string; organizationId: string }> = [];
  private readonly ruleIds: string[] = [];
  private readonly projectIds: string[] = [];
  private publisherRoleId: string | null = null;

  static async create(): Promise<RuleFamilyWorld> {
    const world = new RuleFamilyWorld();
    world.admin = await adminApiContext();
    world.adminUserId = (await send(world.admin, 'get', '/api/v1/auth/me')).json.id;
    return world;
  }

  /** A dedicated organization for this scenario — never shared by name, so
   *  cross-org isolation assertions never collide with another run's rows. */
  async organization(label: string): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/organizations', {
      name: unique(`AXI-2005 Org ${label}`),
      type: 'biotech',
    });
    expect(res.status, `creating organization ${label}`).toBeLessThan(300);
    return res.json.id;
  }

  async workspace(label: string, organizationId: string): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/workspaces', {
      name: unique(`AXI-2005 WS ${label}`),
      description: 'AXI-2005 rule family E2E fixture',
      type: 'internal',
      ownerOrganizationId: organizationId,
    });
    expect(res.status, `creating workspace ${label}`).toBeLessThan(300);
    return res.json.id;
  }

  async project(label: string, workspaceId: string): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/projects', {
      name: unique(`AXI-2005 Project ${label}`),
      workspaceId,
    });
    expect(res.status, `creating project ${label}`).toBeLessThan(300);
    this.projectIds.push(res.json.id);
    return res.json.id;
  }

  async role(label: string, permissions: string[]): Promise<string> {
    const res = await send(this.admin, 'post', '/api/v1/roles', {
      name: unique(`E2E AXI-2005 ${label}`),
      scope: 'SYSTEM',
      permissions,
    });
    expect(res.status, `creating role ${label}`).toBeLessThan(300);
    this.roleIds.push(res.json.id);
    return res.json.id;
  }

  /** A fresh actor, optionally granted `roleId` scoped to `organizationId`
   *  (FR39/FR44 — an assignment with no organization grants no capability). */
  async actor(label: string, roleId?: string, organizationId?: string): Promise<Actor> {
    const email = `${unique(`axi2005-${label}`)}@axiome.local`;
    const password = 'AXI2005-e2e-pw!';
    const bootstrap = await apiRequest.newContext();
    await send(bootstrap, 'post', '/api/v1/auth/register', {
      email,
      password,
      firstName: 'AXI2005',
      lastName: label,
    });
    const login = await send(bootstrap, 'post', '/api/v1/auth/login', { email, password });
    await bootstrap.dispose();
    const api = await apiRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${login.json.accessToken}` },
    });
    const me = await send(api, 'get', '/api/v1/auth/me');
    if (roleId) {
      const res = await send(this.admin, 'post', `/api/v1/users/${me.json.id}/roles`, {
        roleId,
        organizationId,
      });
      expect(res.status, `assigning role to ${label}`).toBeLessThan(300);
    }
    const actor = { userId: me.json.id, api };
    this.actors.push(actor);
    return actor;
  }

  async addWorkspaceMember(workspaceId: string, member: Actor): Promise<void> {
    await send(this.admin, 'post', `/api/v1/workspaces/${workspaceId}/members`, {
      userId: member.userId,
      role: 'admin',
    });
  }

  /** A workspace-scope rule, ordinary library QC rule (never carrier/family). */
  async rule(owner: Actor, workspaceId: string, code: string, families?: string[]): Promise<string> {
    const res = await send(owner.api, 'post', '/api/v1/rules', {
      code,
      title: `AXI-2005 fixture rule ${code}`,
      category: 'qc_guard',
      protocolType: 'QC_RULE',
      scope: 'workspace',
      workspaceId,
      ...(families ? { familyIds: families } : {}),
    });
    expect(res.status, `creating fixture rule ${code}: ${JSON.stringify(res.json)}`).toBeLessThan(300);
    this.ruleIds.push(res.json.id);
    return res.json.id;
  }

  async createFamily(
    actor: Actor,
    organizationId: string,
    scope: 'system' | 'organization' | 'workspace',
    name: string,
    workspaceId?: string,
  ): Promise<{ status: number; id?: string }> {
    const res = await send(
      actor.api,
      'post',
      '/api/v1/rule-families',
      { name: unique(name), scope, ...(workspaceId ? { workspaceId } : {}) },
      orgHeader(organizationId),
    );
    if (res.status < 300) this.families.push({ id: res.json.id, organizationId });
    return { status: res.status, id: res.json?.id };
  }

  async toggleDefault(
    actor: Actor,
    organizationId: string,
    familyId: string,
    defaultAuthorized: boolean,
  ): Promise<{ status: number }> {
    return send(
      actor.api,
      'patch',
      `/api/v1/rule-families/${familyId}/default-authorized`,
      { defaultAuthorized },
      orgHeader(organizationId),
    );
  }

  async addProjectFamily(
    actor: Actor,
    organizationId: string,
    projectId: string,
    familyId: string,
  ): Promise<{ status: number }> {
    return send(
      actor.api,
      'post',
      `/api/v1/projects/${projectId}/rule-families`,
      { familyId },
      orgHeader(organizationId),
    );
  }

  async removeProjectFamily(
    actor: Actor,
    organizationId: string,
    projectId: string,
    familyId: string,
  ): Promise<{ status: number }> {
    return send(
      actor.api,
      'delete',
      `/api/v1/projects/${projectId}/rule-families/${familyId}`,
      undefined,
      orgHeader(organizationId),
    );
  }

  async addMember(actor: Actor, organizationId: string, familyId: string, ruleId: string) {
    return send(actor.api, 'post', '/api/v1/rule-family-membership/add', { familyId, ruleId }, orgHeader(organizationId));
  }

  async removeMember(actor: Actor, organizationId: string, familyId: string, ruleId: string) {
    return send(actor.api, 'post', '/api/v1/rule-family-membership/remove', { familyId, ruleId }, orgHeader(organizationId));
  }

  /**
   * A SERVED, RUNNABLE, test-owned QC_RULE (B1/B2 — see the file header for
   * the full self-approval-vs-two-person-review analysis). Creates a
   * brand-new workspace for a fresh throwaway author, then walks the rule
   * `draft → checked → in_review → published` via ORDINARY two-person
   * review — the owner authors and submits; `this.admin` (a different actor,
   * never the author) approves:
   *
   *   1. `POST /rules` with the two protocol-required output fields
   *      (`qc_include`, `qc_fail_reasons`) and a non-empty `guardOutput` —
   *      `protocol_compliance` passes, `selector_valid`/`connector_valid`
   *      pass on `null` (QC_RULE needs neither), `guidance_complete`/
   *      `field_help_complete` are warning-only since AXI-1861, and a
   *      QC_RULE is always `runnable` (`isRuleRunnable`'s `qc_rule` branch
   *      asks only that the kernel registers the QC gate operation) — so
   *      `initialStatus` lands `checked` on this one save
   *      (`RulesService.create`, FR9).
   *   2. `POST /rules/:id/submit-for-review` — author action, `checked →
   *      in_review`.
   *   3. `POST /rules/:id/approve`, called as `this.admin` — a platform
   *      admin holding `rule:publish` by assigned role who authored none of
   *      this rule's content, so `decideRuleReview` takes the plain
   *      non-author `{ allowed: true, selfApproved: false }` branch (file
   *      header cites the exact lines). No workspace-membership add is
   *      needed for the approver: visibility is satisfied by the
   *      platform-admin bypass in `RuleVisibilityService` regardless (file
   *      header), and `this.admin` is additionally the workspace's own
   *      creator/auto-enrolled member anyway.
   *
   * Returns the owning actor too, in case a caller needs to act as them
   * again (nothing in this suite currently does, but returning it is cheaper
   * than a second resolution if a future scenario needs it).
   */
  async servedQcRule(
    organizationId: string,
    label: string,
    code: string,
  ): Promise<{ ruleId: string; workspaceId: string; owner: Actor }> {
    if (!this.publisherRoleId) this.publisherRoleId = await this.role(`${label}-publisher-role`, ['rule:publish']);
    const workspaceId = await this.workspace(`${label}-served`, organizationId);
    const owner = await this.actor(`${label}-owner`, this.publisherRoleId, organizationId);
    await this.addWorkspaceMember(workspaceId, owner);

    const created = await send(owner.api, 'post', '/api/v1/rules', {
      code,
      title: `AXI-2005 served fixture rule ${code}`,
      category: 'qc_guard',
      protocolType: 'QC_RULE',
      scope: 'workspace',
      workspaceId,
      outputFields: [
        { key: 'qc_include', type: 'boolean', description: 'AXI-2005 fixture: whether the row passes QC.' },
        { key: 'qc_fail_reasons', type: 'string[]', description: 'AXI-2005 fixture: QC failure reason codes.' },
      ],
      guardOutput: { kind: 'threshold' },
    });
    expect(created.status, `[servedQcRule:create] creating served fixture rule ${code}: ${JSON.stringify(created.json)}`).toBeLessThan(300);
    this.ruleIds.push(created.json.id);
    expect(
      created.json.status,
      `[servedQcRule:create] fixture rule ${code} must pass the FR9 checked gate on creation: ${JSON.stringify(created.json)}`,
    ).toBe('checked');

    const submitted = await send(owner.api, 'post', `/api/v1/rules/${created.json.id}/submit-for-review`);
    expect(submitted.status, `[servedQcRule:submit-for-review] submitting fixture rule ${code} for review: ${JSON.stringify(submitted.json)}`).toBeLessThan(300);
    expect(submitted.json.status, `[servedQcRule:submit-for-review] fixture rule ${code} must be in_review: ${JSON.stringify(submitted.json)}`).toBe('in_review');

    // Two-person review (bounce #2, B1): `this.admin` — never `owner` — approves.
    const approved = await send(this.admin, 'post', `/api/v1/rules/${created.json.id}/approve`, {
      note: `AXI-2005 e2e fixture: admin (not the author) approving ${code} under ordinary two-person review.`,
    });
    expect(approved.status, `[servedQcRule:approve] approving fixture rule ${code} as admin (non-author): ${JSON.stringify(approved.json)}`).toBeLessThan(300);
    expect(
      approved.json.status,
      `[servedQcRule:approve] fixture rule ${code} must be served (published) to be offered/withheld at all: ${JSON.stringify(approved.json)}`,
    ).toBe('published');

    return { ruleId: created.json.id, workspaceId, owner };
  }

  /**
   * AXI-2029 (additive — no existing AXI-2005 behaviour changed): the same
   * "narrow a rule into a throwaway, uniquely-named family for the duration
   * of `body`, then always undo it" shape
   * `AXI-2005-new-run-history-decision.spec.ts`'s file-local
   * `withNarrowedSharedRule` already uses, lifted here so more than one
   * AXI-2029 spec file can share it without copy-pasting the removal/
   * deletion order (membership removed and asserted BEFORE the family is
   * deleted — deleting first would leave the membership pointing at a
   * soft-deleted family, which `resolveAuthorizedFamilyIdsForProject`
   * excludes from "authorized", withholding the shared rule stack-wide; see
   * the recovery note in `manual-e2e/AXI-1991-Rule-Families.md` §3).
   *
   * Unlike that file-local copy, this method also drops the family from
   * `this.families` once this method's own `finally` has deleted it — so a
   * later `world.dispose()` call (most callers also register their world
   * for a suite-level `afterAll`) never re-deletes an already-deleted
   * family and 404s. That double-delete is a latent trap in the existing
   * copy (not fixed here — out of this story's ownership boundary; see the
   * handback report).
   */
  async withNarrowedRule<T>(
    organizationId: string,
    ruleId: string,
    label: string,
    body: (familyId: string) => Promise<T>,
  ): Promise<T> {
    const admin: Actor = { userId: this.adminUserId, api: this.admin };
    const family = await this.createFamily(admin, organizationId, 'organization', label);
    if (!family.id) {
      throw new Error(`AXI-2029 withNarrowedRule: creating family "${label}" failed: ${JSON.stringify(family)}`);
    }
    const added = await this.addMember(admin, organizationId, family.id, ruleId);
    if (added.status >= 300) {
      throw new Error(`AXI-2029 withNarrowedRule: adding rule ${ruleId} to "${label}" failed: ${JSON.stringify(added.json)}`);
    }
    try {
      return await body(family.id);
    } finally {
      const removed = await this.removeMember(admin, organizationId, family.id, ruleId);
      if (removed.status >= 300) {
        throw new Error(
          `AXI-2029 cleanup: removing rule ${ruleId} from "${label}" failed (${JSON.stringify(removed.json)}) — ` +
            'the shared rule may now be withheld stack-wide; see the recovery note in manual-e2e/AXI-1991-Rule-Families.md §3',
        );
      }
      const deleted = await send(this.admin, 'delete', `/api/v1/rule-families/${family.id}`, undefined, orgHeader(organizationId));
      if (deleted.status >= 300) {
        throw new Error(`AXI-2029 cleanup: deleting throwaway family "${label}" (${family.id}) failed: HTTP ${deleted.status} ${JSON.stringify(deleted.json)}`);
      }
      const idx = this.families.findIndex((f) => f.id === family.id);
      if (idx >= 0) this.families.splice(idx, 1);
    }
  }

  /**
   * Runs every registered cleanup; collects rather than swallows a failure
   * (A3 — a prior version passed an empty `X-Organization-Id` on family
   * deletion, which the guard answers 400 on before any tenancy check, so
   * cleanup silently never ran and the `.catch()` hid it).
   */
  async dispose(): Promise<void> {
    const failures: string[] = [];
    for (const family of this.families) {
      const res = await send(this.admin, 'delete', `/api/v1/rule-families/${family.id}`, undefined, orgHeader(family.organizationId));
      if (res.status >= 300) failures.push(`delete family ${family.id}: HTTP ${res.status} ${JSON.stringify(res.json)}`);
    }
    for (const id of this.ruleIds) {
      const res = await this.admin.delete(apiUrl(`/api/v1/rules/${id}`));
      if (!res.ok()) failures.push(`delete rule ${id}: HTTP ${res.status()}`);
    }
    for (const actor of this.actors) await actor.api.dispose();
    for (const roleId of this.roleIds) {
      const res = await this.admin.delete(apiUrl(`/api/v1/roles/${roleId}`));
      if (!res.ok()) failures.push(`delete role ${roleId}: HTTP ${res.status()}`);
    }
    await this.admin.dispose();
    if (failures.length > 0) {
      throw new Error(`AXI-2005 world cleanup failed (fixtures may remain on the stack):\n  - ${failures.join('\n  - ')}`);
    }
  }
}
