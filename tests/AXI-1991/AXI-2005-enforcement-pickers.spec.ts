import { test, expect } from '@playwright/test';
import { RuleFamilyWorld, RULE_FAMILY_CAPABILITY, send, orgHeader, type Actor } from './harness/world';

/**
 * AXI-2005 (epic AXI-1991 — AC7; FR23-FR27, FR29, FR30, FR32; EC1-EC3, EC6,
 * EC7; §16a Q6, Q9).
 *
 * Picker-enforcement scenarios from
 * `axiome-docs/manual-e2e/AXI-1991-Rule-Families.md` §2.3. API-level only —
 * calling `GET /rule-runs/offered-rules` directly IS the "a direct API call
 * bypassing the UI is still governed" case (AC7); there is no separate test
 * for it.
 *
 * **Bounce #1 (B1) fix.** `findOfferedRules` offers only a SERVED
 * (`served-rule.ts`) and RUNNABLE (`isRuleRunnable`) rule — a bare,
 * never-published rule is absent from BOTH `offered[]` and `notAvailable[]`,
 * for a reason that has nothing to do with the family gate. Every test here
 * therefore uses `world.servedQcRule()` (`harness/world.ts`'s doc comment)
 * for a rule it owns and KNOWS is served/runnable, and asserts the POSITIVE
 * baseline — "this rule is in `offered[]`" — BEFORE adding any family
 * restriction, so a withheld/absent assertion can never pass for the wrong
 * reason.
 *
 * **Bounce #2 (B1) fix.** `servedQcRule`'s FIRST version had its throwaway
 * owner self-approve; that premise is false on a real stack (the workspace
 * creator is auto-enrolled and `this.admin` — the creator here — already
 * holds `rule:publish`), so it is now ordinary two-person review: the owner
 * authors/submits, `this.admin` approves. See `harness/world.ts`'s header
 * doc comment for the back file:line evidence. Nothing in THIS file changed
 * for that fix — it is entirely inside `servedQcRule` — but every test here
 * inherits it.
 *
 * **Picker-call visibility.** `GET /rule-runs/offered-rules` is authorized by
 * `RuleRunScopeAuthorizerService.authorize` (`apps/gateway/src/proxy/rule-run-scope.authorizer.ts`),
 * the same `VALIDATE_MEMBERSHIP`-style check `audit-logs.controller.ts` uses
 * inline: ordinary workspace MEMBERSHIP, any role — not a `rule_family:*`
 * capability. `author` is added to each served rule's own private workspace
 * via `world.addWorkspaceMember` (role `'admin'`, more than sufficient) before
 * every `offeredRules` call below; the `rule_family:*` role granted in
 * `beforeAll` governs the FAMILY-management calls (`createFamily`/
 * `addMember`/etc.), a separate concern from picker read access.
 *
 * AUTHORED, NOT RUN — no stack was started for this story.
 */

let world: RuleFamilyWorld;
let orgId: string;
let author: Actor;

test.beforeAll(async () => {
  world = await RuleFamilyWorld.create();
  orgId = await world.organization('enforcement');
  const authorRole = await world.role('author', [RULE_FAMILY_CAPABILITY.ASSIGN, RULE_FAMILY_CAPABILITY.MANAGE, RULE_FAMILY_CAPABILITY.READ, RULE_FAMILY_CAPABILITY.PROJECT_SELECT]);
  author = await world.actor('author', authorRole, orgId);
  // No shared workspace/project here any more: each test's served rule gets
  // its OWN private workspace (B1 — see `servedQcRule`'s doc comment) and its
  // own project.
});

test.afterAll(async () => {
  await world.dispose();
});

/**
 * `servedQcRule` mints its OWN private workspace per rule (the harness doc
 * comment explains why), so every caller here passes that rule's own
 * `workspaceId` — never the shared `wsId` the suite-level `author` sits in,
 * which the offering picker would read nothing relevant off.
 */
async function offeredRules(actor: Actor, workspaceId: string, projId: string | undefined) {
  const projQuery = projId ? `&projectId=${projId}` : '';
  return send(actor.api, 'get', `/api/v1/rule-runs/offered-rules?workspaceId=${workspaceId}${projQuery}`);
}

function isOffered(body: any, ruleId: string): boolean {
  return (body.offered ?? []).some((r: any) => (r.id ?? r.rule?.id) === ruleId);
}

function notAvailableEntry(body: any, ruleId: string): any {
  return (body.notAvailable ?? []).find((e: any) => (e.rule?.id ?? e.ruleId) === ruleId);
}

test.describe('AXI-2005 — family gate enforcement on the run/Workbench picker', () => {
  // AC7, EC3 — a rule filed into a non-default, unauthorized family is withheld
  test('AC7/EC3: a rule whose only family is NOT authorized here is withheld from the picker with the stable reason @SI-017 @SI-010', async () => {
    const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'ec3', `AXI2005EC3-${Date.now()}`);
    await world.addWorkspaceMember(workspaceId, author);
    const rp = await world.project('ec3', workspaceId);

    // Positive baseline (B1): before any family exists, the served rule IS offered.
    const baseline = await offeredRules(author, workspaceId, rp);
    expect(baseline.status).toBeLessThan(300);
    expect(isOffered(baseline.json, ruleId), `baseline: ${JSON.stringify(baseline.json)}`).toBe(true);

    const family = await world.createFamily(author, orgId, 'organization', 'Enforcement Unauthorized Family');
    expect(family.id).toBeTruthy();
    const added = await world.addMember(author, orgId, family.id!, ruleId);
    expect(added.status).toBeLessThan(300);

    const after = await offeredRules(author, workspaceId, rp);
    expect(after.status).toBeLessThan(300);
    expect(isOffered(after.json, ruleId), `after: ${JSON.stringify(after.json)}`).toBe(false);
    const entry = notAvailableEntry(after.json, ruleId);
    expect(entry, `rule ${ruleId} should be withheld: ${JSON.stringify(after.json)}`).toBeTruthy();
    expect(entry.reasonCode).toBe('family_not_authorized');
  });

  // AC7, EC2, EC1 — a rule in no family stays usable (deploy-lossless baseline)
  test('AC7/EC2: a rule in no family stays usable in a project that added nothing @SI-017', async () => {
    const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'ec2', `AXI2005EC2-${Date.now()}`);
    await world.addWorkspaceMember(workspaceId, author);
    const rp = await world.project('ec2', workspaceId);

    const res = await offeredRules(author, workspaceId, rp);
    expect(res.status).toBeLessThan(300);
    expect(isOffered(res.json, ruleId), JSON.stringify(res.json)).toBe(true);
  });

  // AC7, EC4 — a default-authorized family's member is usable without being added
  test('AC7/EC4: a rule in a default-authorized family is usable without the project adding it @SI-017', async () => {
    const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'ec4', `AXI2005EC4-${Date.now()}`);
    await world.addWorkspaceMember(workspaceId, author);
    const rp = await world.project('ec4', workspaceId);

    const baseline = await offeredRules(author, workspaceId, rp);
    expect(isOffered(baseline.json, ruleId), JSON.stringify(baseline.json)).toBe(true);

    const family = await world.createFamily(author, orgId, 'organization', 'Enforcement Default Family');
    expect(family.id).toBeTruthy();
    const toggled = await world.toggleDefault(author, orgId, family.id!, true);
    expect(toggled.status).toBeLessThan(300);
    const added = await world.addMember(author, orgId, family.id!, ruleId);
    expect(added.status).toBeLessThan(300);

    const after = await offeredRules(author, workspaceId, rp);
    expect(isOffered(after.json, ruleId), JSON.stringify(after.json)).toBe(true);
  });

  // AC7, EC6 — union semantics: at least one authorized family is enough
  test('AC7/EC6: a rule in two families, only one authorized here, is usable (union semantics) @SI-017', async () => {
    const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'ec6', `AXI2005EC6-${Date.now()}`);
    await world.addWorkspaceMember(workspaceId, author);
    const rp = await world.project('ec6', workspaceId);

    const baseline = await offeredRules(author, workspaceId, rp);
    expect(isOffered(baseline.json, ruleId), JSON.stringify(baseline.json)).toBe(true);

    const authorizedFamily = await world.createFamily(author, orgId, 'organization', 'Enforcement Union Authorized');
    const otherFamily = await world.createFamily(author, orgId, 'organization', 'Enforcement Union Other');
    expect(authorizedFamily.id).toBeTruthy();
    expect(otherFamily.id).toBeTruthy();
    const projAdded = await world.addProjectFamily(author, orgId, rp, authorizedFamily.id!);
    expect(projAdded.status).toBeLessThan(300);
    const m1 = await world.addMember(author, orgId, authorizedFamily.id!, ruleId);
    const m2 = await world.addMember(author, orgId, otherFamily.id!, ruleId);
    expect(m1.status).toBeLessThan(300);
    expect(m2.status).toBeLessThan(300);

    const after = await offeredRules(author, workspaceId, rp);
    expect(isOffered(after.json, ruleId), JSON.stringify(after.json)).toBe(true);
  });

  // AC7, EC5 — deleting an added family drops it from the project with no offering error
  test('AC7/EC5: soft-deleting a project-added family drops it from authorization with no offering error @SI-017', async () => {
    const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'ec5', `AXI2005EC5-${Date.now()}`);
    await world.addWorkspaceMember(workspaceId, author);
    const rp = await world.project('ec5', workspaceId);

    const baseline = await offeredRules(author, workspaceId, rp);
    expect(isOffered(baseline.json, ruleId), JSON.stringify(baseline.json)).toBe(true);

    const family = await world.createFamily(author, orgId, 'organization', 'Enforcement Deleted Family');
    expect(family.id).toBeTruthy();
    const projAdded = await world.addProjectFamily(author, orgId, rp, family.id!);
    expect(projAdded.status).toBeLessThan(300);
    const added = await world.addMember(author, orgId, family.id!, ruleId);
    expect(added.status).toBeLessThan(300);

    const authorized = await offeredRules(author, workspaceId, rp);
    expect(isOffered(authorized.json, ruleId), JSON.stringify(authorized.json)).toBe(true);

    const deleted = await send(author.api, 'delete', `/api/v1/rule-families/${family.id}`, undefined, orgHeader(orgId));
    expect(deleted.status).toBeLessThan(300);

    const after = await offeredRules(author, workspaceId, rp);
    expect(after.status).toBeLessThan(300);
    expect(isOffered(after.json, ruleId), JSON.stringify(after.json)).toBe(false);
    const entry = notAvailableEntry(after.json, ruleId);
    expect(entry?.reasonCode).toBe('family_not_authorized');
  });

  // AC7, §16a Q9 — no platform-admin bypass of the family gate
  test('AC7/Q9: a platform administrator sees the SAME withholding as an ordinary member — no admin bypass @SI-017', async () => {
    const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'q9', `AXI2005Q9-${Date.now()}`);
    await world.addWorkspaceMember(workspaceId, author);
    const rp = await world.project('q9', workspaceId);

    const baseline = await offeredRules(author, workspaceId, rp);
    expect(isOffered(baseline.json, ruleId), JSON.stringify(baseline.json)).toBe(true);

    const family = await world.createFamily(author, orgId, 'organization', 'Enforcement No Admin Bypass');
    expect(family.id).toBeTruthy();
    const added = await world.addMember(author, orgId, family.id!, ruleId);
    expect(added.status).toBeLessThan(300);

    const asAdmin = await send(world.admin, 'get', `/api/v1/rule-runs/offered-rules?workspaceId=${workspaceId}&projectId=${rp}`);
    expect(asAdmin.status).toBeLessThan(300);
    expect(isOffered(asAdmin.json, ruleId), JSON.stringify(asAdmin.json)).toBe(false);
    const entry = notAvailableEntry(asAdmin.json, ruleId);
    expect(entry?.reasonCode).toBe('family_not_authorized');
  });

  // AC7, FR32 — with no project context, nothing is withheld by the family gate
  test('AC7/FR32: with no project context, the family gate withholds nothing (picker falls back to pre-feature behavior) @SI-017', async () => {
    const { ruleId, workspaceId } = await world.servedQcRule(orgId, 'fr32', `AXI2005FR32-${Date.now()}`);
    await world.addWorkspaceMember(workspaceId, author);

    const family = await world.createFamily(author, orgId, 'organization', 'Enforcement No Project Context');
    expect(family.id).toBeTruthy();
    const added = await world.addMember(author, orgId, family.id!, ruleId);
    expect(added.status).toBeLessThan(300);

    // No projectId sent: FR32 says the family gate withholds nothing, so the
    // rule is OFFERED (positive), never carried in `notAvailable[]` for this
    // reason — asserted both ways, not just the absence.
    const res = await send(author.api, 'get', `/api/v1/rule-runs/offered-rules?workspaceId=${workspaceId}`);
    expect(res.status).toBeLessThan(300);
    expect(isOffered(res.json, ruleId), JSON.stringify(res.json)).toBe(true);
    const entry = notAvailableEntry(res.json, ruleId);
    expect(entry).toBeFalsy();
  });
});
