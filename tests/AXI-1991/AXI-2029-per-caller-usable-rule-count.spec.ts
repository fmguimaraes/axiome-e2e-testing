import { test, expect } from '@playwright/test';
import { RuleFamilyWorld, send, orgHeader, RULE_FAMILY_CAPABILITY } from './harness/world';

/**
 * AXI-2029 (epic AXI-1991 — SI-017; AXI-2026 debt, merged onto `origin/main`
 * at `fa7bf897` after this story's design was first drafted — fetched and
 * re-verified against that exact commit).
 *
 * `GET /api/v1/projects/:projectId/rule-families`
 * (`project-rule-family.controller.ts#listAuthorized`) now resolves the
 * caller's own `rule:read`/`rule:view_shared`/`rule:evaluate` role
 * permissions server-side (`RuleAccessResolverService.resolve`, the
 * AXI-1290 precedent) and narrows each returned family's `usableRuleCount`
 * with the SAME `RuleVisibilityService.buildVisibilityWhere` predicate
 * every other Rule read applies
 * (`project-rule-family.service.ts#listAuthorized`,
 * `usable-rule-count.ts#usableRuleCountsByFamily`'s `visibility` parameter).
 * `usableRuleCount: counts[row.id] ?? 0` — a family with no VISIBLE usable
 * member rule reports exactly `0`, never omits the field.
 *
 * `buildVisibilityWhere`'s non-system arms are gated by `hasRead` —
 * `rulePermissions.canRead` (`PERMISSION.RULE_READ = 'rule:read'`,
 * `toRuleAccessFlags`) — "membership alone grants nothing" per that method's
 * own AXI-1290 comment. So the two callers below are built to differ in
 * EXACTLY that one fact: both hold `rule_family:read` (needed merely to call
 * this endpoint, via `OrgCapabilityGuard`); only one additionally holds
 * `rule:read`. The family's one member rule is WORKSPACE-scope (never
 * system), so this is the scope arm `hasRead` gates, not the entitlement-
 * gated system arm — a caller with no `rule:read` at all is denied before
 * membership is even consulted, so this fixture does not need the second
 * caller to differ in workspace membership too (though in fact it also
 * never joins that workspace, belt-and-suspenders).
 *
 * **Owner ruling pending.** AXI-2026's doc comment on
 * `AuthorizedProjectFamilyItem.usableRuleCount` (`libs/contracts/src/
 * rule-family/project-rule-family.patterns.ts`) states this corrects the
 * ORIGINAL AXI-1997 review-gate decision ("deliberately NOT filtered by the
 * requesting caller's own rule-visibility") — i.e. a later story overrode an
 * explicit earlier product ruling on the SAME field's meaning. Per the
 * lead's instruction, this scenario is recorded `automation: playwright`
 * (it runs and holds either way) but flagged "pending owner ruling" in the
 * scenario doc rather than treated as settled, since a future ruling could
 * revert the semantics this test currently pins.
 *
 * AUTHORED, NOT RUN — no stack was started for this story.
 */
test.describe('AXI-2029 — a family\'s usableRuleCount is narrowed by the CALLER\'S OWN rule visibility', () => {
  test.describe.configure({ timeout: 180_000 });

  test(
    "pending owner ruling: two callers with different rule:read-gated visibility into the same family's one member rule see different usableRuleCount for the SAME project/family — a caller with none of it visible sees exactly 0 @SI-017",
    async () => {
      const world = await RuleFamilyWorld.create();
      try {
        const orgId = await world.organization('per-caller-count');
        const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'count', `AXI2029COUNT-${Date.now()}`);
        const projectId = await world.project('per-caller-count', workspaceId);

        const family = await world.createFamily(
          { userId: world.adminUserId, api: world.admin },
          orgId,
          'organization',
          'AXI-2029 Per-Caller Count Family',
        );
        expect(family.id, `family create: ${JSON.stringify(family)}`).toBeTruthy();
        const added = await world.addMember({ userId: world.adminUserId, api: world.admin }, orgId, family.id!, ruleId);
        expect(added.status, `adding the rule to the family: ${JSON.stringify(added.json)}`).toBeLessThan(300);
        const authorized = await world.addProjectFamily(
          { userId: world.adminUserId, api: world.admin },
          orgId,
          projectId,
          family.id!,
        );
        expect(authorized.status, `authorizing the family for the project: HTTP ${authorized.status}`).toBeLessThan(300);

        // Caller A: `rule_family:read` (to call this endpoint at all) PLUS
        // `rule:read` (the ONE fact `buildVisibilityWhere`'s workspace arm
        // gates on) and workspace membership (the scope stamp itself).
        const seeingRole = await world.role('count-seeing', [RULE_FAMILY_CAPABILITY.READ, 'rule:read']);
        const seeingActor = await world.actor('count-seeing', seeingRole, orgId);
        await world.addWorkspaceMember(workspaceId, seeingActor);

        // Caller B: `rule_family:read` only — no `rule:read`, so the
        // workspace arm never even reaches the membership question for
        // them; every non-system arm of `buildVisibilityWhere` is skipped.
        const blindRole = await world.role('count-blind', [RULE_FAMILY_CAPABILITY.READ]);
        const blindActor = await world.actor('count-blind', blindRole, orgId);

        const listUrl = `/api/v1/projects/${projectId}/rule-families`;
        const asSeeing = await send(seeingActor.api, 'get', listUrl, undefined, orgHeader(orgId));
        expect(asSeeing.status, JSON.stringify(asSeeing.json)).toBeLessThan(300);
        const seeingFamily = asSeeing.json.added?.find((f: any) => f.id === family.id);
        expect(seeingFamily, `family must appear in the 'added' bucket for caller A: ${JSON.stringify(asSeeing.json)}`).toBeTruthy();
        expect(seeingFamily.usableRuleCount, JSON.stringify(seeingFamily)).toBe(1);

        const asBlind = await send(blindActor.api, 'get', listUrl, undefined, orgHeader(orgId));
        expect(asBlind.status, JSON.stringify(asBlind.json)).toBeLessThan(300);
        const blindFamily = asBlind.json.added?.find((f: any) => f.id === family.id);
        expect(blindFamily, `family must still appear in the 'added' bucket for caller B — only the COUNT is narrowed, never the listing itself: ${JSON.stringify(asBlind.json)}`).toBeTruthy();
        expect(blindFamily.usableRuleCount, JSON.stringify(blindFamily)).toBe(0);
      } finally {
        await world.dispose();
      }
    },
  );
});
