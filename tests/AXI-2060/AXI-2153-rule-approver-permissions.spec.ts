import { test, expect } from '@playwright/test';
import { apiUrl } from '../../config/env';
import {
  Actor,
  deleteFixtureRules,
  inReviewRule,
  ReviewWorld,
  RuleResponse,
  send,
} from '../AXI-1762/AXI-1765-rule-review-fixtures';

/**
 * AXI-2153 (epic AXI-2060 — Gap G5, FR25/AC12): the real, seeded "Rule
 * Approver" role (`00000000-0000-0000-0000-000000001768`, created by the
 * AXI-1768 bootstrap migration carrying only `rule:publish`) could not OPEN a
 * system rule it was meant to approve — `GET /rules/:id` (and everything
 * that funnels through `RulesService.findOne`) is gated by a SEPARATE,
 * unchanged visibility check (`RuleVisibilityService.isRuleActionPermitted`)
 * that requires `rule:view_shared` for a `scope: 'system'` rule.
 * `rule:publish` alone authorizes the review DECISION (AXI-2086) but not the
 * read that has to happen first.
 *
 * This spec targets the REAL seeded role by name (never a throwaway
 * `world.role()` substitute) — the exact data the AXI-2153 migration
 * (`20261020120000_grant_rule_view_permissions_to_rule_approver`) patches —
 * so a regression that reverts the grant, or a future migration that
 * accidentally drops `rule:publish`, is caught here.
 *
 * Scenario doc: manual-e2e/AXI-2060-Microbiote-IgG4-Study-Reproduction.md
 * (AXI-2153 section). API-level by design, like its AXI-1765/AXI-2086
 * siblings — the review UI itself is unchanged by this story.
 */

const RULE_APPROVER_ROLE_NAME = 'Rule Approver';

let world: ReviewWorld;
let ruleApproverRoleId: string;

test.beforeAll(async () => {
  world = await ReviewWorld.create();
  const roles = (await send(world.admin, 'get', '/api/v1/roles')) as Array<{
    id: string;
    name: string;
    permissions: string[];
  }>;
  const role = roles.find((r) => r.name === RULE_APPROVER_ROLE_NAME);
  expect(role, `seeded role '${RULE_APPROVER_ROLE_NAME}' must exist (AXI-1768 bootstrap grant)`).toBeTruthy();
  ruleApproverRoleId = role!.id;
  // AC — the fix: rule:publish was never dropped, and both read-side
  // permissions are now present (AXI-2153 migration, either path: a fresh
  // grant or a top-up of a partial one).
  expect(role!.permissions).toEqual(
    expect.arrayContaining(['rule:publish', 'rule:read', 'rule:view_shared']),
  );
});

test.afterAll(async () => {
  if (world) await deleteFixtureRules(world.admin);
  await world?.dispose();
});

test.describe('AXI-2153 — the real Rule Approver role can open and review a system rule', () => {
  // AC1
  test('AC1 — a holder of the real Rule Approver role opens a system-scope in_review rule (no 404) @SI-035 @SI-017', async () => {
    // Arrange
    const admin: Actor = { userId: world.adminUserId, email: '', api: world.admin };
    const rule = await inReviewRule(admin.api, { scope: 'system' });
    const approver = await world.actor('approver-2153', ruleApproverRoleId);
    // System-scope visibility also needs an OrgRuleAccess entitlement,
    // reached through any organization membership (default mode is ALL).
    await world.workspace('ws-2153-open', [approver]);

    // Act
    const opened = (await send(approver.api, 'get', `/api/v1/rules/${rule.id}`)) as RuleResponse;

    // Assert — before AXI-2153 this 404'd (RULE_NOT_FOUND, no oracle) because
    // the role carried no rule:view_shared.
    expect(opened.id).toBe(rule.id);
    expect(opened.status).toBe('in_review');
  });

  // AC2
  test('AC2 — that same holder then approves the system-scope rule it just opened @SI-035 @SI-017', async () => {
    // Arrange
    const admin: Actor = { userId: world.adminUserId, email: '', api: world.admin };
    const rule = await inReviewRule(admin.api, { scope: 'system' });
    const approver = await world.actor('approver-2153-approve', ruleApproverRoleId);
    await world.workspace('ws-2153-approve', [approver]);
    await send(approver.api, 'get', `/api/v1/rules/${rule.id}`);

    // Act
    const res = await approver.api.post(apiUrl(`/api/v1/rules/${rule.id}/approve`), {
      data: { note: 'AXI-2153 — real Rule Approver role, read + publish both present' },
    });

    // Assert
    expect(res.ok(), `approve failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('published');
  });

  // AC3
  test('AC3 — without the AXI-2153 grant (rule:publish alone) the same open still 404s, unaffected by this fix @SI-035 @SI-017', async () => {
    // Arrange — a throwaway role mirroring the role's PRE-AXI-2153 shape, to
    // pin that the visibility gate itself is unchanged: rule:publish alone
    // is still not sufficient to open a system rule.
    const publishOnlyRole = await world.role('publish-only-2153', ['rule:publish']);
    const admin: Actor = { userId: world.adminUserId, email: '', api: world.admin };
    const rule = await inReviewRule(admin.api, { scope: 'system' });
    const holder = await world.actor('publish-only-2153', publishOnlyRole);
    await world.workspace('ws-2153-negative', [holder]);

    // Act
    const res = await holder.api.get(apiUrl(`/api/v1/rules/${rule.id}`));

    // Assert
    expect(res.status()).toBe(404);
  });
});
